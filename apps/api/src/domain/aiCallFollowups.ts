// AI Call follow-ups: drafts created after a call (or by an admin) that wait in
// Send Queue → "AI Call follow-ups" until an admin approves them. Approval hands
// the follow-up to the EXISTING senders — a normal WhatsApp batch
// (createWhatsAppSendBatch) or a one-call AI call run — so their workers,
// templates, rate limits and retries apply. Nothing here sends anything itself,
// and nothing is handed over without an admin's approval.

import type { AiCallCustomer, AiCallFollowup, AiCallCustomerStage } from "@prisma/client";
import { followupsForStage, maskPhone, type AiCallStage } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { aiCallsConfig } from "../config/aiCalls.js";
import { aiCallLanguageBlockedReason, asAiCallLanguage } from "./aiCallLanguages.js";
import { createWhatsAppSendBatch } from "./whatsappSend.js";
import { getWhatsAppCredentialsView } from "./whatsappCredentials.js";
import { normalizeWhatsAppPhone } from "./whatsappPhone.js";
import { enqueueAiCallFollowup } from "../queue/queues.js";

export class FollowupError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const REASON: Partial<Record<AiCallStage, string>> = {
  INTERESTED: "Interested",
  FOLLOW_UP_NEEDED: "Follow-up needed",
  APPROVED: "Approved",
  CALLBACK_REQUESTED: "Callback requested",
  NO_ANSWER: "No answer",
};

export async function addCustomerEvent(e: {
  customerId: string;
  type: string;
  stage?: AiCallCustomerStage | null;
  detail?: string | null;
  refId?: string | null;
  actorEmail?: string | null;
}): Promise<void> {
  await prisma.aiCallCustomerEvent.create({
    data: {
      customerId: e.customerId,
      type: e.type.slice(0, 32),
      stage: e.stage ?? null,
      detail: e.detail ? e.detail.slice(0, 5000) : null,
      refId: e.refId ?? null,
      actorEmail: e.actorEmail ?? null,
    },
  });
}

/** WhatsApp follow-ups need an opted-in customer with a number WhatsApp accepts. */
export function canWhatsApp(c: Pick<AiCallCustomer, "whatsappOptIn" | "phone">): boolean {
  return c.whatsappOptIn && normalizeWhatsAppPhone(c.phone, "91") !== null;
}

/** Why a draft was cancelled because a person confirmed the customer as positive. */
export const POSITIVE_CANCEL_REASON = "positive_review";

/** Stages that, once a person confirms them, hand the customer over: no automatic follow-ups. */
export const POSITIVE_STAGES = ["INTERESTED", "APPROVED"] as const;

/** A person confirmed Interested or Approved (not just suggested by a call): no automatic follow-ups. */
export function isConfirmedPositive(c: Pick<AiCallCustomer, "stage" | "needsReview">): boolean {
  return (POSITIVE_STAGES as readonly string[]).includes(c.stage) && !c.needsReview;
}

/** Cancel drafts still waiting for approval (all of them, or only those from one call). */
export async function cancelPendingFollowups(
  customerId: string,
  why: string,
  opts: { sourceCallLogId?: string } = {},
): Promise<number> {
  const { count } = await prisma.aiCallFollowup.updateMany({
    where: {
      customerId,
      status: "PENDING_APPROVAL",
      ...(opts.sourceCallLogId ? { sourceCallLogId: opts.sourceCallLogId } : {}),
    },
    data: { status: "CANCELLED", error: why.slice(0, 500) },
  });
  if (count > 0) {
    await addCustomerEvent({ customerId, type: "followup_cancelled", detail: `${count} pending follow-up(s) cancelled — ${why}` });
  }
  return count;
}

/**
 * Create the follow-up drafts a stage calls for (see followupsForStage). A
 * channel that already has a draft waiting for approval is not duplicated.
 * A customer a person confirmed as Interested or Approved gets none (a suggested
 * Interested from a call still does, until someone reviews it).
 */
