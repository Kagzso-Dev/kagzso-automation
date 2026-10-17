// `npm run prod` (Linux server): the production twin of
//   npm run dev:kill  →  npm run prisma:deploy  →  npm run dev
//
//   1. install dependencies
//   2. apply database migrations (MySQL, and the voice backend's if it is set up)
//   3. build the web app (nginx serves apps/web/dist)
//   4. stop + start ONLY this project's PM2 processes (deploy/ecosystem.config.cjs)
//
// Other PM2 apps on the server are never touched: every pm2 call names this
// project's processes explicitly. Stops at the first failing step, before any
// running process is stopped.

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

const run = (title, cmd, cwd = root) => {
  console.log(`\n[prod] ${title}\n       $ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

run("Installing dependencies", "npm install --no-audit --no-fund");
run("Generating the Prisma client", "npm run prisma:generate");
run("Applying database migrations", "npm run prisma:deploy");
run("Building the web app", "npm run build");

if (existsSync(path.join(voiceBin, "python"))) {
  run("Voice backend: installing requirements", `${path.join(voiceBin, "pip")} install -q -r requirements.txt`, voiceDir);
  run("Voice backend: applying migrations", `${path.join(voiceBin, "alembic")} upgrade head`, voiceDir);
} else {
  console.log("\n[prod] Voice backend skipped - no kagzso-voice-backend-english/.venv (create it to run AI calls).");
}

// Same idea as dev:kill, scoped to this project's process names only.
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
