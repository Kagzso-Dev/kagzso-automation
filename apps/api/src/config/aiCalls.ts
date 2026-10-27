// AI voice-call configuration — deliberately separate from src/env.ts.
//
// Like config/whatsapp.ts this reads only its own variables and NEVER throws:
// a missing/blank value just disables AI calls (the Contacts page hides the
// button). Email, WhatsApp and app startup are unaffected.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { AI_CALL_LANGUAGES, AI_CALL_STANDARD_LANGUAGES, DEFAULT_AI_CALL_LANGUAGE, type AiCallLanguage } from "@dispatch/shared";

loadEnv();
// src/config/aiCalls.ts → repo root is four levels up.
loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

function str(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function intIn(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Absolute ceiling on calls per run, whatever the env says. */
export const AI_CALLS_ABSOLUTE_MAX_PER_RUN = 100;

export const aiCallsConfig = {
  enabled: ["true", "1", "yes"].includes((process.env.ENABLE_AI_CALLS ?? "").trim().toLowerCase()),
  voiceBackendUrl: str(process.env.VOICE_BACKEND_URL)?.replace(/\/+$/, ""),
  voiceBackendApiKey: str(process.env.VOICE_BACKEND_API_KEY),
  /** Optional: a specific agent id in the voice backend. Blank = the agent named VOICE_AGENT_NAME (default Nila; the names Radhi and Kayal also still work). */
  voiceAgentId: intIn(process.env.VOICE_AGENT_ID, 0, 0, Number.MAX_SAFE_INTEGER) || undefined,
  voiceAgentName: str(process.env.VOICE_AGENT_NAME) ?? "Nila",
  /** Shared secret the voice backend signs status callbacks with (HMAC-SHA256). */
  webhookSecret: str(process.env.AI_CALL_WEBHOOK_SECRET),
  defaultCountryCode: (str(process.env.AI_CALLS_DEFAULT_COUNTRY_CODE) ?? "91").replace(/\D/g, "") || "91",
  /** Hard cap on calls in one run (the UI's "max calls" can only go lower). */
  maxPerRun: intIn(process.env.AI_CALLS_MAX_PER_RUN, 10, 1, AI_CALLS_ABSOLUTE_MAX_PER_RUN),
  /** Calls dialled per rolling 24h across all runs. */
  dailyCap: intIn(process.env.AI_CALLS_DAILY_CAP, 100, 1, 10_000),
  minGapSec: intIn(process.env.AI_CALLS_MIN_GAP_SEC, 10, 5, 3600),
  /** A call with no final status after this long is marked FAILED and the run moves on. */
  callTimeoutSec: intIn(process.env.AI_CALLS_CALL_TIMEOUT_SEC, 900, 120, 7200),
  /** "Call Flows" editor + flow picker in the AI Call modal. Off = every call uses the default agent. */
  flowEditorEnabled: ["true", "1", "yes"].includes((process.env.ENABLE_CALL_FLOW_EDITOR ?? "").trim().toLowerCase()),
  /** AI Call Customers: how many "call again" drafts a No answer may create per customer. */
  followupMaxRetries: intIn(process.env.AI_CALL_FOLLOWUP_MAX_RETRIES, 2, 0, 10),
  /** E.164 numbers the "Test call to my number" button may dial (comma-separated). Empty = test calls off. */
  flowTestNumbers: (process.env.AI_CALL_FLOW_TEST_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => /^\+[1-9]\d{7,14}$/.test(n)),
} as const;

/** Both flags: AI calls on and the Call Flows editor on. */
export function isCallFlowEditorEnabled(): boolean {
  return aiCallsConfig.enabled && aiCallsConfig.flowEditorEnabled;
}

export interface VoiceBackendTarget {
  url: string;
  apiKey: string;
}

/**
 * One voice backend per language. English: VOICE_BACKEND_URL + VOICE_BACKEND_API_KEY (as before).
 * Any other language: VOICE_BACKEND_URL_<CODE> (e.g. VOICE_BACKEND_URL_TA) + VOICE_BACKEND_API_KEY_<CODE>,
 * whose key defaults to the English one (the same ADMIN_API_KEY in every backend's .env).
 */
const voiceBackends: Partial<Record<AiCallLanguage, VoiceBackendTarget>> = Object.fromEntries(
  AI_CALL_LANGUAGES.flatMap((lang) => {
    const suffix = lang === DEFAULT_AI_CALL_LANGUAGE ? "" : `_${lang.toUpperCase()}`;
    const url = str(process.env[`VOICE_BACKEND_URL${suffix}`])?.replace(/\/+$/, "");
    const apiKey = str(process.env[`VOICE_BACKEND_API_KEY${suffix}`]) ?? aiCallsConfig.voiceBackendApiKey;
    return url && apiKey ? [[lang, { url, apiKey }]] : [];
  }),
);

/** The language's voice backend, or null when its URL / key are not set. */
export function voiceBackendFor(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): VoiceBackendTarget | null {
  return voiceBackends[language] ?? null;
}

/** English (always, configured or not) and every other language whose voice backend is set. */
export function configuredAiCallLanguages(): AiCallLanguage[] {
  return AI_CALL_LANGUAGES.filter((l) => l === DEFAULT_AI_CALL_LANGUAGE || voiceBackends[l]);
}

/** The languages with pages: English, Tamil, Hindi, Kannada (set up or not) and any other one whose voice backend is set. */
export function offeredAiCallLanguages(): AiCallLanguage[] {
  return AI_CALL_LANGUAGES.filter((l) => AI_CALL_STANDARD_LANGUAGES.includes(l) || voiceBackends[l]);
}

/** True when calls can actually be placed in this language (its voice backend URL + key are set). */
export function isAiCallsConfigured(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): boolean {
  return voiceBackendFor(language) !== null;
}
