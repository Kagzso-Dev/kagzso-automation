import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getAccessToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Badge, ErrorNote, Spinner } from "./ui";
import { useConfirm } from "./confirm";

/**
 * AI call recordings (admins only; the API refuses everyone else too). The voice backend records
 * answered calls when CALL_RECORDING_ENABLED is on: left channel = customer, right = AI agent.
 * Audio is fetched with the signed-in admin's token and played from memory - there is no public
 * URL. The transcript and summary next to it are unchanged.
 */

export type RecordingStatusName = "processing" | "completed" | "failed" | "deleted";
type RecordingStatus = RecordingStatusName;
interface RecordingMeta {
  status: RecordingStatus;
  duration_ms: number | null;
  size_bytes: number | null;
  error: string | null;
}

export function useIsAdmin(): boolean {
  return useAuth().user?.role === "ADMIN";
}

/** Recording status per call log id (call list badges); empty for non-admins. */
export function useRecordingStatuses(logIds: string[]): Record<string, RecordingStatus> {
  const admin = useIsAdmin();
  const ids = [...new Set(logIds)].sort();
  const q = useQuery({
    queryKey: ["ai-call-recordings", ids],
    queryFn: () =>
      api<{ items: Record<string, RecordingStatus> }>(`/api/ai-calls/recordings/status?logIds=${ids.join(",")}`, { notify: false }),
    enabled: admin && ids.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  return q.data?.items ?? {};
}

const STATUS: Record<RecordingStatus, { label: string; tone: "ok" | "neutral" | "crit" | "warn" }> = {
  completed: { label: "recorded", tone: "ok" },
  processing: { label: "saving recording", tone: "warn" },
  failed: { label: "recording failed", tone: "crit" },
  deleted: { label: "recording deleted", tone: "neutral" },
};

export function RecordingBadge({ status }: { status?: RecordingStatus }) {
  if (!status) return null;
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

/** "Recording" toggle + player, download and delete for one call log. Renders nothing for non-admins. */
export function CallRecording({ logId, status }: { logId: string; status?: RecordingStatus }) {
  const admin = useIsAdmin();
  const [open, setOpen] = useState(false);
  if (!admin || !status) return null;
  return (
    <div className="mt-1 text-xs">
      <button type="button" className="cursor-pointer text-accent-ink hover:underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide recording" : "Recording"}
      </button>
      {open && <RecordingPanel logId={logId} />}
    </div>
  );
}

function RecordingPanel({ logId }: { logId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const meta = useQuery({
    queryKey: ["ai-call-recording", logId],
    queryFn: () => api<{ enabled: boolean; recording: RecordingMeta | null }>(`/api/ai-calls/logs/${logId}/recording`, { notify: false }),
    retry: false,
  });
  const rec = meta.data?.recording ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The WAV is fetched with the admin's token (an <audio src> can't send it) and played from memory.
  useEffect(() => {
    if (rec?.status !== "completed") return;
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const token = getAccessToken();
        const res = await fetch(`/api/ai-calls/logs/${logId}/recording/audio`, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Couldn't load the recording (${res.status})`);
        }
        objectUrl = URL.createObjectURL(await res.blob());
        if (!cancelled) setUrl(objectUrl);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [logId, rec?.status]);

  const remove = useMutation({
    mutationFn: () => api(`/api/ai-calls/logs/${logId}/recording`, { method: "DELETE", notify: "Recording deleted" }),
    onSuccess: () => {
      setUrl(null);
      void qc.invalidateQueries({ queryKey: ["ai-call-recording", logId] });
      void qc.invalidateQueries({ queryKey: ["ai-call-recordings"] });
    },
  });

  if (meta.isLoading) return <Spinner />;
  if (meta.error) return <ErrorNote error={meta.error} />;
  if (!rec) {
    return <p className="mt-1 text-slate-550">{meta.data?.enabled ? "No recording for this call." : "Call recording is turned off."}</p>;
  }
  if (rec.status === "processing") return <p className="mt-1 text-warn">The recording is still being saved — check again in a moment.</p>;
  if (rec.status === "failed") return <p className="mt-1 text-crit">This call could not be recorded{rec.error ? ` (${rec.error.replace(/_/g, " ")})` : ""}.</p>;
  if (rec.status === "deleted") return <p className="mt-1 text-slate-550">This recording was deleted.</p>;

  return (
    <div className="mt-1.5 space-y-1.5 rounded-lg border border-line/70 bg-surface-muted px-3 py-2">
      <div className="text-slate-550">
        {rec.duration_ms != null ? `${(rec.duration_ms / 1000).toFixed(1)} s` : ""}
        {rec.size_bytes != null ? ` · ${(rec.size_bytes / 1024 / 1024).toFixed(1)} MB` : ""} · left: customer, right: AI agent
      </div>
      {loadError ? (
        <p className="text-crit">{loadError}</p>
      ) : url ? (
        <audio controls preload="metadata" src={url} className="w-full" aria-label="Call recording" />
      ) : (
        <Spinner />
      )}
      {remove.error && <ErrorNote error={remove.error} />}
      <div className="flex flex-wrap gap-2">
        {url && (
          <a className="btn-ghost h-7 px-2.5 py-0 text-[11px]" href={url} download={`call-${logId}.wav`}>
            Download
          </a>
        )}
        <button
          type="button"
          className="btn h-7 border-crit-line bg-transparent px-2.5 py-0 text-[11px] text-crit hover:bg-crit-soft"
          disabled={remove.isPending}
          onClick={async () => {
            if (
              await confirm({
                title: "Delete this recording?",
                body: "The audio file is deleted permanently. The call, transcript and summary stay.",
                confirmText: "Delete recording",
                tone: "danger",
              })
            )
              remove.mutate();
          }}
        >
          Delete recording
        </button>
      </div>
    </div>
  );
}
