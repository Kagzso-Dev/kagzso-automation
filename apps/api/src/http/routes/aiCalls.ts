// AI voice calls from the Contacts page. Everything except GET /config is
// ADMIN and EDITOR, and returns 404 while ENABLE_AI_CALLS is off.
//
//   GET  /api/ai-calls/config           feature flag + limits (any signed-in user)
//   POST /api/ai-calls/parse            upload .xlsx/.csv → headers, rows, detected columns
//   POST /api/ai-calls/start            validate + plan (dryRun) or create a run
//   GET  /api/ai-calls/runs             recent runs (?language=ta, absent = English)
//   GET  /api/ai-calls/runs/:id         one run with per-call status (polled by the UI)
//   POST /api/ai-calls/runs/:id/cancel  stop dialling (an in-flight call finishes)
//   GET  /api/ai-calls/languages        ADMIN: each language's voice backend status + on/off
//   PUT  /api/ai-calls/languages/:code  ADMIN: { enabled } switch a language (not English) on or off;
//                                       switching on also starts its voice backend when it is down
//   POST /api/ai-calls/languages/:code/run  ADMIN: start that language's voice backend (services/voiceProcess)

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  AI_CALL_LANGUAGE_NAMES,
  aiCallLanguage,
  aiCallLanguageQuery,
  DEFAULT_AI_CALL_LANGUAGE,
  idParam,
  maskPhone,
  setAiCallLanguageInput,
  startAiCallsInput,
  type AiCallLanguage,
  type AiCallLanguageInfo,
  type StartAiCallsInput,
} from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { logger } from "../../logger.js";
import { aiCallsConfig, isCallFlowEditorEnabled, voiceBackendFor } from "../../config/aiCalls.js";
import { CallFlowError, versionForNewRun } from "../../domain/callFlows.js";
import {
  AiCallLanguageError,
  aiCallLanguageBlockedReason,
  listAiCallLanguages,
  runLanguageWhere,
  runInProgressReason,
  runningRun,
  setAiCallLanguageEnabled,
} from "../../domain/aiCallLanguages.js";
import { aiCallFormatFromFilename, readAiCallSheet } from "../../domain/aiCallImport.js";
import { callsCountedTowardDailyCap, loadDoNotCallPhones, planAiCallRun } from "../../domain/aiCalls.js";
import { enqueueAiCallRun } from "../../queue/queues.js";
import { linkCustomersToRun, syncCustomerFromLog } from "../../domain/aiCallCustomerSync.js";
import { getVoiceReady, languageMismatch, voiceCallsBlockedReason } from "../../services/voiceBackend.js";
import { startVoiceBackend } from "../../services/voiceProcess.js";
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

