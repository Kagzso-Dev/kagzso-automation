import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AI_CALL_LANGUAGE_NAMES, AI_CALL_STAGE_LABELS, formatPhoneDisplay } from "@dispatch/shared";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/schedule";
import { useWhatsAppTemplateOptions, type AiCallFollowup, type FollowupStatus } from "../lib/aiCallCustomers";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { Badge, EmptyState, ErrorNote, Modal, type BadgeTone } from "./ui";
import { QueuePagination, ScrollTable, SkeletonRows } from "./QueueTable";
import type { QueueViewProps } from "../pages/SendQueue";
import { QueueActions } from "./QueueActions";

/**
 * Send Queue → "AI Call follow-ups": drafts created after AI calls. Nothing is
 * sent until an admin approves one here; approval hands it to the existing
 * WhatsApp batch sender (it then shows on the WhatsApp tab) or schedules a
 * one-call AI call run.
 */

const STATUS_FILTERS: { value: "" | FollowupStatus; label: string }[] = [
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "FAILED", label: "Failed" },
  { value: "", label: "All" },
];

const STATUS_TONE: Record<FollowupStatus, BadgeTone> = {
  PENDING_APPROVAL: "warn",
  APPROVED: "ok",
  REJECTED: "neutral",
  CANCELLED: "neutral",
  FAILED: "crit",
};

interface Page {
  items: AiCallFollowup[];
  total: number;
  pending: number;
  page: number;
  pageSize: number;
}

const label = (s: string) => s.toLowerCase().replace(/_/g, " ");

const FOLLOWUP_HEAD = ["Customer", "Phone", "Follow-up", "Details", "Status", "Created", ""];

