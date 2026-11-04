// AI Agents (packages/shared/src/aiAgents.ts). Admins configure and publish; admins and editors may call.
//
//   GET    /api/ai-agents/library                          category / industry library (shared by every language)
//   POST   /api/ai-agents/library/categories               admin
//   PATCH  /api/ai-agents/library/categories/:id           admin { name?, archived? }
//   POST   /api/ai-agents/library/industries               admin
//   PATCH  /api/ai-agents/library/industries/:id           admin { name?, discoveryTopics?, archived? }
//   GET    /api/ai-agents?language=ta                      the language's agents
//   POST   /api/ai-agents                                  admin { language, agent }
//   GET    /api/ai-agents/:id
//   PUT    /api/ai-agents/:id                              admin { agent } (language never changes)
//   DELETE /api/ai-agents/:id                              admin: hidden; its generated flow and call history stay
//   GET    /api/ai-agents/:id/knowledge                    files + items
//   POST   /api/ai-agents/:id/knowledge/files              admin, multipart "files" (1-10), optional replacesFileId
//   DELETE /api/ai-agents/:id/knowledge/files/:fileId      admin
//   POST   /api/ai-agents/:id/knowledge/items              admin: add one item by hand (Draft)
//   PATCH  /api/ai-agents/:id/knowledge/items/:itemId      admin: edit (an approved item goes back to Draft)
//   DELETE /api/ai-agents/:id/knowledge/items/:itemId      admin
//   POST   /api/ai-agents/:id/knowledge/decide             admin { ids, status: approved | rejected | draft }
//   POST   /api/ai-agents/:id/preview                      admin: compile + render by the language's voice backend (no LLM)
//   POST   /api/ai-agents/:id/knowledge-test               admin: which approved notes a customer message picks (mock, no LLM)
//   POST   /api/ai-agents/:id/publish                      admin: compile → draft → voice backend check → publish
//   POST   /api/ai-agents/:id/call                         admin / editor: one call (dry run first), the normal AI call run

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  AI_KNOWLEDGE_MAX_FILES_PER_UPLOAD,
  AI_KNOWLEDGE_MAX_FILE_BYTES,
  aiAgentCallInput,
  aiAgentInput,
  aiCallLanguage,
  aiCallLanguageQuery,
  aiCategoryInput,
  aiIndustryInput,
  aiKnowledgeDecision,
  aiKnowledgeItemUpdate,
  createAiAgentInput,
  idParam,
  knowledgeFormatFromFilename,
  startAiCallsInput,
} from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { logger } from "../../logger.js";
import { aiCallsConfig, isCallFlowEditorEnabled } from "../../config/aiCalls.js";
import {
  AiAgentError,
  addKnowledgeFile,
  addKnowledgeItem,
  archiveAgent,
  callFlowIdFor,
  compileAgent,
  createAgent,
  decideKnowledge,
  deleteKnowledgeFile,
  deleteKnowledgeItem,
  getAgent,
  getAgentRow,
  listAgents,
  listKnowledge,
  discardAgentDraft,
  markPublished,
  openDraftOf,
  saveAgentDraft,
  updateAgent,
  updateKnowledgeItem,
} from "../../domain/aiAgents.js";
import { AgentCompileError } from "../../domain/aiAgentCompile.js";
import { extractKnowledge } from "../../domain/aiAgentKnowledge.js";
import { AiIndustryError, createCategory, createIndustry, listLibrary, updateCategory, updateIndustry } from "../../domain/aiIndustries.js";
import { CallFlowError, publishDraft } from "../../domain/callFlows.js";
import { previewFlow, trainingTestReply } from "../../services/voiceBackend.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, wrap } from "../errors.js";
import { builtins, voiceError } from "./callFlows.js";
import { planAndStartAiCallRun } from "./aiCalls.js";

export const aiAgentsRouter = Router();
aiAgentsRouter.use(authRequired);

function featureGate(_req: Request, _res: Response, next: NextFunction) {
  if (!aiCallsConfig.enabled || !isCallFlowEditorEnabled()) {
    return next(new AppError(404, "AI agents need AI calls and call flows (ENABLE_AI_CALLS, ENABLE_CALL_FLOW_EDITOR)", "not_found"));
  }
  next();
}
aiAgentsRouter.use(featureGate, requireRole("ADMIN", "EDITOR"));
const adminOnly = requireRole("ADMIN");

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many AI agent requests — wait a minute and try again.", code: "rate_limited" },
  });
