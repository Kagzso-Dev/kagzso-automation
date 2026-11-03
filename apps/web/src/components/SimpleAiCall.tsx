import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AI_CALL_LANGUAGE_NAMES, type AiCallLanguage } from "@dispatch/shared";
import { api } from "../lib/api";
import { isEnglish } from "../lib/aiCallLanguage";
import type { AiCallPlanSummary } from "../lib/aiCalls";
import { BASE_LABELS, type CallFlowListItem } from "../lib/callFlows";
import { RunStatus } from "./AiCallModal";
import { useConfirm } from "./confirm";
import { PhoneInput, phoneInputOk } from "./PhoneInput";
import { useToast } from "./toast";
import { Badge, EmptyState, ErrorNote } from "./ui";

/** The voice backend keeps at most this much of the follow-up detail (llm_service.FOLLOW_UP_MAX_LEN). */
const CONTEXT_MAX = 300;

/**
 * "Simple AI Call": pick a published flow, type one number, start. Nothing new behind it: the call is a
 * one-customer run of POST /api/ai-calls/start (do-not-call list, daily cap, one run at a time and the
 * voice backend reachability check all apply), checked first with a dry run, then placed only after a
 * confirm. Who calls and why come from the flow's published Training (agent profile); the language is
 * this page's language (one language per call). Once started, the run's live status is shown here (the
 * same panel and run API as the AI Call window: GET /api/ai-calls/runs/:id, with Cancel).
 */
export function SimpleAiCall({
  language,
  flows,
  onOpenFlow,
}: {
  language: AiCallLanguage;
  flows: CallFlowListItem[];
  /** Opens the flow in the Advanced editor (to edit its agent profile in Training). */
  onOpenFlow: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const published = useMemo(() => flows.filter((f) => f.published), [flows]);
  const [flowId, setFlowId] = useState("");
  const chosen = published.find((f) => f.id === (flowId || published[0]?.id)) ?? null;
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [gender, setGender] = useState("");
  const [context, setContext] = useState("");
  const [runId, setRunId] = useState<string | null>(null);

  const body = chosen
    ? {
        rows: [{ phone, customerName: name.trim() || null, gender: gender || null, followUpDetail: context.trim() || null }],
        mode: "all" as const,
        maxCalls: 1,
        flowId: chosen.id,
        ...(isEnglish(language) ? {} : { language }),
      }
    : null;

  const start = useMutation({
    mutationFn: async () => {
      // Dry run first: the same checks as a real start, nothing created.
      const plan = await api<AiCallPlanSummary>("/api/ai-calls/start", { method: "POST", json: { ...body, dryRun: true }, notify: false });
      if (plan.toCall !== 1) {
        const why = plan.skipped.doNotCall ? "the number is on the do-not-call list" : "the number is not valid";
        throw new Error(`No call placed: ${why}.`);
      }
      const ok = await confirm({
        title: `Place a real call to ${phone}?`,
        body:
          `“${chosen!.name}” (live v${chosen!.published!.version}) calls this number now in ${AI_CALL_LANGUAGE_NAMES[language]}. ` +
          "The phone will ring and the call counts toward the daily limit.",
        confirmText: "Start call",
      });
      if (!ok) return null;
      return api<AiCallPlanSummary & { runId: string }>("/api/ai-calls/start", { method: "POST", json: body, notify: false });
    },
    onSuccess: (res) => {
      if (!res) return;
      toast.success("AI call started", ["Its live status is shown below."]);
      void qc.invalidateQueries({ queryKey: ["ai-call-runs"] });
      setRunId(res.runId);
    },
  });

  if (published.length === 0) {
    return (
      <EmptyState>
        Publish a call flow first. Tip: <b>New call flow</b> → <i>{BASE_LABELS.executive}</i>, fill its agent profile in{" "}
        <b>Training</b>, then publish.
      </EmptyState>
    );
  }

  if (runId) {
    return (
      <div className="max-w-3xl rounded-xl border border-line bg-surface p-5 text-sm shadow-sm">
        <RunStatus runId={runId} onNewRun={() => setRunId(null)} onClose={() => setRunId(null)} />
      </div>
    );
  }

  const agent = chosen?.agent;
  const ready = !!chosen && phoneInputOk(phone, true) && !start.isPending;
  return (
    <div className="max-w-3xl rounded-xl border border-line bg-surface p-5 text-sm shadow-sm">
      <p className="mb-4 text-slate-550">
        Give the agent one number. It follows the chosen flow's published script and training — who it is, the business
        objective, approved facts — and decides each reply from what the customer says. Every safety rule (AI disclosure,
        do-not-call, no invented prices or promises) applies as on any call.
      </p>

      <label className="label">Call flow (published)</label>
      <select className="input mb-2" value={chosen?.id ?? ""} onChange={(e) => setFlowId(e.target.value)}>
        {published.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} · v{f.published!.version} · {BASE_LABELS[f.base]?.split(" (")[0] ?? f.base}
          </option>
        ))}
      </select>

      {chosen && (
        <div className="mb-4 rounded-lg border border-line/70 bg-surface-muted px-3 py-2 text-xs">
          {agent && (agent.agentName || agent.role || agent.objective) ? (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{[agent.agentName, agent.company].filter(Boolean).join(" · ") || "Agent profile"}</span>
                <Badge tone={agent.trainingOn ? "ok" : "warn"}>{agent.trainingOn ? "training on" : "training off in the live version"}</Badge>
              </div>
              {agent.role && <div>Role: {agent.role}</div>}
              {agent.objective && <div>Objective: {agent.objective}</div>}
            </>
          ) : (
            <span className="text-slate-550">This flow's live version has no agent profile: it follows its script as written.</span>
          )}
          <button type="button" className="mt-1 block text-accent-ink hover:underline" onClick={() => onOpenFlow(chosen.id)}>
            Edit role and objective (Advanced → Training, then publish)
          </button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Language</label>
          <div className="input bg-surface-muted text-slate-550">{AI_CALL_LANGUAGE_NAMES[language]} (one language per call)</div>
        </div>
        <div>
          <label className="label">Customer number</label>
          <PhoneInput value={phone} onChange={setPhone} required />
        </div>
        <div>
          <label className="label">Customer name (optional)</label>
          <input className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Gender (optional, for sir / madam)</label>
          <select className="input" value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">Not given (never guessed)</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </div>
      </div>
      <label className="label mt-3">Customer context (optional)</label>
      <input
        className="input"
        maxLength={CONTEXT_MAX}
        placeholder="Approved, non-sensitive detail, e.g. runs a restaurant, asked about WhatsApp follow-ups"
        value={context}
        onChange={(e) => setContext(e.target.value)}
      />
      <p className="mt-1 text-xs text-slate-550">
        Sent to the AI as customer data. Never enter passwords, payment details or anyone else's contact details.
      </p>

      {start.error && <ErrorNote error={start.error} />}
      <div className="mt-4 flex justify-end">
        <button type="button" className="btn-primary" disabled={!ready} onClick={() => start.mutate()}>
          {start.isPending ? "Checking…" : "Start AI call"}
        </button>
      </div>
    </div>
  );
}
