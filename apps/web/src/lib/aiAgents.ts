import { useQuery } from "@tanstack/react-query";
import type {
  AiAgentCallInsights,
  AiAgentView,
  AiCallLanguage,
  AiKnowledgeFileView,
  AiKnowledgeItemView,
  CallFlowDefinition,
  TrainingTestResult,
} from "@dispatch/shared";
import { api } from "./api";
import { withLanguage } from "./aiCallLanguage";

/** One language's AI agents (each language section has its own). */
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

export function useAgentKnowledge(id: string | null) {
  return useQuery({
    queryKey: ["ai-agent-knowledge", id],
    // insights: the agent's call insights (sentiment, interest, concerns); null / absent = none yet.
    queryFn: () =>
      api<{ files: AiKnowledgeFileView[]; items: AiKnowledgeItemView[]; insights?: AiAgentCallInsights | null }>(`/api/ai-agents/${id}/knowledge`),
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
