import { useQuery } from "@tanstack/react-query";
import type { CallFlowBase, CallFlowDefinition } from "@dispatch/shared";
import { api } from "./api";

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
}

export const BASE_LABELS: Record<CallFlowBase, string> = {
  nila: "Nila screening (identity → permission → pitch)",
  followup: "Customer follow-up (discusses the follow-up detail)",
};

export function useCallFlows(enabled = true) {
  return useQuery({
    queryKey: ["call-flows"],
    queryFn: () => api<{ items: CallFlowListItem[] }>("/api/call-flows"),
    enabled,
  });
}

export function useCallFlowCatalog() {
  return useQuery({
    queryKey: ["call-flows-builtin"],
    queryFn: () => api<CallFlowCatalog>("/api/call-flows/builtin"),
    staleTime: 5 * 60_000,
  });
}

/* ------------------------------------------------------------ flow for a new AI call run */

/** Stored choice for "Default flow (server agent)" — no flow pinned. */
export const DEFAULT_FLOW_CHOICE = "default";
const LAST_FLOW_KEY = "ai-call-last-flow";

export function rememberedFlowChoice(): string | null {
  try {
    return localStorage.getItem(LAST_FLOW_KEY);
  } catch {
    return null;
  }
}

export function rememberFlowChoice(flowId: string) {
  try {
    localStorage.setItem(LAST_FLOW_KEY, flowId || DEFAULT_FLOW_CHOICE);
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

/** The draft holds edits that calls don't use yet (only the published version is called). */
export function unpublishedDraft(f: CallFlowListItem | null): CallFlowVersionSummary | null {
  return f?.draft && f.published && f.draft.version > f.published.version ? f.draft : null;
}
