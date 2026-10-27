// AI Call Customers: saved customers for AI voice calls (Contacts page → "AI
// Call Customers" tab). Isolated from the email Contact table and from
// WhatsApp contacts: nothing here reads or writes them. Phones are stored as
// E.164 via the shared normalizePhoneE164 (+91 default) and deduped on it.
//
// Each language has its own customer list (the `language` column, English by
// default). A number is in one list at a time; the do-not-call list is shared.

import { Prisma, type AiCallCustomer, type AiCallCustomerStage } from "@prisma/client";
import {
  AI_CALL_LANGUAGE_NAMES,
  checkAiCallCustomerRow,
  DEFAULT_AI_CALL_LANGUAGE,
  FOLLOW_UP_STAGES,
  maskPhone,
  parseOptIn,
  type AiCallCustomerInput,
  type AiCallLanguage,
  type AiCallStage,
} from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { aiCallsConfig } from "../config/aiCalls.js";
import { loadDoNotCallPhones } from "./aiCalls.js";
import { asAiCallLanguage } from "./aiCallLanguages.js";
import { addCustomerEvent, cancelPendingFollowups, createFollowupDrafts, deliveryFor, POSITIVE_CANCEL_REASON } from "./aiCallFollowups.js";

export class CustomerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const cc = () => aiCallsConfig.defaultCountryCode;
const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** Validate + normalise one customer. Throws CustomerError(400) on a blocking problem. */
function cleanInput(input: AiCallCustomerInput) {
  const check = checkAiCallCustomerRow(input, cc());
  if (check.errors.length > 0 || !check.phone) throw new CustomerError(400, check.errors.join("; ") || "Invalid phone");
  return {
    customerName: input.customerName,
    gender: check.gender,
    phone: check.phone,
    businessName: input.businessName,
    followUpDetail: input.followUpDetail,
    email: check.email,
    whatsappOptIn: input.whatsappOptIn,
  };
}

async function liveOrThrow(id: string): Promise<AiCallCustomer> {
  const c = await prisma.aiCallCustomer.findUnique({ where: { id } });
  if (!c || c.deletedAt) throw new CustomerError(404, "Customer not found");
  return c;
}

/** "A customer with this phone number already exists" — naming the other list when it is another language's. */
async function duplicateMessage(phone: string, language: AiCallLanguage): Promise<string> {
  const other = await prisma.aiCallCustomer.findFirst({ where: { activePhone: phone }, select: { language: true } });
  const theirs = asAiCallLanguage(other?.language);
  return other && theirs !== language
    ? `A customer with this phone number already exists in the ${AI_CALL_LANGUAGE_NAMES[theirs]} list`
    : "A customer with this phone number already exists";
}

/* ------------------------------------------------------------------ create / update / delete */

export async function createCustomer(
  input: AiCallCustomerInput,
  actorEmail: string,
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
): Promise<AiCallCustomer> {
  const data = cleanInput(input);
  const dnc = (await loadDoNotCallPhones(cc())).has(data.phone);
  try {
    const c = await prisma.aiCallCustomer.create({
      data: {
        ...data,
        // Only another language's customers carry the column value: English rows are written exactly as before.
        ...(language !== DEFAULT_AI_CALL_LANGUAGE ? { language } : {}),
        activePhone: data.phone,
        createdByEmail: actorEmail,
        ...(dnc ? { doNotCall: true, stage: "DO_NOT_CALL" as const } : {}),
      },
    });
    await addCustomerEvent({
      customerId: c.id,
      type: "created",
      stage: c.stage,
      detail: dnc ? "Added — number is already on the do-not-call list" : "Added manually",
      actorEmail,
    });
    logger.info({ customerId: c.id, phone: maskPhone(c.phone), language, by: actorEmail }, "ai call customer created");
    return c;
  } catch (err) {
    if (isUniqueViolation(err)) throw new CustomerError(409, await duplicateMessage(data.phone, language));
    throw err;
  }
}

