// Existing data: cancel AI Call follow-ups still waiting for approval for customers a
// person already confirmed as positive — stage INTERESTED (not "suggested — review") or
// APPROVED. Read-only unless --apply. New confirmations do this automatically (setCustomerStage).
//
//   npm run followups:positive:plan                lists what would be cancelled, writes nothing
//   npm run followups:positive                     cancels them; saves the ids to restore-logs/
//   npm run followups:positive -- --undo <file>    puts exactly those back to Pending approval
//   (followups:interested[:plan] are the same commands under their earlier name)
//
// Only PENDING_APPROVAL rows change (status CANCELLED, error "positive_review"). Approved,
// rejected, failed or already-cancelled follow-ups, calls, call history and the
// customers themselves are never touched; nothing is deleted. Running it again
// finds nothing new (idempotent). Suggested-only Interested customers are left alone.

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { buildDatabaseUrl } from "../scripts/db-url.mjs";

const REASON = "positive_review";
const UNDO_REASONS = [REASON, "interested"]; // "interested" = rows cancelled by the earlier version
const prisma = new PrismaClient({ datasourceUrl: buildDatabaseUrl() });
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const undoAt = args.indexOf("--undo");
const undoFile = undoAt >= 0 ? (args[undoAt + 1] ?? null) : null;

async function main() {
  if (undoFile) {
    const log = JSON.parse(readFileSync(undoFile, "utf8")) as { followupIds: string[] };
    // Only rows this script cancelled and nobody touched since.
    const { count } = await prisma.aiCallFollowup.updateMany({
      where: { id: { in: log.followupIds }, status: "CANCELLED", error: { in: UNDO_REASONS } },
      data: { status: "PENDING_APPROVAL", error: null },
    });
    console.log(`Undo: ${count} follow-up(s) back to Pending approval (from ${undoFile}).`);
    return;
  }

  const rows = await prisma.aiCallFollowup.findMany({
    where: { status: "PENDING_APPROVAL", customer: { stage: { in: ["INTERESTED", "APPROVED"] }, needsReview: false, deletedAt: null } },
    select: {
      id: true,
      channel: true,
      reason: true,
      scheduledAt: true,
      createdAt: true,
      customerId: true,
      customer: { select: { customerName: true, phone: true, stage: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n${apply ? "CANCELLING" : "DRY RUN — nothing is written"}`);
  console.log(`Pending follow-ups of confirmed Interested / Approved customers: ${rows.length}`);
  for (const r of rows) {
    const when = r.channel === "CALL" && r.scheduledAt ? ` for ${r.scheduledAt.toISOString()}` : "";
    console.log(`  - ${r.customer.customerName ?? "—"} ${r.customer.phone} [${r.customer.stage}]: ${r.channel === "CALL" ? "call again" : "WhatsApp"}${when} (${r.reason ?? "—"}, created ${r.createdAt.toISOString()})`);
  }
  if (!apply) {
    console.log(rows.length ? "\nTo cancel them: npm run followups:positive\n" : "\nNothing to do.\n");
    return;
  }
  if (!rows.length) return;

  const ids = rows.map((r) => r.id);
  const { count } = await prisma.aiCallFollowup.updateMany({
    where: { id: { in: ids }, status: "PENDING_APPROVAL" },
    data: { status: "CANCELLED", error: REASON },
  });
  const perCustomer = new Map<string, number>();
  for (const r of rows) perCustomer.set(r.customerId, (perCustomer.get(r.customerId) ?? 0) + 1);
  await prisma.aiCallCustomerEvent.createMany({
    data: [...perCustomer].map(([customerId, n]) => ({
      customerId,
      type: "followup_cancelled",
      detail: `${n} pending follow-up(s) cancelled — ${REASON} (cleanup of existing data)`,
    })),
  });
  mkdirSync("restore-logs", { recursive: true });
  const file = `restore-logs/interested-followups-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), followupIds: ids }, null, 2));
  console.log(`\nCancelled ${count} follow-up(s). Undo with: npm run followups:positive -- --undo ${file}\n`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
