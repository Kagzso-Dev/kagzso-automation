import { useQuery } from "@tanstack/react-query";
import { AI_CALL_LANGUAGE_NAMES, type AiCallLanguage } from "@dispatch/shared";
import { api } from "../lib/api";
import { useAiCallLanguage } from "../lib/aiCallLanguage";

/**
 * On every language's call pages: which language is placing AI calls right now. One language calls
 * at a time, so while a run is dialling, new runs and test calls in the other languages are refused
 * until it finishes (nothing is cancelled). Nothing is shown while no run is dialling.
 */
export function RunningCallsNote() {
  const language = useAiCallLanguage();
  const running = useQuery({
    queryKey: ["ai-calls-running"],
    queryFn: () => api<{ running: { runId: string; language: AiCallLanguage } | null }>("/api/ai-calls/running"),
    refetchInterval: 10_000,
  }).data?.running;
  if (!running) return null;
  const name = AI_CALL_LANGUAGE_NAMES[running.language];
  return (
    <div role="status" className="mb-4 flex items-start gap-2 rounded-[14px] border border-accent/40 bg-tint p-3.5 text-sm">
      <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
      <p className="text-ink">
        <span className="font-medium">Calling now: {name}.</span>{" "}
        {running.language === language
          ? "Other languages can start calls once this run finishes."
          : `One language calls at a time — ${AI_CALL_LANGUAGE_NAMES[language]} calls and test calls can start once that run finishes.`}
      </p>
    </div>
  );
}