export async function updateCustomer(id: string, input: AiCallCustomerInput, actorEmail: string): Promise<AiCallCustomer> {
  const existing = await liveOrThrow(id);
  const data = cleanInput(input);
  if (existing.doNotCall && data.phone !== existing.phone) {
    throw new CustomerError(409, "This customer is on the do-not-call list — the phone number can't be changed");
  }
  try {
    const c = await prisma.aiCallCustomer.update({ where: { id }, data: { ...data, activePhone: data.phone } });
    await addCustomerEvent({ customerId: id, type: "edited", actorEmail });
    if (existing.whatsappOptIn && !c.whatsappOptIn) {
      await prisma.aiCallFollowup.updateMany({
        where: { customerId: id, channel: "WHATSAPP", status: "PENDING_APPROVAL" },
        data: { status: "CANCELLED", error: "WhatsApp opt-in removed" },
      });
    }
    return c;
  } catch (err) {
    if (isUniqueViolation(err)) throw new CustomerError(409, await duplicateMessage(data.phone, asAiCallLanguage(existing.language)));
    throw err;
  }
}

/** Soft delete: the row stays (history, do-not-call) but leaves the list and frees its number. */
export async function softDeleteCustomers(ids: string[], actorEmail: string): Promise<number> {
  const rows = await prisma.aiCallCustomer.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
  if (rows.length === 0) return 0;
  const live = rows.map((r) => r.id);
  await prisma.aiCallCustomer.updateMany({
    where: { id: { in: live }, deletedAt: null },
    data: { deletedAt: new Date(), activePhone: null },
  });
  await prisma.aiCallFollowup.updateMany({
    where: { customerId: { in: live }, status: "PENDING_APPROVAL" },
    data: { status: "CANCELLED", error: "Customer deleted" },
  });
  await prisma.aiCallCustomerEvent.createMany({
    data: live.map((customerId) => ({ customerId, type: "deleted", actorEmail })),
  });
  logger.info({ count: live.length, by: actorEmail }, "ai call customers soft-deleted");
  return live.length;
}

/* ------------------------------------------------------------------ stage (admin review) */

/**
 * Admin sets the stage (Approve / Reject / change). Do not call is permanent:
 * once set it can't be changed here. Follow-up stages create drafts (pending
 * approval); Not interested / Rejected cancel drafts still waiting.
 */
export async function setCustomerStage(
  id: string,
  stage: AiCallStage,
  actorEmail: string,
  note?: string,
): Promise<AiCallCustomer> {
  const c = await liveOrThrow(id);
  if (c.doNotCall) throw new CustomerError(409, "This customer is permanently on the do-not-call list");
  if (stage === "QUEUED" || stage === "CALLING") throw new CustomerError(400, "That stage is set by the dialler");

  const updated = await prisma.aiCallCustomer.update({
    where: { id },
    data: { stage, needsReview: false, ...(stage === "DO_NOT_CALL" ? { doNotCall: true } : {}) },
  });
  await addCustomerEvent({
    customerId: id,
    type: stage === "APPROVED" ? "approved" : stage === "REJECTED" ? "rejected" : "stage_changed",
    stage,
    detail: note ?? null,
    actorEmail,
  });
  if (stage === "DO_NOT_CALL") {
    await addCustomerEvent({ customerId: id, type: "do_not_call", stage, detail: "Marked Do not call by an admin", actorEmail });
    await cancelPendingFollowups(id, "marked do not call");
  } else if (stage === "NOT_INTERESTED" || stage === "REJECTED") {
    await cancelPendingFollowups(id, `marked ${stage === "REJECTED" ? "rejected" : "not interested"}`);
  } else if (stage === "INTERESTED" || stage === "APPROVED") {
    // Confirmed positive (a person set Interested, or approved): no automatic follow-ups — the
    // customer is handed to a person. Only drafts not yet approved are cancelled (kept, never
    // deleted); a manual "AI Call" / "Call selected" still works.
    await cancelPendingFollowups(id, POSITIVE_CANCEL_REASON);
  } else if (FOLLOW_UP_STAGES.includes(stage) || stage === "CALLBACK_REQUESTED") {
    await createFollowupDrafts(updated, stage, { actorEmail });
  }
  logger.info({ customerId: id, stage, by: actorEmail }, "ai call customer stage set");
  return updated;
}

