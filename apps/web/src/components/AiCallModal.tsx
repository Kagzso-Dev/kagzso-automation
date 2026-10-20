import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CallRecording, RecordingBadge, useRecordingStatuses, type RecordingStatusName } from "./CallRecording";
import {
  AI_CALL_DEFAULT_GREETING_DELAY_SEC,
  AI_CALL_FIELDS,
  AI_CALL_MAX_GREETING_DELAY_SEC,
  checkAiCallRow,
  type AiCallColumnMapping,
  type AiCallField,
  type AiCallMode,
  type AiCallRow,
} from "@dispatch/shared";
import { api } from "../lib/api";
import type {
  AiCallLog,
  AiCallPlanSummary,
  AiCallRun,
  AiCallSheet,
  AiCallStatus,
  AiCallsConfig,
} from "../lib/aiCalls";
import { useCallFlows } from "../lib/callFlows";
import { useToast } from "./toast";
import { Badge, ErrorNote, Modal, Spinner, type BadgeTone } from "./ui";

/**
 * "AI Call" on the Contacts page: upload a sheet of customers, map its columns,
 * preview + validate the rows, pick who to call, confirm, then watch each call's
 * status. Calls are placed server-side one at a time (see apps/api queue/aiCallRun.ts),
 * so closing this window doesn't stop a run — reopening it resumes the live view.
 */
export function AiCallModal({
  open,
  onClose,
  config,
  preselectedCustomerIds,
}: {
  open: boolean;
  onClose: () => void;
  config: AiCallsConfig;
  /** From "Call selected" on AI Call Customers: start on "Saved customers" with these ticked. */
  preselectedCustomerIds?: string[];
}) {
  return (
    <Modal open={open} onClose={onClose} title="Start AI Calls" wide>
      {open ? <AiCallFlow config={config} onClose={onClose} preselectedCustomerIds={preselectedCustomerIds} /> : null}
    </Modal>
  );
}

function AiCallFlow({
  config,
  onClose,
  preselectedCustomerIds,
}: {
  config: AiCallsConfig;
  onClose: () => void;
  preselectedCustomerIds?: string[];
}) {
  const [runId, setRunId] = useState<string | null>(null);
  const resumed = useRef(false);
  const runs = useQuery({
    queryKey: ["ai-call-runs"],
    queryFn: () => api<{ items: { id: string; status: AiCallRun["status"] }[] }>("/api/ai-calls/runs"),
  });

  // A run started earlier is still going — show it instead of a new upload.
  useEffect(() => {
    if (resumed.current || !runs.data) return;
    resumed.current = true;
    const live = runs.data.items.find((r) => r.status === "RUNNING");
    if (live) setRunId(live.id);
  }, [runs.data]);

  if (runs.isLoading) return <Spinner />;
  if (runId) return <RunStatus runId={runId} onNewRun={() => setRunId(null)} onClose={onClose} />;
  return <SetupFlow config={config} onStarted={setRunId} onClose={onClose} preselectedCustomerIds={preselectedCustomerIds} />;
}

/* ------------------------------------------------------------------ setup */

const FIELD_LABELS: Record<AiCallField, string> = {
  customer_name: "Customer name",
  gender: "Gender",
  follow_up_detail: "Follow-up detail",
  phone: "Phone",
};
const PREVIEW_LIMIT = 300;

/** Saved customers shaped like a parsed sheet, so the preview / selection below works unchanged. */
const SAVED_HEADERS = ["customer_name", "gender", "follow_up_detail", "phone"];
const SAVED_MAPPING: AiCallColumnMapping = {
  customer_name: "customer_name",
  gender: "gender",
  follow_up_detail: "follow_up_detail",
  phone: "phone",
};
interface SavedCustomer {
  id: string;
  customerName: string | null;
  gender: string;
  followUpDetail: string | null;
  phone: string;
}

