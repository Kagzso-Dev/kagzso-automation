import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  downloadDataQualityExport,
  EXCLUDED_LABELS,
  issueLabel,
  type DqJob,
  type DqRecord,
  type DqRecordStatus,
  type DqReview,
  type DqStatusInfo,
} from "../lib/dataQuality";
import { PageHeader } from "../components/Layout";
import { Badge, EmptyState, ErrorNote, Spinner, Table, Tabs, type BadgeTone } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useToast } from "../components/toast";

// Data Quality (admin only): check a contact file before using it. Rows stay in staging
// until an admin approves them; nothing is added to any contact list, called or sent.

const JOB_TONE: Record<DqJob["status"], BadgeTone> = { RUNNING: "accent", PAUSED: "warn", CANCELLED: "neutral", DONE: "ok" };
const ROW_TONE: Record<DqRecordStatus, BadgeTone> = { VALID: "ok", INVALID: "crit", DUPLICATE: "warn", EXCLUDED: "neutral" };
const REVIEW_TONE: Record<DqReview, BadgeTone> = { PENDING: "neutral", APPROVED: "ok", REJECTED: "crit" };
type Filter = "ALL" | DqRecordStatus;

function aiLine(job: DqJob): string {
  if (job.aiStatus === "unavailable") return job.note ?? "Ollama not available";
  if (job.aiStatus === "cancelled") return `Cancelled after ${job.aiDone} of ${job.valid}`;
  if (job.aiStatus === "done") return job.valid ? `Scored ${job.aiDone} of ${job.valid}` : "Nothing to score";
  return `${job.aiDone} of ${job.valid} scored${job.aiFailures ? `, ${job.aiFailures} failed` : ""}`;
}

