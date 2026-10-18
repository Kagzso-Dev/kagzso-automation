// Add a Call Flow from a JSON file as an UNPUBLISHED DRAFT (Voice Call Flows page).
// Nothing changes for live calls: a draft is only used by "Test call to my number"
// until someone clicks Publish in the editor and picks the flow for a run.
//
//   npm run callflow:import:plan -- deploy/callflows/thaara-natural.json    validate only, writes nothing
//   npm run callflow:import -- deploy/callflows/thaara-natural.json         create the draft flow
//
// Validated twice before writing: the orchestrator's schema (what the editor saves) and the
// voice backend's /api/flows/preview (what a call renders). Idempotent: a live flow with the
// same name is left alone. To undo: Voice Call Flows → the flow → Remove (allowed while it
// has never been published).

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
  console.log(`✓ Orchestrator schema: "${def.name}" (base ${def.base}, ${def.blocks.length} blocks)`);

  const url = (process.env.VOICE_BACKEND_URL ?? "").replace(/\/+$/, "");
  const key = process.env.VOICE_BACKEND_API_KEY ?? "";
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
    console.log("! VOICE_BACKEND_URL / VOICE_BACKEND_API_KEY not set — voice backend check skipped");
  }

  const existing = await prisma.callFlow.findFirst({ where: { name: def.name, archivedAt: null }, select: { id: true } });
  if (existing) {
    console.log(`= A flow named "${def.name}" already exists (${existing.id}) — nothing written.`);
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
