import { Fragment, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, EmptyState, ErrorNote, Tabs, type BadgeTone } from "../components/ui";
import { pageOf, QueuePagination, ScrollTable, SkeletonRows } from "../components/QueueTable";
import { Icon } from "../components/icons";
import { useToast } from "../components/toast";
import { formatDateTime } from "../lib/schedule";
import { useAiCallsConfig } from "../lib/aiCalls";
import { AiCallFollowupsQueue } from "../components/AiCallFollowupsQueue";
import { QueueActions } from "../components/QueueActions";
import { useScrolledShadow } from "../lib/useScrolledShadow";

/**
 * Send Queue — batch history for the two send channels, each on its own tab.
 * The Email tab reads only /api/contacts/send/batches* (ManualSendBatch tables);
 * the WhatsApp tab reads only /api/whatsapp/send/batches* (whatsapp_send_batches /
 * whatsapp_sends). The two trees share no queries or data types — only the
 * <Tabs> / <Table> visual shell.
 */

type BatchStatus = "RUNNING" | "DONE" | "CANCELLED";

const STATUS_FILTERS: { value: "" | BatchStatus; label: string }[] = [
  { value: "", label: "All" },
  { value: "RUNNING", label: "Running" },
  { value: "DONE", label: "Done" },
  { value: "CANCELLED", label: "Cancelled / failed" },
];

const batchTone: Record<BatchStatus, BadgeTone> = {
  RUNNING: "accent",
  DONE: "ok",
  CANCELLED: "warn",
};

const TAB_KEY = "dispatch:send-queue-tab";

type QueueTab = "email" | "whatsapp" | "ai-followups";

/** Page, page size and status filter — kept per tab while you switch between them. */
export interface QueueView {
  page: number;
  pageSize: number;
  status: string;
}
export interface QueueViewProps {
  view: QueueView;
  setView: (patch: Partial<QueueView>) => void;
}

const DEFAULT_VIEWS: Record<QueueTab, QueueView> = {
  email: { page: 1, pageSize: 10, status: "" },
  whatsapp: { page: 1, pageSize: 10, status: "" },
  "ai-followups": { page: 1, pageSize: 10, status: "PENDING_APPROVAL" },
};

