// One voice backend per language, all from the same kagzso-voice-backend-english code:
//   English  -> kagzso-voice-backend-english/.env         port from VOICE_BACKEND_URL      (default 8002, as before)
//   Tamil    -> kagzso-voice-backend-english/.env.ta      port from VOICE_BACKEND_URL_TA   (default 8003)
//   Hindi    -> .env.hi (8004), Kannada -> .env.kn (8005), ...
// Ports come from Dispatch's .env, so Dispatch always calls the port the backend listens on.
// Shared by deploy/ecosystem.config.cjs, scripts/prod-deploy.mjs, scripts/dev-voice.mjs and
// scripts/voice-lang-env.mjs, so the names and ports can't drift apart.

const fs = require("node:fs");
const path = require("node:path");

/** The other languages a voice backend can call in (its CALL_LANGUAGE codes; same list as @dispatch/shared). */
const VOICE_LANGUAGES = ["ta", "hi", "kn", "te", "ml", "mr", "gu", "bn", "pa", "od"];

/** Default ports: English keeps 8002, then one per language. */
const DEFAULT_PORTS = { en: 8002, ta: 8003, hi: 8004, kn: 8005, te: 8006, ml: 8007, mr: 8008, gu: 8009, bn: 8010, pa: 8011, od: 8012 };

/** KEY=value pairs of a .env file ({} when it doesn't exist). Surrounding quotes are dropped; the first of a repeated key wins. */
function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Dispatch's .env key holding a language's voice backend address. */
const urlKey = (lang) => (lang === "en" ? "VOICE_BACKEND_URL" : `VOICE_BACKEND_URL_${lang.toUpperCase()}`);

/** The port a language's voice backend listens on: the one in Dispatch's VOICE_BACKEND_URL(_<CODE>), else its default. */
function voicePortFor(root, lang) {
  try {
    const url = new URL(readEnvFile(path.join(root, ".env"))[urlKey(lang)]);
    if (url.port) return Number(url.port);
  } catch {
    /* no .env / no URL - use the default */
  }
  return DEFAULT_PORTS[lang];
}

/** The languages (not English) that have their own kagzso-voice-backend-english/.env.<code>. */
function voiceLanguagesSetUp(voiceDir) {
  return VOICE_LANGUAGES.filter((l) => fs.existsSync(path.join(voiceDir, `.env.${l}`)));
}

module.exports = { VOICE_LANGUAGES, DEFAULT_PORTS, readEnvFile, urlKey, voicePortFor, voiceLanguagesSetUp };
