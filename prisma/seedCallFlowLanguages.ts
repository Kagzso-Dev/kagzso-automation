// Seed another language's starter call flows (Voice Call Flows → that language's page) as
// UNPUBLISHED DRAFTS, copied from its own voice backend's built-in scripts (Nila screening and
// Customer follow-up, with that language's spoken lines).
//
//   npm run callflow:seed:plan -- ta       show what would be added, write nothing
//   npm run callflow:seed -- ta            add the missing starter drafts for Tamil
//   npm run callflow:seed -- all           Tamil, Hindi, Kannada and any other language with VOICE_BACKEND_URL_<CODE>
//
// Production-safe and idempotent:
//   - English is never touched (its built-ins are the server's default agent).
//   - A starter that already exists for that language (same name, not removed) is skipped, so
//     re-running adds nothing twice; an existing flow is never changed.
//   - Drafts only: nothing is published, so no call uses a seeded flow until someone edits it,
//     makes a test call and clicks Publish on that language's Voice Call Flows page.
//   - When the language's voice backend is running, the starters come from it: it must answer in
//     that language (CALL_LANGUAGE) and each draft must pass its /api/flows/preview. When it isn't
//     running yet, they are built from the same files it loads (kagzso-voice-backend-english/
//     app/flows/builtin/<base>.json with builtin/<code>/<base>.json laid over it) and checked by
//     the orchestrator's schema; the backend checks them again on Publish and on every call.

import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  AI_CALL_LANGUAGE_NAMES,
  AI_CALL_LANGUAGES,
  AI_CALL_STANDARD_LANGUAGES,
  CALL_FLOW_BASES,
  callFlowDefinition,
  isAiCallLanguage,
  type AiCallLanguage,
  type CallFlowBase,
  type CallFlowDefinition,
} from "@dispatch/shared";
import { buildDatabaseUrl } from "../scripts/db-url.mjs";

/** GET /api/flows/builtin of a language's voice backend (the part used here). */
type Catalog = { language?: string; flows: Record<string, unknown> };

const BUILTIN_DIR = fileURLToPath(new URL("../kagzso-voice-backend-english/app/flows/builtin/", import.meta.url));

/** A built-in flow in `lang` exactly as the voice backend loads it (app/flows/loader.py load_builtin). */
function builtinFromRepo(lang: AiCallLanguage, base: CallFlowBase): Record<string, unknown> {
  const data = JSON.parse(readFileSync(`${BUILTIN_DIR}${base}.json`, "utf8")) as Record<string, unknown>;
  const own = `${BUILTIN_DIR}${lang}/${base}.json`;
  if (existsSync(own)) Object.assign(data, JSON.parse(readFileSync(own, "utf8")));
  return { ...data, language: lang };
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const which = (args.find((a) => !a.startsWith("--")) ?? "").toLowerCase();

const backendOf = (lang: AiCallLanguage) => {
  const url = (process.env[`VOICE_BACKEND_URL_${lang.toUpperCase()}`] ?? "").trim().replace(/\/+$/, "");
  const key = (process.env[`VOICE_BACKEND_API_KEY_${lang.toUpperCase()}`] ?? process.env.VOICE_BACKEND_API_KEY ?? "").trim();
  return url && key ? { url, key } : null;
};
const others = AI_CALL_LANGUAGES.filter((l) => l !== "en");

function languagesToSeed(): AiCallLanguage[] {
  if (which === "all") return others.filter((l) => AI_CALL_STANDARD_LANGUAGES.includes(l) || backendOf(l));
  if (which === "en") {
    console.error("✗ English isn't seeded: its built-in scripts are the server's default agent, and English flows stay as they are.");
    process.exit(1);
  }
  if (!isAiCallLanguage(which)) {
    console.error(`Usage: npm run callflow:seed:plan -- <${others.join("|")}|all>`);
    process.exit(1);
  }
  return [which];
}

async function voice<T>(backend: { url: string; key: string }, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${backend.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-API-Key": backend.key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || !json) throw new Error(`${backend.url}${path} answered ${res.status}`);
  return json;
}

const prisma = new PrismaClient({ datasourceUrl: buildDatabaseUrl() });

async function seedLanguage(lang: AiCallLanguage): Promise<number> {
  const name = AI_CALL_LANGUAGE_NAMES[lang];
  // Its running voice backend when there is one (it validates too), else the same files from the repo.
  let backend = backendOf(lang);
  let catalog: Catalog | null = null;
  if (backend) catalog = await voice<Catalog>(backend, "/api/flows/builtin").catch(() => null);
  if (catalog && (catalog.language ?? "en") !== lang) {
    console.error(`✗ ${name}: the backend at ${backend!.url} calls in '${catalog.language ?? "en"}', not '${lang}' — fix its CALL_LANGUAGE (or the URL).`);
    return 1;
  }
  if (!catalog) backend = null;
  console.log(`\n${name} (${backend ? backend.url : "its voice backend isn't answering — built-in files from the repo"})`);
  let problems = 0;
  for (const base of CALL_FLOW_BASES) {
    const source = catalog ? (catalog.flows[base] as object) : builtinFromRepo(lang, base);
    const parsed = callFlowDefinition.safeParse({ ...source, language: lang });
    if (!parsed.success) {
      console.error(`  ✗ ${base}: the built-in flow fails the orchestrator's schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      problems++;
      continue;
    }
    const def: CallFlowDefinition = parsed.data;
    const existing = await prisma.callFlow.findFirst({ where: { language: lang, name: def.name, archivedAt: null }, select: { id: true } });
    if (existing) {
      console.log(`  - "${def.name}": already there (${existing.id}) — left as it is`);
      continue;
    }
    const check = backend
      ? await voice<{ valid: boolean; errors?: string[] }>(backend, "/api/flows/preview", {
          flow: def,
          sample: { customer_name: "Ragul", gender: "male" },
        })
      : { valid: true };
    if (!check.valid) {
      console.error(`  ✗ "${def.name}": the ${name} voice backend rejected it: ${(check.errors ?? []).join("; ")}`);
      problems++;
      continue;
    }
    if (!apply) {
      console.log(`  + "${def.name}" (base ${base}): would be added as an unpublished draft`);
      continue;
    }
    const flow = await prisma.callFlow.create({
      data: {
        name: def.name,
        description: `${name} starter, copied from its voice backend's built-in ${base} script. Edit it, test it, then Publish.`,
        base,
        language: lang,
        createdByEmail: "seed-script",
        versions: {
          create: {
            version: 1,
            status: "DRAFT",
            definition: def as object,
            // Same as the API's definitionHash (domain/callFlows.ts).
            definitionHash: createHash("sha256").update(JSON.stringify(def)).digest("hex"),
            createdByEmail: "seed-script",
          },
        },
      },
    });
    console.log(`  ✓ "${def.name}" added as an unpublished draft (flow ${flow.id})`);
  }
  return problems;
}

async function main() {
  const langs = languagesToSeed();
  if (langs.length === 0) {
    console.log("No language to seed.");
    return;
  }
  let problems = 0;
  for (const lang of langs) problems += await seedLanguage(lang);
  if (!apply) console.log(`\nDRY RUN — nothing written. To add them: npm run callflow:seed -- ${which}`);
  else console.log("\nOpen each language's Voice Call Flows page, edit the draft, make a test call, then Publish.");
  if (problems) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
