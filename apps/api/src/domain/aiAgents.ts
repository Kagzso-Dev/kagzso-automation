// AI Agents: storage, knowledge review and publishing (packages/shared/src/aiAgents.ts).
//
// Isolation: every read and write is scoped to one agent id (and an agent to one language). Knowledge items
// are only ever loaded with `agentId`, and only APPROVED items of that agent are compiled into that agent's
// own Call Flow; a run pins the flow version it started with, so a later edit never changes queued calls.

import { createHash } from "node:crypto";
import { Prisma, type AiAgent, type AiAgentKnowledgeItem } from "@prisma/client";
import {
  AI_KNOWLEDGE_MAX_APPROVED,
  aiCallLanguage,
  callFlowDefinition,
  type AiAgentConfig,
  type AiAgentView,
  type AiCallLanguage,
  type AiKnowledgeFileView,
  type AiKnowledgeItemView,
  type AiKnowledgeStatus,
  type CallFlowDefinition,
} from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { compileAgentFlow, type CompileKnowledgeItem } from "./aiAgentCompile.js";
import { itemIssues, type Extraction } from "./aiAgentKnowledge.js";
import { definitionHash, latestPublished } from "./callFlows.js";

export class AiAgentError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "AiAgentError";
  }
}

const STATUS_DB: Record<AiKnowledgeStatus, "DRAFT" | "APPROVED" | "REJECTED"> = { draft: "DRAFT", approved: "APPROVED", rejected: "REJECTED" };
const STATUS_VIEW = { DRAFT: "draft", APPROVED: "approved", REJECTED: "rejected" } as const;

/* ------------------------------------------------------------------ agents */
function configFromRow(a: AiAgent): AiAgentConfig {
  return {
    name: a.name,
    mode: a.mode === "GUIDED" ? "guided" : "autonomous",
    categoryId: a.categoryId,
    industryId: a.industryId,
    businessName: a.businessName,
    objective: a.objective ?? "",
    contactName: a.contactName,
    contactGender: (["male", "female", "unspecified"].includes(a.contactGender) ? a.contactGender : "male") as AiAgentConfig["contactGender"],
    contactPhone: a.contactPhone,
    executiveName: a.executiveName,
    companyName: a.companyName,
    callbackNumber: a.callbackNumber,
    personality: a.personality as AiAgentConfig["personality"],
    instructions: a.instructions ?? "",
    targetDurationSec: a.targetDurationSec,
    maxDurationSec: a.maxDurationSec,
    guidedFlowId: a.guidedFlowId,
  };
}

function rowData(c: AiAgentConfig) {
  return {
    name: c.name,
    mode: c.mode === "guided" ? ("GUIDED" as const) : ("AUTONOMOUS" as const),
    categoryId: c.categoryId ?? null,
    industryId: c.industryId ?? null,
    businessName: c.businessName,
    objective: c.objective || null,
    contactName: c.contactName || null,
    contactGender: c.contactGender,
    contactPhone: c.contactPhone || null,
    executiveName: c.executiveName,
    companyName: c.companyName,
    callbackNumber: c.callbackNumber || null,
    personality: c.personality,
    instructions: c.instructions || null,
    targetDurationSec: c.targetDurationSec,
    maxDurationSec: c.maxDurationSec,
    guidedFlowId: c.mode === "guided" ? (c.guidedFlowId ?? null) : null,
  };
}

/** The category / industry exist (not archived) and belong together; a guided flow is a published flow of the language. */
async function checkRefs(c: AiAgentConfig, language: AiCallLanguage): Promise<void> {
  if (c.industryId) {
    const ind = await prisma.aiIndustry.findUnique({ where: { id: c.industryId } });
    if (!ind || ind.archivedAt) throw new AiAgentError("Industry not found", 400);
    if (c.categoryId && ind.categoryId !== c.categoryId) throw new AiAgentError("The industry is not in that category", 400);
  }
  if (c.categoryId) {
    const cat = await prisma.aiBusinessCategory.findUnique({ where: { id: c.categoryId } });
    if (!cat || cat.archivedAt) throw new AiAgentError("Category not found", 400);
  }
  if (c.mode === "guided" && c.guidedFlowId) {
    const flow = await prisma.callFlow.findUnique({ where: { id: c.guidedFlowId } });
    if (!flow || flow.archivedAt || flow.language !== language) throw new AiAgentError("Pick a Call Flow of this language", 400);
    if (!(await latestPublished(flow.id))) throw new AiAgentError("That Call Flow has no published version yet", 400);
  }
}

