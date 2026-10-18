// Orchestrator for one WhatsApp drip batch. Mirrors queue/manualBulkSend.ts but
// calls services/whatsapp.ts — no email code, no daily-cap gate.

import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { pickDelayMs } from "../domain/whatsappSend.js";
import { normalizeWhatsAppPhone } from "../domain/whatsappPhone.js";
import { whatsappConfig } from "../config/whatsapp.js";
import { bodyComponentsFromVariables, sendTemplateMessage, WhatsAppSendError } from "../services/whatsapp.js";
import { headerComponentForTemplate } from "../domain/whatsappTemplateHeader.js";
import { marketingCooldownUntil } from "../domain/whatsappCooldown.js";
import { DeferJobError } from "./engine.js";
import type { WhatsAppBulkSendJob } from "./queues.js";

/**
 * Only a delivery Meta has confirmed counts as "reached". SENT means Meta accepted
 * the message, but it can still fail afterwards (e.g. 131049, reported seconds
 * later through the webhook) — so a SENT recipient is never deleted.
 */
const CONFIRMED_STATUSES = ["DELIVERED", "READ"] as const;

type PurgeSpec = { table: "whatsapp" | "contact"; ids: string[] };

/** The batch's purge spec (stored on the batch; older batches only had it in the job payload). */
function purgeSpecOf(batch: { purgeAfter: boolean; purgeTable: string | null; purgeIds: unknown }, fallback?: PurgeSpec): PurgeSpec | undefined {
  if (!batch.purgeAfter) return undefined;
  if ((batch.purgeTable === "whatsapp" || batch.purgeTable === "contact") && Array.isArray(batch.purgeIds)) {
    return { table: batch.purgeTable, ids: batch.purgeIds.filter((x): x is string => typeof x === "string") };
  }
  return fallback;
}

/**
 * Lead-generation flow: delete the recipients this batch confirmed it reached
 * (DELIVERED / READ). Recipients whose message failed, was skipped, or is only
 * SENT are kept — a failure never costs a contact, and they can be sent to again.
 * `onlySendIds` limits it to those messages (a delivery confirmed after the
 * batch finished). WhatsAppSend.whatsappContactId is onDelete: SetNull, and
 * EmailLog on a contact has no cascade so it's cleared first.
 */