export async function createFollowupDrafts(
  customer: AiCallCustomer,
  stage: AiCallStage,
  opts: { sourceCallLogId?: string | null; actorEmail?: string | null } = {},
): Promise<AiCallFollowup[]> {
  if (isConfirmedPositive(customer)) return [];
  const noAnswerRetries = await prisma.aiCallFollowup.count({
    where: { customerId: customer.id, channel: "CALL", reason: REASON.NO_ANSWER, status: { not: "CANCELLED" } },
  });
  const plans = followupsForStage(stage, {
    whatsappOptIn: canWhatsApp(customer),
    doNotCall: customer.doNotCall,
    noAnswerRetries,
    maxRetries: aiCallsConfig.followupMaxRetries,
  });
  const created: AiCallFollowup[] = [];
  for (const p of plans) {
    const waiting = await prisma.aiCallFollowup.findFirst({
      where: { customerId: customer.id, channel: p.channel, status: "PENDING_APPROVAL" },
      select: { id: true },
    });
    if (waiting) continue;
    const f = await prisma.aiCallFollowup.create({
      data: {
        customerId: customer.id,
        channel: p.channel,
        reason: REASON[stage] ?? null,
        scheduledAt: p.channel === "CALL" ? new Date(Date.now() + (p.callInHours ?? 24) * 3600_000) : null,
        attempt: p.channel === "CALL" && stage === "NO_ANSWER" ? noAnswerRetries + 1 : 1,
        sourceCallLogId: opts.sourceCallLogId ?? null,
        createdByEmail: opts.actorEmail ?? null,
      },
    });
    created.push(f);
    await addCustomerEvent({
      customerId: customer.id,
      type: "followup_created",
      detail: `${p.channel === "WHATSAPP" ? "WhatsApp message" : "Call again"} — pending approval (${REASON[stage] ?? stage})`,
      refId: f.id,
      actorEmail: opts.actorEmail ?? null,
    });
  }
  return created;
}

/** A follow-up an admin adds by hand from the customer drawer (also pending approval). */
export async function createManualFollowup(
  customerId: string,
  input: { channel: "WHATSAPP" | "CALL"; whatsappTemplateId?: string | null; scheduledAt?: Date | null; note?: string | null },
  actorEmail: string,
): Promise<AiCallFollowup> {
  const customer = await prisma.aiCallCustomer.findUnique({ where: { id: customerId } });
  if (!customer || customer.deletedAt) throw new FollowupError(404, "Customer not found");
  if (customer.doNotCall) throw new FollowupError(409, "This customer is on the do-not-call list — no follow-ups");
  if (input.channel === "WHATSAPP" && !canWhatsApp(customer)) {
    throw new FollowupError(400, "WhatsApp follow-ups need the customer's WhatsApp opt-in and an Indian mobile number");
  }
  const f = await prisma.aiCallFollowup.create({
    data: {
      customerId,
      channel: input.channel,
      reason: "Added by admin",
      whatsappTemplateId: input.whatsappTemplateId ?? null,
      scheduledAt: input.channel === "CALL" ? (input.scheduledAt ?? new Date(Date.now() + 3600_000)) : null,
      note: input.note ?? null,
      createdByEmail: actorEmail,
    },
  });
  await addCustomerEvent({
    customerId,
    type: "followup_created",
    detail: `${input.channel === "WHATSAPP" ? "WhatsApp message" : "Call again"} — pending approval (added by admin)`,
    refId: f.id,
    actorEmail,
  });
  return f;
}

async function pendingOrThrow(id: string) {
  const f = await prisma.aiCallFollowup.findUnique({ where: { id }, include: { customer: true } });
  if (!f) throw new FollowupError(404, "Follow-up not found");
  if (f.status !== "PENDING_APPROVAL") throw new FollowupError(409, `Follow-up is already ${f.status.toLowerCase().replace(/_/g, " ")}`);
  return f;
}

