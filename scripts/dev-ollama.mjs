// `npm run dev:ollama` (part of `npm run dev`): makes sure a local Ollama server
// is running for the Data Quality AI score (OLLAMA_BASE_URL, default :11434).
//
// Never breaks the rest of the dev stack: if Ollama is already running, not
// installed, or OLLAMA_BASE_URL is blank, it prints why and exits 0.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnv(key) {
  try {
    const line = readFileSync(path.join(root, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${key}=`));
    if (!line) return "";
    return line.split("=").slice(1).join("=").replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "";
  }
}

function isBusy(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
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
  console.log(`[ollama] ${why}`);
  process.exit(0);
};

const baseUrl = readEnv("OLLAMA_BASE_URL");
if (!baseUrl) skip("OLLAMA_BASE_URL is blank in .env — Data Quality runs the standard checks only.");

let url;
try {
  url = new URL(baseUrl);
} catch {
  skip(`OLLAMA_BASE_URL (${baseUrl}) is not a valid URL — skipping.`);
}
const host = url.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1";
const port = Number(url.port || 11434);
const model = readEnv("OLLAMA_MODEL");

if (await isBusy(port, host)) {
  skip(`already running on :${port}${model ? ` (model ${model})` : ""} — leaving it alone.`);
}

// Find the binary: PATH first, then the default Windows install location.
const candidates = [
  "ollama",
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs", "Ollama", "ollama.exe"),
];
const bin = candidates.find((c) => c === "ollama" || existsSync(c));

console.log(`[ollama] starting \`ollama serve\` on ${host}:${port}`);
const child = spawn(bin, ["serve"], {
  stdio: "inherit",
  env: { ...process.env, OLLAMA_HOST: `${host}:${port}` },
});
child.on("error", () => skip("Ollama is not installed (https://ollama.com/download) — Data Quality runs the standard checks only."));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
