import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  AI_PROVIDER_LABELS,
  CHECK_STATUS_OPTIONS,
  cleanFilters,
  downloadDataQualityExport,
  downloadFilteredExport,
  DQ_COMPUTED_COLUMNS,
  DQ_STORED_COLUMNS,
  EXCLUDED_LABELS,
  EXPORT_PRESETS,
  EXTRA_FIELD_LABELS,
  issueLabel,
  PHONE_TYPE_OPTIONS,
  presetColumns,
  TIER_OPTIONS,
  type DqExtraField,
  type DqFacets,
  type DqFilters,
  type DqJob,
  type DqRecord,
  type DqRecordStatus,
  type DqReview,
  type DqStatusInfo,
  type ExportPreset,
  type FilteredExportRequest,
} from "../lib/dataQuality";
import { PageHeader } from "../components/Layout";
import { Badge, EmptyState, ErrorNote, Modal, Spinner, Table, Tabs, type BadgeTone } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useToast } from "../components/toast";

// Data Quality (admin only): check a contact file before using it. Rows stay in staging
// until an admin approves them; nothing is added to any contact list, called or sent.

const JOB_TONE: Record<DqJob["status"], BadgeTone> = { RUNNING: "accent", PAUSED: "warn", CANCELLED: "neutral", DONE: "ok" };
const ROW_TONE: Record<DqRecordStatus, BadgeTone> = { VALID: "ok", INVALID: "crit", DUPLICATE: "warn", EXCLUDED: "neutral" };
const REVIEW_TONE: Record<DqReview, BadgeTone> = { PENDING: "neutral", APPROVED: "ok", REJECTED: "crit" };
type Filter = "ALL" | DqRecordStatus;

