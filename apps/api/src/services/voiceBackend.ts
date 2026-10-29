// HTTP client for kagzso-voice-backend (FastAPI). Raw fetch, no SDK.
//   POST /api/calls/outbound   place one call
//   GET  /api/calls/{id}       read its status / outcome / transcript
// Auth: X-API-Key = VOICE_BACKEND_API_KEY (the voice backend's ADMIN_API_KEY).
//
// One voice backend per language (config/aiCalls voiceBackendFor): every function takes the
// language last, English by default, so English callers work exactly as before. A call's
// status, recording and so on are read from the backend of the language that placed it.

import {
  AI_CALL_LANGUAGE_NAMES,
  DEFAULT_AI_CALL_LANGUAGE,
  type AiCallLanguage,
  type AiProviderId,
  type AiProviderSelectionInput,
  type AiProviderSettingsView,
  type AiProviderUpdateInput,
} from "@dispatch/shared";
import { aiCallsConfig, isAiCallsConfigured, voiceBackendFor, type VoiceBackendTarget } from "../config/aiCalls.js";

export class VoiceBackendError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    /** True for network errors / 5xx / 429 — the call may succeed if retried later. */
    public readonly retryable: boolean,
    /** The voice backend's own error code, when it sends one ({"detail": {"message", "code"}}). */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "VoiceBackendError";
  }
}

export interface PlaceCallInput {
  customerName: string | null;
  gender: string | null;
  followUpDetail: string | null;
  phone: string; // E.164
  runId: string;
  logId: string;
  /** Pinned call flow version (absent = the default agent, exactly as before). */
  flow?: PinnedFlow | null;
  /** Seconds after answer before the greeting (Start AI Calls); absent = the voice backend's own timing. */
  greetingDelaySec?: number | null;
  /** The run's language: which voice backend places the call (absent = English). */
  language?: AiCallLanguage;
}

export interface PinnedFlow {
  flowId: string;
  version: number;
  draft: boolean;
  definition: unknown;
}

export interface VoiceCallDetail {
  id: string;
  provider_call_id: string | null;
  status: string;
  outcome: string | null;
  summary: string | null;
  hangup_cause: string | null;
  duration_seconds: number | null;
  ended_at: string | null;
  transcripts?: { speaker: string; text: string }[];
}

/** FastAPI errors: {"detail": "msg"} or {"detail": [{"loc": [...], "msg": "..."}]}. */
function detailMessage(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string") {
    return (detail as { message: string }).message;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => {
        const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
        return field ? `${field}: ${d.msg}` : String(d.msg ?? "");
      })
      .join("; ");
  }
  return fallback;
}

/** The .env names a language's voice backend needs, for "not configured" messages. */
export function voiceBackendSettingNames(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): string {
  return language === DEFAULT_AI_CALL_LANGUAGE ? "VOICE_BACKEND_URL / VOICE_BACKEND_API_KEY" : `VOICE_BACKEND_URL_${language.toUpperCase()}`;
}

/** "Voice backend" for English (as before), "Tamil voice backend" for the others. */
export function voiceBackendLabel(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): string {
  return language === DEFAULT_AI_CALL_LANGUAGE ? "Voice backend" : `${AI_CALL_LANGUAGE_NAMES[language]} voice backend`;
}

