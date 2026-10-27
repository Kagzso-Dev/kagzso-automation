// Set up another language's voice backend .env from the English one, so the Sarvam key, phone
// number, LLM, API keys and every other setting are the same, and only what must differ changes.
//
//   npm run voice:lang:plan -- ta                      show what .env.ta would get, write nothing
//   npm run voice:lang:init -- ta                      write kagzso-voice-backend-english/.env.ta
//   npm run voice:lang:init -- ta --public-url https://voice-ta.orchestrator.kagzso.com
//
// Changed in the copy: CALL_LANGUAGE, APP_PORT, MYSQL_DATABASE (<english db>_<code>), PUBLIC_BASE_URL
// (the SAME public address as English plus the language key, e.g. https://voice.example.com/ta - the
// server's nginx (deploy/nginx-voice-languages.conf) or, on a PC, scripts/voice-gateway.mjs sends /ta
// to this backend; --public-url overrides it), SARVAM_STT_MODE=codemix (the language with everyday
// English words) and RECORDINGS_DIR (<dir>-<code>).
// Never overwrites an existing .env.<code> (edit that file instead), never prints a secret, and never
// touches the English .env. With --apply it also adds VOICE_BACKEND_URL_<CODE> to Dispatch's .env when
// that line is missing (existing lines are left as they are).

import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voiceDir = path.join(root, "kagzso-voice-backend-english");
const { VOICE_LANGUAGES, DEFAULT_PORTS, readEnvFile, urlKey, voicePortFor } = createRequire(import.meta.url)("./voice-languages.cjs");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const lang = (args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--public-url") ?? "").toLowerCase();
const publicUrlArg = args.includes("--public-url") ? args[args.indexOf("--public-url") + 1] : undefined;

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
if (!VOICE_LANGUAGES.includes(lang)) {
  fail(`Usage: npm run voice:lang:plan -- <${VOICE_LANGUAGES.join("|")}> [--public-url https://...]\n  (English is the original kagzso-voice-backend-english/.env and is never changed here.)`);
}

const englishFile = path.join(voiceDir, ".env");
const target = path.join(voiceDir, `.env.${lang}`);
if (!existsSync(englishFile)) fail("kagzso-voice-backend-english/.env (the English backend) doesn't exist yet - set that up first.");
if (existsSync(target)) fail(`kagzso-voice-backend-english/.env.${lang} already exists - edit it instead (it is never overwritten).`);

const english = readEnvFile(englishFile);
const port = voicePortFor(root, lang);

/** The same public address as English, plus the language key: https://voice.example.com/ta. */
function languageUrl(url) {
  if (publicUrlArg) return publicUrlArg.replace(/\/+$/, "");
  try {
    return `${new URL(url).origin}/${lang}`;
  } catch {
    return "";
  }
}

const englishDb = english.MYSQL_DATABASE || "kagzso_voice";
const changes = {
  CALL_LANGUAGE: lang,
  APP_PORT: String(port),
  MYSQL_DATABASE: `${englishDb.replace(/_en$/, "")}_${lang}`,
  PUBLIC_BASE_URL: languageUrl(english.PUBLIC_BASE_URL || ""),
  SARVAM_STT_MODE: "codemix",
  ...(english.RECORDINGS_DIR ? { RECORDINGS_DIR: `${english.RECORDINGS_DIR.replace(/\/+$/, "")}-${lang}` } : {}),
};

// Same file, line for line (comments kept); only the keys above change, missing ones are appended.
const lines = readFileSync(englishFile, "utf8").split(/\r?\n/);
const seen = new Set();
const out = lines.map((line) => {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  if (!m || !(m[1] in changes) || seen.has(m[1])) return line;
  seen.add(m[1]);
  return `${m[1]}=${changes[m[1]]}`;
});
const missing = Object.keys(changes).filter((k) => !seen.has(k));
if (missing.length) out.push("", `# ${lang} voice backend (scripts/voice-lang-env.mjs)`, ...missing.map((k) => `${k}=${changes[k]}`));

const dispatchEnv = path.join(root, ".env");
const dispatchKey = urlKey(lang);
const dispatchHas = dispatchKey in readEnvFile(dispatchEnv);

console.log(`\n${lang} voice backend: kagzso-voice-backend-english/.env.${lang} (a copy of the English .env)`);
for (const [k, v] of Object.entries(changes)) console.log(`  ${k}=${v || "(set it: --public-url https://...)"}`);
if (!publicUrlArg && /ngrok/i.test(english.PUBLIC_BASE_URL || "")) {
  console.log("  ! ngrok: point your one tunnel at the gateway (npm run dev starts it on :8010) instead of :8002 — English keeps working through it");
}
console.log("  everything else (SARVAM_API_KEY, PLIVO_*, LLM_*, ADMIN_API_KEY, MYSQL_USER/PASSWORD, ...) same as English");
console.log(`\nDispatch .env: ${dispatchKey}=http://127.0.0.1:${port}${dispatchHas ? "  (already there - left as it is)" : ""}`);
if (port !== DEFAULT_PORTS[lang] && dispatchHas) console.log(`  (port ${port} taken from your ${dispatchKey})`);

if (!apply) {
  console.log(`\nDRY RUN - nothing written. To write it: npm run voice:lang:init -- ${lang}${publicUrlArg ? ` --public-url ${publicUrlArg}` : ""}`);
  process.exit(0);
}
if (!changes.PUBLIC_BASE_URL) fail(`Couldn't work out PUBLIC_BASE_URL from the English one - pass --public-url https://<the English address>/${lang}`);

writeFileSync(target, out.join("\n").replace(/\n*$/, "\n"), { encoding: "utf8", mode: 0o600 });
try {
  chmodSync(target, 0o600); // secrets: owner only (no-op on Windows)
} catch {
  /* not supported here */
}
console.log(`\n✓ Wrote kagzso-voice-backend-english/.env.${lang}`);
if (!dispatchHas) {
  appendFileSync(dispatchEnv, `\n# ${lang} AI calls: its own voice backend (Settings → AI call languages)\n${dispatchKey}=http://127.0.0.1:${port}\n`);
  console.log(`✓ Added ${dispatchKey}=http://127.0.0.1:${port} to Dispatch's .env`);
}
console.log(`
Next (see README → "AI calls in more languages"):
  1. Create its database once:  CREATE DATABASE ${changes.MYSQL_DATABASE} CHARACTER SET utf8mb4;  (and GRANT it to MYSQL_USER)
  2. Route ${changes.PUBLIC_BASE_URL || "its public address"} to port ${port}: on the server, include deploy/nginx-voice-languages.conf
     in the English voice site once (no new domain); on a PC, ngrok → the gateway (npm run dev, port 8010)
  3. Optional: choose its voices in .env.${lang} (SARVAM_TTS_VOICES, SARVAM_TTS_SPEAKER) and its STT_KEYTERMS
  4. npm run prod   (migrates its database and starts kagzso_orchestrator_voice_${lang})
  5. npm run callflow:seed -- ${lang}   (its starter call flows, as drafts)`);
