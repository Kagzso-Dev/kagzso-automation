// Call Flows editor ("Voice Call Flows" page). Reads: ADMIN and EDITOR (the AI Call window's
// flow picker). Changes (create, save, publish, archive, remove, trial numbers): ADMIN only.
// 404 unless both ENABLE_AI_CALLS and ENABLE_CALL_FLOW_EDITOR are on.
//
// Every flow belongs to one language (set when it is created, never changed) and is validated,
// previewed and test-called by that language's voice backend. ?language= on the two list
// endpoints picks the language page (absent = English, exactly as before).
//
//   GET    /api/call-flows/builtin                   built-in flows to copy + locked block text (from the voice backend)
//   GET    /api/call-flows                           flows with their latest published / draft version
//   POST   /api/call-flows                           new flow, draft v1 copied from a built-in (body language, default en)
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
//
// Training tab (admin only). Training lives in the definition (`training`), so it is saved, published,
// restored and imported with the flow; a save that carries training is checked by the voice backend first.
//   POST   /api/call-flows/:id/training/test         one customer message, one enabled LLM: reply without vs with training
//   GET    /api/call-flows/training/calls/:logId     a call's Agent turns (personal details removed) and its flow
//   POST   /api/call-flows/training/calls/:logId     save one turn + the better reply into that flow's training as a Draft
//   POST   /api/call-flows/:id/copy                  a new flow (Draft v1) from this flow's newest version, training kept or not
// Training is admin-only: for editors, GET responses leave `training` out of every definition.