/** Edit-before-send: only while the follow-up is still pending approval. */
export async function editFollowup(
  id: string,
  input: { whatsappTemplateId?: string | null; scheduledAt?: Date | null; note?: string | null },
  actorEmail: string,
): Promise<AiCallFollowup> {
  const f = await pendingOrThrow(id);
  if (input.whatsappTemplateId && f.channel !== "WHATSAPP") throw new FollowupError(400, "Only WhatsApp follow-ups have a template");
  if (input.scheduledAt && f.channel !== "CALL") throw new FollowupError(400, "Only call-again follow-ups have a time");
  if (input.whatsappTemplateId) {
    const t = await prisma.whatsAppTemplate.findUnique({ where: { id: input.whatsappTemplateId }, select: { id: true } });
    if (!t) throw new FollowupError(400, "WhatsApp template not found");
  }
  const updated = await prisma.aiCallFollowup.update({
    where: { id },
    data: {
      ...(input.whatsappTemplateId !== undefined ? { whatsappTemplateId: input.whatsappTemplateId } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  });
  await addCustomerEvent({ customerId: f.customerId, type: "followup_edited", refId: id, actorEmail });
  return updated;
}

export async function rejectFollowup(id: string, actorEmail: string): Promise<void> {
  const f = await pendingOrThrow(id);
  const { count } = await prisma.aiCallFollowup.updateMany({
    where: { id, status: "PENDING_APPROVAL" },
    data: { status: "REJECTED", decidedByEmail: actorEmail, decidedAt: new Date() },
  });
  if (count === 0) throw new FollowupError(409, "Follow-up was already decided");
  await addCustomerEvent({ customerId: f.customerId, type: "followup_rejected", refId: id, actorEmail });
  logger.info({ followupId: id, by: actorEmail }, "ai call follow-up rejected");
}

/**
 * Approve: claim the row (PENDING_APPROVAL → APPROVED, so a double click can't
 * hand it over twice), then hand it to the existing sender. If the hand-over
 * fails the follow-up is marked FAILED with the reason.
 */
export async function approveFollowup(id: string, actorEmail: string): Promise<AiCallFollowup> {
  const f = await pendingOrThrow(id);
  const c = f.customer;
  if (c.deletedAt) throw new FollowupError(409, "The customer was deleted");
  if (c.doNotCall) throw new FollowupError(409, "The customer is on the do-not-call list");

  let templateId: string | null = null;
  if (f.channel === "WHATSAPP") {
    if (!canWhatsApp(c)) throw new FollowupError(409, "The customer has not opted in to WhatsApp (or the number isn't a WhatsApp mobile)");
    templateId = f.whatsappTemplateId;
    if (!templateId) throw new FollowupError(400, "Pick an approved WhatsApp template first (Edit)");
    const t = await prisma.whatsAppTemplate.findUnique({ where: { id: templateId }, select: { providerTemplateName: true } });
    if (!t) throw new FollowupError(400, "WhatsApp template not found");
    if (!t.providerTemplateName) throw new FollowupError(400, "That WhatsApp template has no Meta template name yet");
    if (!(await getWhatsAppCredentialsView()).configured) throw new FollowupError(503, "WhatsApp is not configured");
  } else {
    // The call is in the customer's list language: its voice backend must be set up and switched on.
    const unavailable = await aiCallLanguageBlockedReason(asAiCallLanguage(c.language));
    if (unavailable) throw new FollowupError(503, unavailable);
  }

  const { count } = await prisma.aiCallFollowup.updateMany({
    where: { id, status: "PENDING_APPROVAL" },
    data: { status: "APPROVED", decidedByEmail: actorEmail, decidedAt: new Date() },
  });
  if (count === 0) throw new FollowupError(409, "Follow-up was already decided");
  await addCustomerEvent({ customerId: c.id, type: "followup_approved", refId: id, actorEmail });

  try {
    if (f.channel === "WHATSAPP") {
      const [firstName, ...rest] = (c.customerName ?? "").trim().split(/\s+/);
      const batchId = await createWhatsAppSendBatch({
        templateId: templateId!,
        recipients: [
          { phone: c.phone, firstName: firstName || null, lastName: rest.join(" ") || null, businessName: c.businessName },
        ],
      });
      logger.info({ followupId: id, batchId, phone: maskPhone(c.phone), by: actorEmail }, "ai call follow-up approved → whatsapp batch");
      await addCustomerEvent({ customerId: c.id, type: "followup_handed_over", detail: "WhatsApp message queued (Send Queue → WhatsApp)", refId: id });
      return prisma.aiCallFollowup.update({ where: { id }, data: { whatsappBatchId: batchId } });
    }
    const runAt = f.scheduledAt && f.scheduledAt.getTime() > Date.now() ? f.scheduledAt : new Date();
    await enqueueAiCallFollowup({ followupId: id }, runAt);
    logger.info({ followupId: id, runAt, phone: maskPhone(c.phone), by: actorEmail }, "ai call follow-up approved → call scheduled");
    return prisma.aiCallFollowup.findUniqueOrThrow({ where: { id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.aiCallFollowup.update({ where: { id }, data: { status: "FAILED", error: message.slice(0, 2000) } });
    await addCustomerEvent({ customerId: c.id, type: "followup_failed", detail: message, refId: id });
    logger.warn({ followupId: id, phone: maskPhone(c.phone), err: message }, "ai call follow-up hand-over failed");
    throw new FollowupError(502, `Approved, but it could not be queued: ${message}`);
  }
}

/* ------------------------------------------------------------------ list (Send Queue tab) */

export type FollowupDelivery = { status: string; at: string | null; detail: string | null } | null;

/** What happened after approval, read from the existing ledgers (whatsapp_sends / ai_call_logs). */
export async function deliveryFor(followups: Pick<AiCallFollowup, "id" | "whatsappBatchId" | "aiCallRunId">[]): Promise<Map<string, FollowupDelivery>> {
  const out = new Map<string, FollowupDelivery>();
  const batchIds = followups.map((f) => f.whatsappBatchId).filter((x): x is string => !!x);
  const runIds = followups.map((f) => f.aiCallRunId).filter((x): x is string => !!x);
  const [sends, logs] = await Promise.all([
    batchIds.length
      ? prisma.whatsAppSend.findMany({
          where: { batchId: { in: batchIds } },
          select: { batchId: true, status: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true, error: true },
        })
      : [],
    runIds.length
      ? prisma.aiCallLog.findMany({
          where: { runId: { in: runIds } },
          select: { runId: true, status: true, outcome: true, endedAt: true, startedAt: true, error: true },
        })
      : [],
  ]);
  for (const f of followups) {
    const s = f.whatsappBatchId ? sends.find((x) => x.batchId === f.whatsappBatchId) : undefined;
    if (s) {
      const at = s.readAt ?? s.deliveredAt ?? s.sentAt ?? s.failedAt;
      out.set(f.id, { status: s.status, at: at ? at.toISOString() : null, detail: s.error });
      continue;
    }
    const l = f.aiCallRunId ? logs.find((x) => x.runId === f.aiCallRunId) : undefined;
    if (l) {
      const at = l.endedAt ?? l.startedAt;
      out.set(f.id, { status: l.status, at: at ? at.toISOString() : null, detail: l.error ?? l.outcome });
      continue;
    }
    out.set(f.id, null);
  }
  return out;
}

export async function listFollowups(q: { status?: AiCallFollowup["status"]; page: number; pageSize: number }) {
  const where = q.status ? { status: q.status } : {};
  const [rows, total, pending] = await Promise.all([
    prisma.aiCallFollowup.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        customer: {
          select: { id: true, customerName: true, phone: true, businessName: true, stage: true, whatsappOptIn: true, deletedAt: true, doNotCall: true, language: true },
        },
      },
    }),
    prisma.aiCallFollowup.count({ where }),
    prisma.aiCallFollowup.count({ where: { status: "PENDING_APPROVAL" } }),
  ]);
  const templateIds = [...new Set(rows.map((r) => r.whatsappTemplateId).filter((x): x is string => !!x))];
  const [templates, delivery] = await Promise.all([
    templateIds.length
      ? prisma.whatsAppTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true, name: true } })
      : [],
    deliveryFor(rows),
  ]);
  const tName = new Map(templates.map((t) => [t.id, t.name]));
  return {
    items: rows.map((r) => ({
      ...r,
      whatsappTemplateName: r.whatsappTemplateId ? (tName.get(r.whatsappTemplateId) ?? null) : null,
      delivery: delivery.get(r.id) ?? null,
    })),
    total,
    pending,
    page: q.page,
    pageSize: q.pageSize,
  };
}