const clampScore = (v: string) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function aiLine(job: DqJob): string {
  if (job.aiStatus === "unavailable") return job.note ?? "AI not available";
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

  const ai = status.data?.ai;
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

      {ai && !ai.available && (
        <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          {AI_PROVIDER_LABELS[ai.provider]} not available{ai.reason ? `: ${ai.reason}` : ""}. Only the standard checks run.
        </p>
      )}
      {ai?.available && (
        <p className="mb-3 text-xs text-slate-550">
          AI score: {ai.model} {ai.provider === "ollama" ? "on this server's Ollama" : `via ${AI_PROVIDER_LABELS[ai.provider]}`}. Only the name and business
          name are sent to it; phone numbers and emails are never sent.
          {status.data?.liveCalls ? " Scoring is paused while live AI calls run." : ""}
        </p>
      )}
      <p className="mb-4 text-xs text-slate-550">
        Columns are found by their header: Name, Phone (or Mobile), Business name (or Company), Email. Do not call, Not interested and Wrong
        person numbers are excluded and never scored. Placeholder numbers (9999999999, 1234567890, 9000000001) are invalid; Indian
        landlines are kept but lose 20 points (no WhatsApp). Placeholder emails (test@…, noemail@…, …@example.com) count as bad emails.
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
  const confirm = useConfirm();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [minScore, setMinScore] = useState(70);
  const [aboveOnly, setAboveOnly] = useState(false);
  const detail = useQuery({
    queryKey: ["data-quality-job", jobId],
    queryFn: () => api<{ job: DqJob; records: DqRecord[] }>(`/api/data-quality/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data?.job.status === "RUNNING" ? 3000 : false),
  });
  // Filters: the server checks the whole file (500 rows at a time) and the table shows the result.
  // The buttons above the table (approve / reject by score, export approved) still count the whole file.
  const [filters, setFilters] = useState<DqFilters>({});
  const typedKey = JSON.stringify(cleanFilters(filters));
  const filterKey = useDebounced(typedKey, 300);
  const filtering = filterKey !== "{}";
  const [exportOpen, setExportOpen] = useState(false);
  const facets = useQuery({
    queryKey: ["data-quality-facets", jobId],
    queryFn: () => api<DqFacets>(`/api/data-quality/jobs/${jobId}/facets`),
    staleTime: Infinity,
  });
  const filtered = useQuery({
    queryKey: ["data-quality-job", jobId, filterKey],
    queryFn: () => api<{ job: DqJob; records: DqRecord[] }>(`/api/data-quality/jobs/${jobId}?filters=${encodeURIComponent(filterKey)}`),
    enabled: filtering,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.job.status === "RUNNING" ? 3000 : false),
  });
  useEffect(() => setPicked(new Set()), [filterKey]);
  const reviewed = (updated: number, value: DqReview) => {
    toast.success(value === "APPROVED" ? "Approved" : value === "REJECTED" ? "Rejected" : "Back to pending", [`${updated} row${updated === 1 ? "" : "s"}`]);
    setPicked(new Set());
    void qc.invalidateQueries({ queryKey: ["data-quality-job", jobId] });
  };
  const review = useMutation({
    mutationFn: ({ ids, value }: { ids: string[]; value: DqReview }) =>
      api<{ updated: number }>(`/api/data-quality/jobs/${jobId}/review`, { method: "POST", json: { ids, review: value }, notify: false }),
    onSuccess: ({ updated }, { value }) => reviewed(updated, value),
    onError: (err) => toast.fromError(err),
  });
  const reviewByScore = useMutation({
    mutationFn: (value: "APPROVED" | "REJECTED") =>
      api<{ updated: number }>(`/api/data-quality/jobs/${jobId}/review-by-score`, { method: "POST", json: { minScore, review: value }, notify: false }),
    onSuccess: ({ updated }, value) => reviewed(updated, value),
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
  const tableRecords = filtering ? filtered.data?.records : records;
  const byStatus = !tableRecords ? [] : filter === "ALL" ? tableRecords : tableRecords.filter((r) => r.status === filter);
  const shown = aboveOnly ? byStatus.filter((r) => r.score != null && r.score >= minScore) : byStatus;
  // The export holds exactly the rows shown (excluded rows only when asked for), so wait until the table is current.
  const settling = typedKey !== filterKey || (filtering && (!filtered.data || filtered.isPlaceholderData));
  const exportable = shown.filter((r) => r.status !== "EXCLUDED").length;
  const pickable = shown.filter((r) => r.status === "VALID");
  // Review by score: valid rows nobody has reviewed yet, once no AI score is still to come.
  const waitingForAi = records.some((r) => r.status === "VALID" && r.aiState === "PENDING");
  const unreviewed = records.filter((r) => r.status === "VALID" && r.review === "PENDING" && r.score != null);
  const atOrAbove = unreviewed.filter((r) => r.score! >= minScore).length;
  const below = unreviewed.length - atOrAbove;
  const byScore = async (value: "APPROVED" | "REJECTED") => {
    const n = value === "APPROVED" ? atOrAbove : below;
    const ok = await confirm({
      title: `${value === "APPROVED" ? "Approve" : "Reject"} ${n} row${n === 1 ? "" : "s"} scoring ${value === "APPROVED" ? `${minScore} or more` : `below ${minScore}`}?`,
      body: "Only valid rows not reviewed yet change. Rows you already approved or rejected stay as they are, and nothing leaves Data Quality.",
      confirmText: value === "APPROVED" ? "Approve" : "Reject",
      tone: value === "REJECTED" ? "danger" : "default",
    });
    if (ok) reviewByScore.mutate(value);
  };
  const approved = records.filter((r) => r.review === "APPROVED").length;
  const count = (s: DqRecordStatus) => (tableRecords ?? []).filter((r) => r.status === s).length;
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
          <button type="button" className="btn-ghost" disabled={settling || shown.length === 0} onClick={() => setExportOpen(true)}>
            Export filtered ({exportable.toLocaleString()} rows)
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-slate-550">
        Approving only marks rows here. To use them, export the approved rows and import the file where you need it.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2 text-slate-550">
          Score ≥
          <input type="number" className="input w-20" min={0} max={100} value={minScore} aria-label="Minimum score" onChange={(e) => setMinScore(clampScore(e.target.value))} />
        </label>
        <button type="button" className="btn-ghost" disabled={waitingForAi || atOrAbove === 0 || reviewByScore.isPending} onClick={() => void byScore("APPROVED")}>
          Approve {atOrAbove}
        </button>
        <button type="button" className="btn-ghost" disabled={waitingForAi || below === 0 || reviewByScore.isPending} onClick={() => void byScore("REJECTED")}>
          Reject {below} below
        </button>
        <label className="flex items-center gap-2 text-slate-550">
          <input
            type="checkbox"
            checked={aboveOnly}
            onChange={(e) => {
              setAboveOnly(e.target.checked);
              setPicked(new Set());
            }}
          />
          Only show rows scoring {minScore}+
        </label>
        {waitingForAi && <span className="text-xs text-slate-550">Review by score opens once AI scoring finishes (or is cancelled).</span>}
      </div>
      <FilterPanel
        filters={filters}
        onChange={setFilters}
        facets={facets.data}
        showing={`Showing ${shown.length.toLocaleString()} of ${job.total.toLocaleString()}`}
        busy={settling}
        onClear={() => {
          setFilters({});
          setFilter("ALL");
          setAboveOnly(false);
          setPicked(new Set());
        }}
      />
      <Tabs<Filter>
        tabs={[
          { value: "ALL", label: `All (${(tableRecords ?? []).length})` },
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
      {filtered.error && filtering && <ErrorNote error={filtered.error} />}
      {!tableRecords ? (
        <div className="card">
          <Spinner />
        </div>
      ) : (
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
      )}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        jobId={jobId}
        headers={facets.data?.headers ?? null}
        count={exportable}
        excludedCount={shown.length - exportable}
        base={{
          filters: JSON.parse(filterKey) as DqFilters,
          view: { ...(filter !== "ALL" ? { status: filter } : {}), ...(aboveOnly ? { minScore } : {}) },
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ filters */

function toggleIn<T>(list: T[] | undefined, v: T): T[] {
  const next = new Set(list ?? []);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return [...next];
}
const yesNo = (v: boolean | undefined) => (v === undefined ? "" : v ? "yes" : "no");
const fromYesNo = (s: string) => (s === "" ? undefined : s === "yes");
const scoreOrUndefined = (s: string) => (s === "" ? undefined : clampScore(s));

function CheckGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T[] | undefined;
  onChange: (v: T[]) => void;
}) {
  return (
    <fieldset className="text-sm">
      <legend className="mb-1 text-xs font-medium text-slate-550">{label}</legend>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {options.map(([v, text]) => (
          <label key={v} className="flex items-center gap-1.5">
            <input type="checkbox" checked={value?.includes(v) ?? false} onChange={() => onChange(toggleIn(value, v))} />
            {text}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const EXTRA_FIELDS: DqExtraField[] = ["city", "state", "district", "pincode", "category", "source", "dateAdded"];

function FilterPanel({
  filters,
  onChange,
  facets,
  showing,
  busy,
  onClear,
}: {
  filters: DqFilters;
  onChange: (f: DqFilters) => void;
  facets: DqFacets | undefined;
  showing: string;
  busy: boolean;
  onClear: () => void;
}) {
  const set = <K extends keyof DqFilters>(key: K, value: DqFilters[K]) => onChange({ ...filters, [key]: value });
  const searches: [keyof DqFilters, string][] = [
    ["business", "Business name contains"],
    ["name", "Contact name contains"],
    ["email", "Email contains"],
    ["phone", "Phone contains"],
  ];
  const fileColumns = EXTRA_FIELDS.filter((f) => facets?.columns[f] && facets.values[f]?.length);
  return (
    <div className="card mb-3 space-y-3 p-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {searches.map(([key, label]) => (
          <input
            key={key}
            className="input"
            placeholder={label}
            aria-label={label}
            value={(filters[key] as string | undefined) ?? ""}
            onChange={(e) => set(key, e.target.value)}
          />
        ))}
        {fileColumns.map((f) => (
          <select key={f} className="input" aria-label={EXTRA_FIELD_LABELS[f]} value={filters[f] ?? ""} onChange={(e) => set(f, e.target.value)}>
            <option value="">Any {EXTRA_FIELD_LABELS[f].toLowerCase()}</option>
            {facets!.values[f]!.map(({ value, count }) => (
              <option key={value} value={value}>
                {value} ({count})
              </option>
            ))}
          </select>
        ))}
        <select className="input" aria-label="Has email" value={yesNo(filters.hasEmail)} onChange={(e) => set("hasEmail", fromYesNo(e.target.value))}>
          <option value="">Email: any</option>
          <option value="yes">Has email</option>
          <option value="no">No email</option>
        </select>
        <select className="input" aria-label="Has phone" value={yesNo(filters.hasPhone)} onChange={(e) => set("hasPhone", fromYesNo(e.target.value))}>
          <option value="">Phone: any</option>
          <option value="yes">Has phone</option>
          <option value="no">No phone</option>
        </select>
        <div className="flex items-center gap-2 text-sm text-slate-550">
          Score
          <input type="number" className="input w-20" min={0} max={100} placeholder="min" aria-label="Score from" value={filters.scoreMin ?? ""} onChange={(e) => set("scoreMin", scoreOrUndefined(e.target.value))} />
          to
          <input type="number" className="input w-20" min={0} max={100} placeholder="max" aria-label="Score to" value={filters.scoreMax ?? ""} onChange={(e) => set("scoreMax", scoreOrUndefined(e.target.value))} />
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <CheckGroup label="Check status" options={CHECK_STATUS_OPTIONS} value={filters.status} onChange={(v) => set("status", v)} />
        <CheckGroup label="Phone type" options={PHONE_TYPE_OPTIONS} value={filters.phoneType} onChange={(v) => set("phoneType", v)} />
        <CheckGroup label="Tier" options={TIER_OPTIONS} value={filters.tier} onChange={(v) => set("tier", v)} />
        <CheckGroup
          label="Review"
          options={[
            ["PENDING", "Pending"],
            ["APPROVED", "Approved"],
            ["REJECTED", "Rejected"],
          ] as const}
          value={filters.review}
          onChange={(v) => set("review", v)}
        />
      </div>
      {facets && !facets.headers && (
        <p className="text-xs text-slate-550">
          This file was checked before the other columns were kept, so city, category and its other columns can't be filtered or exported. Upload it
          again to use them.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-ink" aria-live="polite">
          {showing}
          {busy ? " …" : ""}
        </span>
        <button type="button" className="btn-ghost" onClick={onClear}>
          Clear filters
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ filtered export */

const EXPORT_CHOICE_KEY = "dq-export-choice";
interface ExportChoice {
  format: "csv" | "xlsx";
  preset: ExportPreset;
  columns: string[];
}
function loadExportChoice(): ExportChoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(EXPORT_CHOICE_KEY) ?? "null") as ExportChoice | null;
    return v && (v.format === "csv" || v.format === "xlsx") && Array.isArray(v.columns) ? v : null;
  } catch {
    return null;
  }
}
function saveExportChoice(c: ExportChoice) {
  try {
    localStorage.setItem(EXPORT_CHOICE_KEY, JSON.stringify(c));
  } catch {
    /* private window / storage blocked: the choice just isn't remembered */
  }
}

function ExportDialog({
  open,
  onClose,
  jobId,
  headers,
  count,
  excludedCount,
  base,
}: {
  open: boolean;
  onClose: () => void;
  jobId: string;
  headers: string[] | null;
  count: number;
  excludedCount: number;
  base: Pick<FilteredExportRequest, "filters" | "view">;
}) {
  const toast = useToast();
  const remembered = useMemo(loadExportChoice, []);
  const groups = useMemo(
    () =>
      [
        ...(headers?.length ? [{ title: "From the file", items: headers.map((h) => [`col:${h}`, h] as const) }] : []),
        { title: "Checked values", items: DQ_STORED_COLUMNS },
        { title: "Data Quality", items: DQ_COMPUTED_COLUMNS },
      ] as { title: string; items: readonly (readonly [string, string])[] }[],
    [headers],
  );
  const allKeys = useMemo(() => groups.flatMap((g) => g.items.map(([k]) => k)), [groups]);
  const [format, setFormat] = useState<"csv" | "xlsx">(remembered?.format ?? "xlsx");
  const [preset, setPreset] = useState<ExportPreset>(remembered?.preset ?? "all");
  const [custom, setCustom] = useState<Set<string>>(() => new Set(remembered?.preset === "custom" ? remembered.columns : []));
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [busy, setBusy] = useState(false);

  const columns = preset === "custom" ? allKeys.filter((k) => custom.has(k)) : presetColumns(preset, headers);
  const rows = count + (includeExcluded ? excludedCount : 0);

  const run = async () => {
    setBusy(true);
    saveExportChoice({ format, preset, columns: preset === "custom" ? [...custom] : [] });
    try {
      const written = await downloadFilteredExport(jobId, { ...base, columns, format, includeExcluded });
      toast.success("Export downloaded", [`${written.toLocaleString()} row${written === 1 ? "" : "s"}`]);
      onClose();
    } catch (err) {
      toast.fromError(err, "Export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Export filtered (${rows.toLocaleString()} rows)`} wide>
      <div className="space-y-4 text-sm">
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-slate-550">Format</legend>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="dq-format" checked={format === "xlsx"} onChange={() => setFormat("xlsx")} />
              Excel (.xlsx), keeps phone numbers and IDs as text
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="dq-format" checked={format === "csv"} onChange={() => setFormat("csv")} />
              CSV (UTF-8)
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-slate-550">Columns</legend>
          <div className="flex flex-wrap gap-4">
            {EXPORT_PRESETS.map(([p, label]) => (
              <label key={p} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="dq-preset"
                  checked={preset === p}
                  onChange={() => {
                    if (p === "custom" && preset !== "custom") setCustom(new Set(columns));
                    setPreset(p);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {preset === "custom" && (
          <div className="grid gap-3 sm:grid-cols-3">
            {groups.map((g) => (
              <fieldset key={g.title}>
                <legend className="mb-1 text-xs font-medium text-slate-550">{g.title}</legend>
                <div className="space-y-1">
                  {g.items.map(([k, label]) => (
                    <label key={k} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={custom.has(k)} onChange={() => setCustom((c) => new Set(toggleIn([...c], k)))} />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}
        {excludedCount > 0 && (
          <div>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={includeExcluded} onChange={(e) => setIncludeExcluded(e.target.checked)} />
              Include excluded rows (for audit only) — {excludedCount.toLocaleString()} in these filters
            </label>
            {includeExcluded && (
              <p className="mt-1 rounded-lg bg-warn-soft px-3 py-2 text-warn">
                Excluded rows are Do not call, Not interested or Wrong person. They are labelled EXCLUDED in the file. Never call or message them.
              </p>
            )}
          </div>
        )}
        <p className="text-xs text-slate-550">
          Only reads: no row, score, review or contact changes, and nothing is called or sent. The export is logged (who, when, filters, columns, row
          count).
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy || rows === 0 || columns.length === 0} onClick={() => void run()}>
            {busy ? "Exporting…" : `Export ${rows.toLocaleString()} rows`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
