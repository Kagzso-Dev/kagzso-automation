import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TRAINING_PRIVACY_NOTICE,
  TRAINING_SITUATION_LABELS,
  TRAINING_SITUATIONS,
  type TrainingCallTurns,
  type TrainingExample,
  type TrainingSituation,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAiCallsConfig } from "../lib/aiCalls";
import { ErrorNote, Modal, Spinner } from "./ui";

/**
 * "Create training from this turn" under a call's transcript (admins, call flow editor on). The admin
 * picks an Agent turn, writes the better reply, and it is saved into the flow's training as a Draft.
 * The turns come from the server with personal details removed; only text is copied, never audio.
 */
export function TrainingFromCallButton({ logId }: { logId: string }) {
  const isAdmin = useAuth().user?.role === "ADMIN";
  const flowEditor = useAiCallsConfig().data?.flowEditor;
  const [open, setOpen] = useState(false);
  if (!isAdmin || !flowEditor) return null;
  return (
    <>
      <button type="button" className="mt-1 block text-xs text-accent-ink hover:underline" onClick={() => setOpen(true)}>
        Create training from this turn
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Create training from a call turn" wide>
        {open && <TrainingFromCall logId={logId} onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

function TrainingFromCall({ logId, onDone }: { logId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const turns = useQuery({
    queryKey: ["call-training-turns", logId],
    queryFn: () => api<TrainingCallTurns>(`/api/call-flows/training/calls/${logId}`, { notify: false }),
  });
  const [turn, setTurn] = useState<number | null>(null);
  const [better, setBetter] = useState("");
  const [reason, setReason] = useState("");
  const [situation, setSituation] = useState<TrainingSituation | "">("");
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState<NonNullable<TrainingExample["style"]> | "">("");
  const save = useMutation({
    mutationFn: () =>
      api<{ flowId: string; version: number }>(`/api/call-flows/training/calls/${logId}`, {
        method: "POST",
        json: { turn, better, reason, situation: situation || null, style: style || null, ...(topic.trim() ? { topic: topic.trim() } : {}) },
        notify: `Saved as a Draft in “${turns.data?.flowName}” training — check it, make it Active, then publish`,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["call-flow", r.flowId] });
      void qc.invalidateQueries({ queryKey: ["call-flows"] });
      onDone();
    },
  });

  if (turns.isLoading) return <Spinner />;
  if (turns.error) return <ErrorNote error={turns.error} />;
  const d = turns.data!;
  return (
    <div className="text-sm">
      <p className="mb-2 text-slate-550">
        Flow <b>{d.flowName}</b> (this call used v{d.version}). Pick the Agent turn to correct; it is saved into the flow's
        training as a <b>Draft</b> bad example with your better reply. Names, numbers, emails and links were removed below.
      </p>
      <p className="mb-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">{TRAINING_PRIVACY_NOTICE}</p>
      {d.turns.length === 0 ? (
        <p className="text-slate-550">This call has no Agent turns in its transcript.</p>
      ) : (
        <div className="scroll-thin mb-3 max-h-72 space-y-2 overflow-y-auto">
          {d.turns.map((t) => (
            <label key={t.turn} className={`block cursor-pointer rounded-lg border p-2 text-xs ${turn === t.turn ? "border-accent bg-accent-soft" : "border-line"}`}>
              <input type="radio" name="turn" className="mr-2" checked={turn === t.turn} onChange={() => setTurn(t.turn)} />
              <span className="text-slate-550">Customer:</span> {t.customer}
              <div className="ml-5 mt-1">
                <span className="text-slate-550">Agent:</span> {t.agent}
              </div>
            </label>
          ))}
        </div>
      )}
      <label className="label">The better reply</label>
      <input className="input mb-2" maxLength={300} value={better} onChange={(e) => setBetter(e.target.value)} />
      <label className="label">Why (optional)</label>
      <input className="input mb-3" maxLength={200} placeholder="e.g. too pushy" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className="label">Situation (optional)</label>
          <select className="input" value={situation} onChange={(e) => setSituation(e.target.value as TrainingSituation | "")}>
            <option value="">Any</option>
            {TRAINING_SITUATIONS.map((s) => (
              <option key={s} value={s}>
                {TRAINING_SITUATION_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Topic (optional)</label>
          <input className="input" maxLength={40} placeholder="e.g. price" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </div>
        <div>
          <label className="label">Language style (optional)</label>
          <select className="input" value={style} onChange={(e) => setStyle(e.target.value as NonNullable<TrainingExample["style"]> | "")}>
            <option value="">Any</option>
            <option value="english">English</option>
            <option value="mixed">Mixed (e.g. Tanglish)</option>
            <option value="pure">Pure (the call language only)</option>
          </select>
        </div>
      </div>
      {save.error && <ErrorNote error={save.error} />}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="btn-primary" disabled={turn === null || !better.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save as Draft"}
        </button>
      </div>
    </div>
  );
}