export function DataQualityPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["data-quality-status"],
    queryFn: () => api<DqStatusInfo>("/api/data-quality/status"),
    refetchInterval: 30_000,
  });
  const jobs = useQuery({
    queryKey: ["data-quality-jobs"],
    queryFn: () => api<{ items: DqJob[] }>("/api/data-quality/jobs"),
    refetchInterval: (q) => (q.state.data?.items.some((j) => j.status === "RUNNING") ? 3000 : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["data-quality-jobs"] });
    void qc.invalidateQueries({ queryKey: ["data-quality-job"] });
  };

  const uploadFile = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api<{ job: DqJob; truncated: boolean }>("/api/data-quality/jobs", { method: "POST", body: fd, notify: false });
    },
    onSuccess: ({ job, truncated }) => {
      toast.success("File checked", [
        `${job.valid} valid, ${job.invalid} invalid, ${job.duplicates} duplicate, ${job.excluded} excluded`,
        ...(truncated ? ["Only the first 5000 rows were read."] : []),
      ]);
      setOpenId(job.id);
      refresh();
    },
    onError: (err) => toast.fromError(err, "Couldn't check the file"),
  });

  const action = useMutation({
    mutationFn: ({ id, act }: { id: string; act: "pause" | "resume" | "cancel" | "remove" }) =>
      act === "remove"
        ? api(`/api/data-quality/jobs/${id}`, { method: "DELETE", notify: "Removed" })
        : api(`/api/data-quality/jobs/${id}/${act}`, { method: "POST", notify: act === "pause" ? "Paused" : act === "resume" ? "Resumed" : "Cancelled" }),
    onSuccess: (_r, { id, act }) => {
      if (act === "remove" && openId === id) setOpenId(null);
      refresh();
    },
    onError: (err) => toast.fromError(err),
  });

  const askCancel = async (job: DqJob) => {
    if (await confirm({ title: "Cancel AI scoring?", body: "Rows not scored yet keep only the standard checks. This can't be resumed.", confirmText: "Cancel scoring", tone: "danger" })) {
      action.mutate({ id: job.id, act: "cancel" });
    }
  };
  const askRemove = async (job: DqJob) => {
    if (await confirm({ title: `Remove ${job.filename}?`, body: "Deletes this check and its rows from Data Quality only. No contact list is touched.", confirmText: "Remove", tone: "danger" })) {
      action.mutate({ id: job.id, act: "remove" });
    }
  };

  const ollama = status.data?.ollama;
  return (
    <div>
      <PageHeader
        title="Data Quality"
        subtitle="Check a contact file before you use it. Rows stay here until you approve them — nothing is added to your contacts, called or sent."
        action={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile.mutate(f);
                e.target.value = "";
              }}
            />
            <button type="button" className="btn-primary" disabled={uploadFile.isPending} onClick={() => fileRef.current?.click()}>
              {uploadFile.isPending ? "Checking…" : "Upload file"}
            </button>
          </>
        }
      />

      {ollama && !ollama.available && (
        <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          Ollama not available{ollama.reason ? `: ${ollama.reason}` : ""}. Only the standard checks run.
        </p>
      )}
      {ollama?.available && (
        <p className="mb-3 text-xs text-slate-550">
          AI score: {ollama.model} on this server's Ollama. Only the name and business name are sent to it; phone numbers and emails are never sent.
          {status.data?.liveCalls ? " Scoring is paused while live AI calls run." : ""}
        </p>
      )}
      <p className="mb-4 text-xs text-slate-550">
        Columns are found by their header: Name, Phone (or Mobile), Business name (or Company), Email. Do not call, Not interested and Wrong
        person numbers are excluded and never scored.
      </p>

      {jobs.isLoading ? (
        <Spinner />
      ) : jobs.error ? (
        <ErrorNote error={jobs.error} />
      ) : !jobs.data?.items.length ? (
        <EmptyState icon="quality" title="No files checked yet">
          Upload a .csv or .xlsx file to check it.
        </EmptyState>
      ) : (
        <Table head={["File", "Rows", "Valid", "Invalid", "Duplicate", "Excluded", "AI score", "Status", ""]}>
          {jobs.data.items.map((j) => (
            <tr key={j.id} className={`border-b border-line-subtle last:border-0 ${openId === j.id ? "bg-tint" : ""}`}>
              <td className="px-4 py-3">
                <button type="button" className="font-medium text-ink hover:underline" onClick={() => setOpenId(openId === j.id ? null : j.id)}>
                  {j.filename}
                </button>
                <div className="text-xs text-slate-550">{new Date(j.createdAt).toLocaleString()}</div>
              </td>
              <td className="px-4 py-3 font-mono">{j.total}</td>
              <td className="px-4 py-3 font-mono">{j.valid}</td>
              <td className="px-4 py-3 font-mono">{j.invalid}</td>
              <td className="px-4 py-3 font-mono">{j.duplicates}</td>
              <td className="px-4 py-3 font-mono">{j.excluded}</td>
              <td className="px-4 py-3 text-xs">
                {aiLine(j)}
                {j.waitingReason && <div className="text-warn">{j.waitingReason}</div>}
              </td>
              <td className="px-4 py-3">
                <Badge tone={JOB_TONE[j.status]}>{j.status.toLowerCase()}</Badge>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right">
                {j.status === "RUNNING" && (
                  <button type="button" className="btn-ghost" onClick={() => action.mutate({ id: j.id, act: "pause" })}>
                    Pause
                  </button>
                )}
                {j.status === "PAUSED" && (
                  <button type="button" className="btn-ghost" onClick={() => action.mutate({ id: j.id, act: "resume" })}>
                    Resume
                  </button>
                )}
                {(j.status === "RUNNING" || j.status === "PAUSED") && (
                  <button type="button" className="btn-ghost" onClick={() => void askCancel(j)}>
                    Cancel
                  </button>
                )}
                {j.status !== "RUNNING" && (
                  <button type="button" className="btn-ghost" onClick={() => void askRemove(j)}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {openId && <JobDetail key={openId} jobId={openId} />}
    </div>
  );
}

function JobDetail({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const detail = useQuery({
    queryKey: ["data-quality-job", jobId],
    queryFn: () => api<{ job: DqJob; records: DqRecord[] }>(`/api/data-quality/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data?.job.status === "RUNNING" ? 3000 : false),
  });
  const review = useMutation({
    mutationFn: ({ ids, value }: { ids: string[]; value: DqReview }) =>
      api<{ updated: number }>(`/api/data-quality/jobs/${jobId}/review`, { method: "POST", json: { ids, review: value }, notify: false }),
    onSuccess: ({ updated }, { value }) => {
      toast.success(value === "APPROVED" ? "Approved" : value === "REJECTED" ? "Rejected" : "Back to pending", [`${updated} row${updated === 1 ? "" : "s"}`]);
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ["data-quality-job", jobId] });
    },
    onError: (err) => toast.fromError(err),
  });
  const exportRows = async (rows: "approved" | "valid") => {
    try {
      await downloadDataQualityExport(jobId, rows);
    } catch (err) {
      toast.fromError(err, "Export failed");
    }
  };

  if (detail.isLoading) return <div className="card mt-6"><Spinner /></div>;
  if (detail.error) return <div className="mt-6"><ErrorNote error={detail.error} /></div>;
  const { job, records } = detail.data!;
  const shown = filter === "ALL" ? records : records.filter((r) => r.status === filter);
  const pickable = shown.filter((r) => r.status === "VALID");
  const approved = records.filter((r) => r.review === "APPROVED").length;
  const count = (s: DqRecordStatus) => records.filter((r) => r.status === s).length;
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{job.filename}</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" disabled={picked.size === 0 || review.isPending} onClick={() => review.mutate({ ids: [...picked], value: "APPROVED" })}>
            Approve {picked.size || ""}
          </button>
          <button type="button" className="btn-ghost" disabled={picked.size === 0 || review.isPending} onClick={() => review.mutate({ ids: [...picked], value: "REJECTED" })}>
            Reject {picked.size || ""}
          </button>
          <button type="button" className="btn-ghost" disabled={approved === 0} onClick={() => void exportRows("approved")}>
            Export approved ({approved})
          </button>
          <button type="button" className="btn-ghost" disabled={job.valid === 0} onClick={() => void exportRows("valid")}>
            Export all valid
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-slate-550">
        Approving only marks rows here. To use them, export the approved rows and import the file where you need it.
      </p>
      <Tabs<Filter>
        tabs={[
          { value: "ALL", label: `All (${records.length})` },
          { value: "VALID", label: `Valid (${count("VALID")})` },
          { value: "INVALID", label: `Invalid (${count("INVALID")})` },
          { value: "DUPLICATE", label: `Duplicate (${count("DUPLICATE")})` },
          { value: "EXCLUDED", label: `Excluded (${count("EXCLUDED")})` },
        ]}
        value={filter}
        onChange={(f) => {
          setFilter(f);
          setPicked(new Set());
        }}
      />
      <Table
        head={[
          <input
            key="all"
            type="checkbox"
            aria-label="Select all valid rows shown"
            disabled={pickable.length === 0}
            checked={pickable.length > 0 && pickable.every((r) => picked.has(r.id))}
            onChange={(e) => setPicked(e.target.checked ? new Set(pickable.map((r) => r.id)) : new Set())}
          />,
          "Row",
          "Name",
          "Phone",
          "Business",
          "Check",
          "Score",
          "Notes",
          "Review",
        ]}
      >
        {shown.map((r) => (
          <tr key={r.id} className="border-b border-line-subtle align-top last:border-0">
            <td className="px-4 py-3">
              {r.status === "VALID" && <input type="checkbox" aria-label={`Select row ${r.rowIndex + 2}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} />}
            </td>
            <td className="px-4 py-3 font-mono text-xs">{r.rowIndex + 2}</td>
            <td className="px-4 py-3">{r.name ?? <span className="text-slate-550">—</span>}</td>
            <td className="px-4 py-3 font-mono text-xs">{r.phone ?? r.phoneRaw ?? "—"}</td>
            <td className="px-4 py-3">
              {r.businessName ?? <span className="text-slate-550">—</span>}
              {r.email && <div className="text-xs text-slate-550">{r.email}</div>}
            </td>
            <td className="px-4 py-3">
              <Badge tone={ROW_TONE[r.status]}>{r.status === "EXCLUDED" && r.excludedReason ? EXCLUDED_LABELS[r.excludedReason] : r.status.toLowerCase()}</Badge>
            </td>
            <td className="px-4 py-3 font-mono text-xs">
              {r.score ?? "—"}
              {r.ruleScore != null && (
                <div className="text-slate-550">
                  rules {r.ruleScore}
                  {r.aiScore != null ? ` · AI ${r.aiScore}` : r.aiState === "PENDING" ? " · AI …" : ""}
                </div>
              )}
            </td>
            <td className="max-w-xs px-4 py-3 text-xs">
              {[...r.issues, ...r.flags].map((c) => (
                <div key={c}>{issueLabel(c)}</div>
              ))}
              {r.aiNotes && <div className={r.aiState === "ERROR" ? "text-crit" : "text-slate-550"}>AI: {r.aiNotes}</div>}
            </td>
            <td className="px-4 py-3">{r.status === "VALID" ? <Badge tone={REVIEW_TONE[r.review]}>{r.review.toLowerCase()}</Badge> : null}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
