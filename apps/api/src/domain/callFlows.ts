// Call Flows: versioning rules and the lookups the AI-call run needs.
//
//   - a flow has at most one DRAFT version; saving edits a published flow → new draft (n+1)
//   - publishing turns the draft into PUBLISHED; PUBLISHED rows are never updated again
//     (every write below is filtered on status DRAFT, so it can't touch them)
//   - a run pins the version it started with (ai_call_run_flows), so later edits never
//     change calls that are already queued

import { createHash } from "node:crypto";
import { Prisma, type CallFlowVersion } from "@prisma/client";
import type { CallFlowDefinition } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import type { PinnedFlow } from "../services/voiceBackend.js";

export function definitionHash(definition: unknown): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

export class CallFlowError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "CallFlowError";
  }
}

const asJson = (d: CallFlowDefinition) => d as unknown as Prisma.InputJsonValue;

/** Save the flow's draft: update it if there is one, otherwise create version max+1. */
export async function saveDraft(flowId: string, definition: CallFlowDefinition, byEmail: string | null): Promise<CallFlowVersion> {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.callFlowVersion.findFirst({ where: { flowId, status: "DRAFT" } });
    const data = { definition: asJson(definition), definitionHash: definitionHash(definition), createdByEmail: byEmail };
    if (draft) {
      const { count } = await tx.callFlowVersion.updateMany({ where: { id: draft.id, status: "DRAFT" }, data });
      if (count !== 1) throw new CallFlowError("The draft was published meanwhile — reload and edit again", 409);
      await tx.callFlow.update({ where: { id: flowId }, data: { name: definition.name } });
      return tx.callFlowVersion.findUniqueOrThrow({ where: { id: draft.id } });
    }
    const last = await tx.callFlowVersion.aggregate({ where: { flowId }, _max: { version: true } });
    const created = await tx.callFlowVersion.create({
      data: { flowId, version: (last._max.version ?? 0) + 1, status: "DRAFT", ...data },
    });
    await tx.callFlow.update({ where: { id: flowId }, data: { name: definition.name } });
    return created;
  });
}

/** DRAFT → PUBLISHED. The caller has already validated the definition with the voice backend. */
export async function publishDraft(draftId: string): Promise<CallFlowVersion> {
  const { count } = await prisma.callFlowVersion.updateMany({
    where: { id: draftId, status: "DRAFT" },
    data: { status: "PUBLISHED", publishedAt: new Date() },
  });
  if (count !== 1) throw new CallFlowError("Nothing to publish — the draft is gone or already published", 409);
  return prisma.callFlowVersion.findUniqueOrThrow({ where: { id: draftId } });
}

export function latestPublished(flowId: string) {
  return prisma.callFlowVersion.findFirst({
    where: { flowId, status: "PUBLISHED" },
    orderBy: { version: "desc" },
  });
}

/** The version a new run should pin: the latest published one of a live (not archived) flow. */
export async function versionForNewRun(flowId: string): Promise<CallFlowVersion> {
  const flow = await prisma.callFlow.findUnique({ where: { id: flowId }, select: { archivedAt: true } });
  if (!flow || flow.archivedAt) throw new CallFlowError("Call flow not found", 404);
  const version = await latestPublished(flowId);
  if (!version) throw new CallFlowError("This call flow has no published version yet — publish it first", 400);
  return version;
}

/** The flow pinned to a run, in the shape the voice backend expects (null = default agent). */
export async function pinnedFlowForRun(runId: string): Promise<PinnedFlow | null> {
  const link = await prisma.aiCallRunFlow.findUnique({ where: { runId }, include: { flowVersion: true } });
  if (!link) return null;
  const v = link.flowVersion;
  return { flowId: v.flowId, version: v.version, draft: v.status === "DRAFT", definition: v.definition };
}

/** What an admin types to remove a live (published) flow. */
export const REMOVE_LIVE_CONFIRM = "DELETE";

/**
 * Remove a flow from "Your call flows", in one transaction. A live (published) flow
 * needs `confirm: "DELETE"`. A flow a running call run uses is refused. A flow whose
 * versions were used by a run (e.g. a test call) is only hidden (archivedAt): it can no
 * longer be picked for a new run (versionForNewRun refuses it) and run history keeps
 * its pinned version untouched. Anything else is deleted together with its versions.
 */
export async function removeFlow(flowId: string, opts: { confirm?: string } = {}): Promise<"deleted" | "archived"> {
  return prisma.$transaction(async (tx) => {
    const flow = await tx.callFlow.findUnique({
      where: { id: flowId },
      include: { versions: { select: { id: true, version: true, status: true, _count: { select: { runs: true } } } } },
    });
    if (!flow || flow.archivedAt) throw new CallFlowError("Call flow not found", 404);
    const live = flow.versions.filter((v) => v.status === "PUBLISHED").sort((a, b) => b.version - a.version)[0];
    if (live && opts.confirm !== REMOVE_LIVE_CONFIRM) {
      throw new CallFlowError(`"${flow.name}" is live (v${live.version}). Type ${REMOVE_LIVE_CONFIRM} to confirm removing it.`, 400);
    }
    const running = await tx.aiCallRunFlow.count({
      where: { flowVersionId: { in: flow.versions.map((v) => v.id) }, run: { status: "RUNNING" } },
    });
    if (running > 0) throw new CallFlowError("A call run is using this flow right now. Try again when it finishes.", 409);
    if (flow.versions.some((v) => v._count.runs > 0)) {
      await tx.callFlow.update({ where: { id: flowId }, data: { archivedAt: new Date() } });
      return "archived";
    }
    await tx.callFlowVersion.deleteMany({ where: { flowId } });
    await tx.callFlow.delete({ where: { id: flowId } });
    return "deleted";
  });
}
