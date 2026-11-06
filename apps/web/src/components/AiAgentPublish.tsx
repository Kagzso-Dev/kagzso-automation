import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AI_AGENT_GENDER_LABELS, AI_AGENT_GENDERS, AI_CALL_BUSINESS_MAX, type AiAgentGender, type AiAgentView } from "@dispatch/shared";
import { api, ApiError } from "../lib/api";
import { useLanguageReady } from "../lib/aiCallLanguage";
import { AGENT_QUERY_KEYS, type AgentPreview, type KnowledgeTest } from "../lib/aiAgents";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { Badge, ErrorNote } from "./ui";

/**
 * Preview (rendered by this language's voice backend, no LLM), a free knowledge test (which approved notes a
 * customer's words pick, no LLM) and publish (compile → voice backend check → a new published version of the
 * agent's Call Flow; runs already queued keep the version they started with).
 */
export function AiAgentPublish({ agent }: { agent: AiAgentView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { ready } = useLanguageReady();
  const [name, setName] = useState(agent.contactName ?? "Ragul");
  const [gender, setGender] = useState<AiAgentGender>(agent.contactGender);
  const [business, setBusiness] = useState("");
  const [message, setMessage] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);

  const preview = useMutation({
    mutationFn: () =>
      api<AgentPreview>(`/api/ai-agents/${agent.id}/preview`, { method: "POST", json: { customerName: name, gender, customerBusiness: business }, notify: false }),
  });
  const test = useMutation({
    mutationFn: () => api<KnowledgeTest>(`/api/ai-agents/${agent.id}/knowledge-test`, { method: "POST", json: { message }, notify: false }),
  });
  const publish = useMutation({
    mutationFn: (replaceDraft: boolean) =>
      api<{ version: number }>(`/api/ai-agents/${agent.id}/publish`, { method: "POST", json: { replaceDraft }, notify: false }),
    onSuccess: (res) => {
      AGENT_QUERY_KEYS.forEach((k) => void qc.invalidateQueries({ queryKey: [...k] }));
      toast.success(`Published v${res.version}`, ["New calls use this version. Calls already queued keep theirs."]);
    },
    onError: async (err) => {
      // The generated flow has a draft that isn't the agent's (an edit from before it became read-only):
      // replace it only when the admin says so.
      const conflict = err instanceof ApiError && err.status === 409 ? draftConflictOf(err.details) : null;
      if (!conflict) return;
      const ok = await confirm({
        title: `Replace draft v${conflict.version}?`,
        body:
          `The agent's Call Flow has a draft${conflict.by ? ` saved by ${conflict.by}` : ""} that didn't come from this agent. ` +
          "Publishing replaces it with the agent's settings and approved knowledge. To keep it, Cancel and use Copy flow " +
          "in Voice Call Flows first.",
        confirmText: "Replace and publish",
        tone: "danger",
      });
      if (ok) publish.mutate(true);
    },
  });
  const p = preview.data?.preview;

  return (
    <div className="max-w-4xl space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-4 shadow-sm">
        {agent.liveVersion ? <Badge tone="ok">live v{agent.liveVersion}</Badge> : <Badge tone="warn">not published</Badge>}
        {agent.unpublishedChanges && <Badge tone="warn">settings or approved knowledge changed since</Badge>}
        <span className="text-slate-550">{agent.knowledge.approved} approved knowledge item(s) will be included.</span>
        <button
          type="button"
          className="btn-primary ml-auto"
          disabled={!ready || publish.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: `Publish "${agent.name}"?`,
              body: "Its settings, instructions and approved knowledge become a new live version of its Call Flow. Nothing is called.",
              confirmText: "Publish",
            });
            if (ok) publish.mutate(false);
          }}
        >
          {publish.isPending ? "Publishing…" : "Publish"}
        </button>
      </div>
      {!ready && <p className="text-warn">This language's voice backend isn't set up, so the agent can't be checked or published yet.</p>}
      {publish.error && !(publish.error instanceof ApiError && draftConflictOf(publish.error.details)) && <ErrorNote error={publish.error} />}

      <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        <h3 className="mb-2 font-semibold">Preview the opening</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className="label">Sample contact name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
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
          <div>
            <label className="label">Sample business</label>
            <input
              className="input"
              maxLength={AI_CALL_BUSINESS_MAX}
              value={business}
              placeholder="Empty: the AI asks"
              onChange={(e) => setBusiness(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <button type="button" className="btn btn-ghost" disabled={!ready || preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending ? "Rendering…" : "Preview"}
            </button>
          </div>
        </div>
        {preview.error && <ErrorNote error={preview.error} />}
        {p && (
          <div className="mt-3 space-y-2">
            {!p.valid && (
              <div className="rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-crit">
                The voice backend would reject this: {p.errors.join("; ")}
              </div>
            )}
            <div className="rounded-lg bg-surface-muted px-3 py-2">
              <div className="text-xs text-slate-550">The system says</div>
              <div>“{p.greeting}”</div>
              {p.identity_question && <div>“{p.identity_question}”</div>}
              <div className="mt-1 text-xs text-slate-550">
                After that, every reply is the AI's own, from the customer's words. Max {p.max_duration_sec} s
                {p.training_tokens != null ? ` · knowledge block ~${p.training_tokens} of ${p.training_cap} tokens` : ""}.
              </div>
            </div>
            <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => setShowPrompt((v) => !v)}>
              {showPrompt ? "Hide" : "Show"} the full instructions the AI gets
            </button>
            {showPrompt && (
              <pre className="scroll-thin max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-line/70 p-3 text-xs">{p.system_prompt}</pre>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        <h3 className="mb-1 font-semibold">Test the knowledge (free, no AI call)</h3>
        <p className="mb-2 text-xs text-slate-550">Type what a customer might say: you see which approved notes the agent would get for that reply.</p>
        <div className="flex gap-2">
          <input className="input" maxLength={300} value={message} placeholder="e.g. Will it replace our billing software?" onChange={(e) => setMessage(e.target.value)} />
          <button type="button" className="btn btn-ghost" disabled={!ready || !message.trim() || test.isPending} onClick={() => test.mutate()}>
            Test
          </button>
        </div>
        {test.error && <ErrorNote error={test.error} />}
        {test.data && (
          <ul className="mt-2 list-disc pl-5 text-xs">
            {test.data.selected.length ? test.data.selected.map((s) => <li key={s}>{s.replace(/^- /, "")}</li>) : <li>No approved note matches: the agent would say it doesn't have that detail.</li>}
            {test.data.dropped.map((s) => (
              <li key={s} className="text-warn">
                Left out (size limit): {s.replace(/^- /, "")}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The publish API's "draft_conflict" details, or null. */
function draftConflictOf(details: unknown): { version: number; by: string | null } | null {
  const c = (details as { draftConflict?: { version?: unknown; by?: unknown } } | undefined)?.draftConflict;
  return c && typeof c.version === "number" ? { version: c.version, by: typeof c.by === "string" ? c.by : null } : null;
}
