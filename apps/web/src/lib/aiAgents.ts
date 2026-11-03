import { useQuery } from "@tanstack/react-query";
import type {
  AiAgentView,
  AiCallLanguage,
  AiCategoryView,
  AiKnowledgeFileView,
  AiKnowledgeItemView,
  CallFlowDefinition,
  TrainingTestResult,
} from "@dispatch/shared";
import { api } from "./api";
import { withLanguage } from "./aiCallLanguage";

/** One language's AI agents (each language section has its own; the industry library is shared). */
export function useAiAgents(language: AiCallLanguage) {
  return useQuery({
    queryKey: ["ai-agents", language],
    queryFn: () => api<AiAgentView[]>(withLanguage("/api/ai-agents", language)),
  });
}

export function useAiAgent(id: string | null) {
  return useQuery({
    queryKey: ["ai-agent", id],
    queryFn: () => api<AiAgentView>(`/api/ai-agents/${id}`),
    enabled: !!id,
  });
}

export function useAiLibrary(archived = false) {
  return useQuery({
    queryKey: ["ai-agent-library", archived],
    queryFn: () => api<AiCategoryView[]>(`/api/ai-agents/library${archived ? "?archived=true" : ""}`),
    staleTime: 60_000,
  });
}

export function useAgentKnowledge(id: string | null) {
  return useQuery({
    queryKey: ["ai-agent-knowledge", id],
    queryFn: () => api<{ files: AiKnowledgeFileView[]; items: AiKnowledgeItemView[] }>(`/api/ai-agents/${id}/knowledge`),
    enabled: !!id,
  });
}

export interface AgentPreview {
  definition: CallFlowDefinition;
  preview: {
    valid: boolean;
    errors: string[];
    greeting: string | null;
    identity_question?: string | null;
    system_prompt: string | null;
    max_duration_sec: number | null;
    training_tokens?: number | null;
    training_cap?: number | null;
  };
}

export type KnowledgeTest = TrainingTestResult;

/** Every query an agent change can affect. */
export const AGENT_QUERY_KEYS = [["ai-agents"], ["ai-agent"], ["ai-agent-knowledge"], ["call-flows"]] as const;