function SetupFlow({
  config,
  onStarted,
  onClose,
  preselectedCustomerIds,
}: {
  config: AiCallsConfig;
  onStarted: (runId: string) => void;
  onClose: () => void;
  preselectedCustomerIds?: string[];
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<AiCallSheet | null>(null);
  const [mapping, setMapping] = useState<AiCallColumnMapping | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<AiCallMode>("random");
  const [randomCount, setRandomCount] = useState(1);
  const [gapSeconds, setGapSeconds] = useState(config.defaultGapSec);
  // After the customer answers, wait this long before the AI greets (separate from the gap between calls).
  const [greetingDelay, setGreetingDelay] = useState(String(AI_CALL_DEFAULT_GREETING_DELAY_SEC));
  const [maxCalls, setMaxCalls] = useState(Math.min(10, config.maxPerRun));
  const [plan, setPlan] = useState<AiCallPlanSummary | null>(null);
  // "" = the default flow (whatever agent the server is configured with), exactly as before.
  const [flowId, setFlowId] = useState("");
  const flows = useCallFlows(config.flowEditor);
  const publishedFlows = (flows.data?.items ?? []).filter((f) => f.published);
  const chosenFlow = publishedFlows.find((f) => f.id === flowId) ?? null;
  // Where the customers come from: an uploaded file (as before) or the saved AI Call Customers.
  const [source, setSource] = useState<"upload" | "saved">(preselectedCustomerIds?.length ? "saved" : "upload");
  const [savedIds, setSavedIds] = useState<string[] | null>(null);
  const saved = useQuery({
    queryKey: ["ai-call-customers-callable"],
    queryFn: () => api<{ items: SavedCustomer[] }>("/api/ai-call-customers/callable"),
    enabled: source === "saved",
  });
  useEffect(() => {
    if (source !== "saved" || !saved.data || sheet) return;
    const list = saved.data.items;
    if (list.length === 0) return;
    setSheet({
      headers: SAVED_HEADERS,
      rows: list.map((c) => ({
        customer_name: c.customerName ?? "",
        gender: c.gender ?? "",
        follow_up_detail: c.followUpDetail ?? "",
        phone: c.phone,
      })),
      mapping: SAVED_MAPPING,
      truncated: false,
    });
    setMapping(SAVED_MAPPING);
    setSavedIds(list.map((c) => c.id));
    setPlan(null);
    const pre = new Set(preselectedCustomerIds ?? []);
    const idx = list.map((c, i) => (pre.has(c.id) ? i : -1)).filter((i) => i >= 0);
    setSelected(new Set(idx));
    if (idx.length > 0) setMode("selected");
  }, [source, saved.data, sheet, preselectedCustomerIds]);

  function switchSource(next: "upload" | "saved") {
    setSource(next);
    setSheet(null);
    setMapping(null);
    setSavedIds(null);
    setSelected(new Set());
    setPlan(null);
  }

  const parse = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api<AiCallSheet>("/api/ai-calls/parse", { method: "POST", body: fd, notify: false });
    },
    onSuccess: (data) => {
      setSheet(data);
      setMapping(data.mapping);
      setSelected(new Set());
      setPlan(null);
    },
  });

  const rows: AiCallRow[] = useMemo(() => {
    if (!sheet || !mapping) return [];
    const col = (r: Record<string, string>, f: AiCallField) => (mapping[f] ? (r[mapping[f]!] ?? "") : "");
    return sheet.rows.map((r) => ({
      customerName: col(r, "customer_name"),
      gender: col(r, "gender"),
      followUpDetail: col(r, "follow_up_detail"),
      phone: col(r, "phone"),
    }));
  }, [sheet, mapping]);

  const checks = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((r) => {
      const c = checkAiCallRow(r, config.defaultCountryCode);
      const duplicate = !!c.phone && seen.has(c.phone);
      if (c.phone) seen.add(c.phone);
      return { ...c, duplicate };
    });
  }, [rows, config.defaultCountryCode]);

  const counts = useMemo(
    () => ({
      invalid: checks.filter((c) => c.errors.length > 0).length,
      duplicates: checks.filter((c) => c.duplicate).length,
      unknownGender: checks.filter((c) => c.errors.length === 0 && c.gender === "unknown").length,
    }),
    [checks],
  );
  const callable = rows.length - counts.invalid - counts.duplicates;

  const options = {
    mode,
    randomCount,
    selectedIndexes: [...selected].sort((a, b) => a - b),
    gapSeconds,
    greetingDelaySec: Number(greetingDelay),
    maxCalls,
    ...(flowId ? { flowId } : {}),
  };
  // Saved customers: the server reloads them by id (in this order) and links each call to its customer.
  const usingSaved = source === "saved" && !!savedIds;
  const startPath = usingSaved ? "/api/ai-call-customers/call" : "/api/ai-calls/start";
  const body = usingSaved ? { customerIds: savedIds, ...options } : { rows, ...options };

  const review = useMutation({
    mutationFn: () =>
      api<AiCallPlanSummary>(startPath, { method: "POST", json: { ...body, dryRun: true }, notify: false }),
    onSuccess: setPlan,
  });

  const start = useMutation({
    mutationFn: () =>
      api<AiCallPlanSummary & { runId: string }>(startPath, { method: "POST", json: body, notify: false }),
    onSuccess: (res) => {
      toast.success(`AI calls started — ${res.toCall} customer${res.toCall === 1 ? "" : "s"}`, [
        "Calls are placed one at a time. You can close this window; the run keeps going.",
      ]);
      void qc.invalidateQueries({ queryKey: ["ai-call-runs"] });
      void qc.invalidateQueries({ queryKey: ["ai-call-customers"] });
      onStarted(res.runId);
    },
  });

  const formProblem = !mapping?.phone
    ? "Map the Phone column to continue."
    : callable === 0
      ? "No callable rows — every row is invalid or a duplicate."
      : mode === "selected" && selected.size === 0
        ? "Tick at least one row in the table, or pick another mode."
        : gapSeconds < config.minGapSec
          ? `Gap between calls must be at least ${config.minGapSec} seconds.`
          : !greetingDelayValid(greetingDelay)
            ? `AI greeting delay must be 0 to ${AI_CALL_MAX_GREETING_DELAY_SEC} seconds (whole or half seconds).`
          : maxCalls < 1 || maxCalls > config.maxPerRun
            ? `Max calls per run must be between 1 and ${config.maxPerRun}.`
            : mode === "random" && randomCount < 1
              ? "Pick at least 1 random row."
              : null;

  /* ---------- step: confirm */
  if (plan) {
    return (
      <div>
        <div className="mb-4 rounded-lg border border-crit-line bg-crit-soft px-4 py-3">
          <div className="text-base font-semibold text-crit">
            You are about to call {plan.toCall} customer{plan.toCall === 1 ? "" : "s"}.
          </div>
          <p className="mt-1 text-sm text-ink">
            Real phone calls will be placed by the AI agent, one at a time, waiting {gapSeconds}s after each call ends.
            {" "}Script: {chosenFlow ? `${chosenFlow.name} (v${chosenFlow.published!.version})` : "default flow"}.
            {mode === "random" && " The random selection is made when you press Start."}
          </p>
        </div>
        <SkippedSummary skipped={plan.skipped} hardCap={plan.hardCap} />
        {start.error && <ErrorNote error={start.error} />}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" disabled={start.isPending} onClick={() => setPlan(null)}>
            Back
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={start.isPending || plan.toCall === 0}
            onClick={() => start.mutate()}
          >
            {start.isPending ? "Starting…" : `Start ${plan.toCall} call${plan.toCall === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    );
  }

  const sourcePicker = (
    <div className="mb-4 flex flex-wrap items-center gap-4 text-sm" role="radiogroup" aria-label="Customers to call">
      <span className="label mb-0">Customers</span>
      <label className="flex items-center gap-2">
        <input type="radio" name="ai-source" checked={source === "saved"} onChange={() => switchSource("saved")} />
        Saved customers
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" name="ai-source" checked={source === "upload"} onChange={() => switchSource("upload")} />
        Upload file
      </label>
    </div>
  );

  /* ---------- step: saved customers loading */
  if (source === "saved" && (!sheet || !mapping)) {
    return (
      <div>
        {sourcePicker}
        {saved.isLoading ? (
          <Spinner />
        ) : saved.error ? (
          <ErrorNote error={saved.error} />
        ) : (
          <p className="text-sm text-slate-550">
            No saved customers yet — add or import them on the AI Call Customers tab, or upload a file.
          </p>
        )}
      </div>
    );
  }

  /* ---------- step: upload */
  if (!sheet || !mapping) {
    return (
      <div>
        {sourcePicker}
        <p className="mb-3 text-sm text-slate-550">
          Upload a <b>.xlsx</b> or <b>.csv</b> file with the columns <code>customer_name</code>,{" "}
          <code>gender</code>, <code>follow_up_detail</code> and <code>phone</code> (variants like <i>name</i>,{" "}
          <i>sex</i>, <i>notes</i>, <i>mobile</i> are detected too). Numbers without a country code are treated as{" "}
          +{config.defaultCountryCode}.
        </p>
        <button className="btn-primary" disabled={parse.isPending} onClick={() => fileRef.current?.click()}>
          {parse.isPending ? "Reading file…" : "Choose file"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) parse.mutate(f);
            e.target.value = "";
          }}
        />
        {parse.error && (
          <div className="mt-3">
            <ErrorNote error={parse.error} />
          </div>
        )}
      </div>
    );
  }

  /* ---------- step: map + preview + options */
  const previewRows = rows.slice(0, PREVIEW_LIMIT);
  const selectableInPreview = previewRows.map((_, i) => i).filter((i) => checks[i]!.errors.length === 0);
  const allPreviewSelected =
    selectableInPreview.length > 0 && selectableInPreview.every((i) => selected.has(i));

  return (
    <div>
      {sourcePicker}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          <b>{rows.length}</b> {usingSaved ? "saved customer" : "row"}
          {rows.length === 1 ? "" : "s"}
          {usingSaved ? "" : " read"}
          {sheet.truncated && <span className="text-warn"> (file truncated to the first {rows.length})</span>}
        </span>
        {!usingSaved && (
          <button
            className="text-xs text-accent-ink hover:underline"
            onClick={() => {
              setSheet(null);
              setMapping(null);
            }}
          >
            Upload a different file
          </button>
        )}
      </div>

      <div className={`mb-4 grid gap-3 sm:grid-cols-4 ${usingSaved ? "hidden" : ""}`}>
        {AI_CALL_FIELDS.map((f) => (
          <div key={f}>
            <label className="label">
              {FIELD_LABELS[f]}
              {f === "phone" && <span className="text-crit"> *</span>}
            </label>
            <select
              className="input"
              value={mapping[f] ?? ""}
              onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || null })}
            >
              <option value="">— not mapped —</option>
              {sheet.headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="text-ok">{callable} callable</span>
        {counts.invalid > 0 && <span className="text-crit">{counts.invalid} invalid (missing / invalid phone)</span>}
        {counts.duplicates > 0 && <span className="text-warn">{counts.duplicates} duplicate numbers</span>}
        {counts.unknownGender > 0 && (
          <span className="text-warn">{counts.unknownGender} unknown gender (neutral greeting)</span>
        )}
      </div>

      <div className="mb-4 max-h-72 overflow-auto rounded-lg border border-line">
        <table className="table-soft w-full min-w-[40rem] text-xs">
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr className="border-b border-line text-left text-slate-550">
              <th className="px-2 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all valid rows shown"
                  checked={allPreviewSelected}
                  disabled={selectableInPreview.length === 0}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const i of selectableInPreview) e.target.checked ? next.add(i) : next.delete(i);
                      return next;
                    })
                  }
                />
              </th>
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">Gender</th>
              <th className="px-2 py-2">Follow-up detail</th>
              <th className="px-2 py-2">Phone</th>
              <th className="px-2 py-2">Issues</th>
            </tr>
          </thead>
          <tbody>
            {previewRows.map((r, i) => {
              const c = checks[i]!;
              const bad = c.errors.length > 0;
              const issues = [...c.errors, ...(c.duplicate ? ["Duplicate number — called once"] : []), ...c.warnings];
              return (
                <tr
                  key={i}
                  className={`border-b border-line-subtle last:border-0 ${
                    bad ? "bg-crit-soft" : c.duplicate || c.warnings.length ? "bg-warn-soft" : ""
                  }`}
                >
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select row ${i + 1}`}
                      disabled={bad}
                      checked={selected.has(i)}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1.5 text-slate-550">{i + 1}</td>
                  <td className="px-2 py-1.5">{r.customerName || "—"}</td>
                  <td className={`px-2 py-1.5 ${c.gender === "unknown" ? "text-warn" : ""}`}>
                    {r.gender || "—"}
                    {r.gender && c.gender === "unknown" ? " (?)" : ""}
                  </td>
                  <td className="max-w-[14rem] truncate px-2 py-1.5" title={r.followUpDetail ?? ""}>
                    {r.followUpDetail || "—"}
                  </td>
                  <td className={`px-2 py-1.5 font-mono ${bad ? "text-crit" : ""}`}>
                    {c.phone ?? (r.phone || "—")}
                  </td>
                  <td className={`px-2 py-1.5 ${bad ? "text-crit" : "text-warn"}`}>{issues.join("; ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_LIMIT && (
        <p className="-mt-2 mb-4 text-xs text-slate-550">
          Showing the first {PREVIEW_LIMIT} rows. “Random” and “All rows” use every row in the file.
        </p>
      )}

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="label">Who to call</legend>
          <label className="mb-1.5 flex items-center gap-2 text-sm">
            <input type="radio" name="ai-mode" checked={mode === "random"} onChange={() => setMode("random")} />
            Random
            <input
              type="number"
              className="input w-20 py-1"
              min={1}
              max={config.maxPerRun}
              value={randomCount}
              disabled={mode !== "random"}
              onChange={(e) => setRandomCount(Math.max(1, Number(e.target.value) || 1))}
              aria-label="How many random rows"
            />
            <span className="text-xs text-slate-550">rows, no number twice</span>
          </label>
          <label className="mb-1.5 flex items-center gap-2 text-sm">
            <input type="radio" name="ai-mode" checked={mode === "selected"} onChange={() => setMode("selected")} />
            Selected rows ({selected.size} ticked)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="ai-mode" checked={mode === "all"} onChange={() => setMode("all")} />
            All rows ({callable} callable)
          </label>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Gap between calls (s)</label>
            <input
              type="number"
              className="input"
              min={config.minGapSec}
              max={3600}
              value={gapSeconds}
              onChange={(e) => setGapSeconds(Number(e.target.value) || 0)}
            />
          </div>
          <div>
            <label className="label">Max calls per run</label>
            <input
              type="number"
              className="input"
              min={1}
              max={config.maxPerRun}
              value={maxCalls}
              onChange={(e) => setMaxCalls(Number(e.target.value) || 0)}
            />
            <span className="text-xs text-slate-550">Hard limit {config.maxPerRun}</span>
          </div>
          <div>
            <label className="label" htmlFor="ai-greeting-delay">
              AI Greeting Delay (seconds)
            </label>
            <input
              id="ai-greeting-delay"
              type="number"
              className={`input ${greetingDelayValid(greetingDelay) ? "" : "border-crit"}`}
              min={0}
              max={AI_CALL_MAX_GREETING_DELAY_SEC}
              step={0.5}
              value={greetingDelay}
              onChange={(e) => setGreetingDelay(e.target.value)}
            />
            <span className="text-xs text-slate-550">
              After the customer answers. 0 = speak at once. If they speak first, the AI greets right away.
            </span>
          </div>
        </div>
      </div>

      {config.flowEditor && (
        <div className="mb-4 max-w-md">
          <label className="label">Call flow</label>
          <select className="input" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
            <option value="">Default flow (server default)</option>
            {publishedFlows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} — v{f.published!.version}
              </option>
            ))}
          </select>
          <span className="text-xs text-slate-550">
            Only published flows are listed. The version is fixed when the run starts.
          </span>
        </div>
      )}

      {formProblem && <p className="mb-3 text-sm text-warn">{formProblem}</p>}
      {review.error && <ErrorNote error={review.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!!formProblem || review.isPending}
          onClick={() => review.mutate()}
        >
          {review.isPending ? "Checking…" : "Review & start"}
        </button>
      </div>
    </div>
  );
}

