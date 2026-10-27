// PM2 config for this app ONLY. Process names are prefixed "kagzso_orchestrator"
// (the name already used on the Vultr server) so they can never collide with
// other projects there.
//
//   npm run prod                               # build + migrate + (re)start these (scripts/prod-deploy.mjs)
//   pm2 restart deploy/ecosystem.config.cjs    # restart only these
//
// Never run `pm2 restart all`, `pm2 delete all`, `pm2 kill` or `pm2 update`
// on a shared server - those hit every project.
//
// Run from the repo root: the API loads ./.env from its working directory.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const voiceDir = path.join(root, "kagzso-voice-backend-english");
const uvicorn = path.join(voiceDir, ".venv", "bin", "uvicorn");
const { voiceLanguagesSetUp, voicePortFor } = require("../scripts/voice-languages.cjs");

/** Port from VOICE_BACKEND_URL in .env (default 8002), same as scripts/dev-voice.mjs. */
function voicePort() {
  return String(voicePortFor(root, "en"));
}

const common = {
  cwd: root,
  script: tsx,
  interpreter: "none",
  env: { NODE_ENV: "production" },
  autorestart: true,
  max_restarts: 10,
  restart_delay: 5000,
  max_memory_restart: "600M",
  time: true,
};

const apps = [
  { ...common, name: "kagzso_orchestrator", args: "apps/api/src/index.ts" },
  // Exactly one worker: the scheduler assumes a single instance.
  { ...common, name: "kagzso_orchestrator_worker", args: "apps/api/src/worker.ts", instances: 1 },
];

// Voice backend (AI calls) - only once its .venv exists. One uvicorn worker:
// live call state is kept in process memory. Bound to localhost; nginx
// publishes it at PUBLIC_BASE_URL for Plivo.
// KAGZSO_SKIP_VOICE=1 is set by scripts/prod-deploy.mjs when the voice setup failed.
if (fs.existsSync(uvicorn) && process.env.KAGZSO_SKIP_VOICE !== "1") {
  apps.push({
    ...common,
    name: "kagzso_orchestrator_voice",
    cwd: voiceDir,
    script: uvicorn,
    args: `app.main:app --host 127.0.0.1 --port ${voicePort()} --workers 1 --proxy-headers --forwarded-allow-ips 127.0.0.1`,
    env: {},
    max_memory_restart: "1G",
  });

  // One more voice backend per language (Tamil, Hindi, Kannada, ...): the same code and .venv,
  // started with its own kagzso-voice-backend-english/.env.<code> (CALL_LANGUAGE, port, database)
  // on the port in Dispatch's VOICE_BACKEND_URL_<CODE>. Only languages whose .env.<code> exists;
  // KAGZSO_SKIP_VOICE_LANGS (set by scripts/prod-deploy.mjs) leaves out ones whose setup failed.
  const skip = new Set((process.env.KAGZSO_SKIP_VOICE_LANGS || "").split(",").filter(Boolean));
  for (const lang of voiceLanguagesSetUp(voiceDir).filter((l) => !skip.has(l))) {
    apps.push({
      ...common,
      name: `kagzso_orchestrator_voice_${lang}`,
      cwd: voiceDir,
      script: uvicorn,
      args: `app.main:app --host 127.0.0.1 --port ${voicePortFor(root, lang)} --workers 1 --proxy-headers --forwarded-allow-ips 127.0.0.1`,
      env: { KAGZSO_ENV_FILE: `.env.${lang}` },
      max_memory_restart: "1G",
    });
  }
}

module.exports = { apps };
