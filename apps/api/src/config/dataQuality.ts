// Data Quality configuration — deliberately separate from src/env.ts.
//
// Like config/aiCalls.ts this reads only its own variables and NEVER throws: a missing,
// blank or non-local OLLAMA_BASE_URL just turns AI scoring off ("Ollama not available")
// and the standard checks still run. Nothing else in the app reads these.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/dataQuality.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

function intIn(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** This machine only: uploaded records must never leave the server. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export interface OllamaSettings {
  /** Origin of the local Ollama server (e.g. http://127.0.0.1:11434), or null when unusable. */
  origin: string | null;
  model: string | null;
  /** Why AI scoring is off; null when both settings are usable. */
  problem: string | null;
  timeoutMs: number;
}

/** Parse OLLAMA_BASE_URL / OLLAMA_MODEL. Exported for tests; the app uses `dataQualityConfig`. */
export function readOllamaSettings(source: Record<string, string | undefined>): OllamaSettings {
  const timeoutMs = intIn(source.DATA_QUALITY_AI_TIMEOUT_SEC, 60, 5, 240) * 1000;
  const rawUrl = (source.OLLAMA_BASE_URL ?? "").trim();
  const model = (source.OLLAMA_MODEL ?? "").trim() || null;
  if (!rawUrl) return { origin: null, model, problem: "OLLAMA_BASE_URL is not set", timeoutMs };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { origin: null, model, problem: "OLLAMA_BASE_URL is not a valid URL", timeoutMs };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { origin: null, model, problem: "OLLAMA_BASE_URL must start with http:// or https://", timeoutMs };
  }
  if (!isLoopbackHost(url.hostname)) {
    return { origin: null, model, problem: "OLLAMA_BASE_URL must point to this server (localhost / 127.0.0.1)", timeoutMs };
  }
  if (!model) return { origin: url.origin, model, problem: "OLLAMA_MODEL is not set", timeoutMs };
  return { origin: url.origin, model, problem: null, timeoutMs };
}

export const dataQualityConfig = {
  ollama: readOllamaSettings(process.env),
} as const;
