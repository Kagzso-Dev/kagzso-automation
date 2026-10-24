// Call Flows editor ("Voice Call Flows" page). Reads: ADMIN and EDITOR (the AI Call window's
// flow picker). Changes (create, save, publish, archive, remove, trial numbers): ADMIN only.
// 404 unless both ENABLE_AI_CALLS and ENABLE_CALL_FLOW_EDITOR are on.
//
//   GET    /api/call-flows/builtin                   built-in flows to copy + locked block text (from the voice backend)
//   GET    /api/call-flows                           flows with their latest published / draft version
//   POST   /api/call-flows                           new flow, draft v1 copied from a built-in
//   GET    /api/call-flows/:id                       one flow with every version
//   PUT    /api/call-flows/:id/draft                 save the draft (a published flow gets a new draft version)
//   DELETE /api/call-flows/:id/draft                 discard the draft
//   POST   /api/call-flows/:id/publish               validate with the voice backend, then DRAFT → PUBLISHED
//   POST   /api/call-flows/:id/versions/:v/restore   copy an old version into the draft
//   DELETE /api/call-flows/:id/versions/:v           delete one version (not the live one, not one a run used)
//   POST   /api/call-flows/:id/import-preview        split a pasted full prompt into this flow's blocks (saves nothing)
//   POST   /api/call-flows/:id/import-apply          save that split as a new draft (never publishes)
//   POST   /api/call-flows/:id/archive               hide the flow (runs already pinned to it keep it)
//   DELETE /api/call-flows/:id                       remove an unpublished flow (hidden instead if a run used it)
//   POST   /api/call-flows/preview                   render a definition with sample customer data
//   GET    /api/call-flows/test-numbers              trial numbers the test call may dial (saved + AI_CALL_FLOW_TEST_NUMBERS), masked
//   POST   /api/call-flows/test-numbers              save a trial number (max 5)
//   DELETE /api/call-flows/test-numbers/:numberId    remove a saved trial number
//   POST   /api/call-flows/:id/test-call             one call to a trial number, picked by id (never a typed-in number)

import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  addTestCallNumberInput,
  AI_CALL_DEFAULT_GREETING_DELAY_SEC,
  CALL_FLOW_BASES,
  CALL_FLOW_IMPORT_WARN_CHARS,
  callFlowDefinition,
  callFlowImportApplyInput,
  callFlowImportInput,
  callFlowVersionParam,
  createCallFlowInput,
  idParam,
  maskPhone,
  materializeUnlockedBlocks,
  normalizeAiCallGender,
  previewCallFlowInput,
  saveCallFlowDraftInput,
  testCallFlowInput,
  type CallFlowDefinition,
  type CallFlowImportPreview,
  type CallFlowImportResult,
} from "@dispatch/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.js";
import { logger } from "../../logger.js";
import { aiCallsConfig, isAiCallsConfigured, isCallFlowEditorEnabled } from "../../config/aiCalls.js";
import { callsCountedTowardDailyCap, loadDoNotCallPhones } from "../../domain/aiCalls.js";
import { CallFlowError, definitionHash, deleteVersion, latestPublished, publishDraft, removeFlow, saveDraft } from "../../domain/callFlows.js";
import { analyzeImport, changedBlockIds } from "../../domain/callFlowImport.js";
import { addTestNumber, listTestNumbers, removeTestNumber, resolveTestNumber, TestNumberError } from "../../domain/callFlowTestNumbers.js";
import { enqueueAiCallRun } from "../../queue/queues.js";
import { getBuiltinFlows, previewFlow, VoiceBackendError, type VoiceFlowCatalog } from "../../services/voiceBackend.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, conflict, forbidden, notFound, wrap } from "../errors.js";

export const callFlowsRouter = Router();
callFlowsRouter.use(authRequired);

