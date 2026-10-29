import { z } from "zod";

/* ------------------------------------------------------------------ AI provider settings (admin only) */
// Per language: each language's voice backend keeps its own provider settings and encrypted keys.
// Dispatch only proxies (admins only); no API key is ever returned - only key_configured / key_source.

export const AI_PROVIDER_IDS = ["groq_llm", "sarvam_llm", "anthropic_llm", "sarvam_stt", "sarvam_tts"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];
export const AI_LLM_PROVIDER_IDS = ["groq_llm", "sarvam_llm", "anthropic_llm"] as const;
export type AiLlmProviderId = (typeof AI_LLM_PROVIDER_IDS)[number];

export type AiProviderStatus = "configured" | "missing_key" | "disabled" | "error";
export type AiProviderKeySource = "saved" | "environment" | "none" | "unreadable";

export interface AiProviderView {
  id: AiProviderId;
  kind: "llm" | "stt" | "tts";
  label: string;
  provider: string;
  enabled: boolean;
  model: string | null;
  models: string[];
  options: Record<string, string>;
  key_configured: boolean;
  key_source: AiProviderKeySource;
  needs_reencrypt: boolean;
  priority: number | null;
  status: AiProviderStatus;
  untested_model: boolean;
  model_allowed: boolean;
  last_test: { status: "ok" | "error"; message: string; at: string } | null;
}

export interface AiProviderSettingsView {
  language: string;
  live: boolean;
  secrets_ready: boolean;
  env_llm: string;
  llm_order: AiLlmProviderId[];
  usable_llm: AiLlmProviderId[];
  providers: AiProviderView[];
  stt_providers: AiProviderId[];
  warnings: string[];
  test?: { provider: AiProviderId; status: "ok" | "error"; message: string; latency_ms: number };
}

const optionValue = z.string().trim().max(100).nullable();

/** PUT a provider. api_key is write-only: an empty or absent field keeps the saved key; remove_key deletes it. */
export const aiProviderUpdateInput = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().trim().max(100).optional(),
    options: z.record(z.enum(["mode", "speaker"]), optionValue).optional(),
    api_key: z.string().max(512).optional(),
    remove_key: z.boolean().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
export type AiProviderUpdateInput = z.infer<typeof aiProviderUpdateInput>;

export const aiProviderSelectionInput = z
  .object({
    live: z.boolean().optional(),
    llm_order: z.array(z.enum(AI_LLM_PROVIDER_IDS)).length(AI_LLM_PROVIDER_IDS.length).optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
export type AiProviderSelectionInput = z.infer<typeof aiProviderSelectionInput>;
