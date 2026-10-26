// AI voice calls from the Contacts page. Everything except GET /config is
// ADMIN and EDITOR, and returns 404 while ENABLE_AI_CALLS is off.
//
//   GET  /api/ai-calls/config           feature flag + limits (any signed-in user)
//   POST /api/ai-calls/parse            upload .xlsx/.csv → headers, rows, detected columns
//   POST /api/ai-calls/start            validate + plan (dryRun) or create a run
//   GET  /api/ai-calls/runs             recent runs
//   GET  /api/ai-calls/runs/:id         one run with per-call status (polled by the UI)
//   POST /api/ai-calls/runs/:id/cancel  stop dialling (an in-flight call finishes)

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { idParam, maskPhone, startAiCallsInput, type StartAiCallsInput } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { logger } from "../../logger.js";
import { aiCallsConfig, isAiCallsConfigured, isCallFlowEditorEnabled } from "../../config/aiCalls.js";
import { CallFlowError, versionForNewRun } from "../../domain/callFlows.js";
import { aiCallFormatFromFilename, readAiCallSheet } from "../../domain/aiCallImport.js";
import { callsCountedTowardDailyCap, loadDoNotCallPhones, planAiCallRun } from "../../domain/aiCalls.js";
import { enqueueAiCallRun } from "../../queue/queues.js";
import { linkCustomersToRun, syncCustomerFromLog } from "../../domain/aiCallCustomerSync.js";
import { voiceCallsBlockedReason } from "../../services/voiceBackend.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, conflict, notFound, wrap } from "../errors.js";

export const aiCallsRouter = Router();
aiCallsRouter.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const limiter = (limit: number, windowMs: number) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many AI call requests — wait a minute and try again.", code: "rate_limited" },
  });
const startLimiter = limiter(10, 60_000);
const readLimiter = limiter(120, 60_000);

const DEFAULT_GAP_SEC = 30;

aiCallsRouter.get("/config", (req, res) => {
  res.json({
    enabled: aiCallsConfig.enabled,
    configured: aiCallsConfig.enabled && isAiCallsConfigured(),
    canStart: req.user?.role === "ADMIN" || req.user?.role === "EDITOR",
    maxPerRun: aiCallsConfig.maxPerRun,
    minGapSec: aiCallsConfig.minGapSec,
    defaultGapSec: Math.max(DEFAULT_GAP_SEC, aiCallsConfig.minGapSec),
    defaultCountryCode: aiCallsConfig.defaultCountryCode,
    flowEditor: isCallFlowEditorEnabled(),
    testCallNumbers: isCallFlowEditorEnabled() && (req.user?.role === "ADMIN" || req.user?.role === "EDITOR") ? aiCallsConfig.flowTestNumbers.map(maskPhone) : [],
  });
});