import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  addTestCallNumberInput,
  AI_CALL_DEFAULT_GREETING_DELAY_SEC,
  AI_CALL_LANGUAGE_NAMES,
  autonomousCallBlockedReason,
  aiCallLanguageQuery,
  DEFAULT_AI_CALL_LANGUAGE,
  isAiCallLanguage,
  type AiCallLanguage,
  CALL_FLOW_BASES,
  CALL_FLOW_IMPORT_WARN_CHARS,
  callFlowDefinition,
  callFlowImportApplyInput,
  callFlowImportInput,
  callFlowVersionParam,
  copyCallFlowInput,
  createCallFlowInput,
  idParam,
  maskPhone,
  materializeUnlockedBlocks,
  normalizeAiCallGender,
  previewCallFlowInput,
  saveCallFlowDraftInput,
  testCallFlowInput,
  trainingFromCallInput,
  trainingTestInput,
  type CallFlowDefinition,
  type CallFlowImportPreview,
  type CallFlowImportResult,
  type TrainingCallTurns,
} from "@dispatch/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.js";
import { logger } from "../../logger.js";
import { aiCallsConfig, configuredAiCallLanguages, isAiCallsConfigured, isCallFlowEditorEnabled } from "../../config/aiCalls.js";
import { callsCountedTowardDailyCap, loadDoNotCallPhones } from "../../domain/aiCalls.js";
import { aiCallLanguageBlockedReason, asAiCallLanguage, runInProgressReason } from "../../domain/aiCallLanguages.js";
import {
  CallFlowError,
  definitionHash,
  deleteVersion,
  latestPublished,
  publishDraft,
  removeFlow,
  saveDraft,
  schemaIssues,
} from "../../domain/callFlows.js";
import { managingAgent } from "../../domain/aiAgents.js";
import { analyzeImport, changedBlockIds } from "../../domain/callFlowImport.js";
import {
  agentSummary,
  copyDefinition,
  correctionFromTurn,
  transcriptTurns,
  withExample,
  withoutTraining,
} from "../../domain/callFlowTraining.js";
import { addTestNumber, listTestNumbers, removeTestNumber, resolveTestNumber, TestNumberError } from "../../domain/callFlowTestNumbers.js";
import { enqueueAiCallRun } from "../../queue/queues.js";
import {
  getBuiltinFlows,
  previewFlow,
  trainingTestReply,
  voiceCallsBlockedReason,
  VoiceBackendError,
  type VoiceFlowCatalog,
} from "../../services/voiceBackend.js";
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
/** Training test replies spend provider tokens (two requests each). */
const trainingTestLimiter = limiter(5);
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
export function voiceError(err: unknown): never {
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

/**
 * Optional flow settings a voice backend sends as null when unset (a Python Optional = None). Dispatch's flow
 * schema treats an unset setting as absent and refuses null, so a built-in is read without them.
 */
const OPTIONAL_FLOW_SETTINGS = ["language_style", "autonomous", "pauses", "recording_notice", "identity", "training"] as const;

/** A built-in flow as Dispatch's schema expects it: unset (null) optional settings left out; real values kept. */
export function withoutNullOptionalSettings(flow: Record<string, unknown>): Record<string, unknown> {
  const out = { ...flow };
  for (const key of OPTIONAL_FLOW_SETTINGS) if (out[key] === null) delete out[key];
  return out;
}

const builtinCache = new Map<AiCallLanguage, { at: number; data: VoiceFlowCatalog }>();
/**
 * The language's built-in flows, from its own voice backend (cached a minute per language), with unset optional
 * settings left out (withoutNullOptionalSettings) - for AI Agents, "New flow" and the editor alike.
 */
export async function builtins(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): Promise<VoiceFlowCatalog> {
  const hit = builtinCache.get(language);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const data = await getBuiltinFlows(language).catch(voiceError);
  // A backend from before languages has no "language" field: it is the English one.
  const speaks = data.language ?? DEFAULT_AI_CALL_LANGUAGE;
  if (speaks !== language) {
    throw new AppError(
      502,
      `The ${AI_CALL_LANGUAGE_NAMES[language]} voice backend calls in '${speaks}' (its CALL_LANGUAGE). ` +
        `Fix VOICE_BACKEND_URL${language === DEFAULT_AI_CALL_LANGUAGE ? "" : `_${language.toUpperCase()}`} or that backend's CALL_LANGUAGE.`,
      "unavailable",
    );
  }
  const flows = Object.fromEntries(
    Object.entries(data.flows ?? {}).map(([base, flow]) => [base, flow && typeof flow === "object" ? withoutNullOptionalSettings(flow) : flow]),
  );
  const catalog: VoiceFlowCatalog = { ...data, flows };
  builtinCache.set(language, { at: Date.now(), data: catalog });
  return catalog;
}

/** The language a definition is for (a definition that isn't valid yet is English). */
const definitionLanguage = (d: unknown): AiCallLanguage => {
  const l = (d as { language?: unknown } | null)?.language;
  return isAiCallLanguage(l) ? l : DEFAULT_AI_CALL_LANGUAGE;
};

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

const isAdmin = (req: Request) => req.user?.role === "ADMIN";

async function liveFlow(id: string) {
  const flow = await prisma.callFlow.findUnique({ where: { id } });
  if (!flow || flow.archivedAt) throw notFound("Call flow");
  return flow;
}

/**
 * A flow generated by an AI Agent changes only when that agent is published (AI Agents): a hand edit here
 * would be replaced by the agent's next publish. Every route that changes a flow refuses it; viewing,
 * preview, test calls and Copy (a copy is an ordinary flow, free to edit) still work. An archived agent
 * no longer manages its flow.
 */
async function refuseAgentManaged(flowId: string): Promise<void> {
  const agent = await managingAgent(flowId);
  if (agent) {
    throw conflict(
      `This flow is generated by the AI Agent "${agent.name}" and only changes when that agent is published. ` +
        "Edit the agent in AI Agents instead, or Copy this flow to edit a copy by hand.",
    );
  }
}

/** liveFlow for a route that changes the flow: never an AI Agent's generated flow. */
async function editableFlow(id: string) {
  const flow = await liveFlow(id);
  await refuseAgentManaged(id);
  return flow;
}

callFlowsRouter.get(
  "/builtin",
  wrap(async (req, res) => {
    const { language } = aiCallLanguageQuery.parse(req.query);
    res.json(await builtins(language));
  }),
);

callFlowsRouter.get(
  "/",
  wrap(async (req, res) => {
    const { language } = aiCallLanguageQuery.parse(req.query);
    const flows = await prisma.callFlow.findMany({
      where: { archivedAt: null, language },
      orderBy: { updatedAt: "desc" },
      include: {
        versions: {
          orderBy: { version: "desc" },
          select: { id: true, version: true, status: true, publishedAt: true, updatedAt: true },
        },
      },
    });
    // The live version's agent profile (Simple AI Call shows who calls and why) - never the rest of the training.
    // Best effort: the list never fails because of it (no summary = the flow shows without one).
    const liveIds = flows.flatMap((f) => f.versions.find((v) => v.status === "PUBLISHED")?.id ?? []);
    let live: { id: string; definition: Prisma.JsonValue }[] = [];
    try {
      if (liveIds.length) {
        live = await prisma.callFlowVersion.findMany({ where: { id: { in: liveIds } }, select: { id: true, definition: true } });
      }
    } catch (err) {
      logger.warn({ err }, "call flow list: agent profiles not loaded");
    }
    const agents = new Map(live.map((v) => [v.id, agentSummary(v.definition)]));
    // Flows generated by an AI Agent (read-only here). Best effort, as above.
    const managed = new Map<string, { agentId: string; agentName: string }>();
    try {
      if (flows.length) {
        const rows = await prisma.aiAgent.findMany({
          where: { callFlowId: { in: flows.map((f) => f.id) }, archivedAt: null },
          select: { id: true, name: true, callFlowId: true },
        });
        for (const r of rows) if (r.callFlowId) managed.set(r.callFlowId, { agentId: r.id, agentName: r.name });
      }
    } catch (err) {
      logger.warn({ err }, "call flow list: AI agent links not loaded");
    }
    res.json({
      items: flows.map(({ versions, ...f }) => {
        const published = versions.find((v) => v.status === "PUBLISHED") ?? null;
        return {
          ...f,
          published,
          draft: versions.find((v) => v.status === "DRAFT") ?? null,
          versionCount: versions.length,
          agent: published ? (agents.get(published.id) ?? null) : null,
          managedBy: managed.get(f.id) ?? null,
        };
      }),
    });
  }),
);

callFlowsRouter.post(
  "/",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const body = createCallFlowInput.parse(req.body);
    const catalog = await builtins(body.language);
    if (!catalog.flows[body.base]) {
      throw new AppError(502, `This language's voice backend has no '${body.base}' script yet — update that voice backend first`, "unavailable");
    }
    const parsed = callFlowDefinition.safeParse({ ...catalog.flows[body.base], name: body.name, language: body.language });
    if (!parsed.success) {
      throw new AppError(502, `The voice backend's built-in flow failed validation (${schemaIssues(parsed.error)})`, "unavailable");
    }
    const definition = parsed.data;
    const flow = await prisma.callFlow.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        base: body.base,
        language: body.language,
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
    logger.info({ flowId: flow.id, base: body.base, language: body.language, by: req.user!.email }, "call flow created");
    res.status(201).json(flow);
  }),
);

