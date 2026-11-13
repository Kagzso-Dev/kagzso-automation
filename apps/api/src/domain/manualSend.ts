import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { manualKey, queueJobId } from "./idempotency.js";
import { isSuppressed } from "./suppression.js";
import { isEmailDomainAllowed } from "./allowedDomains.js";
import { getBulkSendDelays } from "./settings.js";
import { batchTemplateLabel } from "./templateDelete.js";
import { enqueueSend, enqueueManualBulkSend, type SendEmailJob } from "../queue/queues.js";

export type ManualSendResult =
  | { status: "queued"; idempotencyKey: string }
  | { status: "skipped"; reason: string };

/**
 * Queue a single template send to one existing contact, triggered by hand from
 * the UI. Goes through the same send-email worker as campaigns/triggers, so
 * suppression, the daily cap, rate limiting and the email ledger all apply.
 */
export async function sendManualEmail(
  contactId: string,
  templateId: string,
): Promise<ManualSendResult> {
  const [contact, template] = await Promise.all([
    prisma.contact.findUnique({ where: { id: contactId } }),
    prisma.template.findUnique({ where: { id: templateId } }),
  ]);
  if (!contact) return { status: "skipped", reason: "contact not found" };
  if (!template) return { status: "skipped", reason: "template not found" };

  if (await isSuppressed(contact.id)) {
    return { status: "skipped", reason: "contact is unsubscribed, bounced or complained" };
  }
  if (!(await isEmailDomainAllowed(contact.email))) {
    return { status: "skipped", reason: "email domain is not on the approved sending list" };
  }

  const idempotencyKey = manualKey(templateId, contactId);
  const source: SendEmailJob["source"] = { type: "manual", templateId };
  await enqueueSend(
    { idempotencyKey, contactId: contact.id, source },
    { dedupeKey: queueJobId(idempotencyKey) },
  );

  logger.info({ contactId, templateId, idempotencyKey }, "manual send queued");
  return { status: "queued", idempotencyKey };
}

/* ----------------------------------------------------- drip (sequential) bulk send */

/**
 * A random gap in `[minSec, maxSec]` seconds, in ms. Endpoints inclusive; when
 * `minSec === maxSec` it returns exactly that. `rng` is injectable for tests.
 */
export function pickDelayMs(minSec: number, maxSec: number, rng: () => number = Math.random): number {
  const lo = Math.max(0, minSec);
  const hi = Math.max(lo, maxSec);
  return Math.round((lo + rng() * (hi - lo)) * 1000);
}

/** Reason a contact can't be included in a drip batch, or `null` when it can. */
async function ineligibleReason(contactId: string): Promise<string | null> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return "contact not found";
  if (await isSuppressed(contactId)) {
    return "contact is unsubscribed, bounced or complained";
  }
  if (!(await isEmailDomainAllowed(contact.email))) {
    return "email domain is not on the approved sending list";
  }
  return null;
}

/**
 * Create a drip batch: send `templateId` to each contact, one at a time, with a
 * random gap between sends. Ineligible contacts (suppressed / off-list / gone)
 * are recorded as SKIPPED up front. Returns the batch id; the actual sending is
 * driven by the `manual-bulk-send` queue worker.
 */
export async function createManualSendBatch(
  templateId: string,
  contactIds: string[],
  opts: { retryOfId?: string; purgeAfter?: boolean } = {},
): Promise<string> {
  const ids = [...new Set(contactIds)]; // de-dupe, keep order

  const items: {
    contactId: string;
    email: string;
    name: string | null;
    status: "PENDING" | "SKIPPED";
    error: string | null;
  }[] = [];
  for (const id of ids) {
    const contact = await prisma.contact.findUnique({
      where: { id },
      select: { email: true, firstName: true, lastName: true },
    });
    const reason = await ineligibleReason(id);
    items.push({
      contactId: id,
      email: contact?.email ?? id,
      name: contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null : null,
      status: reason ? "SKIPPED" : "PENDING",
      error: reason,
    });
  }

  const { minDelaySec, maxDelaySec } = await getBulkSendDelays();

  const batch = await prisma.manualSendBatch.create({
    data: {
      templateId,
      minDelaySec,
      maxDelaySec,
      total: items.length,
      retryOfId: opts.retryOfId ?? null,
      purgeAfter: opts.purgeAfter ?? false,
      items: { create: items },
    },
  });

  await enqueueManualBulkSend({ batchId: batch.id });
  logger.info(
    { batchId: batch.id, total: items.length, pending: items.filter((i) => i.status === "PENDING").length },
    "manual drip batch created",
  );
  return batch.id;
}

