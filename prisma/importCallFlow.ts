// Add a Call Flow from a JSON file as an UNPUBLISHED DRAFT (Voice Call Flows page).
// Nothing changes for live calls: a draft is only used by "Test call to my number"
// until someone clicks Publish in the editor and picks the flow for a run.
//
//   npm run callflow:import:plan -- deploy/callflows/thaara-natural.json    validate only, writes nothing
//   npm run callflow:import -- deploy/callflows/thaara-natural.json         create the draft flow
//
// Validated twice before writing: the orchestrator's schema (what the editor saves) and the
// voice backend's /api/flows/preview (what a call renders). Re-running it works like "Save" in
// the editor: it refreshes the flow's newest draft, or adds a new draft version next to a live
// one. A published version is never changed. To undo a new draft: the flow → Discard draft.
// The file's "language" decides the voice backend that checks it (VOICE_BACKEND_URL_<CODE> for
// anything but English) and the language page the flow appears on.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { callFlowDefinition } from "@dispatch/shared";
import { buildDatabaseUrl } from "../scripts/db-url.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Usage: npm run callflow:import:plan -- <file.json>");
  process.exit(1);
}

const prisma = new PrismaClient({ datasourceUrl: buildDatabaseUrl() });

async function main() {
  const parsed = callFlowDefinition.safeParse(JSON.parse(readFileSync(file!, "utf8")));
  if (!parsed.success) {
    console.error("✗ Orchestrator schema rejected it:\n" + parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"));
    process.exit(1);
  }
  const def = parsed.data;
  console.log(`✓ Orchestrator schema: "${def.name}" (base ${def.base}, language ${def.language}, ${def.blocks.length} blocks)`);

  const suffix = def.language === "en" ? "" : `_${def.language.toUpperCase()}`;
  const url = (process.env[`VOICE_BACKEND_URL${suffix}`] ?? "").replace(/\/+$/, "");
  const key = process.env[`VOICE_BACKEND_API_KEY${suffix}`] ?? process.env.VOICE_BACKEND_API_KEY ?? "";
  if (url && key) {
    const res = await fetch(`${url}/api/flows/preview`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ flow: def, sample: { customer_name: "Raagul", gender: "male" } }),
    });
    const body = (await res.json().catch(() => null)) as { valid?: boolean; errors?: string[]; greeting?: string; system_prompt?: string } | null;
    if (!res.ok || !body?.valid) {
      console.error(`✗ Voice backend rejected it (${res.status}): ${(body?.errors ?? []).join("; ") || JSON.stringify(body)}`);
      process.exit(1);
    }
    console.log(`✓ Voice backend preview: greeting "${body.greeting}", prompt ${body.system_prompt?.length.toLocaleString()} chars (~${Math.round((body.system_prompt?.length ?? 0) / 4).toLocaleString()} tokens)`);
  } else {
    console.log(`! VOICE_BACKEND_URL${suffix} / VOICE_BACKEND_API_KEY not set — voice backend check skipped`);
  }

  const existing = await prisma.callFlow.findFirst({
    where: { name: def.name, language: def.language, archivedAt: null },
    select: { id: true, versions: { select: { id: true, version: true, status: true }, orderBy: { version: "desc" } } },
  });
  if (existing) {
    // Same as "Save" in the Voice Call Flows editor: the newest version is a draft → refresh it;
    // the newest is published → add a new draft version next to it. A published version is never
    // changed, so the live flow keeps running until someone clicks Publish on the new draft.
    const latest = existing.versions[0]!;
    const hash = createHash("sha256").update(JSON.stringify(def)).digest("hex");
    if (latest.status === "DRAFT") {
      if (!apply) {
        console.log(`\nDRY RUN — would update the unpublished draft v${latest.version} of "${def.name}" (${existing.id}).`);
        return;
      }
      await prisma.callFlowVersion.update({
        where: { id: latest.id },
        data: { definition: def as object, definitionHash: hash, createdByEmail: "import-script" },
      });
      console.log(`\n✓ Updated the unpublished draft v${latest.version} of "${def.name}" (${existing.id}).`);
      return;
    }
    const next = latest.version + 1;
    if (!apply) {
      console.log(`\nDRY RUN — "${def.name}" is live (v${latest.version}); would add draft v${next}. v${latest.version} stays live until you Publish v${next}.`);
      return;
    }
    await prisma.callFlowVersion.create({
      data: { flowId: existing.id, version: next, status: "DRAFT", definition: def as object, definitionHash: hash, createdByEmail: "import-script" },
    });
    console.log(`\n✓ Added draft v${next} to "${def.name}" (${existing.id}). v${latest.version} stays live until you Publish v${next} in the editor.`);
    return;
  }
  if (!apply) {
    console.log("\nDRY RUN — nothing written. To add it as an unpublished draft: npm run callflow:import -- " + file);
    return;
  }
  const flow = await prisma.callFlow.create({
    data: {
      name: def.name,
      description: `Imported from ${file} as a draft — test it, then Publish in the editor.`,
      base: def.base,
      language: def.language,
      createdByEmail: "import-script",
      versions: {
        create: {
          version: 1,
          status: "DRAFT",
          definition: def as object,
          // Same as the API's definitionHash (domain/callFlows.ts).
          definitionHash: createHash("sha256").update(JSON.stringify(def)).digest("hex"),
          createdByEmail: "import-script",
        },
      },
    },
  });
  console.log(`\n✓ Added "${def.name}" as an unpublished draft (flow ${flow.id}).`);
  console.log("  Open Voice Call Flows → this flow → Test call to my number. Publish only when you're happy.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
