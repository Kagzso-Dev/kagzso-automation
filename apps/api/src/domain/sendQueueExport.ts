// Send Queue → "Download all history": the complete history of ONE tab's
// channel as CSV, one row per recipient. Read-only, and produced batch by batch
// (async generator) so the route can stream it without loading everything.
//
//   email         → manual send batches + items        (Send Queue "Email" tab)
//   whatsapp      → WhatsApp send batches + messages   (Send Queue "WhatsApp" tab)
//   ai-followups  → AI call follow-ups                 (Send Queue "AI Call follow-ups" tab)
//
// Columns reuse the per-batch download's names (Name, Email / Phone, Status,
// Sent at, …, Error) with the batch columns around them, so both files read alike.

import { prisma } from "../prisma.js";
import { csvCell } from "./csv.js";
import { deliveryFor } from "./aiCallFollowups.js";
import { historyResult, type HistorySource } from "./historyFilter.js";
import { batchTemplateLabel } from "./templateDelete.js";

export type ExportChannel = "email" | "whatsapp" | "ai-followups";

/** Batches (or follow-ups) read per query while streaming. */
const PAGE = 200;

/** RFC-4180 quoting — same rule as the per-batch CSV in the browser. */
export { csvCell };
export const csvLine = (cells: (string | null | undefined)[]) => cells.map((c) => csvCell(c ?? "")).join(",");

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");
const result = (source: HistorySource, status: string) => historyResult(source, status) ?? status.toLowerCase();

export const EXPORT_HEADERS: Record<ExportChannel, string[]> = {
  email: [
    "Batch ID",
    "Template",
    "Name",
    "Email",
    "Status",
    "Result",
    "Sent at",
    "Received at",
    "Opened at",
    "Failed at",
    "Error",
    "Batch started",
    "Batch completed",
  ],
  whatsapp: [
    "Batch ID",
    "Template",
    "Name",
    "Phone",
    "Status",
    "Result",
    "Sent at",
    "Delivered at",
    "Opened at",
    "Failed at",
    "Error",
    "Batch started",
    "Batch completed",
  ],
  "ai-followups": [
    "Follow-up ID",
    "Type",
    "Template or call flow",
    "Name",
    "Phone",
    "Status",
    "Result",
    "Error",
    "Started at",
    "Decided at",
    "Completed at",
    "Decided by",
  ],
};

/** How many rows the export would have — drives the button's disabled state. */
export async function exportRowCount(channel: ExportChannel): Promise<number> {
  if (channel === "email") return prisma.manualSendBatchItem.count();
  if (channel === "whatsapp") return prisma.whatsAppSend.count({ where: { batchId: { not: null } } });
  return prisma.aiCallFollowup.count();
}

/** Newest batch first (like the Send Queue list), keyset-paged so very long histories stream steadily. */
async function* pagedBatches<T extends { id: string; createdAt: Date }>(fetch: (after: { createdAt: Date; id: string } | null) => Promise<T[]>) {
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const page = await fetch(after);
    if (page.length === 0) return;
    yield page;
    const last = page[page.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
    if (page.length < PAGE) return;
  }
}

/** Keyset condition for "older than the last row" on (createdAt desc, id desc). */
const olderThan = (a: { createdAt: Date; id: string } | null) =>
  a ? { OR: [{ createdAt: { lt: a.createdAt } }, { createdAt: a.createdAt, id: { lt: a.id } }] } : {};