const writeLimiter = limiter(60);
const uploadLimiter = limiter(20);
const previewLimiter = limiter(60);
const callLimiter = limiter(10);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AI_KNOWLEDGE_MAX_FILE_BYTES, files: AI_KNOWLEDGE_MAX_FILES_PER_UPLOAD },
});
/** The upload middleware, with multer's limit errors as a readable 400 (not an "Internal server error"). */
function uploadFiles(req: Request, res: Response, next: NextFunction) {
  upload.array("files", AI_KNOWLEDGE_MAX_FILES_PER_UPLOAD)(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      const mb = Math.round(AI_KNOWLEDGE_MAX_FILE_BYTES / (1024 * 1024));
      return next(
        badRequest(
          err.code === "LIMIT_FILE_SIZE"
            ? `Each file must be ${mb} MB or smaller`
            : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
              ? `At most ${AI_KNOWLEDGE_MAX_FILES_PER_UPLOAD} files per upload, in the field "files"`
              : err.message,
        ),
      );
    }
    next(err as Error | undefined);
  });
}

function domainError(err: unknown): never {
  if (err instanceof AiAgentError || err instanceof AiIndustryError || err instanceof CallFlowError) {
    const code = err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : "bad_request";
    throw new AppError(err.status, err.message, code);
  }
  if (err instanceof AgentCompileError) throw new AppError(400, err.message, "bad_request");
  throw err;
}
const guard = <T>(p: Promise<T>) => p.catch(domainError);

const agentParam = z.object({ id: z.string().min(1).max(64) });
const fileParam = agentParam.extend({ fileId: z.string().min(1).max(64) });
const itemParam = agentParam.extend({ itemId: z.string().min(1).max(64) });
const archivedPatch = z.object({ archived: z.boolean().optional() });
const publishBody = z.object({ replaceDraft: z.boolean().optional() });

/* ------------------------------------------------------------------ library */
aiAgentsRouter.get(
  "/library",
  wrap(async (req, res) => {
    res.json(await listLibrary(req.query.archived === "true" && req.user?.role === "ADMIN"));
  }),
);
aiAgentsRouter.post(
  "/library/categories",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const body = aiCategoryInput.parse(req.body);
    res.status(201).json(await guard(createCategory(body.name)));
  }),
);
aiAgentsRouter.patch(
  "/library/categories/:id",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = aiCategoryInput.partial().merge(archivedPatch).strict().parse(req.body);
    res.json(await guard(updateCategory(id, body)));
  }),
);
aiAgentsRouter.post(
  "/library/industries",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const body = aiIndustryInput.parse(req.body);
    res.status(201).json(await guard(createIndustry(body)));
  }),
);
aiAgentsRouter.patch(
  "/library/industries/:id",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = aiIndustryInput.omit({ categoryId: true }).partial().merge(archivedPatch).strict().parse(req.body);
    res.json(await guard(updateIndustry(id, body)));
  }),
);

/* ------------------------------------------------------------------ agents */
aiAgentsRouter.get(
  "/",
  wrap(async (req, res) => {
    const { language } = aiCallLanguageQuery.parse(req.query);
    res.json(await listAgents(language));
  }),
);

aiAgentsRouter.post(
  "/",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const body = createAiAgentInput.parse(req.body);
    const agent = await guard(createAgent(body.language, body.agent, req.user!));
    logger.info({ agentId: agent.id, language: body.language, mode: agent.mode, by: req.user!.email }, "ai agent created");
    res.status(201).json(agent);
  }),
);

aiAgentsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    res.json(await guard(getAgent(id)));
  }),
);

aiAgentsRouter.put(
  "/:id",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    const body = z.object({ agent: aiAgentInput }).strict().parse(req.body);
    res.json(await guard(updateAgent(id, body.agent)));
  }),
);