callFlowsRouter.post(
  "/preview",
  previewLimiter,
  wrap(async (req, res) => {
    const body = previewCallFlowInput.parse(req.body);
    if (!isAdmin(req)) {
      // Training is admin-only: an editor's preview never compiles training.
      if (body.trainingMessage) throw forbidden("Training is for admins");
      body.definition = withoutTraining(body.definition);
    }
    // Rendered by the voice backend of the flow's own language.
    res.json(
      await previewFlow(body.definition, body.sample, definitionLanguage(body.definition), body.trainingMessage).catch(voiceError),
    );
  }),
);

/**
 * A definition that carries training is checked by its voice backend before it is saved: the content
 * rules (personal data, override / false-promise wording) and the token cap live there. Each problem
 * names the entry, e.g. "training.phrases.3.text: … contains a phone number". Without training: no check
 * (saving works exactly as before).
 */
async function checkTraining(definition: CallFlowDefinition, language: AiCallLanguage): Promise<void> {
  if (!definition.training) return;
  const check = await previewFlow(definition, {}, language).catch(voiceError);
  if (!check.valid) throw badRequest("Fix the training entries first", { errors: check.errors });
}

/** The call a transcript turn comes from, with the flow version it used (admins pick it in the call detail). */
async function callForTraining(logId: string) {
  const log = await prisma.aiCallLog.findUnique({
    where: { id: logId },
    select: {
      transcript: true,
      customerName: true,
      followUpDetail: true,
      run: { select: { flow: { select: { flowVersion: { select: { version: true, flowId: true, flow: true } } } } } },
    },
  });
  if (!log) throw notFound("Call");
  const used = log.run.flow?.flowVersion;
  if (!used) throw badRequest("This call didn't use a call flow, so there is no flow to train");
  if (used.flow.archivedAt) throw notFound("Call flow");
  const turns = transcriptTurns(log.transcript, { name: log.customerName, detail: log.followUpDetail });
  return { log, flow: used.flow, version: used.version, turns };
}

callFlowsRouter.get(
  "/training/calls/:logId",
  adminOnly,
  wrap(async (req, res) => {
    const { flow, version, turns } = await callForTraining(String(req.params.logId ?? ""));
    res.json({ flowId: flow.id, flowName: flow.name, version, turns } satisfies TrainingCallTurns);
  }),
);