/** Start a fresh batch containing only the FAILED contacts of an earlier one. */
export async function retryFailedItems(batchId: string): Promise<string | null> {
  const batch = await prisma.manualSendBatch.findUnique({
    where: { id: batchId },
    include: { items: { where: { status: "FAILED" }, select: { contactId: true } } },
  });
  // No template any more (deleted after this send): the route says so before calling here.
  if (!batch || !batch.templateId || batch.items.length === 0) return null;
  return createManualSendBatch(
    batch.templateId,
    batch.items.map((i) => i.contactId),
    { retryOfId: batchId },
  );
}

export type BatchItemStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";

const EMPTY_ITEM_COUNTS: Record<BatchItemStatus, number> = {
  PENDING: 0,
  SENDING: 0,
  SENT: 0,
  FAILED: 0,
  SKIPPED: 0,
};

/**
 * Batch history for the Send Queue page (Email tab). Newest first. Reads only the
 * ManualSendBatch / ManualSendBatchItem tables — no campaign or WhatsApp data.
 */
export async function listManualSendBatches(status?: "RUNNING" | "DONE" | "CANCELLED") {
  const batches = await prisma.manualSendBatch.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { template: { select: { name: true } } },
  });
  if (batches.length === 0) return [];

  const grouped = await prisma.manualSendBatchItem.groupBy({
    by: ["batchId", "status"],
    where: { batchId: { in: batches.map((b) => b.id) } },
    _count: { _all: true },
  });
  const countsByBatch = new Map<string, Record<BatchItemStatus, number>>();
  for (const row of grouped) {
    const counts = countsByBatch.get(row.batchId) ?? { ...EMPTY_ITEM_COUNTS };
    counts[row.status as BatchItemStatus] = row._count._all;
    countsByBatch.set(row.batchId, counts);
  }

  return batches.map((b) => {
    const counts = countsByBatch.get(b.id) ?? { ...EMPTY_ITEM_COUNTS };
    return {
      id: b.id,
      templateName: batchTemplateLabel(b),
      total: b.total,
      status: b.status,
      counts,
      sent: counts.SENT,
      failed: counts.FAILED,
      purgeAfter: b.purgeAfter,
      startedAt: b.createdAt,
      completedAt: b.status === "RUNNING" ? null : b.updatedAt,
    };
  });
}

/** Shape the Send Queue batch-detail view (and the legacy poller) consume. */
export async function getBatchView(batchId: string) {
  const batch = await prisma.manualSendBatch.findUnique({
    where: { id: batchId },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!batch) return null;

  const counts: Record<BatchItemStatus, number> = { ...EMPTY_ITEM_COUNTS };
  for (const item of batch.items) counts[item.status as BatchItemStatus]++;

  // Newer batches snapshot the recipient name onto the item so the detail view
  // still reads after a purge. Older batches (name === null) fall back to a live
  // contact lookup.
  const missingNameIds = batch.items.filter((i) => !i.name).map((i) => i.contactId);
  const contacts = missingNameIds.length
    ? await prisma.contact.findMany({
        where: { id: { in: [...new Set(missingNameIds)] } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const nameById = new Map(
    contacts.map((c) => [c.id, [c.firstName, c.lastName].filter(Boolean).join(" ") || null]),
  );

  // Delivered / opened times live on the EmailLog each item produced. A purged
  // batch has no logs left, so this map is simply empty then.
  const logIds = batch.items.map((i) => i.emailLogId).filter((v): v is string => !!v);
  const logs = logIds.length
    ? await prisma.emailLog.findMany({
        where: { id: { in: [...new Set(logIds)] } },
        select: { id: true, deliveredAt: true, openedAt: true, failedAt: true },
      })
    : [];
  const logById = new Map(logs.map((l) => [l.id, l]));

  return {
    id: batch.id,
    status: batch.status,
    total: batch.total,
    nextItemAt: batch.nextItemAt,
    retryOfId: batch.retryOfId,
    purgeAfter: batch.purgeAfter,
    counts,
    items: batch.items.map((i) => {
      const log = i.emailLogId ? logById.get(i.emailLogId) : undefined;
      return {
        id: i.id,
        name: i.name ?? nameById.get(i.contactId) ?? null,
        email: i.email,
        status: i.status,
        error: i.error,
        sentAt: i.sentAt,
        deliveredAt: log?.deliveredAt ?? null,
        openedAt: log?.openedAt ?? null,
        failedAt: log?.failedAt ?? null,
      };
    }),
  };
}
