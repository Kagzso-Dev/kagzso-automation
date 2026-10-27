// `npm run prod` (Linux server): the production twin of
//   npm run dev:kill  →  npm run prisma:deploy  →  npm run dev
//
//   1. install dependencies
//   2. apply database migrations (MySQL, and the voice backend's if it is set up -
//      English with .env, every other language with its own .env.<code>)
//   3. build the web app (nginx serves apps/web/dist)
//   4. stop + start ONLY this project's PM2 processes (deploy/ecosystem.config.cjs)
//
// Other PM2 apps on the server are never touched: every pm2 call names this
// project's processes explicitly. Stops at the first failing step, before any
// running process is stopped. A language voice backend that can't be set up
// (e.g. its database doesn't exist yet) is reported and left out; English and
// the other languages deploy as normal.

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voiceDir = path.join(root, "kagzso-voice-backend-english");
const voiceBin = path.join(voiceDir, ".venv", "bin");
const ecosystem = path.join(root, "deploy", "ecosystem.config.cjs");

if (process.platform === "win32") {
  console.error("npm run prod is for the Linux server. On this PC use: npm run dev:kill; npm run prisma:deploy; npm run dev");
  process.exit(1);
}

const run = (title, cmd, cwd = root, env = process.env) => {
  console.log(`\n[prod] ${title}\n       $ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit", env });
};
const { voiceLanguagesSetUp } = createRequire(import.meta.url)("./voice-languages.cjs");

run("Installing dependencies", "npm install --no-audit --no-fund");
run("Generating the Prisma client", "npm run prisma:generate");
run("Applying database migrations", "npm run prisma:deploy");
run("Building the web app", "npm run build");

// Like dev:voice, a voice backend problem never blocks the email/WhatsApp deploy:
// it is reported, and the voice process is left out of this start.
let skipVoice = false;
if (existsSync(path.join(voiceBin, "python"))) {
  try {
    run("Voice backend: installing requirements", `${path.join(voiceBin, "pip")} install -q -r requirements.txt`, voiceDir);
    run("Voice backend: applying migrations", `${path.join(voiceBin, "alembic")} upgrade head`, voiceDir);
  } catch {
    skipVoice = true;
    console.warn(
      "\n[prod] WARNING: voice backend setup failed (see the error above) - deploying without it.\n" +
        "       Fix kagzso-voice-backend-english/.env (MYSQL_* etc.), then rerun npm run prod.",
    );
  }
} else {
  console.log("\n[prod] Voice backend skipped - no kagzso-voice-backend-english/.venv (create it to run AI calls).");
}
// The other languages' voice backends: the same code, each with its own .env.<code> and database.
const skipLangs = [];
if (!skipVoice && existsSync(path.join(voiceBin, "python"))) {
  for (const lang of voiceLanguagesSetUp(voiceDir)) {
    try {
      run(
        `Voice backend (${lang}): applying migrations to its own database (.env.${lang})`,
        `${path.join(voiceBin, "alembic")} upgrade head`,
        voiceDir,
        { ...process.env, KAGZSO_ENV_FILE: `.env.${lang}` },
      );
    } catch {
      skipLangs.push(lang);
      console.warn(
        `\n[prod] WARNING: the ${lang} voice backend could not be set up (see the error above) - deploying without it.\n` +
          `       Check kagzso-voice-backend-english/.env.${lang} (MYSQL_DATABASE exists, MYSQL_* login), then rerun npm run prod.`,
      );
    }
  }
}
// deploy/ecosystem.config.cjs reads these when pm2 loads it below.
if (skipVoice) process.env.KAGZSO_SKIP_VOICE = "1";
if (skipLangs.length) process.env.KAGZSO_SKIP_VOICE_LANGS = skipLangs.join(",");

// Same idea as dev:kill, scoped to this project's process names only.
// With KAGZSO_SKIP_VOICE (or a language in KAGZSO_SKIP_VOICE_LANGS) set, that
// voice process is not in this list, so an already-running one is left alone.
const names = createRequire(import.meta.url)(ecosystem).apps.map((a) => a.name);
for (const name of names) {
  try {
    execSync(`pm2 describe ${name}`, { stdio: "ignore" });
    run(`Stopping ${name}`, `pm2 delete ${name}`);
  } catch {
    /* not running yet */
  }
}
run("Starting this project's processes", `pm2 start ${ecosystem}`);
run("Saving the PM2 process list (survives reboot)", "pm2 save");
run("Status", `pm2 ls`);