export async function getAgentRow(id: string): Promise<AiAgent> {
  const a = await prisma.aiAgent.findUnique({ where: { id } });
  if (!a || a.archivedAt) throw new AiAgentError("AI agent not found", 404);
  return a;
}

async function view(a: AiAgent): Promise<AiAgentView> {
  const [counts, files] = await Promise.all([
    prisma.aiAgentKnowledgeItem.groupBy({ by: ["status"], where: { agentId: a.id }, _count: { _all: true } }),
    prisma.aiAgentKnowledgeFile.count({ where: { agentId: a.id, status: { not: "REPLACED" } } }),
  ]);
  const n = (s: "DRAFT" | "APPROVED" | "REJECTED") => counts.find((c) => c.status === s)?._count._all ?? 0;
  const flowId = a.mode === "GUIDED" ? a.guidedFlowId : a.callFlowId;
  const live = flowId ? await latestPublished(flowId) : null;
  let unpublished = false;
  if (a.mode === "AUTONOMOUS") {
    // Without calling the voice backend: the inputs a publish compiles from, against those of the last publish.
    unpublished = !a.publishedHash || a.publishedHash !== (await agentInputsHash(a));
  }
  return {
    ...configFromRow(a),
    id: a.id,
    language: aiCallLanguage.parse(a.language),
    callFlowId: flowId,
    liveVersion: live?.version ?? null,
    unpublishedChanges: unpublished,
    knowledge: { draft: n("DRAFT"), approved: n("APPROVED"), rejected: n("REJECTED"), files },
    createdByEmail: a.createdByEmail,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export async function listAgents(language: AiCallLanguage): Promise<AiAgentView[]> {
  const rows = await prisma.aiAgent.findMany({ where: { language, archivedAt: null }, orderBy: { updatedAt: "desc" } });
  return Promise.all(rows.map(view));
}

export async function getAgent(id: string): Promise<AiAgentView> {
  return view(await getAgentRow(id));
}

export async function createAgent(language: AiCallLanguage, c: AiAgentConfig, user: { id: string; email: string }): Promise<AiAgentView> {
  await checkRefs(c, language);
  const a = await prisma.aiAgent.create({ data: { ...rowData(c), language, createdById: user.id, createdByEmail: user.email } });
  return view(a);
}

export async function updateAgent(id: string, c: AiAgentConfig): Promise<AiAgentView> {
  const before = await getAgentRow(id);
  await checkRefs(c, aiCallLanguage.parse(before.language));
  const a = await prisma.aiAgent.update({ where: { id }, data: rowData(c) });
  return view(a);
}

/** Hidden from the list; its generated flow stays (as an ordinary flow) and so does every call's history. */
export async function archiveAgent(id: string): Promise<void> {
  await getAgentRow(id);
  await prisma.aiAgent.update({ where: { id }, data: { archivedAt: new Date() } });
}

/* ------------------------------------------------------------------ knowledge */
function itemView(i: AiAgentKnowledgeItem): AiKnowledgeItemView {
  return {
    id: i.id,
    fileId: i.fileId,
    kind: i.kind === "qa" ? "qa" : "fact",
    topic: i.topic,
    text: i.text,
    questions: Array.isArray(i.questions) ? (i.questions as string[]) : [],
    always: i.always,
    status: STATUS_VIEW[i.status],
    issues: Array.isArray(i.issues) ? (i.issues as string[]) : [],
    source: i.source,
    industryHint: i.industryHint,
  };
}

export async function listKnowledge(agentId: string): Promise<{ files: AiKnowledgeFileView[]; items: AiKnowledgeItemView[] }> {
  await getAgentRow(agentId);
  const [files, items] = await Promise.all([
    prisma.aiAgentKnowledgeFile.findMany({ where: { agentId }, orderBy: { createdAt: "desc" } }),
    prisma.aiAgentKnowledgeItem.findMany({ where: { agentId }, orderBy: [{ fileId: "asc" }, { createdAt: "asc" }] }),
  ]);
  return {
    files: files.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      format: f.format as AiKnowledgeFileView["format"],
      sizeBytes: f.sizeBytes,
      status: f.status === "FAILED" ? "failed" : f.status === "REPLACED" ? "replaced" : "extracted",
      error: f.error,
      itemCount: f.itemCount,
      uploadedByEmail: f.uploadedByEmail,
      createdAt: f.createdAt.toISOString(),
    })),
    items: items.map(itemView),
  };
}

export interface StoredFile {
  fileName: string;
  format: string;
  buffer: Buffer;
}

/**
 * Save an uploaded file's extraction (or its failure). `replacesFileId` (a file of the same agent): the old file
 * is marked replaced and its items removed (approved ones too: the new file's items start as drafts again).
 */
