import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { deliverEmail } from "../domain/delivery.js";
import { manualKey } from "../domain/idempotency.js";
import { pickDelayMs } from "../domain/manualSend.js";
import { DeferJobError } from "./engine.js";
import { dailyCapReached, msUntilNextWindow } from "./dailyCap.js";
import type { ManualBulkSendJob } from "./queues.js";

async function countByStatus(batchId: string): Promise<Record<string, number>> {
  const rows = await prisma.manualSendBatchItem.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}

/**
 * Lead-generation flow: delete the contacts this batch emailed successfully
 * (item SENT). Failed and skipped contacts are kept, untouched, so a failure
 * never costs a contact and they can be emailed again. EmailLog has no cascade
 * rule so it's cleared first; list memberships and the unsubscribe row cascade
 * on the contact delete.
 */
async function purgeBatchContacts(batchId: string): Promise<number> {
  const items = await prisma.manualSendBatchItem.findMany({
    where: { batchId, status: "SENT" },
    select: { contactId: true },
  });
  const ids = [...new Set(items.map((i) => i.contactId))];
  if (ids.length === 0) return 0;
  await prisma.$transaction([
    prisma.emailLog.deleteMany({ where: { contactId: { in: ids } } }),
    prisma.contact.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return ids.length;
}

async function finish(batchId: string, purgeAfter: boolean): Promise<Record<string, number>> {
  await prisma.manualSendBatch.update({
    where: { id: batchId },
    data: { status: "DONE", nextItemAt: null },
  });
  // A send interrupted mid-flight (worker restart) would otherwise stay SENDING for ever.
  // Marked FAILED once; never re-queued.
  await prisma.manualSendBatchItem.updateMany({
    where: { batchId, status: "SENDING" },
    data: { status: "FAILED", error: "Interrupted while sending (worker restarted) — not retried automatically" },
  });
  const counts = await countByStatus(batchId);
  logger.info({ batchId, ...counts }, "manual drip batch complete");
  if (purgeAfter) {
    const removed = await purgeBatchContacts(batchId);
    logger.info({ batchId, removed }, "manual drip batch purged its contacts");
  }
  return counts;
}

/**
 * One iteration of a drip batch: send the next PENDING contact, record the
 * outcome, then re-schedule this same job `random(min,max)` seconds later via
 * DeferJobError (which does not consume a retry attempt). A per-contact send
 * failure is caught and recorded — the batch always moves on. Stops when no
 * PENDING items remain or the batch is no longer RUNNING (cancelled).
 */
export async function processManualBulkSend(payload: Record<string, unknown>): Promise<unknown> {
  const { batchId } = payload as unknown as ManualBulkSendJob;

  const batch = await prisma.manualSendBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { skipped: "batch gone" };
  if (batch.status !== "RUNNING") return { skipped: `batch ${batch.status}` };

  const item = await prisma.manualSendBatchItem.findFirst({
    where: { batchId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!item) return { done: true, ...(await finish(batchId, batch.purgeAfter)) };

  // Same daily-cap gate the send-email worker uses: park until the next UTC window.
  if (await dailyCapReached()) {
    const runAt = new Date(Date.now() + msUntilNextWindow());
    await prisma.manualSendBatch.update({ where: { id: batchId }, data: { nextItemAt: runAt } });
    logger.warn({ batchId, runAt }, "daily cap reached — deferring drip batch");
    throw new DeferJobError(runAt);
  }

  await prisma.manualSendBatchItem.update({ where: { id: item.id }, data: { status: "SENDING" } });

  try {
    const outcome = await deliverEmail({
      idempotencyKey: manualKey(batch.templateId, item.contactId),
      contactId: item.contactId,
      source: { type: "manual", templateId: batch.templateId },
    });
    await prisma.manualSendBatchItem.update({
      where: { id: item.id },
      data:
        outcome.result === "skipped"
          ? { status: "SKIPPED", error: outcome.reason, emailLogId: outcome.emailLogId }
          : { status: "SENT", sentAt: new Date(), error: null, emailLogId: outcome.emailLogId },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // deliverEmail() already wrote the failure + failedAt onto its EmailLog row
    // before throwing (domain/delivery.ts) — link it here so the Send Queue
    // detail view (which joins through emailLogId) can show that timestamp.
    const log = await prisma.emailLog.findUnique({
      where: { idempotencyKey: manualKey(batch.templateId, item.contactId) },
      select: { id: true },
    });
    await prisma.manualSendBatchItem.update({
      where: { id: item.id },
      data: { status: "FAILED", error: message.slice(0, 2000), emailLogId: log?.id ?? null },
    });
    logger.warn({ batchId, itemId: item.id, err: message }, "drip item failed — continuing batch");
  }

  // Re-read status so a cancel that landed mid-send stops the loop here.
  const fresh = await prisma.manualSendBatch.findUnique({
    where: { id: batchId },
    select: { status: true },
  });
  if (fresh?.status !== "RUNNING") {
    await prisma.manualSendBatch.update({ where: { id: batchId }, data: { nextItemAt: null } });
    return { stopped: fresh?.status ?? "gone" };
  }

  const remaining = await prisma.manualSendBatchItem.count({
    where: { batchId, status: "PENDING" },
  });
  if (remaining === 0) return { done: true, ...(await finish(batchId, batch.purgeAfter)) };

  const runAt = new Date(Date.now() + pickDelayMs(batch.minDelaySec, batch.maxDelaySec));
  await prisma.manualSendBatch.update({ where: { id: batchId }, data: { nextItemAt: runAt } });
  throw new DeferJobError(runAt);
}