callFlowsRouter.post(
  "/training/calls/:logId",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const logId = String(req.params.logId ?? "");
    const body = trainingFromCallInput.parse(req.body);
    const { flow, turns } = await callForTraining(logId);
    await refuseAgentManaged(flow.id);
    const turn = turns.find((t) => t.turn === body.turn);
    if (!turn) throw badRequest("Pick an Agent turn of this call");
    const language = asAiCallLanguage(flow.language);
    // Into the open draft, else a new draft from the newest version (a published version is never changed).
    const working = await prisma.callFlowVersion.findFirst({ where: { flowId: flow.id }, orderBy: { version: "desc" } });
    const parsed = callFlowDefinition.safeParse(working?.definition);
    if (!parsed.success) throw badRequest("The flow's current version is not valid — fix and save it first");
    const example = correctionFromTurn(turn, body.better, body.reason, { situation: body.situation, topic: body.topic, style: body.style });
    const next = callFlowDefinition.safeParse(withExample(parsed.data, example));
    if (!next.success) throw badRequest("The training is full or the correction is not valid", next.error.flatten());
    await checkTraining(next.data, language);
    const draft = await saveDraft(flow.id, next.data, req.user!.email).catch(flowError);
    // Never the transcript or the reply: who, which call and flow, and where it went.
    logger.info({ flowId: flow.id, version: draft.version, logId, entryId: example.id, by: req.user!.email }, "call flow training: correction from a call");
    res.status(201).json({ flowId: flow.id, version: draft.version, entryId: example.id });
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
    const agent = await managingAgent(id).catch((err) => {
      logger.warn({ err, flowId: id }, "call flow: AI agent link not loaded");
      return null;
    });
    const managedBy = agent ? { agentId: agent.id, agentName: agent.name } : null;
    if (isAdmin(req)) {
      res.json({ ...flow, managedBy });
      return;
    }
    res.json({ ...flow, managedBy, versions: flow.versions.map((v) => ({ ...v, definition: withoutTraining(v.definition) })) });
  }),
);

callFlowsRouter.put(
  "/:id/draft",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = saveCallFlowDraftInput.parse(req.body);
    const flow = await editableFlow(id);
    if (body.definition.base !== flow.base) throw badRequest(`This flow is based on '${flow.base}'; base can't change`);
    if (body.definition.language !== asAiCallLanguage(flow.language)) {
      throw badRequest(`This is a ${AI_CALL_LANGUAGE_NAMES[asAiCallLanguage(flow.language)]} flow; its language can't change`);
    }
    if (body.description !== undefined) {
      await prisma.callFlow.update({ where: { id }, data: { description: body.description } });
    }
    await checkTraining(body.definition, asAiCallLanguage(flow.language));
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
    await editableFlow(id);
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
    const flow = await editableFlow(id);
    const draft = await prisma.callFlowVersion.findFirst({ where: { flowId: id, status: "DRAFT" } });
    if (!draft) throw conflict("Nothing to publish — save a draft first");
    const local = callFlowDefinition.safeParse(draft.definition);
    if (!local.success) throw badRequest("The draft is not valid", local.error.flatten());
    const check = await previewFlow(local.data, {}, asAiCallLanguage(flow.language)).catch(voiceError);
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
    const flow = await editableFlow(id);
    const old = await prisma.callFlowVersion.findUnique({ where: { flowId_version: { flowId: id, version } } });
    if (!old) throw notFound("Version");
    const parsed = callFlowDefinition.safeParse(old.definition);
    if (!parsed.success) throw badRequest("That version no longer passes validation and can't be restored");
    await checkTraining(parsed.data, asAiCallLanguage(flow.language));
    res.json(await saveDraft(id, parsed.data, req.user!.email).catch(flowError));
  }),
);

callFlowsRouter.delete(
  "/:id/versions/:version",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id, version } = callFlowVersionParam.parse(req.params);
    await refuseAgentManaged(id);
    await deleteVersion(id, version).catch(flowError);
    logger.info({ flowId: id, version, by: req.user!.email }, "call flow version deleted");
    res.json({ ok: true });
  }),
);

/** "Large prompt" warning for an import; CALL_FLOW_IMPORT_WARN_CHARS overrides the default. */
const importWarnChars = () => Number(process.env.CALL_FLOW_IMPORT_WARN_CHARS) || CALL_FLOW_IMPORT_WARN_CHARS;