function featureGate(_req: Request, _res: Response, next: NextFunction) {
  if (!isCallFlowEditorEnabled()) {
    return next(new AppError(404, "Call flows are disabled (set ENABLE_AI_CALLS and ENABLE_CALL_FLOW_EDITOR)", "not_found"));
  }
  next();
}
callFlowsRouter.use(featureGate, requireRole("ADMIN", "EDITOR"));

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many call flow requests — wait a minute and try again.", code: "rate_limited" },
  });
const writeLimiter = limiter(60);
/** Changing call flows (create, save, publish, archive, remove, trial numbers): admins only. Editors keep the
 *  reads the AI Call window uses (the flow picker); they don't get the Voice Call Flows page (web lib/navAccess). */
const adminOnly = requireRole("ADMIN");
const previewLimiter = limiter(120);
const testCallLimiter = limiter(3);
/** 3 placed test calls per hour per user. Refused requests (4xx/5xx) don't use up the hour. */
const testCallHourlyLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 3,
  standardHeaders: true,
  skipFailedRequests: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "You can place 3 test calls per hour — try again later.", code: "rate_limited" },
});

/** Voice backend problems become 503 (unreachable) or 502 (it rejected us), never a crash. */
function voiceError(err: unknown): never {
  if (err instanceof VoiceBackendError) {
    throw new AppError(err.status === null || err.retryable ? 503 : 502, err.message, "unavailable");
  }
  throw err;
}

function flowError(err: unknown): never {
  if (err instanceof CallFlowError) {
    throw new AppError(err.status, err.message, err.status === 404 ? "not_found" : err.status === 400 ? "bad_request" : "conflict");
  }
  throw err;
}

let builtinCache: { at: number; data: VoiceFlowCatalog } | null = null;
async function builtins(): Promise<VoiceFlowCatalog> {
  if (builtinCache && Date.now() - builtinCache.at < 60_000) return builtinCache.data;
  const data = await getBuiltinFlows().catch(voiceError);
  builtinCache = { at: Date.now(), data };
  return data;
}

function testNumberError(err: unknown): never {
  if (err instanceof TestNumberError) {
    const code = err.status === 409 ? "conflict" : err.status === 404 ? "not_found" : err.status === 503 ? "unavailable" : "bad_request";
    throw new AppError(err.status, err.message, code);
  }
  throw err;
}

const asJson = (d: unknown) => d as Prisma.InputJsonValue;

/** DELETE /api/call-flows/:id body: a live flow needs { confirm: "DELETE" }. */
const removeFlowBody = z.object({ confirm: z.string().max(32).optional() });

async function liveFlow(id: string) {
  const flow = await prisma.callFlow.findUnique({ where: { id } });
  if (!flow || flow.archivedAt) throw notFound("Call flow");
  return flow;
}

callFlowsRouter.get(
  "/builtin",
  wrap(async (_req, res) => {
    res.json(await builtins());
  }),
);

callFlowsRouter.get(
  "/",
  wrap(async (_req, res) => {
    const flows = await prisma.callFlow.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: "desc" },
      include: {
        versions: {
          orderBy: { version: "desc" },
          select: { id: true, version: true, status: true, publishedAt: true, updatedAt: true },
        },
      },
    });
    res.json({
      items: flows.map(({ versions, ...f }) => ({
        ...f,
        published: versions.find((v) => v.status === "PUBLISHED") ?? null,
        draft: versions.find((v) => v.status === "DRAFT") ?? null,
        versionCount: versions.length,
      })),
    });
  }),
);

callFlowsRouter.post(
  "/",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const body = createCallFlowInput.parse(req.body);
    const catalog = await builtins();
    const parsed = callFlowDefinition.safeParse({ ...catalog.flows[body.base], name: body.name });
    if (!parsed.success) throw new AppError(502, "The voice backend's built-in flow failed validation", "unavailable");
    const definition = parsed.data;
    const flow = await prisma.callFlow.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        base: body.base,
        createdById: req.user!.id,
        createdByEmail: req.user!.email,
        versions: {
          create: {
            version: 1,
            status: "DRAFT",
            definition: asJson(definition),
            definitionHash: definitionHash(definition),
            createdByEmail: req.user!.email,
          },
        },
      },
    });
    logger.info({ flowId: flow.id, base: body.base, by: req.user!.email }, "call flow created");
    res.status(201).json(flow);
  }),
);