export async function addKnowledgeFile(
  agentId: string,
  file: StoredFile,
  result: { extraction: Extraction } | { error: string },
  byEmail: string,
  replacesFileId?: string | null,
): Promise<AiKnowledgeFileView> {
  await getAgentRow(agentId);
  if (replacesFileId) {
    const old = await prisma.aiAgentKnowledgeFile.findUnique({ where: { id: replacesFileId } });
    if (!old || old.agentId !== agentId) throw new AiAgentError("The file to replace is not one of this agent's", 404);
  }
  const sha256 = createHash("sha256").update(file.buffer).digest("hex");
  const created = await prisma.$transaction(async (tx) => {
    const f = await tx.aiAgentKnowledgeFile.create({
      data: {
        agentId,
        fileName: file.fileName.slice(0, 200),
        format: file.format,
        sizeBytes: file.buffer.length,
        sha256,
        status: "error" in result ? "FAILED" : "EXTRACTED",
        error: "error" in result ? result.error.slice(0, 2000) : result.extraction.notes.join("\n") || null,
        itemCount: "error" in result ? 0 : result.extraction.items.length,
        uploadedByEmail: byEmail,
      },
    });
    if (!("error" in result) && result.extraction.items.length) {
      await tx.aiAgentKnowledgeItem.createMany({
        data: result.extraction.items.map((i) => ({
          agentId,
          fileId: f.id,
          kind: i.kind,
          topic: i.topic.slice(0, 40),
          text: i.text,
          questions: i.questions as unknown as Prisma.InputJsonValue,
          issues: i.issues as unknown as Prisma.InputJsonValue,
          source: i.source,
          industryHint: i.industryHint,
        })),
      });
    }
    if (replacesFileId && !("error" in result)) {
      await tx.aiAgentKnowledgeItem.deleteMany({ where: { agentId, fileId: replacesFileId } });
      await tx.aiAgentKnowledgeFile.update({ where: { id: replacesFileId }, data: { status: "REPLACED", replacedById: f.id } });
    }
    return f;
  });
  return (await listKnowledge(agentId)).files.find((f) => f.id === created.id)!;
}

/** Remove a file and its items (approved ones too). */
export async function deleteKnowledgeFile(agentId: string, fileId: string): Promise<void> {
  const f = await prisma.aiAgentKnowledgeFile.findUnique({ where: { id: fileId } });
  if (!f || f.agentId !== agentId) throw new AiAgentError("File not found", 404);
  await prisma.$transaction([
    prisma.aiAgentKnowledgeItem.deleteMany({ where: { agentId, fileId } }),
    prisma.aiAgentKnowledgeFile.delete({ where: { id: fileId } }),
  ]);
}

async function ownItem(agentId: string, itemId: string): Promise<AiAgentKnowledgeItem> {
  const i = await prisma.aiAgentKnowledgeItem.findUnique({ where: { id: itemId } });
  if (!i || i.agentId !== agentId) throw new AiAgentError("Knowledge item not found", 404);
  return i;
}

/** Add one item by hand (Draft). */
export async function addKnowledgeItem(
  agentId: string,
  input: { kind: "fact" | "qa"; topic: string; text: string; questions: string[]; always: boolean },
): Promise<AiKnowledgeItemView> {
  await getAgentRow(agentId);
  const issues = itemIssues(input);
  const created = await prisma.aiAgentKnowledgeItem.create({
    data: {
      agentId,
      kind: input.kind,
      topic: input.topic,
      text: input.text,
      questions: input.questions as unknown as Prisma.InputJsonValue,
      always: input.kind === "fact" && input.always,
      issues: issues as unknown as Prisma.InputJsonValue,
      source: "added by hand",
    },
  });
  return itemView(created);
}

/** Edit an item: its issues are checked again, and an approved item goes back to Draft (approve it again). */
export async function updateKnowledgeItem(
  agentId: string,
  itemId: string,
  patch: { kind?: "fact" | "qa"; topic?: string; text?: string; questions?: string[]; always?: boolean },
): Promise<AiKnowledgeItemView> {
  const i = await ownItem(agentId, itemId);
  const next = {
    kind: patch.kind ?? (i.kind === "qa" ? "qa" : "fact"),
    topic: patch.topic ?? i.topic,
    text: patch.text ?? i.text,
    questions: patch.questions ?? (Array.isArray(i.questions) ? (i.questions as string[]) : []),
  } as const;
  const always = (patch.always ?? i.always) && next.kind === "fact";
  const contentChanged = patch.kind !== undefined || patch.topic !== undefined || patch.text !== undefined || patch.questions !== undefined;
  const updated = await prisma.aiAgentKnowledgeItem.update({
    where: { id: i.id },
    data: {
      ...next,
      questions: next.questions as unknown as Prisma.InputJsonValue,
      always,
      issues: itemIssues(next) as unknown as Prisma.InputJsonValue,
      ...(contentChanged && i.status === "APPROVED" ? { status: "DRAFT", decidedAt: null, decidedByEmail: null } : {}),
    },
  });
  return itemView(updated);
}

