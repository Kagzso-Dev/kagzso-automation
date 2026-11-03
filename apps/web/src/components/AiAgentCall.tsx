import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AI_AGENT_GENDER_LABELS,
  AI_AGENT_GENDERS,
  AI_CALL_LANGUAGE_NAMES,
  type AiAgentGender,
  type AiAgentView,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { useLanguageReady } from "../lib/aiCallLanguage";
import type { AiCallPlanSummary } from "../lib/aiCalls";
import { RunStatus } from "./AiCallModal";
import { useConfirm } from "./confirm";
import { PhoneInput, phoneInputOk } from "./PhoneInput";
import { useToast } from "./toast";
import { ErrorNote } from "./ui";

/**
 * Call one number with the agent: a one-customer AI call run (do-not-call list, daily cap, one run at a time and
 * the voice backend check all apply), checked first with a dry run, placed only after a confirm. Bigger lists:
 * Voicecall Contact → AI Call, picking this agent's Call Flow.
 */
export function AiAgentCall({ agent }: { agent: AiAgentView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { ready } = useLanguageReady();
  const [phone, setPhone] = useState(agent.contactPhone ?? "");
  const [name, setName] = useState(agent.contactName ?? "");
  const [gender, setGender] = useState<AiAgentGender>(agent.contactGender);
  const [runId, setRunId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: async () => {
      const body = { phone, customerName: name.trim() || undefined, gender };
      const plan = await api<AiCallPlanSummary>(`/api/ai-agents/${agent.id}/call`, { method: "POST", json: { ...body, dryRun: true }, notify: false });
      if (plan.toCall !== 1) throw new Error(plan.skipped.doNotCall ? "No call placed: the number is on the do-not-call list." : "No call placed: the number is not valid.");
      const ok = await confirm({
        title: `Place a real call to ${phone}?`,
        body: `${agent.executiveName} (“${agent.name}”, live v${agent.liveVersion}) calls this number now in ${AI_CALL_LANGUAGE_NAMES[agent.language]}. The phone will ring and the call counts toward the daily limit.`,
        confirmText: "Start call",
      });
      if (!ok) return null;
      return api<AiCallPlanSummary & { runId: string }>(`/api/ai-agents/${agent.id}/call`, { method: "POST", json: body, notify: false });
    },
    onSuccess: (res) => {
      if (!res) return;
      toast.success("AI call started", ["Its live status is shown below."]);
      void qc.invalidateQueries({ queryKey: ["ai-call-runs"] });
      setRunId(res.runId);
    },
  });

  if (!agent.liveVersion) {
    return (
      <p className="text-sm text-slate-550">
        {agent.mode === "autonomous" ? "Publish the agent first (Preview & publish)." : "The agent's Call Flow has no published version."}
      </p>
    );
  }
  if (runId) {
    return (
      <div className="max-w-3xl rounded-xl border border-line bg-surface p-5 text-sm shadow-sm">
        <RunStatus runId={runId} onNewRun={() => setRunId(null)} onClose={() => setRunId(null)} />
      </div>
    );
  }
  return (
    <div className="max-w-3xl space-y-3 rounded-xl border border-line bg-surface p-5 text-sm shadow-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">Number</label>
          <PhoneInput value={phone} onChange={setPhone} required />
        </div>
        <div>
          <label className="label">Contact name</label>
          <input className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Gender</label>
          <select className="input" value={gender} onChange={(e) => setGender(e.target.value as AiAgentGender)}>
            {AI_AGENT_GENDERS.map((g) => (
              <option key={g} value={g}>
                {AI_AGENT_GENDER_LABELS[g]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-slate-550">
        The recording, transcript and outcome appear in the call history like every AI call. To call a list, use Voicecall Contact → AI Call and
        pick this agent's Call Flow.
      </p>
      {start.error && <ErrorNote error={start.error} />}
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={!ready || !phoneInputOk(phone, true) || start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? "Checking…" : "Start AI call"}
        </button>
      </div>
    </div>
  );
}
