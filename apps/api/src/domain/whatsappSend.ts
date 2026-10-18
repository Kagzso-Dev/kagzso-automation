// WhatsApp bulk ("drip") send — batch creation, message rendering and the
// progress view. Isolated from the email send pipeline (domain/manualSend.ts,
// domain/delivery.ts): the only shared idea is the paced-drip pattern, and the
// tiny delay helper is duplicated here on purpose.

import type { WhatsAppTemplate } from "@prisma/client";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { whatsappConfig } from "../config/whatsapp.js";
import { enqueueWhatsAppBulkSend } from "../queue/queues.js";
import { normalizeWhatsAppPhone } from "./whatsappPhone.js";

/**
 * A random gap in `[minSec, maxSec]` seconds, in ms. Endpoints inclusive.
 * `rng` is injectable for tests. (Duplicated from domain/manualSend to keep the
 * WhatsApp module free of email imports.)
 */
export function pickDelayMs(minSec: number, maxSec: number, rng: () => number = Math.random): number {
  const lo = Math.max(0, minSec);
  const hi = Math.max(lo, maxSec);
  return Math.round((lo + rng() * (hi - lo)) * 1000);
}

export interface WhatsAppVarsInput {
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
  phone?: string | null;
}

/** Greeting used for {{first_name}} when the recipient has no first name ("Hi there"). */
export const FIRST_NAME_FALLBACK = "there";

/**
 * Flatten a recipient into the `{{variables}}` a WhatsApp template can use. An
 * empty / whitespace-only first name becomes "there"; business_name is left
 * empty, so a template that uses it still skips that recipient.
 */