async function purgeBatchContacts(batchId: string, purge: PurgeSpec, onlySendIds?: string[]): Promise<number> {
  const sent = await prisma.whatsAppSend.findMany({
    where: { batchId, status: { in: [...CONFIRMED_STATUSES] }, ...(onlySendIds ? { id: { in: onlySendIds } } : {}) },
    select: { whatsappContactId: true, phone: true },
  });
  let ids = [...new Set(purge.ids)];
  if (purge.table === "whatsapp") {
    const reached = new Set(sent.map((s) => s.whatsappContactId).filter(Boolean));
    ids = ids.filter((id) => reached.has(id));
  } else {
    // Email-contact sends only snapshot the phone, so match on that.
    const reachedPhones = new Set(sent.map((s) => s.phone));
    const rows = await prisma.contact.findMany({ where: { id: { in: ids } }, select: { id: true, phone: true } });
    ids = rows
      .filter((r) => {
        const phone = r.phone ? normalizeWhatsAppPhone(r.phone, whatsappConfig.defaultCountryCode) : null;
        return phone !== null && reachedPhones.has(phone);
      })
      .map((r) => r.id);
  }
  if (ids.length === 0) return 0;
  if (purge.table === "whatsapp") {
    const { count } = await prisma.whatsAppContact.deleteMany({ where: { id: { in: ids } } });
    return count;
  }
  await prisma.$transaction([
    prisma.emailLog.deleteMany({ where: { contactId: { in: ids } } }),
    prisma.contact.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return ids.length;
}

/**
 * Called when Meta confirms a message DELIVERED / READ (webhook). If its batch is
 * a finished lead-gen batch, delete that one recipient now — the batch-end purge
 * only deletes deliveries already confirmed by then. Never throws.
 */
export async function purgeConfirmedRecipient(sendId: string): Promise<void> {
  try {
    const send = await prisma.whatsAppSend.findUnique({ where: { id: sendId }, select: { batchId: true } });
    if (!send?.batchId) return;
    const batch = await prisma.whatsAppSendBatch.findUnique({
      where: { id: send.batchId },
      select: { status: true, purgeAfter: true, purgeTable: true, purgeIds: true },
    });
    const spec = batch && batch.status === "DONE" ? purgeSpecOf(batch) : undefined;
    if (!spec) return; // not lead-gen, still running (its finish() handles it) or cancelled
    const removed = await purgeBatchContacts(send.batchId, spec, [sendId]);
    if (removed) logger.info({ batchId: send.batchId, sendId, removed }, "whatsapp lead-gen: recipient deleted after confirmed delivery");
  } catch (err) {
    logger.warn({ sendId, err: err instanceof Error ? err.message : String(err) }, "whatsapp lead-gen purge after delivery failed");
  }
}

async function finish(batchId: string, purge?: PurgeSpec): Promise<Record<string, number>> {
  await prisma.whatsAppSendBatch.update({
    where: { id: batchId },
    data: { status: "DONE", nextItemAt: null },
  });
  // A send interrupted mid-flight (worker restart) would otherwise stay SENDING for ever.
  // Marked FAILED once; never re-queued.
  await prisma.whatsAppSend.updateMany({
    where: { batchId, status: "SENDING" },
    data: { status: "FAILED", failedAt: new Date(), error: "Interrupted while sending (worker restarted) — not retried automatically" },
  });
  const rows = await prisma.whatsAppSend.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r._count._all;
  logger.info({ batchId, ...counts }, "whatsapp drip batch complete");
  if (purge) {
    const removed = await purgeBatchContacts(batchId, purge);
    logger.info({ batchId, removed, table: purge.table }, "whatsapp drip batch purged the recipients with confirmed delivery");
  }
  return counts;
}

/**
 * One iteration: send the next QUEUED item, record the outcome, then re-schedule
 * this job `random(min,max)` seconds later via DeferJobError (which does not
 * consume a retry attempt). A per-message failure is caught and recorded — the
 * batch always moves on. Stops when no QUEUED items remain or the batch is no
 * longer RUNNING (cancelled).
 */
export async function processWhatsAppBulkSend(payload: Record<string, unknown>): Promise<unknown> {
  const { batchId, purge: payloadPurge } = payload as unknown as WhatsAppBulkSendJob;

  const batch = await prisma.whatsAppSendBatch.findUnique({
    where: { id: batchId },
    include: { template: true },
  });
  if (!batch) return { skipped: "batch gone" };
  if (batch.status !== "RUNNING") return { skipped: `batch ${batch.status}` };
  const purge = purgeSpecOf(batch, payloadPurge);

  const item = await prisma.whatsAppSend.findFirst({
    where: { batchId, status: "QUEUED" },
    orderBy: { createdAt: "asc" },
  });
  if (!item) return { done: true, ...(await finish(batchId, purge)) };

  // Meta 131049: it recently refused a marketing message to this number. Skip (not
  // retry) until the cooldown is over; the contact itself is never touched.
  const cooldownUntil = await marketingCooldownUntil(item.phone, batch.template);
  if (cooldownUntil) {
    await prisma.whatsAppSend.update({
      where: { id: item.id },
      data: {
        status: "SKIPPED",
        error: `Meta 131049 cooldown: a marketing template to this number was refused recently — send again after ${cooldownUntil.toISOString()}`,
      },
    });
    logger.info({ batchId, itemId: item.id, until: cooldownUntil }, "whatsapp drip item skipped — 131049 cooldown");
    const left = await prisma.whatsAppSend.count({ where: { batchId, status: "QUEUED" } });
    if (left === 0) return { done: true, ...(await finish(batchId, purge)) };
    // No message went out, so no pacing gap is needed before the next one.
    throw new DeferJobError(new Date(Date.now() + 1000));
  }

  await prisma.whatsAppSend.update({ where: { id: item.id }, data: { status: "SENDING" } });

  try {
    if (!batch.template.providerTemplateName) {
      throw new WhatsAppSendError(`template "${batch.template.name}" has no Meta template name`, false);
    }
    const contentVariables = (item.contentVariables ?? {}) as Record<string, string>;
    // Header media (image / video / document) when the template has one; otherwise body only, as before.
    const header = await headerComponentForTemplate(batch.template.id).catch((err) => {
      throw new WhatsAppSendError(`header media: ${err instanceof Error ? err.message : String(err)}`, false);
    });
    if (header) {
      await prisma.whatsAppSendMedia.upsert({
        where: { sendId: item.id },
        create: { sendId: item.id, mediaId: header.mediaId, role: "header" },
        update: { mediaId: header.mediaId },
      });
    }
    const body = bodyComponentsFromVariables(contentVariables) ?? [];
    const components = header ? [header.component, ...body] : body;
    const { providerMessageId } = await sendTemplateMessage({
      to: item.phone,
      templateName: batch.template.providerTemplateName,
      languageCode: batch.template.languageCode,
      components: components.length ? components : undefined,
    });
    await prisma.whatsAppSend.update({
      where: { id: item.id },
      data: { status: "SENT", provider: "meta", providerMessageId, sentAt: new Date(), error: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.whatsAppSend.update({
      where: { id: item.id },
      data: {
        status: "FAILED",
        provider: "meta",
        failedAt: new Date(),
        errorCode: err instanceof WhatsAppSendError ? (err.code ?? null) : null,
        error: message.slice(0, 2000),
      },
    });
    const retryable = err instanceof WhatsAppSendError && err.retryable;
    logger.warn(
      { batchId, itemId: item.id, err: message, retryable },
      "whatsapp drip item failed — continuing batch",
    );
  }

  // Re-read status so a cancel that landed mid-send stops the loop here.
  const fresh = await prisma.whatsAppSendBatch.findUnique({
    where: { id: batchId },
    select: { status: true },
  });
  if (fresh?.status !== "RUNNING") {
    await prisma.whatsAppSendBatch.update({ where: { id: batchId }, data: { nextItemAt: null } });
    return { stopped: fresh?.status ?? "gone" };
  }

  const remaining = await prisma.whatsAppSend.count({ where: { batchId, status: "QUEUED" } });
  if (remaining === 0) return { done: true, ...(await finish(batchId, purge)) };

  const runAt = new Date(Date.now() + pickDelayMs(batch.minDelaySec, batch.maxDelaySec));
  await prisma.whatsAppSendBatch.update({ where: { id: batchId }, data: { nextItemAt: runAt } });
  throw new DeferJobError(runAt);
}
