// Restore contacts that a lead-gen batch ("remove contacts after the batch") deleted
// although their send FAILED. Read-only unless --apply.
//
//   npm run contacts:restore:plan                 dry run: prints what it would restore, writes nothing
//   npm run contacts:restore                      restore, and save the created ids to restore-logs/
//   npm run contacts:restore -- --undo <file>     delete exactly the rows that run created (reverts it)
//   ... --skip 919876543210,ada@example.com       leave these phones / emails out (e.g. ones you deleted by hand)
//
// What it restores (only when no contact with that phone / email exists today — idempotent):
//   WhatsApp Contacts  from WhatsApp lead-gen batches: messages Meta FAILED (e.g. 131049 after the
//                      batch ended), whose WhatsApp contact is gone. Phone, name and business come
//                      from the send record's snapshot.
//   Email Contacts     from email lead-gen batches: items FAILED, or SKIPPED for "domain not approved".
//                      Email and name come from the snapshot; phone / business were not kept.
// Never restored: items skipped as "suppressed" (unsubscribed / bounced / complained — the opt-out
// was deleted with the contact, so restoring would email someone who opted out), successful sends
// (deleted by design), and WhatsApp batches started from Email Contacts (no email address was kept).
// Send and call history is never changed.

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { buildDatabaseUrl } from "../scripts/db-url.mjs";

const prisma = new PrismaClient({ datasourceUrl: buildDatabaseUrl() });
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const undoAt = args.indexOf("--undo");
const undoFile = undoAt >= 0 ? (args[undoAt + 1] ?? null) : null;
const skip = new Set(
  (args.includes("--skip") ? (args[args.indexOf("--skip") + 1] ?? "") : "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

function splitName(name: string | null): { firstName: string | null; lastName: string | null } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(" ") || null };
}

/** Which table a WhatsApp batch purged: stored on the batch, else its job payload, else inferred. */
async function purgeTableOf(batch: { id: string; purgeTable: string | null }): Promise<"whatsapp" | "contact" | null> {
  if (batch.purgeTable === "whatsapp" || batch.purgeTable === "contact") return batch.purgeTable;
  const jobs = await prisma.job.findMany({ where: { queue: "whatsapp-bulk-send" }, select: { payload: true } });
  const job = jobs.find((j) => (j.payload as { batchId?: string } | null)?.batchId === batch.id);
  const table = (job?.payload as { purge?: { table?: string } } | undefined)?.purge?.table;
  if (table === "whatsapp" || table === "contact") return table;
  // Sends from WhatsApp Contacts carry whatsappContactId (kept on recipients that weren't deleted);
  // sends from Email Contacts never do.
  const linked = await prisma.whatsAppSend.count({ where: { batchId: batch.id, whatsappContactId: { not: null } } });
  return linked > 0 ? "whatsapp" : null;
}