export function buildWhatsAppVars(input: WhatsAppVarsInput): Record<string, string> {
  const first = input.firstName ?? "";
  const last = input.lastName ?? "";
  return {
    first_name: first.trim() ? first : FIRST_NAME_FALLBACK,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(" "),
    business_name: input.businessName ?? "",
    phone: input.phone ?? "",
  };
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Logic-less {{name}} substitution for the stored preview body. */
export function renderWhatsAppBody(body: string, vars: Record<string, string>): string {
  return body.replace(VAR_RE, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : "",
  );
}

/** Map a template's declared variable names to positional template params ({{1}}, {{2}}, …). */
export function buildContentVariables(
  template: Pick<WhatsAppTemplate, "variables">,
  vars: Record<string, string>,
): Record<string, string> {
  const declared = Array.isArray(template.variables) ? (template.variables as string[]) : [];
  const out: Record<string, string> = {};
  declared.forEach((name, i) => {
    out[String(i + 1)] = vars[name] ?? "";
  });
  return out;
}

/**
 * Declared template variables that resolve to an empty value for this
 * recipient. Meta rejects a template send with an empty parameter, so such a
 * recipient is skipped up front instead of failing at send time.
 */
export function missingTemplateVariables(
  template: Pick<WhatsAppTemplate, "variables">,
  vars: Record<string, string>,
): string[] {
  const declared = Array.isArray(template.variables) ? (template.variables as string[]) : [];
  return declared.filter((name) => !(vars[name] ?? "").trim());
}

export interface WhatsAppRecipient {
  whatsappContactId?: string | null;
  /** Raw phone — normalised here. */
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
  /** WhatsAppContactStatus for a "whatsapp" recipient; omitted for "contacts". */
  status?: string | null;
}

type ItemSeed = {
  whatsappContactId: string | null;
  phone: string;
  name: string | null;
  businessName: string | null;
  body: string;
  contentVariables: Record<string, string>;
  status: "QUEUED" | "SKIPPED";
  error: string | null;
};

/**
 * Create a drip batch: send `templateId` to each recipient, one at a time with
 * a random gap. Recipients with no usable phone or a non-ACTIVE status are
 * recorded SKIPPED up front. Returns the batch id; sending is driven by the
 * `whatsapp-bulk-send` queue worker.
 */
export async function createWhatsAppSendBatch(args: {
  templateId: string;
  recipients: WhatsAppRecipient[];
  /** Lead-gen: delete these contacts once Meta confirms delivery to them (never on failure). */
  purge?: { table: "whatsapp" | "contact"; ids: string[] };
}): Promise<string> {
  const template = await prisma.whatsAppTemplate.findUnique({ where: { id: args.templateId } });
  if (!template) throw new Error("templateId does not exist");

  const seen = new Set<string>();
  const items: ItemSeed[] = [];
  for (const r of args.recipients) {
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || null;
    const phone = r.phone ? normalizeWhatsAppPhone(r.phone, whatsappConfig.defaultCountryCode) : null;
    const vars = buildWhatsAppVars({ ...r, phone });
    const body = renderWhatsAppBody(template.body, vars);
    const base = {
      whatsappContactId: r.whatsappContactId ?? null,
      name,
      businessName: r.businessName ?? null,
      body,
      contentVariables: buildContentVariables(template, vars),
    };

    if (!phone) {
      items.push({ ...base, phone: "", status: "SKIPPED", error: "no valid phone number" });
      continue;
    }
    if (seen.has(phone)) continue;
    seen.add(phone);
    if (r.status && r.status !== "ACTIVE") {
      items.push({ ...base, phone, status: "SKIPPED", error: `contact is ${r.status.toLowerCase()}` });
      continue;
    }
    const missing = missingTemplateVariables(template, vars);
    if (missing.length) {
      items.push({
        ...base,
        phone,
        status: "SKIPPED",
        error: `no value for ${missing.map((m) => `{{${m}}}`).join(", ")} — WhatsApp templates can't send an empty variable`,
      });
      continue;
    }
    items.push({ ...base, phone, status: "QUEUED", error: null });
  }

  const { minDelaySec, maxDelaySec } = whatsappConfig;

  const batch = await prisma.whatsAppSendBatch.create({
    data: {
      templateId: template.id,
      minDelaySec,
      maxDelaySec,
      total: items.length,
      purgeAfter: !!args.purge,
      ...(args.purge ? { purgeTable: args.purge.table, purgeIds: args.purge.ids } : {}),
      items: { create: items.map((i) => ({ ...i, templateId: template.id })) },
    },
  });

  await enqueueWhatsAppBulkSend({
    batchId: batch.id,
    ...(args.purge && args.purge.ids.length ? { purge: args.purge } : {}),
  });
  logger.info(
    { batchId: batch.id, total: items.length, queued: items.filter((i) => i.status === "QUEUED").length },
    "whatsapp drip batch created",
  );
  return batch.id;
}

export type WhatsAppItemStatus =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "SKIPPED";

const EMPTY_WA_COUNTS: Record<WhatsAppItemStatus, number> = {
  QUEUED: 0,
  SENDING: 0,
  SENT: 0,
  DELIVERED: 0,
  READ: 0,
  FAILED: 0,
  SKIPPED: 0,
};

/**
 * Batch history for the Send Queue page (WhatsApp tab). Newest first. Reads only
 * whatsapp_send_batches / whatsapp_sends — shares nothing with the email tables.
 */
export async function listWhatsAppSendBatches(status?: "RUNNING" | "DONE" | "CANCELLED") {
  const batches = await prisma.whatsAppSendBatch.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { template: { select: { name: true } } },
  });
  if (batches.length === 0) return [];

  const grouped = await prisma.whatsAppSend.groupBy({
    by: ["batchId", "status"],
    where: { batchId: { in: batches.map((b) => b.id) } },
    _count: { _all: true },
  });
  const countsByBatch = new Map<string, Record<WhatsAppItemStatus, number>>();
  for (const row of grouped) {
    if (!row.batchId) continue;
    const counts = countsByBatch.get(row.batchId) ?? { ...EMPTY_WA_COUNTS };
    counts[row.status as WhatsAppItemStatus] = row._count._all;
    countsByBatch.set(row.batchId, counts);
  }

  return batches.map((b) => {
    const counts = countsByBatch.get(b.id) ?? { ...EMPTY_WA_COUNTS };
    return {
      id: b.id,
      templateName: b.template.name,
      total: b.total,
      status: b.status,
      counts,
      sent: counts.SENT + counts.DELIVERED + counts.READ,
      failed: counts.FAILED,
      purgeAfter: b.purgeAfter,
      startedAt: b.createdAt,
      completedAt: b.status === "RUNNING" ? null : b.updatedAt,
    };
  });
}

/** Shape the Send Queue WhatsApp batch-detail view (and the legacy poller) consume. */
export async function getWhatsAppBatchView(batchId: string) {
  const batch = await prisma.whatsAppSendBatch.findUnique({
    where: { id: batchId },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!batch) return null;

  const counts: Record<WhatsAppItemStatus, number> = { ...EMPTY_WA_COUNTS };
  for (const item of batch.items) counts[item.status as WhatsAppItemStatus]++;

  return {
    id: batch.id,
    status: batch.status,
    total: batch.total,
    nextItemAt: batch.nextItemAt,
    purgeAfter: batch.purgeAfter,
    counts,
    items: batch.items.map((i) => ({
      id: i.id,
      phone: i.phone,
      name: i.name,
      status: i.status,
      error: i.error,
      sentAt: i.sentAt,
      deliveredAt: i.deliveredAt,
      readAt: i.readAt,
      failedAt: i.failedAt,
    })),
  };
}