/* ------------------------------------------------------------------ list */

export async function listCustomers(q: {
  language?: AiCallLanguage;
  search?: string;
  gender?: string;
  stage?: AiCallCustomerStage;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.AiCallCustomerWhereInput = { deletedAt: null, language: q.language ?? DEFAULT_AI_CALL_LANGUAGE };
  if (q.gender) where.gender = q.gender;
  if (q.stage) where.stage = q.stage;
  if (q.search) {
    const digits = q.search.replace(/\D/g, "");
    where.OR = [
      { customerName: { contains: q.search } },
      { businessName: { contains: q.search } },
      { email: { contains: q.search } },
      { followUpDetail: { contains: q.search } },
      ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
    ];
  }
  const [items, total] = await Promise.all([
    prisma.aiCallCustomer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.aiCallCustomer.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Every live customer of one language's list, for the AI Call modal's "Saved customers" source. */
export async function callableCustomers(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE) {
  return prisma.aiCallCustomer.findMany({
    where: { deletedAt: null, language },
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: { id: true, customerName: true, gender: true, followUpDetail: true, phone: true, stage: true, doNotCall: true },
  });
}

/* ------------------------------------------------------------------ import */

export interface ImportSummary {
  imported: number;
  skipped: number;
  duplicates: number;
  doNotCall: number;
  problems: { row: number; errors: string[] }[];
}

/**
 * Bulk import (rows already mapped to fields by the browser). Only valid rows
 * are imported; a number that is already saved, or repeated in the file, is a
 * duplicate (first row wins). Numbers on the do-not-call list are imported as
 * Do not call so they are never dialled.
 */
export async function importCustomers(
  rows: {
    customerName?: string | null;
    gender?: string | null;
    phone?: string | null;
    businessName?: string | null;
    followUpDetail?: string | null;
    email?: string | null;
    whatsappOptIn?: boolean | string | null;
  }[],
  actorEmail: string,
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, skipped: 0, duplicates: 0, doNotCall: 0, problems: [] };
  const valid: { row: number; data: Prisma.AiCallCustomerCreateManyInput }[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const check = checkAiCallCustomerRow(r, cc());
    if (check.errors.length > 0 || !check.phone) {
      summary.skipped++;
      if (summary.problems.length < 200) summary.problems.push({ row: i + 1, errors: check.errors });
      return;
    }
    if (seen.has(check.phone)) {
      summary.duplicates++;
      if (summary.problems.length < 200) summary.problems.push({ row: i + 1, errors: ["Duplicate number in the file"] });
      return;
    }
    seen.add(check.phone);
    const text = (v: string | null | undefined, max: number) => (v ?? "").trim().slice(0, max) || null;
    valid.push({
      row: i + 1,
      data: {
        customerName: text(r.customerName, 100),
        gender: check.gender,
        phone: check.phone,
        activePhone: check.phone,
        businessName: text(r.businessName, 160),
        followUpDetail: text(r.followUpDetail, 500),
        email: check.email,
        whatsappOptIn: typeof r.whatsappOptIn === "boolean" ? r.whatsappOptIn : parseOptIn(r.whatsappOptIn),
        createdByEmail: actorEmail,
        ...(language !== DEFAULT_AI_CALL_LANGUAGE ? { language } : {}),
      },
    });
  });

  // A number is in one list at a time: one saved in another language's list is a duplicate too.
  const existing = new Map(
    (
      await prisma.aiCallCustomer.findMany({
        where: { activePhone: { in: valid.map((v) => v.data.phone) } },
        select: { phone: true, language: true },
      })
    ).map((c) => [c.phone, asAiCallLanguage(c.language)]),
  );
  const dnc = await loadDoNotCallPhones(cc());
  for (const v of valid) {
    if (existing.has(v.data.phone)) {
      const theirs = existing.get(v.data.phone)!;
      summary.duplicates++;
      if (summary.problems.length < 200) {
        summary.problems.push({
          row: v.row,
          errors: [theirs === language ? "Number already saved" : `Number already saved in the ${AI_CALL_LANGUAGE_NAMES[theirs]} list`],
        });
      }
      continue;
    }
    const blocked = dnc.has(v.data.phone);
    try {
      const c = await prisma.aiCallCustomer.create({
        data: { ...v.data, ...(blocked ? { doNotCall: true, stage: "DO_NOT_CALL" as const } : {}) },
        select: { id: true, stage: true },
      });
      await addCustomerEvent({
        customerId: c.id,
        type: "created",
        stage: c.stage,
        detail: blocked ? "Imported — number is on the do-not-call list" : "Imported from file",
        actorEmail,
      });
      summary.imported++;
      if (blocked) summary.doNotCall++;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      summary.duplicates++; // saved concurrently
    }
  }
  logger.info({ ...summary, problems: summary.problems.length, language, by: actorEmail }, "ai call customers imported");
  return summary;
}

/* ------------------------------------------------------------------ detail + timeline */

export interface TimelineItem {
  at: string;
  type: string;
  stage: AiCallCustomerStage | null;
  detail: string | null;
  actor: string | null;
}

export async function customerDetail(id: string) {
  const c = await prisma.aiCallCustomer.findUnique({ where: { id } });
  if (!c) throw new CustomerError(404, "Customer not found");
  const [links, events, followups] = await Promise.all([
    prisma.aiCallCustomerCall.findMany({ where: { customerId: id }, select: { logId: true } }),
    prisma.aiCallCustomerEvent.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.aiCallFollowup.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" } }),
  ]);
  const calls = links.length
    ? await prisma.aiCallLog.findMany({
        where: { id: { in: links.map((l) => l.logId) } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, runId: true, status: true, outcome: true, summary: true, transcript: true, error: true,
          durationSec: true, startedAt: true, endedAt: true, createdAt: true,
        },
      })
    : [];
  const delivery = await deliveryFor(followups);

  // "sent" and "replied" come from the existing WhatsApp ledger, not from our events.
  const timeline: TimelineItem[] = events.map((e) => ({
    at: e.createdAt.toISOString(),
    type: e.type,
    stage: e.stage,
    detail: e.detail,
    actor: e.actorEmail,
  }));
  for (const f of followups) {
    const d = delivery.get(f.id);
    if (f.whatsappBatchId && d && d.at && ["SENT", "DELIVERED", "READ", "FAILED", "SKIPPED"].includes(d.status)) {
      timeline.push({ at: d.at, type: d.status === "FAILED" || d.status === "SKIPPED" ? "whatsapp_failed" : "whatsapp_sent", stage: null, detail: `WhatsApp ${d.status.toLowerCase()}${d.detail ? ` — ${d.detail}` : ""}`, actor: null });
    }
  }
  const firstWa = followups.filter((f) => f.whatsappBatchId).map((f) => f.decidedAt ?? f.createdAt).sort((a, b) => a.getTime() - b.getTime())[0];
  if (firstWa) {
    const replies = await prisma.whatsAppInboundMessage.findMany({
      where: { phone: c.phone.replace(/^\+/, ""), sentAt: { gte: firstWa } },
      orderBy: { sentAt: "desc" },
      take: 20,
      select: { sentAt: true, body: true, messageType: true },
    });
    for (const r of replies) {
      timeline.push({ at: r.sentAt.toISOString(), type: "replied", stage: null, detail: `WhatsApp reply: ${(r.body ?? r.messageType).slice(0, 300)}`, actor: null });
    }
  }
  timeline.sort((a, b) => b.at.localeCompare(a.at));

  return {
    customer: c,
    calls,
    followups: followups.map((f) => ({ ...f, delivery: delivery.get(f.id) ?? null })),
    timeline,
  };
}
