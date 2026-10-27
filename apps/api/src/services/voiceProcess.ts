// Start a language's voice backend from Settings → AI call languages ("Run", or switching a
// language on while its backend is down). Only ever this project's own voice backend for that
// language, with fixed commands (no shell; the only input is the language code):
//
//   - on the server (the API itself runs under PM2): `pm2 restart kagzso_orchestrator_voice_<code>`
//     when PM2 already knows it, else `pm2 start deploy/ecosystem.config.cjs --only <that name>`,
//     then `pm2 save` (survives a reboot). No other app's process is ever named.
//   - on a PC (npm run dev): uvicorn from kagzso-voice-backend-english/.venv with .env.<code>, in
//     the background, logging to kagzso-voice-backend-english/voice-<code>.log; npm run dev:kill
//     stops it like the others.
//
// Its database migrations run first (alembic upgrade head: nothing to do when they're applied).
// Nothing is started when the backend already answers, when its address isn't on this machine,
// or with AI_CALL_BACKEND_CONTROL=false. Every command gets a clean environment (PATH, HOME, …),
// so Dispatch's own .env (its DATABASE_URL, LOG_LEVEL, …) can never reach the voice backend.

import { execFile, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_AI_CALL_LANGUAGE, type AiCallLanguage } from "@dispatch/shared";
import { voiceBackendFor } from "../config/aiCalls.js";
import { voiceBackendLabel, voiceBackendSettingNames } from "./voiceBackend.js";

const exec = promisify(execFile);
// src/services/voiceProcess.ts → the repo root is four levels up.
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const VOICE_DIR = path.join(ROOT, "kagzso-voice-backend-english");
const ECOSYSTEM = path.join(ROOT, "deploy", "ecosystem.config.cjs");
const START_WAIT_MS = 30_000;

export class VoiceProcessError extends Error {
  constructor(
    public readonly status: 409 | 500 | 503,
    message: string,
  ) {
    super(message);
    this.name = "VoiceProcessError";
  }
}

/** The PM2 process name of a language's voice backend (as in deploy/ecosystem.config.cjs). */
export const voicePm2Name = (l: AiCallLanguage) =>
  l === DEFAULT_AI_CALL_LANGUAGE ? "kagzso_orchestrator_voice" : `kagzso_orchestrator_voice_${l}`;
/** The language's .env inside kagzso-voice-backend-english. */
export const voiceEnvFile = (l: AiCallLanguage) => (l === DEFAULT_AI_CALL_LANGUAGE ? ".env" : `.env.${l}`);

/** Run / switch-on may start voice backends unless AI_CALL_BACKEND_CONTROL=false. */
export function voiceBackendControlEnabled(): boolean {
  return !["false", "0", "no", "off"].includes((process.env.AI_CALL_BACKEND_CONTROL ?? "").trim().toLowerCase());
}

/** The API runs under PM2 (the server): PM2 starts the voice backend too. */
const underPm2 = () => process.env.pm_id !== undefined;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Only what a login shell has: never Dispatch's own .env values (DATABASE_URL, LOG_LEVEL, …). */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "USER", "LOGNAME", "LANG", "LC_ALL", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PM2_HOME",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

const venvBin = (name: string) =>
  process.platform === "win32" ? path.join(VOICE_DIR, ".venv", "Scripts", `${name}.exe`) : path.join(VOICE_DIR, ".venv", "bin", name);

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

/** The last lines of a failed command's output, for the admin (never the environment). */
function tail(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const text = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim() || e.message || String(err);
  return text.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ").slice(-600);
}

const starting = new Set<AiCallLanguage>();

/**
 * Start the language's voice backend unless it already answers. Resolves once it answers
 * (or throws a VoiceProcessError saying why it couldn't, and what to check).
 */
export async function startVoiceBackend(language: AiCallLanguage): Promise<{ started: boolean; how: "pm2" | "process" | "already_running" }> {
  const label = voiceBackendLabel(language);
  const backend = voiceBackendFor(language);
  if (!backend) {
    throw new VoiceProcessError(
      409,
      `${label} is not set up — set ${voiceBackendSettingNames(language)} (npm run voice:lang:init -- ${language}), then restart Dispatch`,
    );
  }
  if (await answers(backend.url)) return { started: false, how: "already_running" };
  if (!voiceBackendControlEnabled()) {
    throw new VoiceProcessError(409, `${label} isn't running, and starting voice backends from Settings is turned off (AI_CALL_BACKEND_CONTROL=false)`);
  }

  const url = new URL(backend.url);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new VoiceProcessError(409, `${label} is on another machine (${url.host}) — start it there`);
  const port = Number(url.port);
  if (!port) throw new VoiceProcessError(409, `${voiceBackendSettingNames(language).split(" / ")[0]} needs a port, e.g. http://127.0.0.1:8003`);
  const envFile = voiceEnvFile(language);
  if (!existsSync(path.join(VOICE_DIR, envFile))) {
    throw new VoiceProcessError(409, `kagzso-voice-backend-english/${envFile} doesn't exist — run npm run voice:lang:init -- ${language} first`);
  }
  if (!existsSync(venvBin("python"))) {
    throw new VoiceProcessError(409, "kagzso-voice-backend-english/.venv doesn't exist — create it (see its README) first");
  }
  if (starting.has(language)) throw new VoiceProcessError(409, `${label} is already being started — wait a few seconds`);
  starting.add(language);
  try {
    // Its own database: apply the migrations first (idempotent).
    try {
      await exec(venvBin("alembic"), ["upgrade", "head"], { cwd: VOICE_DIR, env: cleanEnv({ KAGZSO_ENV_FILE: envFile }), timeout: 120_000 });
    } catch (err) {
      throw new VoiceProcessError(500, `${label}: its database migrations failed — check MYSQL_* in ${envFile} (the database must exist). ${tail(err)}`);
    }

    let how: "pm2" | "process";
    if (underPm2()) {
      how = "pm2";
      const name = voicePm2Name(language);
      const env = cleanEnv();
      try {
        const { stdout } = await exec("pm2", ["jlist"], { cwd: ROOT, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        const known = (JSON.parse(stdout) as { name?: string }[]).some((p) => p.name === name);
        await exec("pm2", known ? ["restart", name] : ["start", ECOSYSTEM, "--only", name], { cwd: ROOT, env, timeout: 60_000 });
        await exec("pm2", ["save"], { cwd: ROOT, env, timeout: 30_000 });
      } catch (err) {
        throw new VoiceProcessError(500, `${label}: PM2 couldn't start ${name} — on the server run npm run prod. ${tail(err)}`);
      }
    } else {
      how = "process";
      const log = openSync(path.join(VOICE_DIR, `voice-${language}.log`), "a");
      const child = spawn(
        venvBin("python"),
        ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)],
        { cwd: VOICE_DIR, env: cleanEnv({ KAGZSO_ENV_FILE: envFile }), detached: true, stdio: ["ignore", log, log], windowsHide: true },
      );
      child.unref(); // keeps running when the API reloads; npm run dev:kill stops it
    }

    for (const until = Date.now() + START_WAIT_MS; Date.now() < until; ) {
      if (await answers(backend.url)) return { started: true, how };
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const where = how === "pm2" ? `pm2 logs ${voicePm2Name(language)}` : `kagzso-voice-backend-english/voice-${language}.log`;
    throw new VoiceProcessError(500, `${label} didn't answer within ${START_WAIT_MS / 1000} s — see ${where}`);
  } finally {
    starting.delete(language);
  }
}