aiAgentsRouter.delete(
  "/:id",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    await guard(archiveAgent(id));
    logger.info({ agentId: id, by: req.user!.email }, "ai agent archived");
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ knowledge */
aiAgentsRouter.get(
  "/:id/knowledge",
  adminOnly, // like a Call Flow's training, an agent's knowledge is admin-only (editors only see the counts)
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    res.json(await guard(listKnowledge(id)));
  }),
);

aiAgentsRouter.post(
  "/:id/knowledge/files",
  adminOnly,
  uploadLimiter,
  uploadFiles,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw badRequest("Add at least one file (multipart field 'files')");
    const replacesFileId = z.string().min(1).max(64).optional().parse(req.body?.replacesFileId || undefined);
    if (replacesFileId && files.length !== 1) throw badRequest("Replace one file at a time");
    const agent = await guard(getAgentRow(id));
    const industry = agent.industryId ? await prisma.aiIndustry.findUnique({ where: { id: agent.industryId } }) : null;
    const results = [];
    for (const f of files) {
      const format = knowledgeFormatFromFilename(f.originalname);
      if (!format) {
        results.push({ fileName: f.originalname, error: "Unsupported file type — use CSV, XLSX, PDF, DOCX or TXT" });
        continue;
      }
      let outcome: Parameters<typeof addKnowledgeFile>[2];
      try {
        outcome = { extraction: await extractKnowledge(f.buffer, format, f.originalname, industry?.name ?? null) };
      } catch (err) {
        outcome = { error: `Couldn't read the file: ${err instanceof Error ? err.message : String(err)}` };
      }
      const saved = await guard(addKnowledgeFile(id, { fileName: f.originalname, format, buffer: f.buffer }, outcome, req.user!.email, replacesFileId));
      results.push(saved);
    }
    logger.info({ agentId: id, files: files.length, replaced: !!replacesFileId, by: req.user!.email }, "ai agent knowledge uploaded");
    res.status(201).json({ files: results });
  }),
);

aiAgentsRouter.delete(
  "/:id/knowledge/files/:fileId",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id, fileId } = fileParam.parse(req.params);
    await guard(deleteKnowledgeFile(id, fileId));
    res.json({ ok: true });
  }),
);

const newItemInput = z
  .object({
    kind: z.enum(["fact", "qa"]).default("fact"),
    topic: z.string().trim().min(1).max(40),
    text: z.string().trim().min(1).max(500),
    questions: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
    always: z.boolean().default(false),
  })
  .strict();

aiAgentsRouter.post(
  "/:id/knowledge/items",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    res.status(201).json(await guard(addKnowledgeItem(id, newItemInput.parse(req.body))));
  }),
);

aiAgentsRouter.patch(
  "/:id/knowledge/items/:itemId",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id, itemId } = itemParam.parse(req.params);
    res.json(await guard(updateKnowledgeItem(id, itemId, aiKnowledgeItemUpdate.parse(req.body))));
  }),
);

aiAgentsRouter.delete(
  "/:id/knowledge/items/:itemId",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id, itemId } = itemParam.parse(req.params);
    await guard(deleteKnowledgeItem(id, itemId));
    res.json({ ok: true });
  }),
);

aiAgentsRouter.post(
  "/:id/knowledge/decide",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    const body = aiKnowledgeDecision.parse(req.body);
    const out = await guard(decideKnowledge(id, body.ids, body.status, req.user!.email));
    logger.info({ agentId: id, status: body.status, updated: out.updated, refused: out.refused.length, by: req.user!.email }, "ai agent knowledge decided");
    res.json(out);
  }),
);

/* ------------------------------------------------------------------ compile, preview, publish */
async function compiled(id: string) {
  const agent = await guard(getAgentRow(id));
  if (agent.mode !== "AUTONOMOUS") throw badRequest("A guided agent uses its Call Flow as it is: nothing to compile");
  const language = aiCallLanguage.parse(agent.language);
  const catalog = await builtins(language);
  const base = catalog.flows.executive;
  if (!base) throw new AppError(502, "This language's voice backend has no Business executive script yet — update it first", "unavailable");
  return { agent, language, definition: await guard(compileAgent(agent, base)) };
}

const previewInput = z
  .object({
    customerName: z.string().trim().max(100).optional(),
    gender: z.enum(["male", "female", "unspecified"]).optional(),
  })
  .strict();