export async function deleteKnowledgeItem(agentId: string, itemId: string): Promise<void> {
  const i = await ownItem(agentId, itemId);
  await prisma.aiAgentKnowledgeItem.delete({ where: { id: i.id } });
}

/** Approve / reject / back to draft. Items with issues can't be approved; at most 120 approved per agent. */
export async function decideKnowledge(
  agentId: string,
  ids: string[],
  status: AiKnowledgeStatus,
  byEmail: string,
): Promise<{ updated: number; refused: { id: string; reason: string }[] }> {
  await getAgentRow(agentId);
  const items = await prisma.aiAgentKnowledgeItem.findMany({ where: { id: { in: ids }, agentId } });
  const refused: { id: string; reason: string }[] = ids
    .filter((id) => !items.some((i) => i.id === id))
    .map((id) => ({ id, reason: "not one of this agent's items" }));
  let ok = items;
  if (status === "approved") {
    ok = items.filter((i) => {
      const issues = Array.isArray(i.issues) ? (i.issues as string[]) : [];
      if (issues.length) refused.push({ id: i.id, reason: `fix first: ${issues.join("; ")}` });
      return issues.length === 0;
    });
    const already = await prisma.aiAgentKnowledgeItem.count({ where: { agentId, status: "APPROVED", id: { notIn: ok.map((i) => i.id) } } });
    const room = Math.max(0, AI_KNOWLEDGE_MAX_APPROVED - already);
    if (ok.length > room) {
      for (const i of ok.slice(room)) refused.push({ id: i.id, reason: `at most ${AI_KNOWLEDGE_MAX_APPROVED} approved items per agent` });
      ok = ok.slice(0, room);
    }
  }
  if (ok.length) {
    await prisma.aiAgentKnowledgeItem.updateMany({
      where: { agentId, id: { in: ok.map((i) => i.id) } },
      data: { status: STATUS_DB[status], decidedByEmail: status === "draft" ? null : byEmail, decidedAt: status === "draft" ? null : new Date() },
    });
  }
  return { updated: ok.length, refused };
}

/* ------------------------------------------------------------------ compile + publish */
async function approvedKnowledge(agentId: string): Promise<CompileKnowledgeItem[]> {
  const rows = await prisma.aiAgentKnowledgeItem.findMany({
    where: { agentId, status: "APPROVED" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "qa" ? "qa" : "fact",
    topic: r.topic,
    text: r.text,
    questions: Array.isArray(r.questions) ? (r.questions as string[]) : [],
    always: r.always,
  }));
}

/** Hash of everything a publish compiles from (settings, industry, approved knowledge): differs = unpublished changes. */
export async function agentInputsHash(a: AiAgent): Promise<string> {
  const [knowledge, industry, category] = await Promise.all([
    approvedKnowledge(a.id),
    a.industryId ? prisma.aiIndustry.findUnique({ where: { id: a.industryId } }) : null,
    a.categoryId ? prisma.aiBusinessCategory.findUnique({ where: { id: a.categoryId } }) : null,
  ]);
  return definitionHash({
    config: configFromRow(a),
    industry: industry ? [industry.name, industry.discoveryTopics] : null,
    category: category?.name ?? null,
    knowledge: knowledge.map((k) => [k.kind, k.topic, k.text, k.questions, k.always]),
  });
}

/** The agent compiled with the language's built-in executive flow (from its voice backend). */
export async function compileAgent(a: AiAgent, builtinExecutive: unknown): Promise<CallFlowDefinition> {
  const language = aiCallLanguage.parse(a.language);
  const base = callFlowDefinition.safeParse({ ...(builtinExecutive as object), language });
  if (!base.success) throw new AiAgentError("The voice backend's built-in Business executive flow failed validation", 409);
  const [knowledge, industry, category] = await Promise.all([
    approvedKnowledge(a.id),
    a.industryId ? prisma.aiIndustry.findUnique({ where: { id: a.industryId } }) : null,
    a.categoryId ? prisma.aiBusinessCategory.findUnique({ where: { id: a.categoryId } }) : null,
  ]);
  const compiled = compileAgentFlow({
    language,
    agent: configFromRow(a),
    categoryName: category?.name ?? null,
    industry: industry ? { name: industry.name, discoveryTopics: industry.discoveryTopics ?? "" } : null,
    knowledge,
    base: base.data,
  });
  const checked = callFlowDefinition.safeParse(compiled);
  if (!checked.success) {
    const msg = checked.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new AiAgentError(`The compiled flow is not valid: ${msg}`, 400);
  }
  return checked.data;
}

