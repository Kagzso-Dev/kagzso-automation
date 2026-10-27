import { useQuery } from "@tanstack/react-query";
import { DEFAULT_AI_CALL_LANGUAGE, type AiCallLanguage, type CallFlowBase, type CallFlowDefinition } from "@dispatch/shared";
import { api } from "./api";
import { isEnglish, withLanguage } from "./aiCallLanguage";

export interface CallFlowVersionSummary {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  publishedAt: string | null;
  updatedAt: string;
}

export interface CallFlowListItem {
  id: string;
  name: string;
  description: string | null;
  base: CallFlowBase;
  updatedAt: string;
  published: CallFlowVersionSummary | null;
  draft: CallFlowVersionSummary | null;
  versionCount: number;
}

export interface CallFlowVersion extends CallFlowVersionSummary {
  definition: CallFlowDefinition;
  definitionHash: string;
  createdByEmail: string | null;
  createdAt: string;
}

export interface CallFlowDetail {
  id: string;
  name: string;
  description: string | null;
  base: CallFlowBase;
  versions: CallFlowVersion[];
}

/** From the voice backend: the built-in flows and the text of the locked safety blocks. */
export interface CallFlowCatalog {
  flows: Record<CallFlowBase, CallFlowDefinition>;
  locked_blocks: Record<string, string>;
  variables: string[];
  limits: { max_duration_sec: number; max_block_chars: number; max_prompt_chars: number };
  /** The voices a flow may pick (from the voice backend); absent on an older voice backend. */
  voices?: VoiceOption[];
  default_voice?: string;
  /** The voice backend records calls (CALL_RECORDING_ENABLED); absent on an older voice backend. */
  recording_enabled?: boolean;
  /** The language that voice backend calls in; absent on a voice backend from before languages (English). */
  language?: AiCallLanguage;
}

export interface VoiceOption {
  id: string;
  name: string;
  gender?: string;
  language?: string;
}

export interface CallFlowPreview {
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

export const BASE_LABELS: Record<CallFlowBase, string> = {
  nila: "Nila screening (identity → permission → pitch)",
  followup: "Customer follow-up (discusses the follow-up detail)",
};

/** One language's call flows (each language has its own; English = the original list). */
export function useCallFlows(enabled = true, language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE) {
  return useQuery({
    queryKey: ["call-flows", language],
    queryFn: () => api<{ items: CallFlowListItem[] }>(withLanguage("/api/call-flows", language)),
    enabled,
  });
}

/** The built-in flows and voices of one language's voice backend (not asked while that backend isn't set up). */
export function useCallFlowCatalog(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE, enabled = true) {
  return useQuery({
    queryKey: ["call-flows-builtin", language],
    queryFn: () => api<CallFlowCatalog>(withLanguage("/api/call-flows/builtin", language)),
    staleTime: 5 * 60_000,
    enabled,
  });
}

/* ------------------------------------------------------------ flow for a new AI call run */

/** Stored choice for "Default flow (server agent)" — no flow pinned (English only). */
export const DEFAULT_FLOW_CHOICE = "default";
const LAST_FLOW_KEY = "ai-call-last-flow";
const lastFlowKey = (language: AiCallLanguage) => (isEnglish(language) ? LAST_FLOW_KEY : `${LAST_FLOW_KEY}:${language}`);

/** The last flow picked in this browser for that language. Another language has no default agent, so no "default" choice. */
export function rememberedFlowChoice(language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE): string | null {
  try {
    const v = localStorage.getItem(lastFlowKey(language));
    return !isEnglish(language) && v === DEFAULT_FLOW_CHOICE ? null : v;
  } catch {
    return null;
  }
}

export function rememberFlowChoice(flowId: string, language: AiCallLanguage = DEFAULT_AI_CALL_LANGUAGE) {
  try {
    localStorage.setItem(lastFlowKey(language), flowId || DEFAULT_FLOW_CHOICE);
  } catch {
    /* private window — the choice lasts for this visit */
  }
}

/**
 * The flow a new run starts with ("" = the server's default agent): the last choice
 * in this browser while that flow is still published, otherwise the most recently
 * published flow, so edits made in Voice Call Flows are what real calls use.
 */
export function initialFlowChoice(published: CallFlowListItem[], remembered: string | null): string {
  if (remembered === DEFAULT_FLOW_CHOICE) return "";
  if (remembered && published.some((f) => f.id === remembered)) return remembered;
  const newest = [...published].sort((a, b) => (b.published?.publishedAt ?? "").localeCompare(a.published?.publishedAt ?? ""))[0];
  return newest?.id ?? "";
}

/**
 * The version "Test call" starts on: the live one (newest published), so a test call
 * sounds like a real call. A flow that was never published starts on its newest version.
 */
export function testCallDefaultVersion(versions: Pick<CallFlowVersionSummary, "version" | "status">[]): number {
  const live = versions.filter((v) => v.status === "PUBLISHED").sort((a, b) => b.version - a.version)[0];
  return live?.version ?? Math.max(1, ...versions.map((v) => v.version));
}

/** The draft holds edits that calls don't use yet (only the published version is called). */
export function unpublishedDraft(f: CallFlowListItem | null): CallFlowVersionSummary | null {
  return f?.draft && f.published && f.draft.version > f.published.version ? f.draft : null;
}
