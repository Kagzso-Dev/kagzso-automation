// AI Call Customers: saved customers for AI voice calls (Contacts page → "AI
// Call Customers" tab). Isolated from the email Contact table and from
// WhatsApp contacts: nothing here reads or writes them. Phones are stored as
// E.164 via the shared normalizePhoneE164 (+91 default) and deduped on it.
//
// Each language has its own customer list (the `language` column, English by
// default). The same number may be in each language's list (once per list); its
// calls, follow-ups and recordings stay with that list's row. The do-not-call list
// is shared: a number marked in one list is never called from any list.

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
import { asAiCallLanguage, listAiCallLanguages } from "./aiCallLanguages.js";
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

/** "A customer with this phone number already exists in the Tamil list": the list that has the number. */
async function duplicateMessage(phone: string, language: AiCallLanguage): Promise<string> {
  const same = await prisma.aiCallCustomer.findFirst({ where: { activePhone: phone, language }, select: { id: true } });
  if (same) return `A customer with this phone number already exists in the ${AI_CALL_LANGUAGE_NAMES[language]} list`;
  // Only until migration 0030 is applied: the database still allows a number in one list only.
  const other = await prisma.aiCallCustomer.findFirst({ where: { activePhone: phone }, select: { language: true } });
  return other
    ? `A customer with this phone number already exists in the ${AI_CALL_LANGUAGE_NAMES[asAiCallLanguage(other.language)]} list ` +
        "(one number in several lists needs the database update: npm run prisma:deploy)"
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
  const language = q.language ?? DEFAULT_AI_CALL_LANGUAGE;
  const where: Prisma.AiCallCustomerWhereInput = { deletedAt: null, language };
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
  // Do not call set in another language's list (deleted rows included: it is permanent): shown on this
  // list's row too, since that number is never called from any list.
  const elsewhere = items.length
    ? await prisma.aiCallCustomer.findMany({
        where: { phone: { in: items.map((c) => c.phone) }, doNotCall: true, language: { not: language } },
        orderBy: { createdAt: "asc" },
        select: { phone: true, language: true },
      })
    : [];
  const setIn = new Map<string, AiCallLanguage>();
  for (const r of elsewhere) if (!setIn.has(r.phone)) setIn.set(r.phone, asAiCallLanguage(r.language));
  return {
    items: items.map((c) => ({ ...c, doNotCallSetIn: c.doNotCall ? null : (setIn.get(c.phone) ?? null) })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
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

  // Already saved in this list (the same number may also be in another language's list).
  const existing = new Set(
    (
      await prisma.aiCallCustomer.findMany({
        where: { activePhone: { in: valid.map((v) => v.data.phone) }, language },
        select: { phone: true },
      })
    ).map((c) => c.phone),
  );
  const dnc = await loadDoNotCallPhones(cc());
  for (const v of valid) {
    if (existing.has(v.data.phone)) {
      summary.duplicates++;
      if (summary.problems.length < 200) summary.problems.push({ row: v.row, errors: ["Number already saved"] });
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

/* ------------------------------------------------------------------ several language lists (admin) */

/** Only languages switched on in Settings (English always is) can receive customers. */
async function assertLanguagesOpen(languages: AiCallLanguage[]): Promise<void> {
  const enabled = new Map((await listAiCallLanguages()).map((l) => [l.code, l.enabled]));
  for (const l of languages) {
    if (!enabled.has(l)) throw new CustomerError(400, `${AI_CALL_LANGUAGE_NAMES[l]} has no customer list here`);
    if (!enabled.get(l)) throw new CustomerError(400, `${AI_CALL_LANGUAGE_NAMES[l]} is switched off (Settings → AI call languages)`);
  }
}

export interface AddToLanguageResult {
  language: AiCallLanguage;
  status: "added" | "exists" | "failed";
  message: string | null;
  customerId: string | null;
}

/**
 * Add one customer to several language lists, one row per list with the same details. Each list is
 * saved on its own: a number already in a list is "exists", a failure in one list doesn't undo the others.
 */
export async function addCustomerToLanguages(
  input: AiCallCustomerInput,
  actorEmail: string,
  languages: AiCallLanguage[],
): Promise<AddToLanguageResult[]> {
  cleanInput(input); // a bad row is refused once, before any list is touched
  await assertLanguagesOpen(languages);
  const results: AddToLanguageResult[] = [];
  for (const language of languages) {
    try {
      const c = await createCustomer(input, actorEmail, language);
      results.push({ language, status: "added", message: c.doNotCall ? "Saved as Do not call (the number is on the do-not-call list)" : null, customerId: c.id });
    } catch (err) {
      if (err instanceof CustomerError && err.status === 409) {
        results.push({ language, status: "exists", message: err.message, customerId: null });
      } else {
        logger.warn({ language, err: err instanceof Error ? err.message : String(err) }, "ai call customer: adding to a language list failed");
        results.push({ language, status: "failed", message: "Could not be saved — try again", customerId: null });
      }
    }
  }
  const count = (s: AddToLanguageResult["status"]) => results.filter((r) => r.status === s).length;
  logger.info({ languages, added: count("added"), exists: count("exists"), failed: count("failed"), by: actorEmail }, "ai call customer added to several language lists");
  return results;
}

export interface CopyToLanguageResult {
  language: AiCallLanguage;
  /** Copies this language gets (the preview) / got (after the copy). */
  added: number;
  /** Already in that language's list: skipped. */
  exists: number;
  /** On the do-not-call list (set in any list): skipped. */
  doNotCall: number;
  failed: number;
}

/**
 * Copy ticked customers into other language lists: name, gender, phone, business, follow-up detail, email
 * and WhatsApp opt-in only (no stage, calls, follow-ups or recordings). The source rows are never changed.
 * Numbers already in a target list and do-not-call numbers are skipped. dryRun = the preview: counts only.
 */
export async function copyCustomersToLanguages(
  ids: string[],
  targets: AiCallLanguage[],
  actorEmail: string,
  dryRun: boolean,
): Promise<{ customers: number; results: CopyToLanguageResult[] }> {
  const sources = await prisma.aiCallCustomer.findMany({ where: { id: { in: ids }, deletedAt: null }, orderBy: { createdAt: "asc" } });
  if (sources.length === 0) throw new CustomerError(404, "No customers to copy");
  await assertLanguagesOpen(targets);
  const phones = [...new Set(sources.map((s) => s.phone))];
  const [present, dnc] = await Promise.all([
    prisma.aiCallCustomer.findMany({ where: { activePhone: { in: phones }, language: { in: targets } }, select: { phone: true, language: true } }),
    loadDoNotCallPhones(cc()),
  ]);
  const inList = new Set(present.map((p) => `${p.language}\u0000${p.phone}`));

  const results: CopyToLanguageResult[] = [];
  for (const language of targets) {
    const r: CopyToLanguageResult = { language, added: 0, exists: 0, doNotCall: 0, failed: 0 };
    for (const s of sources) {
      const key = `${language}\u0000${s.phone}`;
      if (asAiCallLanguage(s.language) === language || inList.has(key)) {
        r.exists++;
        continue;
      }
      if (s.doNotCall || dnc.has(s.phone)) {
        r.doNotCall++;
        continue;
      }
      inList.add(key); // the same number ticked twice is copied once
      if (dryRun) {
        r.added++;
        continue;
      }
      try {
        const c = await prisma.aiCallCustomer.create({
          data: {
            customerName: s.customerName,
            gender: s.gender,
            phone: s.phone,
            activePhone: s.phone,
            businessName: s.businessName,
            followUpDetail: s.followUpDetail,
            email: s.email,
            whatsappOptIn: s.whatsappOptIn,
            createdByEmail: actorEmail,
            ...(language !== DEFAULT_AI_CALL_LANGUAGE ? { language } : {}),
          },
          select: { id: true, stage: true },
        });
        await addCustomerEvent({
          customerId: c.id,
          type: "created",
          stage: c.stage,
          detail: `Copied from the ${AI_CALL_LANGUAGE_NAMES[asAiCallLanguage(s.language)]} list`,
          actorEmail,
        });
        r.added++;
      } catch (err) {
        if (isUniqueViolation(err)) {
          r.exists++; // saved meanwhile (or migration 0030 not applied yet)
        } else {
          logger.warn({ language, err: err instanceof Error ? err.message : String(err) }, "ai call customer: copy into a language list failed");
          r.failed++;
        }
      }
    }
    results.push(r);
  }
  if (!dryRun) {
    logger.info({ customers: sources.length, results, by: actorEmail }, "ai call customers copied to other language lists");
  }
  return { customers: sources.length, results };
}

/** Import the same mapped rows into several language lists, each with the usual import rules and summary. */
export async function importCustomersToLanguages(
  rows: Parameters<typeof importCustomers>[0],
  actorEmail: string,
  languages: AiCallLanguage[],
): Promise<(ImportSummary & { language: AiCallLanguage; failed: boolean })[]> {
  await assertLanguagesOpen(languages);
  const out: (ImportSummary & { language: AiCallLanguage; failed: boolean })[] = [];
  for (const language of languages) {
    try {
      out.push({ language, failed: false, ...(await importCustomers(rows, actorEmail, language)) });
    } catch (err) {
      logger.warn({ language, err: err instanceof Error ? err.message : String(err) }, "ai call customers: import into a language list failed");
      out.push({ language, failed: true, imported: 0, skipped: 0, duplicates: 0, doNotCall: 0, problems: [] });
    }
  }
  return out;
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
