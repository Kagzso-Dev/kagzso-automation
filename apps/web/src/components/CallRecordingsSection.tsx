import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Badge, ErrorNote, Spinner } from "./ui";
import { CallRecording, RecordingBadge, type RecordingStatusName } from "./CallRecording";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";

/**
 * Settings > Call recordings (admins): whether calls are recorded, how many recordings there are,
 * the space they use, free disk, how long they're kept, and the latest recordings with a player.
 * Includes "Test call to my number" calls, which don't appear in the other call lists.
 */

interface RecordingSettings {
  enabled: boolean;
  storage_configured: boolean;
  retention_days: number;
  default_retention_days: number;
  max_retention_days: number;
  counts: { completed: number; processing: number; failed: number; deleted: number };
  total_bytes: number;
  oldest_at: string | null;
  disk_free_bytes: number | null;
}

interface RecentRecording {
  logId: string;
  customerName: string | null;
  outcome: string | null;
  durationSec: number | null;
  at: string;
  testCall: boolean;
  status: RecordingStatusName;
  recordingMs: number | null;
}

const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

export function CallRecordingsSection() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const settings = useQuery({
    queryKey: ["recording-settings"],
    queryFn: () => api<RecordingSettings>("/api/ai-calls/recordings/settings", { notify: false }),
    retry: false,
  });
  const recent = useQuery({
    queryKey: ["recent-recordings"],
    queryFn: () => api<{ items: RecentRecording[] }>("/api/ai-calls/recordings/recent?limit=20", { notify: false }),
    enabled: !!settings.data,
    retry: false,
  });

  const [days, setDays] = useState("");
  const [dirty, setDirty] = useState(false);
  const serverDays = settings.data?.retention_days;
  useEffect(() => {
    if (serverDays !== undefined) {
      setDays(String(serverDays));
      setDirty(false);
    }
  }, [serverDays]);

  const save = useMutation({
    mutationFn: () =>
      api<RecordingSettings>("/api/ai-calls/recordings/settings", {
        method: "PUT",
        json: { retentionDays: Number(days) },
        notify: "Retention saved",
      }),
    onSuccess: (v) => {
      qc.setQueryData(["recording-settings"], v);
      setDirty(false);
    },
  });

  // Delete one recording: the same API (and voice backend helper) the retention job's deletion uses.
  // Only the audio goes; the call, transcript and summary stay.
  const removeRecording = useMutation({
    mutationFn: (logId: string) =>
      api(`/api/ai-calls/logs/${logId}/recording`, { method: "DELETE", notify: "Recording deleted" }),
    onSuccess: (_res, logId) => {
      qc.setQueryData<{ items: RecentRecording[] }>(["recent-recordings"], (d) =>
        d ? { items: d.items.map((i) => (i.logId === logId ? { ...i, status: "deleted" } : i)) } : d,
      );
      void qc.invalidateQueries({ queryKey: ["ai-call-recording", logId] });
      void qc.invalidateQueries({ queryKey: ["ai-call-recordings"] });
      void qc.invalidateQueries({ queryKey: ["recording-settings"] });
    },
    onError: (err) => toast.error("Couldn't delete the recording", [err instanceof Error ? err.message : String(err)]),
  });

  // AI calls off (404): the section isn't shown at all.
  if (settings.error instanceof ApiError && settings.error.status === 404) return null;

  const s = settings.data;
  const max = s?.max_retention_days ?? 3650;
  const n = Number(days);
  const bad = days.trim() === "" || !Number.isInteger(n) || n < 0 || n > max;

  return (
    <section className="settings-section">
      <h2 className="settings-heading">Call recordings</h2>
      <div className="settings-card space-y-4">
        {settings.isLoading ? (
          <Spinner />
        ) : settings.error ? (
          <ErrorNote error={settings.error} />
        ) : s ? (
          <>
            <p className="text-slate-550">
              {s.enabled ? (
                <>
                  <Badge tone="ok">recording on</Badge> Answered AI calls are recorded on this server (left: customer, right:
                  AI agent).
                </>
              ) : (
                <>
                  <Badge>recording off</Badge> Turn it on with CALL_RECORDING_ENABLED on the voice backend.
                </>
              )}
              {!s.storage_configured && <span className="text-crit"> RECORDINGS_DIR is not set on the voice backend.</span>}
            </p>

            <ul className="grid gap-2 sm:grid-cols-4">
              {(
                [
                  ["Recordings", String(s.counts.completed)],
                  ["Space used", mb(s.total_bytes)],
                  ["Oldest kept", s.oldest_at ? new Date(s.oldest_at).toLocaleDateString() : "—"],
                  ["Free disk", s.disk_free_bytes != null ? mb(s.disk_free_bytes) : "—"],
                ] as const
              ).map(([label, value]) => (
                <li key={label} className="rounded-lg border border-line/70 px-3 py-2">
                  <div className="text-lg font-semibold">{value}</div>
                  <div className="text-xs text-slate-550">{label}</div>
                </li>
              ))}
            </ul>
            {(s.counts.failed > 0 || s.counts.processing > 0) && (
              <p className="text-xs text-slate-550">
                {s.counts.processing > 0 && `${s.counts.processing} being saved. `}
                {s.counts.failed > 0 && `${s.counts.failed} could not be recorded.`}
              </p>
            )}

            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!bad) save.mutate();
              }}
            >
              <div>
                <label className="label" htmlFor="recording-retention">
                  Keep recordings for
                </label>
                <div className="input-suffix">
                  <input
                    id="recording-retention"
                    className={`input w-32 pr-12 ${bad ? "border-crit" : ""}`}
                    type="number"
                    min={0}
                    max={max}
                    value={days}
                    disabled={!s.storage_configured || save.isPending}
                    onChange={(e) => {
                      setDays(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <span>days</span>
                </div>
              </div>
              <button className="btn-primary settings-btn" disabled={!dirty || bad || save.isPending || !s.storage_configured}>
                {save.isPending ? "Saving…" : "Save"}
              </button>
              {save.isSuccess && !dirty && <span className="text-ok">Saved.</span>}
            </form>
            <p className="text-xs text-slate-550">
              {bad
                ? `Enter a whole number from 0 to ${max}.`
                : n === 0
                  ? "0 = keep recordings forever (watch the free disk space)."
                  : `Recordings older than ${n} days are deleted automatically (checked every hour). Calls, transcripts and summaries are kept.`}
            </p>
            {save.error && <ErrorNote error={save.error} />}

            <div>
              <h3 className="mb-2 text-sm font-semibold">Recent recordings</h3>
              {recent.isLoading ? (
                <Spinner />
              ) : recent.error ? (
                <ErrorNote error={recent.error} />
              ) : !recent.data?.items.length ? (
                <p className="text-sm text-slate-550">No recordings yet.</p>
              ) : (
                <ul className="divide-y divide-line/70 rounded-lg border border-line/70">
                  {recent.data.items.map((r) => (
                    <li key={r.logId} className="px-3 py-2.5 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.customerName || "Customer"}</span>
                        {r.testCall && <Badge tone="accent">test call</Badge>}
                        {r.outcome && <span className="text-xs text-slate-550">{r.outcome.replace(/_/g, " ")}</span>}
                        {r.recordingMs != null && <span className="text-xs text-slate-550">{(r.recordingMs / 1000).toFixed(0)}s</span>}
                        <RecordingBadge status={r.status} />
                        <span className="ml-auto text-xs text-slate-550">{new Date(r.at).toLocaleString()}</span>
                        {r.status === "completed" && (
                          <button
                            type="button"
                            className="text-action-danger text-xs"
                            aria-label={`Delete the recording of ${r.customerName || "this call"}`}
                            disabled={removeRecording.isPending}
                            onClick={async () => {
                              const ok = await confirm({
                                title: "Delete this recording?",
                                body: "This permanently deletes the audio recording. The call, transcript and summary will be kept. This cannot be undone.",
                                confirmText: "Delete",
                                tone: "danger",
                              });
                              if (ok) removeRecording.mutate(r.logId);
                            }}
                          >
                            {removeRecording.isPending && removeRecording.variables === r.logId ? "Deleting…" : "Delete"}
                          </button>
                        )}
                      </div>
                      {r.status === "deleted" ? (
                        // The player (and any audio playing) is gone with it.
                        <p className="mt-1 text-xs text-slate-550">This recording was deleted.</p>
                      ) : (
                        <CallRecording logId={r.logId} status={r.status} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