callFlowsRouter.post(
  "/preview",
  previewLimiter,
  wrap(async (req, res) => {
    const body = previewCallFlowInput.parse(req.body);
    res.json(await previewFlow(body.definition, body.sample).catch(voiceError));
  }),
);

callFlowsRouter.get(
  "/test-numbers",
  wrap(async (_req, res) => {
    res.json(await listTestNumbers());
  }),
);

callFlowsRouter.post(
  "/test-numbers",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const body = addTestCallNumberInput.parse(req.body);
    const { item, phone } = await addTestNumber(body.phone, body.label, req.user!.email).catch(testNumberError);
    logger.info({ phone: maskPhone(phone), by: req.user!.email }, "call flow trial number added");
    res.status(201).json(item);
  }),
);

callFlowsRouter.delete(
  "/test-numbers/:numberId",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { phone } = await removeTestNumber(String(req.params.numberId ?? "")).catch(testNumberError);
    logger.info({ phone: maskPhone(phone), by: req.user!.email }, "call flow trial number removed");
    res.json({ ok: true });
  }),
);

callFlowsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const flow = await prisma.callFlow.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!flow || flow.archivedAt) throw notFound("Call flow");
    res.json(flow);
  }),
);

callFlowsRouter.put(
  "/:id/draft",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = saveCallFlowDraftInput.parse(req.body);
    const flow = await liveFlow(id);
    if (body.definition.base !== flow.base) throw badRequest(`This flow is based on '${flow.base}'; base can't change`);
    if (body.description !== undefined) {
      await prisma.callFlow.update({ where: { id }, data: { description: body.description } });
    }
    const before = await prisma.callFlowVersion.findFirst({ where: { flowId: id }, orderBy: { version: "desc" } });
    const draft = await saveDraft(id, body.definition, req.user!.email).catch(flowError);
    logger.info(
      { flowId: id, version: draft.version, changedBlocks: changedBlockIds(before?.definition, body.definition), by: req.user!.email },
      "call flow draft saved",
    );
    res.json(draft);
  }),
);

callFlowsRouter.delete(
  "/:id/draft",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await liveFlow(id);
    const published = await latestPublished(id);
    if (!published) throw conflict("This flow has never been published — archive it instead of discarding its only draft");
    const { count } = await prisma.callFlowVersion.deleteMany({ where: { flowId: id, status: "DRAFT", runs: { none: {} } } });
    if (count === 0) throw conflict("No draft to discard (or it was already used for a test call)");
    res.json({ ok: true });
  }),
);

callFlowsRouter.post(
  "/:id/publish",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await liveFlow(id);
    const draft = await prisma.callFlowVersion.findFirst({ where: { flowId: id, status: "DRAFT" } });
    if (!draft) throw conflict("Nothing to publish — save a draft first");
    const local = callFlowDefinition.safeParse(draft.definition);
    if (!local.success) throw badRequest("The draft is not valid", local.error.flatten());
    const check = await previewFlow(local.data).catch(voiceError);
    if (!check.valid) throw badRequest("The voice backend rejected this flow", { errors: check.errors });
    const published = await publishDraft(draft.id).catch(flowError);
    logger.info({ flowId: id, version: published.version, by: req.user!.email }, "call flow published");
    res.json(published);
  }),
);