/** The language's backend, or a (not retryable) error naming the setting to add. */
function target(language: AiCallLanguage): VoiceBackendTarget {
  const t = voiceBackendFor(language);
  if (!t) throw new VoiceBackendError(`${voiceBackendLabel(language)} is not configured (${voiceBackendSettingNames(language)})`, null, false);
  return t;
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  json?: unknown,
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const backend = target(language);
  let res: Response;
  try {
    res = await fetch(`${backend.url}${path}`, {
      method,
      headers: {
        ...extraHeaders,
        "X-API-Key": backend.apiKey,
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new VoiceBackendError(`Voice backend unreachable: ${why}`, null, true);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = detailMessage(body, res.statusText);
    const code = (body as { detail?: { code?: unknown } } | null)?.detail?.code;
    throw new VoiceBackendError(`Voice backend ${res.status}: ${msg}`, res.status, res.status >= 500 || res.status === 429,
      typeof code === "string" ? code : undefined);
  }
  return body as T;
}

/** The voice backend's /ready answer (it is 503 while not ready; the body is read either way). */
export interface VoiceReady {
  status?: string;
  mysql?: string;
  providers?: Record<string, string> & { public_base_url?: string };
  public_base_url_check?: { url?: string | null; reason?: string | null };
  telephony_provider?: string;
  /** The language it calls in (CALL_LANGUAGE); absent on a voice backend from before languages. */
  language?: string;
}

/** GET /ready of the language's backend (no API key: /ready is public). Throws when it can't be reached. */
export async function getVoiceReady(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): Promise<VoiceReady> {
  // Longer than the backend's own 5 s self-check of PUBLIC_BASE_URL.
  const res = await fetch(`${target(language).url}/ready`, { signal: AbortSignal.timeout(8_000) });
  const body = (await res.json().catch(() => null)) as VoiceReady | null;
  if (!body) throw new VoiceBackendError(`${voiceBackendLabel(language)} /ready answered ${res.status} without a body`, res.status, true);
  return body;
}

/** A backend reporting another language than the one Dispatch sends it: every call would speak the wrong language. */
export function languageMismatch(language: AiCallLanguage, ready: VoiceReady): string | null {
  if (!ready.language || ready.language === language) return null;
  const said = AI_CALL_LANGUAGE_NAMES[ready.language as AiCallLanguage] ?? ready.language;
  return (
    `The ${AI_CALL_LANGUAGE_NAMES[language]} calls go to a voice backend that calls in ${said} (CALL_LANGUAGE=${ready.language}). ` +
    `Fix ${voiceBackendSettingNames(language).split(" / ")[0]} in Dispatch's .env, or CALL_LANGUAGE in that backend's .env, and restart it.`
  );
}

/**
 * Why calls can't connect right now, or null. The voice backend's /ready calls itself through
 * its PUBLIC_BASE_URL (the address Plivo / Twilio use) and says "unreachable" when that fails,
 * e.g. the ngrok tunnel is stopped. A backend that calls in another language than this one is
 * refused too. Any other answer (ready, an older voice backend without the check, no answer at
 * all) is null: calls go out as before and fail on their own if they must.
 */
export async function voiceCallsBlockedReason(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): Promise<string | null> {
  if (!isAiCallsConfigured(language)) return null;
  try {
    const body = await getVoiceReady(language);
    const mismatch = languageMismatch(language, body);
    if (mismatch) return mismatch;
    if (body.providers?.public_base_url !== "unreachable") return null;
    const provider = body.telephony_provider === "twilio" ? "Twilio" : "Plivo";
    const url = body.public_base_url_check?.url ?? "its PUBLIC_BASE_URL";
    const why = body.public_base_url_check?.reason ? ` (${body.public_base_url_check.reason})` : "";
    const backend = voiceBackendLabel(language).replace(/^Voice/, "voice");
    return `Calls can't connect: ${provider} can't reach the ${backend} at ${url}${why}. Start ngrok, or fix PUBLIC_BASE_URL in the ${backend}'s .env and restart it, then try again.`;
  } catch {
    return null;
  }
}

export async function placeVoiceCall(input: PlaceCallInput): Promise<{ callId: string; providerCallId: string | null }> {
  const res = await request<{ success: boolean; call_id: string; provider_call_id: string | null }>(
    "POST",
    "/api/calls/outbound",
    {
      phone_number: input.phone,
      customer_name: input.customerName || undefined,
      gender: input.gender || undefined,
      follow_up_detail: input.followUpDetail || undefined,
      run_id: input.runId,
      log_id: input.logId,
      ...(input.greetingDelaySec != null ? { greeting_delay_sec: input.greetingDelaySec } : {}),
      ...(input.flow
        ? {
            flow_id: input.flow.flowId,
            flow_version: input.flow.version,
            flow_draft: input.flow.draft,
            flow: input.flow.definition,
          }
        : {}),
      // VOICE_AGENT_ID is a row in the English backend's database; another language's backend
      // has its own rows, so it is only ever asked by name (its built-in Nila, in its language).
      ...(aiCallsConfig.voiceAgentId && (input.language ?? DEFAULT_AI_CALL_LANGUAGE) === DEFAULT_AI_CALL_LANGUAGE
        ? { agent_id: aiCallsConfig.voiceAgentId }
        : { agent_name: aiCallsConfig.voiceAgentName }),
    },
    input.language,
  );
  return { callId: res.call_id, providerCallId: res.provider_call_id ?? null };
}

export interface VoiceFlowCatalog {
  flows: Record<string, Record<string, unknown>>;
  locked_blocks: Record<string, string>;
  variables: string[];
  groups: string[];
  limits: { max_duration_sec: number; max_block_chars: number; max_prompt_chars: number };
  /** The voices a flow may pick (the voice backend's list is the only one). */
  voices?: VoiceOption[];
  default_voice?: string;
  /** CALL_RECORDING_ENABLED on the voice backend (absent on an older one = off). */
  recording_enabled?: boolean;
  /** The language the backend calls in (absent on a voice backend from before languages = English). */
  language?: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  gender?: string;
  language?: string;
}

export interface VoiceFlowPreview {
  valid: boolean;
  errors: string[];
  greeting: string | null;
  system_prompt: string | null;
  script_chars: number | null;
  silence_reprompt: string | null;
  silence_closing: string | null;
  max_duration_sec: number | null;
  /** System-spoken after a time-of-day opening; null when skipped (opening names the customer, or no name). */
  identity_question?: string | null;
  identity_reask?: string | null;
}

/** Built-in flows (the defaults to copy) + locked block text, from the language's voice backend. */
export function getBuiltinFlows(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): Promise<VoiceFlowCatalog> {
  return request<VoiceFlowCatalog>("GET", "/api/flows/builtin", undefined, language);
}

/** Validate a flow and render it exactly as a call would (the flow language's voice backend is the authority). */
export function previewFlow(
  definition: unknown,
  sample: Record<string, unknown> = {},
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
): Promise<VoiceFlowPreview> {
  return request<VoiceFlowPreview>("POST", "/api/flows/preview", { flow: definition, sample }, language);
}

/** "Listen": a WAV of `voiceId` saying `text` ({{short_delay}} etc. as real silence). Text-to-speech only — the voice backend dials nothing. */
export async function previewVoice(
  voiceId: string,
  text: string,
  pauses?: { short_ms: number; medium_ms: number; long_ms: number },
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
): Promise<Buffer> {
  const backend = target(language);
  let res: Response;
  try {
    res = await fetch(`${backend.url}/api/voices/preview`, {
      method: "POST",
      headers: { "X-API-Key": backend.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: voiceId, text, ...(pauses ? { pauses } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new VoiceBackendError(`Voice backend unreachable: ${why}`, null, true);
  }
  if (!res.ok) {
    const msg = detailMessage(await res.json().catch(() => null), res.statusText);
    throw new VoiceBackendError(`Voice backend ${res.status}: ${msg}`, res.status, res.status >= 500 || res.status === 429);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function getVoiceCall(voiceCallId: string, language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): Promise<VoiceCallDetail> {
  return request<VoiceCallDetail>("GET", `/api/calls/${encodeURIComponent(voiceCallId)}`, undefined, language);
}

/* ------------------------------------------------------------------ call recordings */

/** One call's recording as the voice backend describes it (never a path or URL). */
export interface VoiceRecording {
  call_id: string;
  status: "processing" | "completed" | "failed" | "deleted";
  format: string;
  duration_ms: number | null;
  size_bytes: number | null;
  error: string | null;
  created_at: string | null;
  completed_at: string | null;
  deleted_at: string | null;
}

export function getRecording(
  voiceCallId: string,
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
): Promise<{ enabled: boolean; recording: VoiceRecording | null }> {
  return request("GET", `/api/recordings/${encodeURIComponent(voiceCallId)}`, undefined, language);
}

export function listRecordings(
  voiceCallIds: string[],
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
): Promise<{ enabled: boolean; items: VoiceRecording[] }> {
  return request("GET", `/api/recordings?call_ids=${voiceCallIds.map(encodeURIComponent).join(",")}`, undefined, language);
}

/** Settings > Call recordings: counts, space used, free disk and the retention period. */
export interface VoiceRecordingSettings {
  enabled: boolean;
  storage_configured: boolean;
  retention_days: number;
  default_retention_days: number;
  max_retention_days: number;
  counts: { completed: number; processing: number; failed: number; deleted: number };
  total_bytes: number;
  oldest_at: string | null;
  disk_free_bytes: number | null;
}

export function getRecordingSettings(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): Promise<VoiceRecordingSettings> {
  return request("GET", "/api/recordings/settings", undefined, language);
}

/** 0 = keep recordings forever. */
export function setRecordingRetention(days: number, language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): Promise<VoiceRecordingSettings> {
  return request("PUT", "/api/recordings/settings", { retention_days: days }, language);
}

export function deleteRecording(
  voiceCallId: string,
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
): Promise<{ ok: true; recording: VoiceRecording | null }> {
  return request("DELETE", `/api/recordings/${encodeURIComponent(voiceCallId)}`, undefined, language);
}

/** The recording's WAV as a raw response (status, headers and body are passed through, Range included). */
export async function fetchRecordingAudio(
  voiceCallId: string,
  range?: string,
  language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE,
): Promise<Response> {
  const backend = target(language);
  try {
    return await fetch(`${backend.url}/api/recordings/${encodeURIComponent(voiceCallId)}/audio`, {
      headers: { "X-API-Key": backend.apiKey, ...(range ? { Range: range } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new VoiceBackendError(`Voice backend unreachable: ${why}`, null, true);
  }
}

/* ------------------------------------------------------------------ AI provider settings (admins only) */
// The language's voice backend keeps the settings and the encrypted keys; it never returns a key.
// The admin's e-mail goes along in X-Actor for its audit log.

const KEY_FIELD = /^(api_?key|encrypted_key|secret|key)$/i;

/** Defence in depth: drop any key-like field before a provider-settings answer reaches the browser. */
export function stripProviderSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripProviderSecrets) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !KEY_FIELD.test(k))
        .map(([k, v]) => [k, stripProviderSecrets(v)]),
    ) as T;
  }
  return value;
}

const actorHeaders = (actor: string) => ({ "X-Actor": actor });

export async function getAiProviderSettings(language: AiCallLanguage): Promise<AiProviderSettingsView> {
  return stripProviderSecrets(await request<AiProviderSettingsView>("GET", "/api/admin/ai-providers", undefined, language));
}

export async function updateAiProvider(
  language: AiCallLanguage,
  providerId: AiProviderId,
  change: AiProviderUpdateInput,
  actor: string,
): Promise<AiProviderSettingsView> {
  const path = `/api/admin/ai-providers/providers/${encodeURIComponent(providerId)}`;
  return stripProviderSecrets(await request<AiProviderSettingsView>("PUT", path, change, language, actorHeaders(actor)));
}

export async function updateAiProviderSelection(
  language: AiCallLanguage,
  change: AiProviderSelectionInput,
  actor: string,
): Promise<AiProviderSettingsView> {
  return stripProviderSecrets(
    await request<AiProviderSettingsView>("PUT", "/api/admin/ai-providers/selection", change, language, actorHeaders(actor)),
  );
}

export async function testAiProvider(language: AiCallLanguage, providerId: AiProviderId, actor: string): Promise<AiProviderSettingsView> {
  const path = `/api/admin/ai-providers/providers/${encodeURIComponent(providerId)}/test`;
  return stripProviderSecrets(await request<AiProviderSettingsView>("POST", path, undefined, language, actorHeaders(actor)));
}

export async function reencryptAiProviderKeys(language: AiCallLanguage, actor: string): Promise<AiProviderSettingsView> {
  return stripProviderSecrets(
    await request<AiProviderSettingsView>("POST", "/api/admin/ai-providers/reencrypt", undefined, language, actorHeaders(actor)),
  );
}
