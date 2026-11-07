import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  VOICE_TUNING_DEFAULT_PRESET,
  VOICE_TUNING_LIMITS,
  VOICE_TUNING_PRESET_HINTS,
  VOICE_TUNING_PRESET_LABELS,
  VOICE_TUNING_PRESETS,
  voiceTuningPreset,
  voiceTuningSetting,
  type VoiceTuningRow,
  type VoiceTuningSetting,
} from "@dispatch/shared";
import { api, ApiError } from "../lib/api";
import { ErrorNote, Spinner } from "./ui";
import { useToast } from "./toast";

type Field = "endOfSpeechSilenceMs" | "extraWaitIfIncompleteMs" | "hardCapMs";
const FIELDS: { key: Field; label: string }[] = [
  { key: "endOfSpeechSilenceMs", label: "End-of-speech wait (ms)" },
  { key: "extraWaitIfIncompleteMs", label: "Extra wait for unfinished sentences (ms)" },
  { key: "hardCapMs", label: "Hard cap on waiting (ms, 0 = no cap)" },
];

/**
 * Settings > Voice response tuning (admins): how long a call waits for the customer before replying. Tamil only:
 * every other language keeps its calls exactly as they are. A preset applies from the next call as soon as it is
 * clicked, so "Current behavior" is an instant rollback.
 */
export function VoiceResponseTuningSection() {
  const list = useQuery({
    queryKey: ["voice-tuning"],
    queryFn: () => api<{ items: VoiceTuningRow[] }>("/api/ai-calls/voice-tuning", { notify: false }),
    retry: false,
  });
  if (list.error instanceof ApiError && list.error.status === 404) return null; // AI calls are off
  if (list.data && list.data.items.length === 0) return null;
  return (
    <section className="settings-section">
      <h2 className="settings-heading">Voice response tuning</h2>
      <div className="settings-card space-y-3">
        <p className="text-slate-550">
          How long the AI waits for the customer before it replies, and how fast it answers once they have finished. Applies from the next call,
          except for an AI agent that has picked its own Reply speed.
        </p>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <ErrorNote error={list.error} />
        ) : (
          list.data!.items.map((row) => <TuningRow key={`${row.language}:${JSON.stringify(row.tuning)}`} row={row} />)
        )}
      </div>
    </section>
  );
}

function TuningRow({ row }: { row: VoiceTuningRow }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<VoiceTuningSetting>(row.tuning);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["voice-tuning"] });
  const save = useMutation({
    mutationFn: (tuning: VoiceTuningSetting) =>
      api<VoiceTuningRow>(`/api/ai-calls/voice-tuning/${row.language}`, { method: "PUT", json: tuning, notify: false }),
    onSuccess: (saved) => {
      toast.success(`${row.name}: ${saved.tuning.preset === "custom" ? "custom values" : VOICE_TUNING_PRESET_LABELS[saved.tuning.preset]} saved`, [
        "New calls use it.",
      ]);
      refresh();
    },
  });
  const reset = useMutation({
    mutationFn: () => api<VoiceTuningRow>(`/api/ai-calls/voice-tuning/${row.language}`, { method: "DELETE", notify: false }),
    onSuccess: () => {
      toast.success(`${row.name}: back to ${VOICE_TUNING_PRESET_LABELS[VOICE_TUNING_DEFAULT_PRESET]}`);
      refresh();
    },
  });
  const check = voiceTuningSetting.safeParse(form);
  const fieldError = (k: Field) => (!check.success ? check.error.issues.find((i) => i.path[0] === k)?.message : undefined);
  const busy = save.isPending || reset.isPending;

  return (
    <div className="space-y-3 rounded-lg border border-line/70 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{row.name}</span>
        <button type="button" className="btn btn-ghost" disabled={!row.saved || busy} onClick={() => reset.mutate()}>
          Reset to default
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label={`${row.name} response mode`}>
        {VOICE_TUNING_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={row.tuning.preset === p}
            disabled={busy}
            onClick={() => save.mutate(voiceTuningPreset(p))}
            className={`rounded-lg border px-3 py-2 text-left ${row.tuning.preset === p ? "border-accent bg-tint font-semibold" : "border-line"} disabled:opacity-50`}
          >
            {VOICE_TUNING_PRESET_LABELS[p]}
            {p === VOICE_TUNING_DEFAULT_PRESET ? " (default)" : ""}
            <span className="block text-xs font-normal text-slate-550">{VOICE_TUNING_PRESET_HINTS[p]}</span>
          </button>
        ))}
      </div>
      {row.tuning.preset === "custom" && <p className="text-xs text-slate-550">Using custom values from Advanced.</p>}
      <details>
        <summary className="cursor-pointer text-xs font-semibold text-accent-ink">Advanced</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {FIELDS.map(({ key, label }) => (
            <div key={key}>
              <label className="label" htmlFor={`voice-tuning-${key}`}>
                {label}
              </label>
              <input
                id={`voice-tuning-${key}`}
                type="number"
                inputMode="numeric"
                className="input"
                min={VOICE_TUNING_LIMITS[key].min}
                max={VOICE_TUNING_LIMITS[key].max}
                step={50}
                aria-invalid={!!fieldError(key)}
                value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, preset: "custom", [key]: e.target.valueAsNumber }))}
              />
              {fieldError(key) && <p className="mt-1 text-xs text-crit">{fieldError(key)}</p>}
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" className="btn-primary" disabled={!check.success || busy} onClick={() => check.success && save.mutate(check.data)}>
            Save values
          </button>
        </div>
      </details>
      {(save.error || reset.error) && <ErrorNote error={save.error ?? reset.error} />}
    </div>
  );
}
