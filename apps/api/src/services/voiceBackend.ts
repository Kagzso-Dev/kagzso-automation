// HTTP client for kagzso-voice-backend (FastAPI). Raw fetch, no SDK.
//   POST /api/calls/outbound   place one call
//   GET  /api/calls/{id}       read its status / outcome / transcript
// Auth: X-API-Key = VOICE_BACKEND_API_KEY (the voice backend's ADMIN_API_KEY).

import { aiCallsConfig, isAiCallsConfigured } from "../config/aiCalls.js";

export class VoiceBackendError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    /** True for network errors / 5xx / 429 — the call may succeed if retried later. */
    public readonly retryable: boolean,
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

async function request<T>(method: "GET" | "POST", path: string, json?: unknown): Promise<T> {
  if (!isAiCallsConfigured()) {
    throw new VoiceBackendError("Voice backend is not configured (VOICE_BACKEND_URL / VOICE_BACKEND_API_KEY)", null, false);
  }
  let res: Response;
  try {
    res = await fetch(`${aiCallsConfig.voiceBackendUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": aiCallsConfig.voiceBackendApiKey!,
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
    throw new VoiceBackendError(`Voice backend ${res.status}: ${msg}`, res.status, res.status >= 500 || res.status === 429);
  }
  return body as T;
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
      ...(input.flow
        ? {
            flow_id: input.flow.flowId,
            flow_version: input.flow.version,
            flow_draft: input.flow.draft,
            flow: input.flow.definition,
          }
        : {}),
      ...(aiCallsConfig.voiceAgentId
        ? { agent_id: aiCallsConfig.voiceAgentId }
        : { agent_name: aiCallsConfig.voiceAgentName }),
    },
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
}

/** Built-in flows (the defaults to copy) + locked block text, from the voice backend. */
export function getBuiltinFlows(): Promise<VoiceFlowCatalog> {
  return request<VoiceFlowCatalog>("GET", "/api/flows/builtin");
}

/** Validate a flow and render it exactly as a call would (the voice backend is the authority). */
export function previewFlow(definition: unknown, sample: Record<string, unknown> = {}): Promise<VoiceFlowPreview> {
  return request<VoiceFlowPreview>("POST", "/api/flows/preview", { flow: definition, sample });
}

/** "Listen": a WAV of `voiceId` saying `text`. Text-to-speech only — the voice backend dials nothing. */
export async function previewVoice(voiceId: string, text: string): Promise<Buffer> {
  if (!isAiCallsConfigured()) {
    throw new VoiceBackendError("Voice backend is not configured (VOICE_BACKEND_URL / VOICE_BACKEND_API_KEY)", null, false);
  }
  let res: Response;
  try {
    res = await fetch(`${aiCallsConfig.voiceBackendUrl}/api/voices/preview`, {
      method: "POST",
      headers: { "X-API-Key": aiCallsConfig.voiceBackendApiKey!, "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: voiceId, text }),
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

export function getVoiceCall(voiceCallId: string): Promise<VoiceCallDetail> {
  return request<VoiceCallDetail>("GET", `/api/calls/${encodeURIComponent(voiceCallId)}`);
}