export function SendQueuePage() {
  // "AI Call follow-ups" (approval queue) — admins only, while ENABLE_AI_CALLS is on.
  const aiCalls = useAiCallsConfig();
  const showAi = !!aiCalls.data?.enabled && !!aiCalls.data.canStart;
  const [tab, setTab] = useState<QueueTab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return saved === "whatsapp" || saved === "ai-followups" ? saved : "email";
    } catch {
      return "email";
    }
  });

  const [views, setViews] = useState(DEFAULT_VIEWS);
  const viewProps = (t: QueueTab): QueueViewProps => ({
    view: views[t],
    setView: (patch) => setViews((v) => ({ ...v, [t]: { ...v[t], ...patch } })),
  });

  function pick(next: QueueTab) {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* storage unavailable — non-fatal */
    }
  }

  return (
    <div>
      <PageHeader
        title="Send Queue"
        subtitle="Track sent batches — which recipients are still sending, done, or failed. Email and WhatsApp are kept separate."
      />
      <Tabs
        tabs={[
          { value: "email", label: "Email" },
          { value: "whatsapp", label: "WhatsApp" },
          ...(showAi ? [{ value: "ai-followups" as const, label: "AI Call follow-ups" }] : []),
        ]}
        value={tab === "ai-followups" && !showAi ? "email" : tab}
        onChange={pick}
      />
      {tab === "ai-followups" && showAi ? (
        <AiCallFollowupsQueue {...viewProps("ai-followups")} />
      ) : tab === "whatsapp" ? (
        <WhatsAppQueue {...viewProps("whatsapp")} />
      ) : (
        <EmailQueue {...viewProps("email")} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ shared shell bits */

function StatusFilter({
  value,
  onChange,
  action,
}: {
  value: "" | BatchStatus;
  onChange: (v: "" | BatchStatus) => void;
  /** Right side of the toolbar row (the Upload / Download action group). */
  action?: ReactNode;
}) {
  return (
    <div className="queue-toolbar">
      <div className="queue-toolbar-filter">
        <label className="text-xs font-medium uppercase tracking-[0.06em] text-slate-550">Status</label>
        <select
          className="input sm:max-w-[14rem]"
          value={value}
          onChange={(e) => onChange(e.target.value as "" | BatchStatus)}
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {action}
    </div>
  );
}

function ProgressBar({ pct, barClass }: { pct: number; barClass: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${barClass}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

const HEAD = ["", "Batch", "Template", "Recipients", "Status", "Sent", "Failed", "Started", "Completed", ""];

/* ------------------------------------------------------------------ CSV download */

/** RFC-4180 quoting: wrap in quotes and double any embedded quote when needed. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Save a text blob to the user's machine — no server round-trip. */
function downloadTextFile(filename: string, text: string) {
  // Leading BOM so Excel opens the file as UTF-8.
  const blob = new Blob(["﻿", text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Per-row "download recipients as CSV" button. `buildCsv` fetches the batch
 * detail and returns the file body; the click is stopped from bubbling so it
 * doesn't also toggle the row's expanded panel.
 */
function DownloadCsvButton({
  filename,
  buildCsv,
}: {
  filename: string;
  buildCsv: () => Promise<string>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title="Download recipients as CSV"
      aria-label="Download recipients as CSV"
      className="btn-ghost px-2 py-1.5"
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          downloadTextFile(filename, await buildCsv());
        } catch (err) {
          toast.fromError(err, "Could not build the download");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="download" size={14} className={busy ? "animate-pulse" : undefined} />
    </button>
  );
}

/* ================================================================== EMAIL TAB */

type EmailItemStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";

interface EmailBatchRow {
  id: string;
  templateName: string;
  total: number;
  status: BatchStatus;
  sent: number;
  failed: number;
  purgeAfter: boolean;
  startedAt: string;
  completedAt: string | null;
}

interface EmailBatchDetailView {
  id: string;
  status: BatchStatus;
  total: number;
  counts: Record<EmailItemStatus, number>;
  items: {
    id: string;
    name: string | null;
    email: string;
    status: EmailItemStatus;
    error: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    openedAt: string | null;
    failedAt: string | null;
  }[];
}

const emailItemTone: Record<EmailItemStatus, BadgeTone> = {
  PENDING: "neutral",
  SENDING: "accent",
  SENT: "ok",
  FAILED: "crit",
  SKIPPED: "warn",
};

function EmailQueue({ view, setView }: QueueViewProps) {
  const status = view.status as "" | BatchStatus;
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["email-batches", status],
    queryFn: () =>
      api<{ items: EmailBatchRow[] }>(
        `/api/contacts/send/batches${status ? `?status=${status}` : ""}`,
      ),
    // Live status: re-poll only while a batch on the page being viewed is still sending.
    refetchInterval: (query) =>
      pageOf(query.state.data?.items ?? [], view.page, view.pageSize).rows.some((b) => b.status === "RUNNING") ? 4000 : false,
  });
  // Newest first (the API orders by start time, newest first).
  const current = pageOf(q.data?.items ?? [], view.page, view.pageSize);

  return (
    <div>
      <StatusFilter
        value={status}
        onChange={(v) => setView({ status: v, page: 1 })}
        action={<QueueActions upload="email" history="email" />}
      />
      {q.isLoading ? (
        <ScrollTable head={HEAD}>
          <SkeletonRows cols={HEAD.length} />
        </ScrollTable>
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : q.data!.items.length === 0 ? (
        <EmptyState icon="mail" title="No batches yet">
          Bulk sends started from the Contacts page show up here.
        </EmptyState>
      ) : (
        <>
        <ScrollTable head={HEAD} scrollKey={`${status}:${current.page}:${view.pageSize}`}>
          {current.rows.map((b) => {
            const open = expanded === b.id;
            return (
              <Fragment key={b.id}>
                <tr
                  className="cursor-pointer border-b border-line-subtle last:border-0 hover:bg-tint"
                  onClick={() => setExpanded(open ? null : b.id)}
                >
                  <td className="px-4 py-2.5">
                    <Chevron open={open} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-mono text-xs text-slate-550">{b.id.slice(0, 8)}</div>
                    {b.purgeAfter && (
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {b.status === "RUNNING" ? "will remove reached contacts" : "reached contacts removed"}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-550">{b.templateName}</td>
                  <td className="px-4 py-2.5 text-slate-550">{b.total}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={batchTone[b.status]}>{b.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-ok">{b.sent}</td>
                  <td className="px-4 py-2.5 font-mono text-crit">{b.failed}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">{formatDateTime(b.startedAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">
                    {b.completedAt ? formatDateTime(b.completedAt) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <DownloadCsvButton
                      filename={`email-batch-${b.id.slice(0, 8)}.csv`}
                      buildCsv={async () => {
                        const v = await api<EmailBatchDetailView>(
                          `/api/contacts/send/batches/${b.id}`,
                        );
                        return toCsv(
                          ["Name", "Email", "Status", "Sent at", "Received at", "Opened at", "Failed at", "Error"],
                          v.items.map((it) => [
                            it.name ?? "",
                            it.email,
                            it.status,
                            it.sentAt ?? "",
                            it.deliveredAt ?? "",
                            it.openedAt ?? "",
                            it.failedAt ?? "",
                            it.error ?? "",
                          ]),
                        );
                      }}
                    />
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-line-subtle">
                    <td colSpan={HEAD.length} className="bg-surface-sunken px-4 py-4">
                      <EmailBatchDetail id={b.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </ScrollTable>
        <QueuePagination
          page={current.page}
          pageSize={view.pageSize}
          total={q.data!.items.length}
          onPage={(page) => setView({ page })}
          onPageSize={(pageSize) => setView({ pageSize, page: 1 })}
        />
        </>
      )}
    </div>
  );
}

function EmailBatchDetail({ id }: { id: string }) {
  const shadowRef = useScrolledShadow<HTMLDivElement>();
  const q = useQuery({
    queryKey: ["email-batch", id],
    queryFn: () => api<EmailBatchDetailView>(`/api/contacts/send/batches/${id}`),
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 2000 : false),
  });

  if (q.isLoading) return <div className="text-sm text-slate-550">Loading recipients…</div>;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Batch not found.")} />;

  const v = q.data;
  const done = v.counts.SENT + v.counts.FAILED + v.counts.SKIPPED;
  const pct = v.total ? Math.round((done / v.total) * 100) : 100;

  return (
    <div>
      <ProgressBar pct={pct} barClass="bg-gradient-accent" />
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-550">
        <span>
          <b className="text-ok">{v.counts.SENT}</b> sent
        </span>
        <span>
          <b className="text-crit">{v.counts.FAILED}</b> failed
        </span>
        <span>
          <b className="text-warn">{v.counts.SKIPPED}</b> skipped
        </span>
        {v.counts.PENDING + v.counts.SENDING > 0 && (
          <span>
            <b className="text-ink">{v.counts.PENDING + v.counts.SENDING}</b> to go
          </span>
        )}
      </div>

      <div ref={shadowRef} className="scroll-shadow scroll-thin mt-3 max-h-72 overflow-auto rounded-lg border border-line bg-white">
        <table className="table-soft w-full min-w-[36rem] text-sm">
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr className="border-b border-line text-left text-xs uppercase tracking-[0.06em] text-slate-550">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Sent</th>
              <th className="px-3 py-2">Received</th>
              <th className="px-3 py-2">Opened</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {v.items.map((it) => (
              <tr key={it.id} className="border-b border-line-subtle last:border-0">
                <td className="px-3 py-1.5">{it.name || "—"}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{it.email}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={emailItemTone[it.status]}>{it.status}</Badge>
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  {it.sentAt ? formatDateTime(it.sentAt) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  {it.deliveredAt ? formatDateTime(it.deliveredAt) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  {it.openedAt ? formatDateTime(it.openedAt) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  <span className="block max-w-[20rem] truncate" title={it.error ?? undefined}>
                    {it.error || "—"}
                  </span>
                  {it.failedAt && <span className="block text-[11px] text-slate-400">{formatDateTime(it.failedAt)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* =============================================================== WHATSAPP TAB */

type WaItemStatus = "QUEUED" | "SENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "SKIPPED";

interface WaBatchRow {
  id: string;
  templateName: string;
  total: number;
  status: BatchStatus;
  sent: number;
  failed: number;
  purgeAfter: boolean;
  startedAt: string;
  completedAt: string | null;
}

interface WaBatchDetailView {
  id: string;
  status: BatchStatus;
  total: number;
  counts: Record<WaItemStatus, number>;
  items: {
    id: string;
    name: string | null;
    phone: string;
    status: WaItemStatus;
    error: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
    failedAt: string | null;
  }[];
}

const waItemTone: Record<WaItemStatus, BadgeTone> = {
  QUEUED: "neutral",
  SENDING: "accent",
  SENT: "ok",
  DELIVERED: "ok",
  READ: "ok",
  FAILED: "crit",
  SKIPPED: "warn",
};

function WhatsAppQueue({ view, setView }: QueueViewProps) {
  const status = view.status as "" | BatchStatus;
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["whatsapp-batches", status],
    queryFn: () =>
      api<{ items: WaBatchRow[] }>(
        `/api/whatsapp/send/batches${status ? `?status=${status}` : ""}`,
      ),
    // Live status: re-poll only while a batch on the page being viewed is still sending.
    refetchInterval: (query) =>
      pageOf(query.state.data?.items ?? [], view.page, view.pageSize).rows.some((b) => b.status === "RUNNING") ? 4000 : false,
  });
  // Newest first (the API orders by start time, newest first).
  const current = pageOf(q.data?.items ?? [], view.page, view.pageSize);

  return (
    <div>
      <StatusFilter
        value={status}
        onChange={(v) => setView({ status: v, page: 1 })}
        action={<QueueActions upload="whatsapp" history="whatsapp" />}
      />
      {q.isLoading ? (
        <ScrollTable head={HEAD}>
          <SkeletonRows cols={HEAD.length} />
        </ScrollTable>
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : q.data!.items.length === 0 ? (
        <EmptyState icon="whatsapp" title="No batches yet">
          WhatsApp sends started from the Contacts or WhatsApp Contacts page show up here.
        </EmptyState>
      ) : (
        <>
        <ScrollTable head={HEAD} scrollKey={`${status}:${current.page}:${view.pageSize}`}>
          {current.rows.map((b) => {
            const open = expanded === b.id;
            return (
              <Fragment key={b.id}>
                <tr
                  className="cursor-pointer border-b border-line-subtle last:border-0 hover:bg-tint"
                  onClick={() => setExpanded(open ? null : b.id)}
                >
                  <td className="px-4 py-2.5">
                    <Chevron open={open} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-mono text-xs text-slate-550">{b.id.slice(0, 8)}</div>
                    {b.purgeAfter && (
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {b.status === "RUNNING" ? "will remove reached contacts" : "reached contacts removed"}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-550">{b.templateName}</td>
                  <td className="px-4 py-2.5 text-slate-550">{b.total}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={batchTone[b.status]}>{b.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-ok">{b.sent}</td>
                  <td className="px-4 py-2.5 font-mono text-crit">{b.failed}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">{formatDateTime(b.startedAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">
                    {b.completedAt ? formatDateTime(b.completedAt) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                    <DownloadCsvButton
                      filename={`whatsapp-batch-${b.id.slice(0, 8)}.csv`}
                      buildCsv={async () => {
                        const v = await api<WaBatchDetailView>(
                          `/api/whatsapp/send/batches/${b.id}`,
                        );
                        return toCsv(
                          ["Name", "Phone", "Status", "Sent at", "Delivered at", "Opened at", "Failed at", "Error"],
                          v.items.map((it) => [
                            it.name ?? "",
                            it.phone ?? "",
                            it.status,
                            it.sentAt ?? "",
                            it.deliveredAt ?? "",
                            it.readAt ?? "",
                            it.failedAt ?? "",
                            it.error ?? "",
                          ]),
                        );
                      }}
                    />
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-line-subtle">
                    <td colSpan={HEAD.length} className="bg-surface-sunken px-4 py-4">
                      <WhatsAppBatchDetail id={b.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </ScrollTable>
        <QueuePagination
          page={current.page}
          pageSize={view.pageSize}
          total={q.data!.items.length}
          onPage={(page) => setView({ page })}
          onPageSize={(pageSize) => setView({ pageSize, page: 1 })}
        />
        </>
      )}
    </div>
  );
}

function WhatsAppBatchDetail({ id }: { id: string }) {
  const shadowRef = useScrolledShadow<HTMLDivElement>();
  const q = useQuery({
    queryKey: ["whatsapp-batch", id],
    queryFn: () => api<WaBatchDetailView>(`/api/whatsapp/send/batches/${id}`),
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 2000 : false),
  });

  if (q.isLoading) return <div className="text-sm text-slate-550">Loading recipients…</div>;
  if (q.error || !q.data) return <ErrorNote error={q.error ?? new Error("Batch not found.")} />;

  const v = q.data;
  const done = v.counts.SENT + v.counts.DELIVERED + v.counts.READ + v.counts.FAILED + v.counts.SKIPPED;
  const pct = v.total ? Math.round((done / v.total) * 100) : 100;

  return (
    <div>
      <ProgressBar pct={pct} barClass="bg-wa" />
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-550">
        <span>
          <b className="text-ok">{v.counts.SENT + v.counts.DELIVERED + v.counts.READ}</b> sent
        </span>
        <span>
          <b className="text-crit">{v.counts.FAILED}</b> failed
        </span>
        <span>
          <b className="text-warn">{v.counts.SKIPPED}</b> skipped
        </span>
        {v.counts.QUEUED + v.counts.SENDING > 0 && (
          <span>
            <b className="text-ink">{v.counts.QUEUED + v.counts.SENDING}</b> to go
          </span>
        )}
      </div>

      <div ref={shadowRef} className="scroll-shadow scroll-thin mt-3 max-h-72 overflow-auto rounded-lg border border-line bg-white">
        <table className="table-soft w-full min-w-[36rem] text-sm">
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr className="border-b border-line text-left text-xs uppercase tracking-[0.06em] text-slate-550">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Sent</th>
              <th className="px-3 py-2">Received</th>
              <th className="px-3 py-2">Opened</th>
              <th className="px-3 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {v.items.map((it) => (
              <tr key={it.id} className="border-b border-line-subtle last:border-0">
                <td className="px-3 py-1.5">{it.name || "—"}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{it.phone || "—"}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={waItemTone[it.status]}>{it.status}</Badge>
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  {it.sentAt ? formatDateTime(it.sentAt) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  {it.deliveredAt ? formatDateTime(it.deliveredAt) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  {it.readAt ? formatDateTime(it.readAt) : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-550">
                  <span className="block max-w-[20rem] truncate" title={it.error ?? undefined}>
                    {it.error || "—"}
                  </span>
                  {it.failedAt && <span className="block text-[11px] text-slate-400">{formatDateTime(it.failedAt)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
