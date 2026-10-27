// `npm run dev:voice` (part of `npm run dev`): starts kagzso-voice-backend-english
// with auto-reload, on the port in VOICE_BACKEND_URL (default 8002). Every other
// language with its own kagzso-voice-backend-english/.env.<code> (Tamil .env.ta, ...)
// starts too, from the same code, on the port in VOICE_BACKEND_URL_<CODE>
// (scripts/voice-languages.cjs), plus the gateway that gives them all one public
// address (scripts/voice-gateway.mjs: /ta → Tamil, ..., the rest → English).
//
// Never breaks the rest of the dev stack: if the voice backend folder or its
// .venv is missing, or a port is already taken, it prints why and leaves that
// backend out (exit 0 when nothing is left to run).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayPort, startVoiceGateway } from "./voice-gateway.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voiceDir = path.join(root, "kagzso-voice-backend-english");
const { voiceLanguagesSetUp, voicePortFor } = createRequire(import.meta.url)("./voice-languages.cjs");

function isBusy(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const skip = (why) => {
  console.log(`[voice] ${why}`);
  process.exit(0);
};

const python = [path.join(voiceDir, ".venv", "Scripts", "python.exe"), path.join(voiceDir, ".venv", "bin", "python")].find(
  existsSync,
);
if (!existsSync(voiceDir)) skip("kagzso-voice-backend-english/ not found — skipping the voice backend.");
if (!python) skip("No .venv in kagzso-voice-backend-english — create it (see its README) to start it with `npm run dev`.");

const children = [];
for (const lang of ["en", ...voiceLanguagesSetUp(voiceDir)]) {
  const port = voicePortFor(root, lang);
  const tag = lang === "en" ? "[voice]" : `[voice:${lang}]`;
  if (await isBusy(port)) {
    console.log(
      `${tag} Port ${port} is already in use — leaving the running voice backend alone. ` +
        "Stop it (npm run dev:kill) and rerun `npm run dev` if it's an old process without --reload.",
    );
    continue;
  }
  console.log(`${tag} starting on :${port}${lang === "en" ? "" : ` with .env.${lang}`} (auto-reload on app/ changes)`);
  const child = spawn(
    python,
    ["-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", String(port), "--reload", "--reload-dir", "app"],
    { cwd: voiceDir, stdio: "inherit", env: lang === "en" ? process.env : { ...process.env, KAGZSO_ENV_FILE: `.env.${lang}` } },
  );
  children.push(child);
  // English decides when dev:voice ends, as before; a language backend that stops only logs it.
  child.on("exit", (code) => {
    if (lang === "en") process.exit(code ?? 0);
    console.log(`${tag} stopped (exit ${code ?? 0})`);
  });
}
// One public address for all of them (only needed once another language is set up).
if (voiceLanguagesSetUp(voiceDir).length > 0) {
  const port = gatewayPort(root);
  if (await isBusy(port)) {
    console.log(`[voice] gateway port ${port} is already in use — leaving it alone.`);
  } else {
    const gateway = startVoiceGateway({ root, voiceDir, port });
    children.push({ kill: () => gateway.close() });
  }
}
if (children.length === 0) process.exit(0);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => children.forEach((c) => c.kill(sig)));
