// Data Quality configuration — deliberately separate from src/env.ts.
//
// Like config/aiCalls.ts this reads only its own variables and NEVER throws: a missing or
// wrong value just turns AI scoring off ("<service> not available") and the standard checks
// still run. Nothing else in the app reads these.
//
// DATA_QUALITY_AI_PROVIDER picks the one service that gives the AI score:
//   ollama (default)  OLLAMA_BASE_URL (this machine only) + OLLAMA_MODEL
//   groq              GROQ_API_KEY + GROQ_MODEL      → https://api.groq.com only
//   gemini            GEMINI_API_KEY + GEMINI_MODEL  → https://generativelanguage.googleapis.com only
// Whatever the service, only a row's name and business name are sent (domain/dataQuality.ts).

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv();
// src/config/dataQuality.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

function intIn(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** This machine only: Ollama must never be another host. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export const AI_PROVIDERS = ["ollama", "groq", "gemini"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** The fixed address of each cloud service (not configurable, so nothing else can be reached). */
export const CLOUD_ORIGINS = { groq: "https://api.groq.com", gemini: "https://generativelanguage.googleapis.com" } as const;

export const PROVIDER_LABELS: Record<AiProvider, string> = { ollama: "Ollama", groq: "Groq", gemini: "Gemini" };

export interface AiSettings {
  provider: AiProvider;
  /** Origin requests may go to, or null when unusable. */
  origin: string | null;
  model: string | null;
  /** Groq / Gemini key (never logged or returned by the API). */
  apiKey: string | null;
  /** Why AI scoring is off; null when the settings are usable. */
  problem: string | null;
  timeoutMs: number;
  /** Pause between two rows (cloud services have per-minute limits). */
  minGapMs: number;
}

const MODEL_RE: Record<AiProvider, RegExp> = {
  ollama: /^[A-Za-z0-9._:/-]{1,100}$/,
  groq: /^[A-Za-z0-9._:/-]{1,100}$/,
  gemini: /^[A-Za-z0-9._-]{1,100}$/, // goes into the URL path
};

/** Parse the DATA_QUALITY_AI_* / OLLAMA_* / GROQ_* / GEMINI_* settings. Exported for tests. */
export function readAiSettings(source: Record<string, string | undefined>): AiSettings {
  const timeoutMs = intIn(source.DATA_QUALITY_AI_TIMEOUT_SEC, 60, 5, 240) * 1000;
  const rawProvider = (source.DATA_QUALITY_AI_PROVIDER ?? "").trim().toLowerCase() || "ollama";
  const provider = (AI_PROVIDERS as readonly string[]).includes(rawProvider) ? (rawProvider as AiProvider) : "ollama";
  const minGapMs = intIn(source.DATA_QUALITY_AI_MIN_GAP_MS, provider === "ollama" ? 250 : 2500, 0, 60_000);
  const base = { provider, timeoutMs, minGapMs, apiKey: null };
  if (rawProvider !== provider) {
    return { ...base, origin: null, model: null, problem: `DATA_QUALITY_AI_PROVIDER must be one of: ${AI_PROVIDERS.join(", ")}` };
  }

  if (provider === "ollama") {
    const rawUrl = (source.OLLAMA_BASE_URL ?? "").trim();
    const model = (source.OLLAMA_MODEL ?? "").trim() || null;
    if (!rawUrl) return { ...base, origin: null, model, problem: "OLLAMA_BASE_URL is not set" };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ...base, origin: null, model, problem: "OLLAMA_BASE_URL is not a valid URL" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ...base, origin: null, model, problem: "OLLAMA_BASE_URL must start with http:// or https://" };
    }
    if (!isLoopbackHost(url.hostname)) {
      return { ...base, origin: null, model, problem: "OLLAMA_BASE_URL must point to this server (localhost / 127.0.0.1)" };
    }
    if (!model) return { ...base, origin: url.origin, model, problem: "OLLAMA_MODEL is not set" };
    if (!MODEL_RE.ollama.test(model)) return { ...base, origin: url.origin, model: null, problem: "OLLAMA_MODEL is not a valid model name" };
    return { ...base, origin: url.origin, model, problem: null };
  }

  const prefix = provider === "groq" ? "GROQ" : "GEMINI";
  const apiKey = (source[`${prefix}_API_KEY`] ?? "").trim() || null;
  const model = (source[`${prefix}_MODEL`] ?? "").trim() || null;
  const origin = CLOUD_ORIGINS[provider];
  if (!apiKey) return { ...base, origin: null, model, problem: `${prefix}_API_KEY is not set` };
  if (!model) return { ...base, origin: null, model, problem: `${prefix}_MODEL is not set` };
  if (!MODEL_RE[provider].test(model)) return { ...base, origin: null, model: null, problem: `${prefix}_MODEL is not a valid model name` };
  return { ...base, origin, model, apiKey, problem: null };
}

export const dataQualityConfig = {
  ai: readAiSettings(process.env),
} as const;