export function AiCallFollowupsQueue({ view, setView }: QueueViewProps) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  // Page, page size and status filter live in the Send Queue page, so they survive tab switches.
  const status = view.status as "" | FollowupStatus;
  const { page, pageSize } = view;
  const [editing, setEditing] = useState<AiCallFollowup | null>(null);

  const q = useQuery({
    queryKey: ["ai-call-followups", status, page, pageSize],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) p.set("status", status);
      return api<Page>(`/api/ai-call-followups?${p}`);
    },
    placeholderData: keepPreviousData, // no flash of empty rows while the next page loads
    refetchInterval: 15_000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["ai-call-followups"] });
    void qc.invalidateQueries({ queryKey: ["ai-call-customer"] });
    void qc.invalidateQueries({ queryKey: ["whatsapp-batches"] });
  };
  const approve = useMutation({
    mutationFn: (id: string) => api(`/api/ai-call-followups/${id}/approve`, { method: "POST", notify: false }),
    onSuccess: () => {
      toast.success("Approved — queued with the existing sender");
      refresh();
    },
    onError: (err) => {
      toast.fromError(err, "Could not approve");
      refresh();
    },
  });
  const reject = useMutation({
    mutationFn: (id: string) => api(`/api/ai-call-followups/${id}/reject`, { method: "POST", notify: "Follow-up rejected" }),
    onSuccess: refresh,
    onError: (err) => toast.fromError(err, "Could not reject"),
  });

  return (
    <div>
      <div className="queue-toolbar">
        <div className="queue-toolbar-filter flex-wrap">
          <label className="text-xs font-medium uppercase tracking-[0.06em] text-slate-550">Status</label>
          <select
            className="input sm:max-w-[14rem]"
            value={status}
            onChange={(e) => setView({ status: e.target.value, page: 1 })}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          {q.data && q.data.pending > 0 && (
            <span className="text-sm text-warn">
              {q.data.pending} waiting for approval — nothing is sent until you approve.
            </span>
          )}
        </div>
        <QueueActions upload="ai-call" history="ai-followups" />
      </div>

      {q.isLoading ? (
        <ScrollTable head={FOLLOWUP_HEAD}>
          <SkeletonRows cols={FOLLOWUP_HEAD.length} />
        </ScrollTable>
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : q.data!.items.length === 0 ? (
        <EmptyState icon="phone" title={status === "PENDING_APPROVAL" ? "Nothing waiting for approval" : "No follow-ups"}>
          Follow-ups are created after AI calls to saved customers (Interested, Follow-up needed, Approved, Callback
          requested, No answer) or added from a customer's call detail.
        </EmptyState>
      ) : (
        <>
          <ScrollTable head={FOLLOWUP_HEAD} scrollKey={`${status}:${page}:${pageSize}`}>
            {q.data!.items.map((f) => {
              const c = f.customer;
              const blocked = !!c?.deletedAt || !!c?.doNotCall;
              return (
                <tr key={f.id} className="border-b border-line-subtle align-top last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">
                      {c?.customerName || "—"}
                      {/* Another language's customer: its "call again" goes out in that language. */}
                      {c?.language && c.language !== "en" && (
                        <span className="ml-1.5">
                          <Badge tone="accent">{AI_CALL_LANGUAGE_NAMES[c.language]}</Badge>
                        </span>
                      )}
                    </div>
                    {c?.businessName && <div className="text-xs text-slate-550">{c.businessName}</div>}
                    {c && <div className="text-[11px] text-slate-400">Stage: {AI_CALL_STAGE_LABELS[c.stage]}</div>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{c ? formatPhoneDisplay(c.phone) : "—"}</td>
                  <td className="px-4 py-2.5">
                    <div>{f.channel === "WHATSAPP" ? "WhatsApp message" : "Call again"}</div>
                    <div className="text-xs text-slate-550">
                      {f.reason ?? "—"}
                      {f.channel === "CALL" && f.attempt > 1 ? ` · retry ${f.attempt}` : ""}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">
                    {f.channel === "WHATSAPP" ? (
                      f.whatsappTemplateName ? (
                        <>Template: {f.whatsappTemplateName}</>
                      ) : (
                        <span className="text-warn">No template yet — Edit to pick one</span>
                      )
                    ) : (
                      <>At {f.scheduledAt ? formatDateTime(f.scheduledAt) : "—"}</>
                    )}
                    {f.note && <div className="mt-0.5 italic">{f.note}</div>}
                    {f.error && <div className="mt-0.5 text-crit">{f.error}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS_TONE[f.status]}>{label(f.status)}</Badge>
                    {f.delivery && (
                      <div className="mt-0.5 text-[11px] text-slate-550">
                        → {label(f.delivery.status)}
                        {f.delivery.at ? ` · ${formatDateTime(f.delivery.at)}` : ""}
                      </div>
                    )}
                    {f.decidedByEmail && <div className="text-[11px] text-slate-400">by {f.decidedByEmail}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-550">{formatDateTime(f.createdAt)}</td>
                  <td className="px-4 py-2.5">
                    {f.status === "PENDING_APPROVAL" && (
                      <div className="flex flex-col items-end gap-1.5">
                        <button
                          className="btn-primary px-3 py-1 text-xs"
                          disabled={approve.isPending || blocked}
                          title={blocked ? "Customer deleted or on the do-not-call list" : undefined}
                          onClick={async () => {
                            const ok = await confirm({
                              title: f.channel === "WHATSAPP" ? "Send this WhatsApp message?" : "Schedule this call?",
                              body:
                                f.channel === "WHATSAPP"
                                  ? `It is queued now with the WhatsApp sender to ${c ? formatPhoneDisplay(c.phone) : "the customer"}.`
                                  : `The AI agent will call ${c ? formatPhoneDisplay(c.phone) : "the customer"} at ${f.scheduledAt ? formatDateTime(f.scheduledAt) : "the next free slot"}.`,
                              confirmText: "Approve",
                            });
                            if (ok) approve.mutate(f.id);
                          }}
                        >
                          Approve
                        </button>
                        <div className="flex gap-3">
                          <button className="text-xs text-accent-ink hover:underline" onClick={() => setEditing(f)}>
                            Edit
                          </button>
                          <button className="text-xs text-crit hover:underline" disabled={reject.isPending} onClick={() => reject.mutate(f.id)}>
                            Reject
                          </button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </ScrollTable>
          <QueuePagination
            page={page}
            pageSize={pageSize}
            total={q.data!.total}
            noun="follow-ups"
            onPage={(p) => setView({ page: p })}
            onPageSize={(n) => setView({ pageSize: n, page: 1 })}
          />
        </>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title="Edit follow-up before sending">
        {editing && <EditFollowup key={editing.id} followup={editing} onDone={() => { setEditing(null); refresh(); }} />}
      </Modal>
    </div>
  );
}

function toLocalInput(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function EditFollowup({ followup: f, onDone }: { followup: AiCallFollowup; onDone: () => void }) {
  const templates = useWhatsAppTemplateOptions(f.channel === "WHATSAPP");
  const [templateId, setTemplateId] = useState(f.whatsappTemplateId ?? "");
  const [when, setWhen] = useState(toLocalInput(f.scheduledAt));
  const [note, setNote] = useState(f.note ?? "");
  const save = useMutation({
    mutationFn: () =>
      api(`/api/ai-call-followups/${f.id}`, {
        method: "PATCH",
        json: {
          note: note.trim() || null,
          ...(f.channel === "WHATSAPP" ? { whatsappTemplateId: templateId || null } : { scheduledAt: new Date(when).toISOString() }),
        },
        notify: "Follow-up updated",
      }),
    onSuccess: onDone,
  });
  const usable = (templates.data?.items ?? []).filter((t) => t.providerTemplateName);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {f.channel === "WHATSAPP" ? (
        <div>
          <label className="label">Approved WhatsApp template</label>
          <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">— pick a template —</option>
            {usable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.providerTemplateName})
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-550">
            Only templates with a Meta template name are listed. The customer's name and business fill the template variables.
          </p>
        </div>
      ) : (
        <div>
          <label className="label">Call again at</label>
          <input type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} required />
        </div>
      )}
      <div>
        <label className="label">Note (internal)</label>
        <textarea className="input min-h-[4rem]" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </div>
      {save.error && <ErrorNote error={save.error} />}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="btn-primary" disabled={save.isPending || (f.channel === "CALL" && !when)}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