callFlowsRouter.post(
  "/:id/versions/:version/restore",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id, version } = callFlowVersionParam.parse(req.params);
    await liveFlow(id);
    const old = await prisma.callFlowVersion.findUnique({ where: { flowId_version: { flowId: id, version } } });
    if (!old) throw notFound("Version");
    const parsed = callFlowDefinition.safeParse(old.definition);
    if (!parsed.success) throw badRequest("That version no longer passes validation and can't be restored");
    res.json(await saveDraft(id, parsed.data, req.user!.email).catch(flowError));
  }),
);

callFlowsRouter.delete(
  "/:id/versions/:version",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id, version } = callFlowVersionParam.parse(req.params);
    await deleteVersion(id, version).catch(flowError);
    logger.info({ flowId: id, version, by: req.user!.email }, "call flow version deleted");
    res.json({ ok: true });
  }),
);

/** "Large prompt" warning for an import; CALL_FLOW_IMPORT_WARN_CHARS overrides the default. */
const importWarnChars = () => Number(process.env.CALL_FLOW_IMPORT_WARN_CHARS) || CALL_FLOW_IMPORT_WARN_CHARS;

/** What an import works on: the newest version (draft, else live), with the unlocked safety blocks as text. */
async function importBase(id: string) {
  await liveFlow(id);
  const versions = await prisma.callFlowVersion.findMany({ where: { flowId: id }, orderBy: { version: "desc" } });
  const draft = versions.find((v) => v.status === "DRAFT") ?? null;
  const published = versions.find((v) => v.status === "PUBLISHED") ?? null;
  const working = draft ?? published;
  if (!working) throw notFound("Version");
  const parsed = callFlowDefinition.safeParse(working.definition);
  if (!parsed.success) throw badRequest("The current version is not valid — fix and save it first");
  const catalog = await builtins();
  return {
    draft,
    published,
    working: parsed.data,
    definition: materializeUnlockedBlocks(parsed.data, catalog.locked_blocks),
    lockedText: catalog.locked_blocks,
    // An open draft next to a live version would be overwritten (and Undo couldn't bring it back).
    draftConflict: draft && published ? `This flow has a draft (v${draft.version}). Publish or discard it first.` : null,
  };
}

callFlowsRouter.post(
  "/:id/import-preview",
  adminOnly,
  previewLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = callFlowImportInput.parse(req.body);
    const base = await importBase(id);
    const { preview } = analyzeImport(body, base.definition, base.lockedText, importWarnChars());
    res.json({ ...preview, draftConflict: base.draftConflict } satisfies CallFlowImportPreview);
  }),
);

callFlowsRouter.post(
  "/:id/import-apply",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = callFlowImportApplyInput.parse(req.body);
    const base = await importBase(id);
    if (base.draftConflict) throw conflict(base.draftConflict);
    const { preview, next } = analyzeImport(body, base.definition, base.lockedText, importWarnChars());
    if (preview.blocking.length) throw badRequest("Fix or skip these sections first", { blocking: preview.blocking });
    if (preview.dncWarning && !body.confirmDncWarning) {
      throw badRequest("The do-not-call block no longer ends the call on a do-not-call request. Confirm to save it anyway.");
    }
    const counts = { ...preview.summary, changedBlocks: preview.changedBlocks };
    if (!preview.changed) {
      logger.info({ flowId: id, by: req.user!.email, ...counts }, "call flow prompt import: no changes");
      res.json({ changed: false, version: null, summary: preview.summary, changedBlocks: [], undo: null } satisfies CallFlowImportResult);
      return;
    }
    const check = await previewFlow(next).catch(voiceError);
    if (!check.valid) throw badRequest("The voice backend rejected this flow", { errors: check.errors });
    const saved = await saveDraft(id, next, req.user!.email).catch(flowError);
    // Never the prompt text: who, which flow and the counts only.
    logger.info({ flowId: id, version: saved.version, by: req.user!.email, ...counts }, "call flow prompt imported");
    res.json({
      changed: true,
      version: saved.version,
      summary: preview.summary,
      changedBlocks: preview.changedBlocks,
      // Live version next to it: Undo discards the new draft. Never published: Undo saves the old text back.
      undo: base.published ? { kind: "discard" } : { kind: "restore", definition: base.working },
    } satisfies CallFlowImportResult);
  }),
);

