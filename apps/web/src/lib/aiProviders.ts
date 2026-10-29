import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiCallLanguage,
  AiLlmProviderId,
  AiProviderId,
  AiProviderSelectionInput,
  AiProviderSettingsView,
  AiProviderUpdateInput,
  AiProviderView,
} from "@dispatch/shared";
import { api } from "./api";

/**
 * Settings → AI providers (admins only). Every language's voice backend keeps its own settings and
 * encrypted keys; the API never returns a key, only key_configured / key_source. A typed key lives
 * only in the input until it is sent, and nothing here is kept in browser storage.
 */
const key = (language: AiCallLanguage) => ["ai-providers", language] as const;

/**
 * Live calls use this provider right now ("Use for live calls" is on and it is enabled and usable:
 * an LLM in the fallback order, or the speech settings calls take). Switching it off asks first,
 * even when another provider would take over.
 */
export function usedByLiveCalls(p: AiProviderView, view: AiProviderSettingsView): boolean {
  if (!view.live || !p.enabled) return false;
  return p.kind === "llm" ? view.usable_llm.includes(p.id as AiLlmProviderId) : p.key_configured && p.model_allowed;
}

/** What switching off a provider that live calls use means, for the confirmation. */
export function disableConsequence(p: AiProviderView, view: AiProviderSettingsView): string {
  if (p.kind !== "llm") return `New live calls go back to the server's .env ${p.kind === "stt" ? "speech-to-text" : "voice"} settings.`;
  const rest = view.usable_llm.filter((id) => id !== p.id);
  if (view.usable_llm[0] !== p.id) return "It is a fallback for live calls; the other providers in the order stay as they are.";
  return rest.length
    ? "It answers live calls now. New calls will be answered by the next provider in the fallback order."
    : "It is the only usable language model for live calls.";
}

export function useAiProviderSettings(language: AiCallLanguage, enabled: boolean) {
  return useQuery({
    queryKey: key(language),
    queryFn: () => api<AiProviderSettingsView>(`/api/ai-providers/${language}`),
    enabled,
    staleTime: 0,
  });
}

function useSettingsMutation<V>(language: AiCallLanguage, request: (vars: V) => Promise<AiProviderSettingsView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (view) => qc.setQueryData(key(language), view),
  });
}

export function useUpdateAiProvider(language: AiCallLanguage) {
  return useSettingsMutation(language, ({ id, change }: { id: AiProviderId; change: AiProviderUpdateInput }) =>
    api<AiProviderSettingsView>(`/api/ai-providers/${language}/providers/${id}`, { method: "PUT", json: change, notify: false }),
  );
}

export function useUpdateAiProviderSelection(language: AiCallLanguage) {
  return useSettingsMutation(language, (change: AiProviderSelectionInput) =>
    api<AiProviderSettingsView>(`/api/ai-providers/${language}/selection`, { method: "PUT", json: change, notify: false }),
  );
}

export function useTestAiProvider(language: AiCallLanguage) {
  return useSettingsMutation(language, (id: AiProviderId) =>
    api<AiProviderSettingsView>(`/api/ai-providers/${language}/providers/${id}/test`, { method: "POST", notify: false }),
  );
}

export function useReencryptAiProviderKeys(language: AiCallLanguage) {
  return useSettingsMutation(language, () =>
    api<AiProviderSettingsView>(`/api/ai-providers/${language}/reencrypt`, { method: "POST", notify: false }),
  );
}
