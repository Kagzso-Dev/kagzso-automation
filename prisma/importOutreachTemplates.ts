// Add the 15 KAGZSO business-outreach EMAIL templates to the Templates page.
//
//   npm run outreach:templates:plan    show what would be added, writes nothing
//   npm run outreach:templates         add them
//
// Add-only. It inserts rows into the email Template table and nothing else: no campaign,
// trigger, contact, list, WhatsApp or call data is read or changed, and no process needs a
// restart (the Templates page reads the table on every load). A template whose id or name is
// already there is skipped, never overwritten, so it is safe to re-run. To undo: delete the
// "KAGZSO Outreach …" templates from the Templates page.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { buildDatabaseUrl } from "../scripts/db-url.mjs";
import { outreachTemplates, planOutreachImport } from "../apps/api/src/domain/outreachTemplates.js";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient({ datasourceUrl: buildDatabaseUrl() });

async function main() {
  const [row] = await prisma.$queryRaw<{ db: string | null }[]>`SELECT DATABASE() AS db`;
  const templates = outreachTemplates();
  const existing = await prisma.template.findMany({
    where: { OR: [{ id: { in: templates.map((t) => t.id) } }, { name: { in: templates.map((t) => t.name) } }] },
    select: { id: true, name: true },
  });
  const plan = planOutreachImport(templates, existing);
  const toCreate = plan.filter((s) => s.action === "create").map((s) => s.template);

  console.log(`Outreach email templates — database "${row?.db ?? "?"}":`);
  for (const step of plan) {
    console.log(`  ${step.action === "create" ? "add " : "skip"}  ${step.template.name}${step.action === "skip" ? ` (${step.reason})` : ""}`);
  }

  if (toCreate.length === 0) {
    console.log("\n✓ Nothing to add — all 15 are already on the Templates page.");
    return;
  }
  if (!apply) {
    console.log(`\nDRY RUN — nothing written. To add these ${toCreate.length}: npm run outreach:templates`);
    return;
  }

  // The Templates page lists newest first; stagger the timestamps a second apart so the
  // templates show in the PDF's order (01 at the top).
  const now = Date.now();
  await prisma.$transaction(
    toCreate.map((t) => {
      const at = new Date(now - templates.indexOf(t) * 1000);
      return prisma.template.create({
        data: {
          id: t.id,
          name: t.name,
          kind: t.kind,
          subject: t.subject,
          bodyText: t.bodyText,
          signature: t.signature,
          htmlBody: t.htmlBody,
          links: t.links,
          variables: t.variables,
          createdAt: at,
          updatedAt: at,
        },
      });
    }),
  );
  console.log(`\n✓ Added ${toCreate.length} email template(s). Open Templates → "KAGZSO Outreach …" to preview or edit.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