/**
 * Save the compiled definition as the agent's flow draft (creating the flow on first publish, or again when an
 * admin removed it from Voice Call Flows) and return the draft. The caller validates it with the voice backend
 * and then publishes it (domain/callFlows publishDraft) - the same path as the Call Flows page.
 */
export async function saveAgentDraft(a: AiAgent, definition: CallFlowDefinition, byEmail: string): Promise<{ flowId: string; draftId: string }> {
  return prisma.$transaction(async (tx) => {
    let flowId = a.callFlowId;
    if (flowId) {
      const flow = await tx.callFlow.findUnique({ where: { id: flowId } });
      if (!flow || flow.archivedAt) flowId = null;
    }
    const data = {
      definition: definition as unknown as Prisma.InputJsonValue,
      definitionHash: definitionHash(definition),
      createdByEmail: byEmail,
    };
    if (!flowId) {
      const flow = await tx.callFlow.create({
        data: {
          name: definition.name,
          description: `AI Agent "${a.name}" (generated - edit the agent, not this flow)`,
          base: "executive",
          language: a.language,
          createdByEmail: byEmail,
          versions: { create: { version: 1, status: "DRAFT", ...data } },
        },
        include: { versions: true },
      });
      await tx.aiAgent.update({ where: { id: a.id }, data: { callFlowId: flow.id } });
      return { flowId: flow.id, draftId: flow.versions[0]!.id };
    }
    const draft = await tx.callFlowVersion.findFirst({ where: { flowId, status: "DRAFT" } });
    if (draft) {
      await tx.callFlowVersion.update({ where: { id: draft.id }, data });
      await tx.callFlow.update({ where: { id: flowId }, data: { name: definition.name } });
      return { flowId, draftId: draft.id };
    }
    const last = await tx.callFlowVersion.aggregate({ where: { flowId }, _max: { version: true } });
    const created = await tx.callFlowVersion.create({ data: { flowId, version: (last._max.version ?? 0) + 1, status: "DRAFT", ...data } });
    await tx.callFlow.update({ where: { id: flowId }, data: { name: definition.name } });
    return { flowId, draftId: created.id };
  });
}

/**
 * An open draft on the agent's generated flow. The agent's own publish saves and publishes in one go and removes
 * its draft when publishing fails (discardAgentDraft), so an open draft was made some other way (by hand before
 * generated flows became read-only in Voice Call Flows): publishing would replace it, so the admin is asked first.
 */
export async function openDraftOf(a: AiAgent): Promise<{ version: number; createdByEmail: string | null; updatedAt: Date } | null> {
  if (!a.callFlowId) return null;
  return prisma.callFlowVersion.findFirst({
    where: { flowId: a.callFlowId, status: "DRAFT" },
    select: { version: true, createdByEmail: true, updatedAt: true },
  });
}

/** The agent's publish failed after its draft was saved: remove that draft (it is rebuilt from the agent anytime). */
export async function discardAgentDraft(draftId: string): Promise<void> {
  await prisma.callFlowVersion.deleteMany({ where: { id: draftId, status: "DRAFT", runs: { none: {} } } });
}

export async function markPublished(a: AiAgent): Promise<void> {
  await prisma.aiAgent.update({ where: { id: a.id }, data: { publishedHash: await agentInputsHash(a) } });
}

/** The (not archived) AI Agent whose generated flow this is, or null: such a flow changes only on that agent's publish. */
export async function managingAgent(flowId: string): Promise<{ id: string; name: string } | null> {
  return prisma.aiAgent.findFirst({ where: { callFlowId: flowId, archivedAt: null }, select: { id: true, name: true } });
}

/** The published flow an agent calls with (autonomous: its own; guided: the picked one). */
export async function callFlowIdFor(a: AiAgent): Promise<string> {
  const flowId = a.mode === "GUIDED" ? a.guidedFlowId : a.callFlowId;
  if (!flowId || !(await latestPublished(flowId))) {
    throw new AiAgentError(a.mode === "GUIDED" ? "The agent's Call Flow has no published version" : "Publish the agent first", 409);
  }
  return flowId;
}