callFlowsRouter.post(
  "/:id/archive",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await liveFlow(id);
    await prisma.callFlow.update({ where: { id }, data: { archivedAt: new Date() } });
    logger.info({ flowId: id, by: req.user!.email }, "call flow archived");
    res.json({ ok: true });
  }),
);

callFlowsRouter.delete(
  "/:id",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    if ((CALL_FLOW_BASES as readonly string[]).includes(id)) throw forbidden("Built-in scripts can't be removed");
    // A live flow needs { confirm: "DELETE" } (the UI's type-to-confirm box).
    const { confirm } = removeFlowBody.parse(req.body ?? {});
    const result = await removeFlow(id, { confirm }).catch(flowError);
    logger.info({ flowId: id, result, byUserId: req.user!.id }, "call flow removed");
    res.json({ ok: true, result });
  }),
);

callFlowsRouter.post(
  "/:id/test-call",
  testCallHourlyLimiter,
  testCallLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = testCallFlowInput.parse(req.body);
    if (!isAiCallsConfigured()) {
      throw new AppError(503, "Voice backend is not configured — set VOICE_BACKEND_URL and VOICE_BACKEND_API_KEY", "unavailable");
    }
    const phone = await resolveTestNumber(body.numberId);
    if (!phone) throw badRequest("Test calls can only go to a saved trial number — pick one from the list");
    await liveFlow(id);
    const version = await prisma.callFlowVersion.findUnique({ where: { flowId_version: { flowId: id, version: body.version } } });
    if (!version) throw notFound("Version");
    const definition: CallFlowDefinition | null = callFlowDefinition.safeParse(version.definition).data ?? null;
    if (!definition) throw badRequest("This version is not valid — fix and save it first");
    const check = await previewFlow(definition).catch(voiceError);
    if (!check.valid) throw badRequest("The voice backend rejected this flow", { errors: check.errors });

    if ((await loadDoNotCallPhones(aiCallsConfig.defaultCountryCode)).has(phone)) {
      throw conflict("That number is on the do-not-call list");
    }
    if (await prisma.aiCallRun.findFirst({ where: { status: "RUNNING" }, select: { id: true } })) {
      throw conflict("Another AI call run is still in progress — wait for it to finish or cancel it first");
    }
    if ((await callsCountedTowardDailyCap()) + 1 > aiCallsConfig.dailyCap) {
      throw new AppError(429, `Daily AI call limit reached (${aiCallsConfig.dailyCap} in 24 hours)`, "rate_limited");
    }

    const run = await prisma.aiCallRun.create({
      data: {
        mode: "SELECTED",
        gapSeconds: aiCallsConfig.minGapSec,
        maxCalls: 1,
        total: 1,
        createdById: req.user!.id,
        createdByEmail: req.user!.email,
        // Same greeting timing as a real run started with the default "AI Greeting Delay".
        skipped: { invalid: 0, duplicates: 0, doNotCall: 0, capped: 0, testCall: true, greetingDelaySec: AI_CALL_DEFAULT_GREETING_DELAY_SEC },
        flow: { create: { flowVersionId: version.id } },
        logs: {
          create: {
            position: 0,
            customerName: body.customerName || null,
            gender: normalizeAiCallGender(body.gender),
            followUpDetail: body.followUpDetail || null,
            phone,
          },
        },
      },
    });
    await enqueueAiCallRun({ runId: run.id });
    logger.info(
      { runId: run.id, flowId: id, version: version.version, draft: version.status === "DRAFT", phone: maskPhone(phone), by: req.user!.email },
      "call flow test call started",
    );
    res.status(201).json({ runId: run.id });
  }),
);