/** CSV text chunks: the header line, then one chunk per batch page. */
export async function* exportHistoryCsv(channel: ExportChannel): AsyncGenerator<string> {
  yield csvLine(EXPORT_HEADERS[channel]) + "\r\n";

  if (channel === "email") {
    const pages = pagedBatches((after) =>
      prisma.manualSendBatch.findMany({
        where: olderThan(after),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE,
        include: { template: { select: { name: true } } },
      }),
    );
    for await (const batches of pages) {
      const items = await prisma.manualSendBatchItem.findMany({
        where: { batchId: { in: batches.map((b) => b.id) } },
        orderBy: { createdAt: "asc" },
      });
      // Received / opened / failed times live on the EmailLog row each send produced (same join as the batch detail).
      const logIds = items.map((i) => i.emailLogId).filter((x): x is string => !!x);
      const logs = logIds.length
        ? await prisma.emailLog.findMany({
            where: { id: { in: logIds } },
            select: { id: true, deliveredAt: true, openedAt: true, failedAt: true },
          })
        : [];
      const logById = new Map(logs.map((l) => [l.id, l]));
      const byBatch = groupBy(items, (i) => i.batchId);
      let out = "";
      for (const b of batches) {
        const completed = b.status === "RUNNING" ? null : b.updatedAt;
        for (const it of byBatch.get(b.id) ?? []) {
          const log = it.emailLogId ? logById.get(it.emailLogId) : undefined;
          out +=
            csvLine([
              b.id,
              batchTemplateLabel(b),
              it.name,
              it.email,
              it.status,
              result("email-batch", it.status),
              iso(it.sentAt),
              iso(log?.deliveredAt),
              iso(log?.openedAt),
              iso(log?.failedAt),
              it.error,
              iso(b.createdAt),
              iso(completed),
            ]) + "\r\n";
        }
      }
      if (out) yield out;
    }
    return;
  }

  if (channel === "whatsapp") {
    const pages = pagedBatches((after) =>
      prisma.whatsAppSendBatch.findMany({
        where: olderThan(after),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE,
        include: { template: { select: { name: true } } },
      }),
    );
    for await (const batches of pages) {
      const sends = await prisma.whatsAppSend.findMany({
        where: { batchId: { in: batches.map((b) => b.id) } },
        orderBy: { createdAt: "asc" },
        select: {
          batchId: true,
          name: true,
          phone: true,
          status: true,
          error: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          failedAt: true,
        },
      });
      const byBatch = groupBy(sends, (s) => s.batchId!);
      let out = "";
      for (const b of batches) {
        const completed = b.status === "RUNNING" ? null : b.updatedAt;
        for (const s of byBatch.get(b.id) ?? []) {
          out +=
            csvLine([
              b.id,
              b.template.name,
              s.name,
              s.phone,
              s.status,
              result("whatsapp", s.status),
              iso(s.sentAt),
              iso(s.deliveredAt),
              iso(s.readAt),
              iso(s.failedAt),
              s.error,
              iso(b.createdAt),
              iso(completed),
            ]) + "\r\n";
        }
      }
      if (out) yield out;
    }
    return;
  }

  // AI Call follow-ups: one row per follow-up (the tab's unit), newest first.
  const pages = pagedBatches((after) =>
    prisma.aiCallFollowup.findMany({
      where: olderThan(after),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE,
      include: { customer: { select: { customerName: true, phone: true } } },
    }),
  );
  for await (const rows of pages) {
    // What happened after approval — the same ledger read the tab uses.
    const delivery = await deliveryFor(rows);
    const templateIds = [...new Set(rows.map((f) => f.whatsappTemplateId).filter((x): x is string => !!x))];
    const runIds = [...new Set(rows.map((f) => f.aiCallRunId).filter((x): x is string => !!x))];
    const [templates, pins] = await Promise.all([
      templateIds.length
        ? prisma.whatsAppTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true, name: true } })
        : [],
      runIds.length
        ? prisma.aiCallRunFlow.findMany({
            where: { runId: { in: runIds } },
            select: { runId: true, flowVersion: { select: { version: true, flow: { select: { name: true } } } } },
          })
        : [],
    ]);
    const templateName = new Map(templates.map((t) => [t.id, t.name]));
    const flowName = new Map(pins.map((p) => [p.runId, `${p.flowVersion.flow.name} v${p.flowVersion.version}`]));
    let out = "";
    for (const f of rows) {
      const d = delivery.get(f.id) ?? null;
      const what =
        f.channel === "WHATSAPP"
          ? (f.whatsappTemplateId ? templateName.get(f.whatsappTemplateId) ?? "Deleted template" : "")
          : f.aiCallRunId
            ? flowName.get(f.aiCallRunId) ?? "Default agent"
            : "";
      out +=
        csvLine([
          f.id,
          f.channel === "WHATSAPP" ? "WhatsApp message" : "Call again",
          what,
          f.customer?.customerName,
          f.customer?.phone,
          f.status,
          followupResult(f.status, f.channel, d?.status ?? null),
          f.error ?? (d && historyResult(f.channel === "WHATSAPP" ? "whatsapp" : "call", d.status) === "failed" ? d.detail : null),
          iso(f.createdAt),
          iso(f.decidedAt),
          d?.at ?? "",
          f.decidedByEmail,
        ]) + "\r\n";
    }
    if (out) yield out;
  }
}

/**
 * A follow-up's result: before approval it is still pending; after approval it is
 * whatever the WhatsApp message or call it was handed to did.
 */
export function followupResult(status: string, channel: string, deliveryStatus: string | null): string {
  if (status === "PENDING_APPROVAL") return "waiting for approval";
  if (status === "REJECTED") return "rejected";
  if (status === "CANCELLED") return "cancelled";
  if (status === "FAILED") return "failed";
  // APPROVED: handed over — read the ledger it went to.
  if (!deliveryStatus) return "still sending";
  return historyResult(channel === "WHATSAPP" ? "whatsapp" : "call", deliveryStatus) ?? deliveryStatus.toLowerCase();
}