function featureGate(_req: Request, _res: Response, next: NextFunction) {
  if (!aiCallsConfig.enabled) return next(new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found"));
  next();
}
aiCallsRouter.use(featureGate, requireRole("ADMIN", "EDITOR")); // editors may start calls (Contacts / AI Call Customers)

aiCallsRouter.post(
  "/parse",
  readLimiter,
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    const format = aiCallFormatFromFilename(req.file.originalname);
    if (!format) throw badRequest("Unsupported file type — upload a .xlsx or .csv file");
    let sheet;
    try {
      sheet = await readAiCallSheet(req.file.buffer, format);
    } catch (err) {
      throw badRequest(`Couldn't read the file: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (sheet.headers.length === 0) throw badRequest("The file has no header row");
    if (sheet.rows.length === 0) throw badRequest("The file has no data rows");
    res.json(sheet);
  }),
);

/**
 * Plan a run from rows and (unless dryRun) create + enqueue it. Shared by
 * POST /start (rows from an uploaded file) and POST /api/ai-call-customers/call
 * (rows from saved customers; `customerIdByRow[i]` links row i to its customer).
 */
export async function planAndStartAiCallRun(
  body: StartAiCallsInput,
  user: { id: string; email: string },
  customerIdByRow?: (string | null)[],
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (!isAiCallsConfigured()) {
    throw new AppError(503, "Voice backend is not configured — set VOICE_BACKEND_URL and VOICE_BACKEND_API_KEY", "unavailable");
  }
  if (body.gapSeconds < aiCallsConfig.minGapSec) {
    throw badRequest(`Gap between calls must be at least ${aiCallsConfig.minGapSec} seconds`);
  }
  // A chosen call flow pins its latest published version to the run; none = the default agent.
  let flowVersion: { id: string; version: number } | null = null;
  if (body.flowId) {
    if (!isCallFlowEditorEnabled()) throw badRequest("Call flows are disabled (ENABLE_CALL_FLOW_EDITOR)");
    try {
      flowVersion = await versionForNewRun(body.flowId);
    } catch (err) {
      if (err instanceof CallFlowError) throw new AppError(err.status, err.message, err.status === 404 ? "not_found" : "bad_request");
      throw err;
    }
  }

  const plan = planAiCallRun(body, {
    doNotCall: await loadDoNotCallPhones(aiCallsConfig.defaultCountryCode),
    hardCap: aiCallsConfig.maxPerRun,
    defaultCountryCode: aiCallsConfig.defaultCountryCode,
  });
  const summary = {
    toCall: plan.targets.length,
    skipped: plan.skipped,
    invalidRows: plan.invalidRows.slice(0, 200),
    hardCap: aiCallsConfig.maxPerRun,
  };
  if (plan.targets.length === 0) {
    throw badRequest("No callable customers — every row was invalid, a duplicate, or on the do-not-call list");
  }
  // Checked on the dry run too, so the confirm step never promises a run that can't start.
  const running = await prisma.aiCallRun.findFirst({ where: { status: "RUNNING" }, select: { id: true } });
  if (running) {
    throw conflict("Another AI call run is still in progress — wait for it to finish or cancel it first");
  }
  // Plivo / Twilio can't reach the voice backend (e.g. ngrok stopped): every call would ring, then go silent.
  const blocked = await voiceCallsBlockedReason();
  if (blocked) throw new AppError(503, blocked, "voice_unreachable");
  const used = await callsCountedTowardDailyCap();
  if (used + plan.targets.length > aiCallsConfig.dailyCap) {
    throw new AppError(
      429,
      `Daily AI call limit reached: ${used} of ${aiCallsConfig.dailyCap} used in the last 24 hours, ` +
        `this run needs ${plan.targets.length}`,
      "rate_limited",
    );
  }
  if (body.dryRun) return { status: 200, json: { dryRun: true, ...summary, flowVersion: flowVersion?.version ?? null } };

  const run = await prisma.aiCallRun.create({
    data: {
      mode: body.mode === "random" ? "RANDOM" : body.mode === "selected" ? "SELECTED" : "ALL",
      gapSeconds: body.gapSeconds,
      maxCalls: Math.min(body.maxCalls, aiCallsConfig.maxPerRun),
      total: plan.targets.length,
      createdById: user.id,
      createdByEmail: user.email,
      // greetingDelaySec rides along in this JSON (like a test call's testCall flag): no schema change.
      skipped: { ...plan.skipped, greetingDelaySec: body.greetingDelaySec },
      ...(flowVersion ? { flow: { create: { flowVersionId: flowVersion.id } } } : {}),
      logs: {
        create: plan.targets.map((t, i) => ({
          position: i,
          customerName: t.customerName,
          gender: t.gender,
          followUpDetail: t.followUpDetail,
          phone: t.phone,
        })),
      },
    },
  });
  if (customerIdByRow) {
    // Saved customers: link each call to its customer (marks them Queued).
    const logs = await prisma.aiCallLog.findMany({ where: { runId: run.id }, select: { id: true, position: true } });
    const links = logs
      .map((l) => ({ logId: l.id, customerId: customerIdByRow[plan.targets[l.position]!.rowIndex] }))
      .filter((l): l is { logId: string; customerId: string } => !!l.customerId);
    await linkCustomersToRun(run.id, links, user.email);
  }
  await enqueueAiCallRun({ runId: run.id });
  logger.info(
    {
      runId: run.id,
      by: user.email,
      mode: body.mode,
      calls: plan.targets.length,
      phones: plan.targets.map((t) => maskPhone(t.phone)),
      skipped: plan.skipped,
      flowId: body.flowId ?? null,
      flowVersion: flowVersion?.version ?? null,
      greetingDelaySec: body.greetingDelaySec,
      savedCustomers: !!customerIdByRow,
    },
    "ai call run started",
  );
  return { status: 201, json: { runId: run.id, ...summary, flowVersion: flowVersion?.version ?? null } };
}

aiCallsRouter.post(
  "/start",
  startLimiter,
  wrap(async (req, res) => {
    const body = startAiCallsInput.parse(req.body);
    const out = await planAndStartAiCallRun(body, req.user!);
    res.status(out.status).json(out.json);
  }),
);

aiCallsRouter.get(
  "/runs",
  readLimiter,
  wrap(async (_req, res) => {
    const items = await prisma.aiCallRun.findMany({ orderBy: { createdAt: "desc" }, take: 10 });
    res.json({ items });
  }),
);

aiCallsRouter.get(
  "/runs/:id",
  readLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const run = await prisma.aiCallRun.findUnique({
      where: { id },
      include: {
        logs: { orderBy: { position: "asc" } },
        flow: { include: { flowVersion: { select: { flowId: true, version: true, status: true, flow: { select: { name: true } } } } } },
      },
    });
    if (!run) throw notFound("AI call run");
    res.json(run);
  }),
);

aiCallsRouter.post(
  "/runs/:id/cancel",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const run = await prisma.aiCallRun.findUnique({ where: { id }, select: { status: true } });
    if (!run) throw notFound("AI call run");
    if (run.status !== "RUNNING") throw conflict(`Run is already ${run.status.toLowerCase()}`);
    const queued = await prisma.aiCallLog.findMany({ where: { runId: id, status: "QUEUED" }, select: { id: true } });
    await prisma.$transaction([
      prisma.aiCallRun.update({ where: { id }, data: { status: "CANCELLED", nextCallAt: null } }),
      prisma.aiCallLog.updateMany({ where: { runId: id, status: "QUEUED" }, data: { status: "CANCELLED" } }),
    ]);
    // Saved customers that were only queued go back to their previous stage.
    for (const l of queued) await syncCustomerFromLog(l.id);
    logger.info({ runId: id, by: req.user!.email }, "ai call run cancelled");
    res.json({ ok: true });
  }),
);