aiAgentsRouter.post(
  "/:id/preview",
  adminOnly,
  previewLimiter,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    const body = previewInput.parse(req.body ?? {});
    const { agent, language, definition } = await compiled(id);
    const gender = body.gender ?? agent.contactGender;
    const sample = {
      customer_name: body.customerName ?? agent.contactName ?? null,
      gender: gender === "unspecified" ? "unknown" : gender,
    };
    const preview = await previewFlow(definition, sample, language).catch(voiceError);
    res.json({ definition, preview });
  }),
);

aiAgentsRouter.post(
  "/:id/knowledge-test",
  adminOnly,
  previewLimiter,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    const { message } = z.object({ message: z.string().trim().min(1).max(300) }).strict().parse(req.body);
    const { language, definition } = await compiled(id);
    // "mock": no LLM provider is asked; the voice backend shows which approved notes this message picks.
    res.json(await trainingTestReply(definition, "mock", null, message, language).catch(voiceError));
  }),
);

aiAgentsRouter.post(
  "/:id/publish",
  adminOnly,
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    const body = publishBody.parse(req.body ?? {});
    const { agent, language, definition } = await compiled(id);
    // The voice backend of the agent's language is the authority (script, training rules, token cap).
    const check = await previewFlow(definition, {}, language).catch(voiceError);
    if (!check.valid) throw badRequest("The voice backend rejected the compiled flow", { errors: check.errors });
    // Never replace a draft someone left on the generated flow without asking.
    const open = await openDraftOf(agent);
    if (open && !body.replaceDraft) {
      throw new AppError(
        409,
        `The agent's Call Flow has an unpublished draft (v${open.version}${open.createdByEmail ? `, saved by ${open.createdByEmail}` : ""}) ` +
          "that this publish would replace. Copy the flow in Voice Call Flows first to keep it, then publish again and confirm.",
        "draft_conflict",
        { draftConflict: { version: open.version, by: open.createdByEmail, updatedAt: open.updatedAt } },
      );
    }
    const { flowId, draftId } = await guard(saveAgentDraft(agent, definition, req.user!.email));
    const published = await guard(publishDraft(draftId)).catch(async (err) => {
      await discardAgentDraft(draftId).catch((e) => logger.warn({ err: e, agentId: id }, "ai agent: failed draft not removed"));
      throw err;
    });
    if (open) logger.info({ agentId: id, flowId, replacedDraft: open.version, by: req.user!.email }, "ai agent publish replaced an open draft");
    await markPublished(await getAgentRow(id));
    logger.info({ agentId: id, flowId, version: published.version, language, by: req.user!.email }, "ai agent published");
    res.json({ flowId, version: published.version, agent: await getAgent(id) });
  }),
);

/* ------------------------------------------------------------------ call */
aiAgentsRouter.post(
  "/:id/call",
  callLimiter,
  wrap(async (req, res) => {
    const { id } = agentParam.parse(req.params);
    const body = aiAgentCallInput.parse(req.body ?? {});
    const agent = await guard(getAgentRow(id));
    const flowId = await guard(callFlowIdFor(agent));
    const phone = body.phone ?? agent.contactPhone;
    if (!phone) throw badRequest("Enter the number to call (the agent has no contact number)");
    const gender = body.gender ?? (agent.contactGender as "male" | "female" | "unspecified");
    const language = aiCallLanguage.parse(agent.language);
    // The normal AI call run (do-not-call list, daily cap, one run at a time, voice backend reachability).
    const start = startAiCallsInput.parse({
      rows: [
        {
          phone,
          customerName: (body.customerName ?? agent.contactName ?? "").trim() || null,
          gender: gender === "unspecified" ? null : gender,
          followUpDetail: null,
        },
      ],
      mode: "all",
      gapSeconds: Math.max(30, aiCallsConfig.minGapSec),
      maxCalls: 1,
      flowId,
      language,
      dryRun: body.dryRun,
    });
    const out = await planAndStartAiCallRun(
      start,
      req.user!,
      undefined,
      gender === "unspecified" ? { neutralGenderRows: new Set([0]) } : undefined,
    );
    res.status(out.status).json(out.json);
  }),
);