aiCallsRouter.get(
  "/config",
  wrap(async (req, res) => {
    // The language pages to show: configured and switched on (English always). A failed settings
    // read must not take the AI call pages down: English alone is shown then.
    const languages = await listAiCallLanguages()
      .then((all) => all.filter((l) => l.enabled))
      .catch((err): AiCallLanguageInfo[] => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ai call languages unreadable — English only");
        return [{ code: "en", name: "English", configured: voiceBackendFor("en") !== null, enabled: true }];
      });
    res.json({
      enabled: aiCallsConfig.enabled,
      configured: aiCallsConfig.enabled && voiceBackendFor(DEFAULT_AI_CALL_LANGUAGE) !== null,
      canStart: req.user?.role === "ADMIN" || req.user?.role === "EDITOR",
      maxPerRun: aiCallsConfig.maxPerRun,
      minGapSec: aiCallsConfig.minGapSec,
      defaultGapSec: Math.max(DEFAULT_GAP_SEC, aiCallsConfig.minGapSec),
      defaultCountryCode: aiCallsConfig.defaultCountryCode,
      flowEditor: isCallFlowEditorEnabled(),
      testCallNumbers: isCallFlowEditorEnabled() && (req.user?.role === "ADMIN" || req.user?.role === "EDITOR") ? aiCallsConfig.flowTestNumbers.map(maskPhone) : [],
      languages,
    });
  }),
);

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
  // The run's language: its voice backend must be set up (and, for any language but English, switched on).
  const language = body.language;
  const unavailable = await aiCallLanguageBlockedReason(language);
  if (unavailable) throw new AppError(503, unavailable, "unavailable");
  if (body.gapSeconds < aiCallsConfig.minGapSec) {
    throw badRequest(`Gap between calls must be at least ${aiCallsConfig.minGapSec} seconds`);
  }
  // A chosen call flow pins its latest published version to the run; none = the default agent,
  // which is English: any other language always calls with one of its own published flows.
  let flowVersion: { id: string; version: number } | null = null;
  if (body.flowId) {
    if (!isCallFlowEditorEnabled()) throw badRequest("Call flows are disabled (ENABLE_CALL_FLOW_EDITOR)");
    try {
      flowVersion = await versionForNewRun(body.flowId, language);
    } catch (err) {
      if (err instanceof CallFlowError) throw new AppError(err.status, err.message, err.status === 404 ? "not_found" : "bad_request");
      throw err;
    }
  } else if (language !== DEFAULT_AI_CALL_LANGUAGE) {
    const name = AI_CALL_LANGUAGE_NAMES[language];
    throw badRequest(`Pick a ${name} call flow — ${name} calls always use one (publish one in ${name} → Voice Call Flows)`);
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
  // One run at a time, one language at a time (a run in another language blocks this one too).
  const inProgress = await runInProgressReason(language);
  if (inProgress) throw conflict(inProgress);
  // Plivo / Twilio can't reach the voice backend (e.g. ngrok stopped): every call would ring, then go silent.
  const blocked = await voiceCallsBlockedReason(language);
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
      language,
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

// The language calling right now (any language's run still dialling), for the note on every language page.
aiCallsRouter.get(
  "/running",
  readLimiter,
  wrap(async (_req, res) => {
    res.json({ running: await runningRun() });
  }),
);

aiCallsRouter.get(
  "/runs",
  readLimiter,
  wrap(async (req, res) => {
    const { language } = aiCallLanguageQuery.parse(req.query);
    const items = await prisma.aiCallRun.findMany({ where: runLanguageWhere(language), orderBy: { createdAt: "desc" }, take: 10 });
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

/* ------------------------------------------------------------------ languages (Settings, admins) */

const languageParam = z.object({ code: aiCallLanguage });

/** Is the language's voice backend up, and does it call in that language? Never throws. */
async function backendStatus(language: AiCallLanguage) {
  try {
    const ready = await getVoiceReady(language);
    const missing = Object.entries({ mysql: ready.mysql, ...ready.providers }).filter(([, v]) => v && v !== "ok" && v !== "configured");
    const problem =
      languageMismatch(language, ready) ??
      (ready.status === "ready" ? null : `Not ready (${missing.map(([k, v]) => `${k}: ${v}`).join(", ") || "see its /ready"})`);
    return { reachable: true, ready: ready.status === "ready", reportedLanguage: ready.language ?? null, problem };
  } catch (err) {
    return { reachable: false, ready: false, reportedLanguage: null, problem: `Not reachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function languageError(err: unknown): never {
  if (err instanceof AiCallLanguageError) {
    throw new AppError(err.status, err.message, err.status === 404 ? "not_found" : err.status === 503 ? "unavailable" : "bad_request");
  }
  throw err;
}

aiCallsRouter.get(
  "/languages",
  requireRole("ADMIN"),
  readLimiter,
  wrap(async (_req, res) => {
    const languages = await listAiCallLanguages();
    const items = await Promise.all(
      languages.map(async (l) => ({
        ...l,
        // Admins only: where Dispatch sends this language's calls (from the API's .env).
        url: voiceBackendFor(l.code)?.url ?? null,
        status: l.configured ? await backendStatus(l.code) : null,
      })),
    );
    res.json({ items });
  }),
);

/** Start the language's voice backend; the outcome (or why it couldn't) for the admin. Never throws. */
async function runBackend(language: AiCallLanguage, by: string): Promise<{ started: boolean; running: boolean; error: string | null }> {
  try {
    const r = await startVoiceBackend(language);
    logger.info({ language, how: r.how, started: r.started, by }, "ai call voice backend run");
    return { started: r.started, running: true, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ language, by, err: error }, "ai call voice backend could not be started");
    return { started: false, running: false, error };
  }
}

aiCallsRouter.put(
  "/languages/:code",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const { code } = languageParam.parse(req.params);
    const { enabled } = setAiCallLanguageInput.parse(req.body ?? {});
    let items = await setAiCallLanguageEnabled(code, enabled).catch(languageError);
    logger.info({ language: code, enabled, by: req.user!.email }, "ai call language switched");
    // Switched on: its voice backend runs too, so the language can be used at once (when it is set up).
    const backend = enabled && items.find((l) => l.code === code)?.configured ? await runBackend(code, req.user!.email) : null;
    if (backend?.started) items = await listAiCallLanguages();
    res.json({ items, backend });
  }),
);

aiCallsRouter.post(
  "/languages/:code/run",
  requireRole("ADMIN"),
  rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon" }),
  wrap(async (req, res) => {
    const { code } = languageParam.parse(req.params);
    const backend = await runBackend(code, req.user!.email);
    if (backend.error) throw new AppError(409, backend.error, "conflict");
    res.json(backend);
  }),
);