function SkippedSummary({ skipped, hardCap }: { skipped: AiCallPlanSummary["skipped"]; hardCap: number }) {
  const lines = [
    skipped.invalid && `${skipped.invalid} invalid row${skipped.invalid === 1 ? "" : "s"} skipped`,
    skipped.duplicates && `${skipped.duplicates} duplicate number${skipped.duplicates === 1 ? "" : "s"} skipped`,
    skipped.doNotCall && `${skipped.doNotCall} on the do-not-call list (unsubscribed / opted out) skipped`,
    skipped.capped && `${skipped.capped} not called because of the max-calls limit (hard limit ${hardCap})`,
  ].filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <ul className="mb-3 list-disc pl-5 text-sm text-slate-550">
      {lines.map((l) => (
        <li key={String(l)}>{l}</li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ live status */

const STATUS_LABEL: Record<AiCallStatus, string> = {
  QUEUED: "queued",
  DIALING: "dialing",
  RINGING: "ringing",
  IN_PROGRESS: "in progress",
  COMPLETED: "completed",
  NO_ANSWER: "no answer",
  BUSY: "busy",
  FAILED: "failed",
  CANCELLED: "cancelled",
};
const STATUS_TONE: Record<AiCallStatus, BadgeTone> = {
  QUEUED: "neutral",
  DIALING: "accent",
  RINGING: "accent",
  IN_PROGRESS: "warn",
  COMPLETED: "ok",
  NO_ANSWER: "warn",
  BUSY: "warn",
  FAILED: "crit",
  CANCELLED: "neutral",
};
const IN_FLIGHT: AiCallStatus[] = ["DIALING", "RINGING", "IN_PROGRESS"];

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function RunStatus({ runId, onNewRun, onClose }: { runId: string; onNewRun: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const run = useQuery({
    queryKey: ["ai-call-run", runId],
    queryFn: () => api<AiCallRun>(`/api/ai-calls/runs/${runId}`),
    refetchInterval: (q) => {
      const d = q.state.data;
      return !d || d.status === "RUNNING" || d.logs.some((l) => IN_FLIGHT.includes(l.status)) ? 3000 : false;
    },
  });
  const recordings = useRecordingStatuses(run.data?.logs.map((l) => l.id) ?? []); // admins only
  const cancel = useMutation({
    mutationFn: () => api(`/api/ai-calls/runs/${runId}/cancel`, { method: "POST", notify: "AI call run cancelled" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ai-call-run", runId] });
      void qc.invalidateQueries({ queryKey: ["ai-call-runs"] });
    },
  });
  const running = run.data?.status === "RUNNING";
  const now = useNow(running);

  if (run.isLoading) return <Spinner />;
  if (run.error) return <ErrorNote error={run.error} />;
  const r = run.data!;
  const done = r.logs.filter((l) => l.status !== "QUEUED" && !IN_FLIGHT.includes(l.status)).length;
  const nextIn = r.nextCallAt ? Math.max(0, Math.ceil((new Date(r.nextCallAt).getTime() - now) / 1000)) : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={running ? "warn" : r.status === "DONE" ? "ok" : "neutral"}>{r.status.toLowerCase()}</Badge>
        <span>
          {done} of {r.total} call{r.total === 1 ? "" : "s"} finished
        </span>
        {running && nextIn !== null && nextIn > 0 && (
          <span className="text-slate-550">next call in {nextIn}s</span>
        )}
        <span className="ml-auto text-xs text-slate-550">Updates every 3 seconds</span>
      </div>

      <div className="mb-4 max-h-96 overflow-auto rounded-lg border border-line">
        <table className="table-soft w-full min-w-[40rem] text-sm">
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr className="border-b border-line text-left text-xs uppercase tracking-[0.06em] text-slate-550">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {r.logs.map((l) => (
              <LogRow key={l.id} log={l} recording={recordings[l.id]} />
            ))}
          </tbody>
        </table>
      </div>

      {cancel.error && <ErrorNote error={cancel.error} />}
      <div className="flex flex-wrap justify-end gap-2">
        {running ? (
          <button className="btn-danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending ? "Cancelling…" : "Cancel remaining calls"}
          </button>
        ) : (
          <button className="btn-ghost" onClick={onNewRun}>
            Start another run
          </button>
        )}
        <button className="btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** 0-10 seconds, whole or half seconds. */
function greetingDelayValid(v: string): boolean {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= AI_CALL_MAX_GREETING_DELAY_SEC && Number.isInteger(n * 2);
}

function LogRow({ log: l, recording }: { log: AiCallLog; recording?: RecordingStatusName }) {
  const detail = l.error || l.summary || l.transcript;
  return (
    <tr className="border-b border-line-subtle align-top last:border-0">
      <td className="px-3 py-2 text-slate-550">{l.position + 1}</td>
      <td className="px-3 py-2">
        {l.customerName || "—"}
        {l.followUpDetail && <div className="max-w-[14rem] truncate text-xs text-slate-550">{l.followUpDetail}</div>}
      </td>
      <td className="px-3 py-2 font-mono text-xs">{l.phone}</td>
      <td className="px-3 py-2">
        <Badge tone={STATUS_TONE[l.status]}>{STATUS_LABEL[l.status]}</Badge>
        {l.durationSec != null && <div className="mt-0.5 text-xs text-slate-550">{l.durationSec}s</div>}
        {recording && (
          <div className="mt-0.5">
            <RecordingBadge status={recording} />
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        {l.outcome && <div className="font-medium">{l.outcome.replace(/_/g, " ")}</div>}
        {l.error && <div className="text-crit">{l.error}</div>}
        {!l.error && l.summary && <div className="text-slate-550">{l.summary}</div>}
        {l.transcript && (
          <details className="mt-1">
            <summary className="cursor-pointer text-accent-ink">Transcript</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-sans text-slate-550">{l.transcript}</pre>
          </details>
        )}
        <CallRecording logId={l.id} status={recording} />
        {!detail && !l.outcome && <span className="text-slate-550">—</span>}
      </td>
    </tr>
  );
}