/** What an import works on: the newest version (draft, else live), with the unlocked safety blocks as text. */
async function importBase(id: string) {
  const flow = await liveFlow(id);
  const language = asAiCallLanguage(flow.language);
  const versions = await prisma.callFlowVersion.findMany({ where: { flowId: id }, orderBy: { version: "desc" } });
  const draft = versions.find((v) => v.status === "DRAFT") ?? null;
  const published = versions.find((v) => v.status === "PUBLISHED") ?? null;
  const working = draft ?? published;
  if (!working) throw notFound("Version");
  const parsed = callFlowDefinition.safeParse(working.definition);
  if (!parsed.success) throw badRequest("The current version is not valid — fix and save it first");
  const catalog = await builtins(language);
  return {
    language,
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
    await refuseAgentManaged(id);
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
    const check = await previewFlow(next, {}, base.language).catch(voiceError);
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
  "/:id/training/test",
  adminOnly,
  trainingTestLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = trainingTestInput.parse(req.body);
    const language = asAiCallLanguage((await liveFlow(id)).language);
    if (definitionLanguage(body.definition) !== language) throw badRequest("The definition is not this flow's language");
    // Mock (default): nothing is sent to a provider. Real: confirmCost was required by the schema above.
    const result = await trainingTestReply(body.definition, body.mode, body.providerId ?? null, body.message, language).catch((err: unknown) => {
      // The backend's own refusals (provider not switched on, nothing Active, invalid flow) are the admin's to fix.
      if (err instanceof VoiceBackendError && (err.status === 400 || err.status === 422)) throw badRequest(err.message);
      return voiceError(err);
    });
    // Never the message or the replies (the customer message may be anything the admin typed).
    logger.info({ flowId: id, mode: body.mode, providerId: body.providerId ?? null, by: req.user!.email }, "call flow training: test reply");
    res.json(result);
  }),
);

callFlowsRouter.post(
  "/:id/copy",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = copyCallFlowInput.parse(req.body);
    const source = await liveFlow(id);
    const language = asAiCallLanguage(source.language);
    // The newest version (the open draft, else the live one): what the admin sees in the editor.
    const working = await prisma.callFlowVersion.findFirst({ where: { flowId: id }, orderBy: { version: "desc" } });
    if (!working) throw notFound("Version");
    const parsed = callFlowDefinition.safeParse(working.definition);
    if (!parsed.success) throw badRequest("This flow's current version is not valid — fix and save it first");
    const definition = copyDefinition(parsed.data, body.name, body.includeTraining);
    const check = await previewFlow(definition, {}, language).catch(voiceError);
    if (!check.valid) throw badRequest("The voice backend rejected the copy", { errors: check.errors });
    const flow = await prisma.callFlow.create({
      data: {
        name: body.name,
        description: source.description,
        base: source.base,
        language: source.language,
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
    logger.info(
      { flowId: flow.id, from: id, fromVersion: working.version, training: !!definition.training, by: req.user!.email },
      "call flow copied",
    );
    res.status(201).json(flow);
  }),
);

callFlowsRouter.post(
  "/:id/archive",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await editableFlow(id);
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
    await refuseAgentManaged(id);
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
    if (configuredAiCallLanguages().every((l) => !isAiCallsConfigured(l))) {
      throw new AppError(503, "Voice backend is not configured — set VOICE_BACKEND_URL and VOICE_BACKEND_API_KEY", "unavailable");
    }
    const phone = await resolveTestNumber(body.numberId);
    if (!phone) throw badRequest("Test calls can only go to a saved trial number — pick one from the list");
    // The flow's language decides which voice backend dials (and it must be set up and switched on).
    const language = asAiCallLanguage((await liveFlow(id)).language);
    const unavailable = await aiCallLanguageBlockedReason(language);
    if (unavailable) throw new AppError(503, unavailable, "unavailable");
    const version = await prisma.callFlowVersion.findUnique({ where: { flowId_version: { flowId: id, version: body.version } } });
    if (!version) throw notFound("Version");
    const definition: CallFlowDefinition | null = callFlowDefinition.safeParse(version.definition).data ?? null;
    if (!definition) throw badRequest("This version is not valid — fix and save it first");
    const paused = autonomousCallBlockedReason(language, definition);
    if (paused) throw conflict(paused);
    const check = await previewFlow(definition, {}, language).catch(voiceError);
    if (!check.valid) throw badRequest("The voice backend rejected this flow", { errors: check.errors });

    if ((await loadDoNotCallPhones(aiCallsConfig.defaultCountryCode)).has(phone)) {
      throw conflict("That number is on the do-not-call list");
    }
    // One run at a time, one language at a time (the test call is a one-call run of the flow's language).
    const inProgress = await runInProgressReason(language);
    if (inProgress) throw conflict(inProgress);
    // Plivo / Twilio can't reach the voice backend (e.g. ngrok stopped): the test call would ring, then go silent.
    const blocked = await voiceCallsBlockedReason(language);
    if (blocked) throw new AppError(503, blocked, "voice_unreachable");
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
      { runId: run.id, flowId: id, version: version.version, draft: version.status === "DRAFT", language, phone: maskPhone(phone), by: req.user!.email },
      "call flow test call started",
    );
    res.status(201).json({ runId: run.id });
  }),
);