async function plan() {
  const whatsapp: { phone: string; firstName: string | null; lastName: string | null; businessName: string | null; batchId: string; reason: string }[] = [];
  const email: { email: string; firstName: string | null; lastName: string | null; batchId: string; reason: string }[] = [];
  const notRestored: string[] = [];

  for (const batch of await prisma.whatsAppSendBatch.findMany({ where: { purgeAfter: true }, select: { id: true, purgeTable: true } })) {
    const failed = await prisma.whatsAppSend.findMany({
      where: { batchId: batch.id, status: "FAILED", whatsappContactId: null, phone: { not: "" } },
      select: { phone: true, name: true, businessName: true, errorCode: true },
    });
    if (failed.length === 0) continue;
    const table = await purgeTableOf(batch);
    if (table !== "whatsapp") {
      notRestored.push(`WhatsApp batch ${batch.id}: ${failed.length} failed recipient(s) from ${table === "contact" ? "Email Contacts" : "an unknown source"} — no email address was kept, can't restore`);
      continue;
    }
    for (const s of failed) {
      if (skip.has(s.phone) || whatsapp.some((w) => w.phone === s.phone)) continue;
      if (await prisma.whatsAppContact.findUnique({ where: { phone: s.phone }, select: { id: true } })) continue;
      whatsapp.push({ phone: s.phone, ...splitName(s.name), businessName: s.businessName, batchId: batch.id, reason: `FAILED${s.errorCode ? ` ${s.errorCode}` : ""}` });
    }
  }

  for (const batch of await prisma.manualSendBatch.findMany({ where: { purgeAfter: true }, select: { id: true } })) {
    const items = await prisma.manualSendBatchItem.findMany({
      where: { batchId: batch.id, status: { in: ["FAILED", "SKIPPED"] } },
      select: { contactId: true, email: true, name: true, status: true, error: true },
    });
    for (const i of items) {
      const addr = i.email.trim().toLowerCase();
      if (i.status === "SKIPPED" && i.error !== "domain not approved") {
        if (i.error === "suppressed") notRestored.push(`${addr}: was suppressed (unsubscribed / bounced / complained) — not restored`);
        continue;
      }
      if (skip.has(addr) || email.some((e) => e.email === addr)) continue;
      if (await prisma.contact.findUnique({ where: { id: i.contactId }, select: { id: true } })) continue; // never deleted
      if (await prisma.contact.findUnique({ where: { email: addr }, select: { id: true } })) continue; // re-added since
      email.push({ email: addr, ...splitName(i.name), batchId: batch.id, reason: i.status === "FAILED" ? "FAILED" : "SKIPPED (domain not approved)" });
    }
  }
  return { whatsapp, email, notRestored };
}

async function main() {
  if (undoFile) {
    const log = JSON.parse(readFileSync(undoFile, "utf8")) as { whatsappContactIds: string[]; contactIds: string[] };
    const wa = await prisma.whatsAppContact.deleteMany({ where: { id: { in: log.whatsappContactIds } } });
    const em = await prisma.contact.deleteMany({ where: { id: { in: log.contactIds } } });
    console.log(`Undo: removed ${wa.count} WhatsApp contact(s) and ${em.count} email contact(s) created by ${undoFile}.`);
    return;
  }

  const p = await plan();
  console.log(`\n${apply ? "RESTORING" : "DRY RUN — nothing is written"}\n`);
  console.log(`WhatsApp Contacts to restore: ${p.whatsapp.length}`);
  for (const w of p.whatsapp) console.log(`  + ${w.phone}  ${[w.firstName, w.lastName].filter(Boolean).join(" ") || "—"}  ${w.businessName ?? ""}  (${w.reason}, batch ${w.batchId})`);
  console.log(`Email Contacts to restore: ${p.email.length}`);
  for (const e of p.email) console.log(`  + ${e.email}  ${[e.firstName, e.lastName].filter(Boolean).join(" ") || "—"}  (${e.reason}, batch ${e.batchId})`);
  if (p.notRestored.length) {
    console.log(`Not restored: ${p.notRestored.length}`);
    for (const n of p.notRestored) console.log(`  - ${n}`);
  }
  if (!apply) {
    console.log("\nReview the list. To leave some out: --skip phone1,email2. To restore: npm run contacts:restore\n");
    return;
  }

  const created = { at: new Date().toISOString(), whatsappContactIds: [] as string[], contactIds: [] as string[] };
  for (const w of p.whatsapp) {
    const row = await prisma.whatsAppContact.create({ data: { phone: w.phone, firstName: w.firstName, lastName: w.lastName, businessName: w.businessName } });
    created.whatsappContactIds.push(row.id);
  }
  for (const e of p.email) {
    const row = await prisma.contact.create({ data: { email: e.email, firstName: e.firstName, lastName: e.lastName, customFields: {} } });
    created.contactIds.push(row.id);
  }
  mkdirSync("restore-logs", { recursive: true });
  const file = `restore-logs/restore-${created.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(created, null, 2));
  console.log(`\nRestored ${created.whatsappContactIds.length} WhatsApp and ${created.contactIds.length} email contact(s).`);
  console.log(`Undo with: npm run contacts:restore -- --undo ${file}\n`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
