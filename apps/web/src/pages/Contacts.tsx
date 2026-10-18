import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, ErrorNote, Modal, Spinner, Table } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useToast } from "../components/toast";
import { SendWhatsApp } from "../components/SendWhatsApp";
import { useWhatsAppConfig, WHATSAPP_NOT_CONFIGURED_HINT } from "../lib/whatsapp";
import { AiCallModal } from "../components/AiCallModal";
import { Icon } from "../components/icons";
import { useAiCallsConfig } from "../lib/aiCalls";
import { formatPhoneDisplay } from "@dispatch/shared";
import { PhoneInput, phoneInputOk } from "../components/PhoneInput";

interface Contact {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  businessName?: string | null;
  status: string;
  createdAt: string;
}
interface Page {
  items: Contact[];
  total: number;
  page: number;
  pageSize: number;
}

interface Template {
  id: string;
  name: string;
}

const statusTone: Record<string, "ok" | "warn" | "crit" | "neutral"> = {
  ACTIVE: "ok",
  UNSUBSCRIBED: "warn",
  BOUNCED: "crit",
  COMPLAINED: "crit",
};

/**
 * WhatsApp and AI Call entry points are not offered on Email Contacts (they live on
 * the WhatsApp Contacts and Voicecall Contact pages). The code stays; it just isn't rendered here.
 */
const SHOW_WHATSAPP = false;
const SHOW_AI_CALL = false;

/** Phone is optional; when given it must be valid for its country (shared PhoneInput rules). */
const phoneOk = (s: string) => phoneInputOk(s, false);
/** Indian numbers are stored as 10 digits, other countries as +code…; show both with their code. */
const showPhone = (p: string | null | undefined) => (p ? formatPhoneDisplay(p.startsWith("+") ? p : p.length === 10 ? `+91${p}` : `+${p}`) : "—");

export function ContactsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const whatsAppConfig = useWhatsAppConfig();
  const [waSendOpen, setWaSendOpen] = useState(false);
  const aiCallsConfig = useAiCallsConfig();
  const [aiCallOpen, setAiCallOpen] = useState(false);
  // Shown when a send button is clicked with nothing usable selected — the
  // buttons themselves stay enabled (a click always does something).
  const [sendHint, setSendHint] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [sendTargets, setSendTargets] = useState<Contact[] | null>(null);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ["contacts", search, status, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (search) p.set("search", search);
      if (status) p.set("status", status);
      return api<Page>(`/api/contacts?${p}`);
    },
  });

  // Selection is scoped to the visible page, so reset it whenever the page or
  // filters change to keep the count and the actual send in sync.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, status, page]);

  const items = query.data?.items ?? [];
  // Only ACTIVE contacts are eligible for a send; the rest are filtered out by
  // suppression on the server anyway.
  const selectableIds = items.filter((c) => c.status === "ACTIVE").map((c) => c.id);
  const selectedOnPage = selectableIds.filter((id) => selectedIds.has(id));
  const allSelected = selectableIds.length > 0 && selectedOnPage.length === selectableIds.length;

  function toggleOne(id: string, on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of selectableIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  // Clear the "nothing selected" hint as soon as the selection changes.
  useEffect(() => {
    setSendHint(null);
  }, [selectedIds]);

  // WhatsApp bulk send — a fully separate code path. Eligible = selected contacts
  // that have a phone number; the rest are shown as skipped.
  const waConfigured = whatsAppConfig.data?.configured ?? false;
  const waEligible = items.filter((c) => selectedIds.has(c.id) && c.status === "ACTIVE" && c.phone);
  const waSkippedNoPhone = selectedIds.size - waEligible.length;
  const waRecipients =
    waSendOpen && waEligible.length
      ? waEligible.map((c) => ({
          id: c.id,
          phone: c.phone,
          firstName: c.firstName,
          lastName: c.lastName,
          businessName: c.businessName,
        }))
      : null;

  function openBulkSend() {
    const selected = items.filter((c) => selectedIds.has(c.id) && c.status === "ACTIVE");
    if (!selected.length) {
      setSendHint("Select at least one active contact to send to, or use “Select all”.");
      return;
    }
    setSendHint(null);
    setSendTargets(selected);
  }

  function openWaSend() {
    if (waEligible.length) {
      setSendHint(null);
      setWaSendOpen(true);
      return;
    }
    setSendHint(
      selectedIds.size === 0
        ? "Select at least one active contact to send to, or use “Select all”."
        : "None of the selected contacts have a phone number — WhatsApp needs one.",
    );
  }

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/contacts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }),
  });

  const importMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api<{ jobId: string }>("/api/contacts/import", { method: "POST", body: fd });
    },
    onSuccess: () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ["contacts"] }), 1500);
    },
  });

  return (
    <div>
      <PageHeader
        title="Contacts"
        action={
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-ghost"
              title="Send a template to the selected active contacts"
              onClick={openBulkSend}
            >
              Send email{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
            </button>
            {SHOW_WHATSAPP && (
              <button
                className="btn-whatsapp"
                disabled={!waConfigured}
                title={
                  waConfigured
                    ? "Send a WhatsApp template to the selected contacts that have a phone number"
                    : WHATSAPP_NOT_CONFIGURED_HINT
                }
                onClick={openWaSend}
              >
                Send WhatsApp{waEligible.length > 0 ? ` (${waEligible.length})` : ""}
              </button>
            )}
            {SHOW_AI_CALL && aiCallsConfig.data?.enabled && (
              <button
                className="btn-ghost"
                disabled={!aiCallsConfig.data.configured || !aiCallsConfig.data.canStart}
                title={
                  !aiCallsConfig.data.canStart
                    ? "Only admins can start AI calls"
                    : !aiCallsConfig.data.configured
                      ? "Set VOICE_BACKEND_URL and VOICE_BACKEND_API_KEY to enable AI calls"
                      : "Call customers from an Excel / CSV file with the AI voice agent"
                }
                onClick={() => setAiCallOpen(true)}
              >
                <Icon name="phone" size={16} />
                AI Call
              </button>
            )}
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
              Import file
            </button>
            <button className="btn-primary" onClick={() => setShowAdd(true)}>
              Add contact
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importMut.mutate(f);
                e.target.value = "";
              }}
            />
          </div>
        }
      />

      {importMut.isPending && <div className="mb-3 text-sm text-slate-550">Uploading file…</div>}
      {importMut.isSuccess && (
        <div className="mb-3 text-sm text-ok">Import queued — refreshing shortly.</div>
      )}
      {importMut.error && (
        <div className="mb-3">
          <ErrorNote error={importMut.error} />
        </div>
      )}
      {del.error && (
        <div className="mb-3">
          <ErrorNote error={del.error} />
        </div>
      )}
      <p className="mb-4 text-xs text-slate-550">
        Import a <b>.csv</b> or <b>.xlsx</b> file with an <code>email</code> column (plus optional{" "}
        <code>first name</code>, <code>last name</code>, <code>phone</code>, <code>business name</code>),
        or a <b>.pdf</b> to pull every email address out of its text. Rows whose domain is not on the
        approved sending list (Settings) are skipped.
      </p>

      {SHOW_WHATSAPP && waConfigured && selectedIds.size > 0 && waSkippedNoPhone > 0 && (
        <div className="mb-3 text-xs text-warn">
          {waSkippedNoPhone} contact{waSkippedNoPhone === 1 ? "" : "s"} skipped for WhatsApp — no
          phone number.
        </div>
      )}

      {sendHint && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface-muted px-3 py-2 text-sm">
          <span className="text-ink">{sendHint}</span>
          {selectableIds.length > 0 && (
            <button
              className="text-xs font-medium text-accent-ink hover:underline"
              onClick={() => {
                toggleAll(true);
                setSendHint(null);
              }}
            >
              Select all on this page
            </button>
          )}
          <button
            className="ml-auto text-xs text-slate-550 hover:underline"
            onClick={() => setSendHint(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          className="input sm:max-w-xs"
          placeholder="Search email or name"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          className="input sm:max-w-[12rem]"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {["ACTIVE", "UNSUBSCRIBED", "BOUNCED", "COMPLAINED"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <Spinner />
      ) : query.error ? (
        <ErrorNote error={query.error} />
      ) : (
        <>
          <Table
            head={[
              <input
                key="all"
                type="checkbox"
                className="align-middle"
                aria-label="Select all active contacts on this page"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = selectedOnPage.length > 0 && !allSelected;
                }}
                disabled={selectableIds.length === 0}
                onChange={(e) => toggleAll(e.target.checked)}
              />,
              "Email",
              "Name",
              "Business",
              "Phone",
              "Status",
              "Added",
              "",
            ]}
          >
            {items.map((c) => (
              <tr key={c.id} className="border-b border-line-subtle last:border-0">
                <td className="px-4 py-2.5">
                  <input
                    type="checkbox"
                    className="align-middle"
                    aria-label={`Select ${c.email}`}
                    checked={selectedIds.has(c.id)}
                    disabled={c.status !== "ACTIVE"}
                    title={c.status === "ACTIVE" ? undefined : "Contact is not active"}
                    onChange={(e) => toggleOne(c.id, e.target.checked)}
                  />
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">{c.email}</td>
                <td className="px-4 py-2.5">
                  {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                </td>
                <td className="px-4 py-2.5">{c.businessName || "—"}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{showPhone(c.phone)}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone[c.status] ?? "neutral"}>{c.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-slate-550">
                  {new Date(c.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-3">
                    <button
                      className="text-xs text-accent-ink hover:underline"
                      title="Edit this contact"
                      onClick={() => setEditContact(c)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-xs text-crit hover:underline disabled:opacity-50"
                      disabled={del.isPending}
                      title="Delete this contact"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Delete ${c.email}?`,
                          body: "This removes the contact and its email history.",
                          confirmText: "Delete",
                          tone: "danger",
                        });
                        if (ok) del.mutate(c.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
          <Pagination
            page={query.data!.page}
            pageSize={query.data!.pageSize}
            total={query.data!.total}
            onChange={setPage}
          />
        </>
      )}

      {SHOW_WHATSAPP && (
        <SendWhatsApp
          recipients={waRecipients}
          source="contacts"
          onClose={() => setWaSendOpen(false)}
          onSelectionConsumed={() => setSelectedIds(new Set())}
        />
      )}

      {SHOW_AI_CALL && aiCallsConfig.data?.enabled && (
        <AiCallModal open={aiCallOpen} onClose={() => setAiCallOpen(false)} config={aiCallsConfig.data} />
      )}

      <AddContactModal open={showAdd} onClose={() => setShowAdd(false)} />
      <EditContactModal contact={editContact} onClose={() => setEditContact(null)} />
      <SendEmailModal
        contacts={sendTargets}
        onClose={() => setSendTargets(null)}
        onSent={() => setSelectedIds(new Set())}
      />
    </div>
  );
}

function useTemplateOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["templates"],
    queryFn: () => api<{ items: Template[] }>("/api/templates"),
    enabled,
  });
}

function TemplateSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const templates = useTemplateOptions(true);
  return (
    <>
      <label className="label">Template</label>
      <select
        className="input mb-3"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required
      >
        <option value="">Select…</option>
        {templates.data?.items.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </>
  );
}

/**
 * "Send email" for one or more selected contacts. Confirming creates a
 * server-side paced drip batch (one send at a time with a random gap — see
 * Settings → Bulk send pacing) and hands off immediately: the modal closes, the
 * selection clears, and progress is tracked on the Send Queue page. Even a single
 * recipient goes through a batch so every send shows up there.
 */
function SendEmailModal({
  contacts,
  onClose,
  onSent,
}: {
  contacts: Contact[] | null;
  onClose: () => void;
  /** The send has been kicked off — clear the selection. */
  onSent: () => void;
}) {
  const open = !!contacts && contacts.length > 0;
  const count = contacts?.length ?? 0;
  const only = count === 1 ? contacts?.[0] : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={only ? `Send email to ${only.email}` : `Send email to ${count} contacts`}
    >
      {open ? (
        <SendEmailBody
          key={contacts!.map((c) => c.id).join(",")}
          contacts={contacts!}
          onClose={onClose}
          onSent={onSent}
        />
      ) : null}
    </Modal>
  );
}

function SendEmailBody({
  contacts,
  onClose,
  onSent,
}: {
  contacts: Contact[];
  onClose: () => void;
  onSent: () => void;
}) {
  const toast = useToast();
  const [templateId, setTemplateId] = useState("");
  const [purgeAfter, setPurgeAfter] = useState(false);

  const start = useMutation({
    mutationFn: () =>
      api<{ batchId: string }>("/api/contacts/send", {
        method: "POST",
        json: { templateId, contactIds: contacts.map((c) => c.id), purgeAfter },
        notify: false,
      }),
    onSuccess: () => {
      toast.success("Send started", [
        "Track progress on the Send Queue page (Email tab).",
        ...(purgeAfter ? ["Contacts emailed successfully will be deleted once the batch finishes. Failed ones are kept."] : []),
      ]);
      onSent();
      onClose();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <p className="mb-3 text-sm text-slate-550">
        Sends the selected template to all <b>{contacts.length}</b> selected contact
        {contacts.length === 1 ? "" : "s"}, one at a time with a random gap between each (Settings →
        Bulk send pacing). Contacts that are unsubscribed, bounced or whose domain isn't on the
        approved sending list are skipped. Once you start, this window closes — follow the batch on
        the <b>Send Queue</b> page.
      </p>
      <TemplateSelect value={templateId} onChange={setTemplateId} disabled={start.isPending} />
      <label className="mb-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={purgeAfter}
          disabled={start.isPending}
          onChange={(e) => setPurgeAfter(e.target.checked)}
        />
        <span>
          Remove contacts emailed successfully
          <span className="block text-xs text-slate-550">
            For lead-generation blasts — once every send is done, deletes the recipients whose email
            was sent (and their email history). Failed or skipped recipients are never deleted.
          </span>
        </span>
      </label>
      {start.error && <ErrorNote error={start.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={start.isPending || !templateId}>
          {start.isPending ? "Starting…" : `Start sending (${contacts.length})`}
        </button>
      </div>
    </form>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-550">
      <span>{total} contacts</span>
      <div className="flex gap-2">
        <button className="btn-ghost" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Prev
        </button>
        <span className="px-2 py-2">
          {page} / {pages}
        </span>
        <button className="btn-ghost" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

function AddContactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [businessName, setBusiness] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      api("/api/contacts", {
        method: "POST",
        json: {
          email,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          phone: phone || undefined,
          businessName: businessName || undefined,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      setEmail("");
      setFirst("");
      setLast("");
      setPhone("");
      setBusiness("");
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="Add contact">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
      >
        <label className="label">Email</label>
        <input className="input mb-3" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">First name</label>
            <input className="input" value={firstName} onChange={(e) => setFirst(e.target.value)} />
          </div>
          <div>
            <label className="label">Last name</label>
            <input className="input" value={lastName} onChange={(e) => setLast(e.target.value)} />
          </div>
        </div>
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Phone number <span className="text-slate-550">(optional)</span></label>
            <PhoneInput value={phone} onChange={setPhone} />
          </div>
          <div>
            <label className="label">Business name <span className="text-slate-550">(optional)</span></label>
            <input
              className="input"
              value={businessName}
              onChange={(e) => setBusiness(e.target.value)}
            />
          </div>
        </div>
        {mut.error && <ErrorNote error={mut.error} />}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={mut.isPending || !phoneOk(phone)}>
            Add
          </button>
        </div>
      </form>
    </Modal>
  );
}

const CONTACT_STATUSES = ["ACTIVE", "UNSUBSCRIBED", "BOUNCED", "COMPLAINED"];

function EditContactModal({ contact, onClose }: { contact: Contact | null; onClose: () => void }) {
  return (
    <Modal open={!!contact} onClose={onClose} title={`Edit ${contact?.email ?? "contact"}`}>
      {contact ? <EditContactForm key={contact.id} contact={contact} onClose={onClose} /> : null}
    </Modal>
  );
}

function EditContactForm({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    email: contact.email,
    firstName: contact.firstName ?? "",
    lastName: contact.lastName ?? "",
    phone: contact.phone ?? "",
    businessName: contact.businessName ?? "",
    status: contact.status,
  });
  const mut = useMutation({
    mutationFn: () =>
      api(`/api/contacts/${contact.id}`, {
        method: "PUT",
        json: {
          email: form.email,
          firstName: form.firstName || null,
          lastName: form.lastName || null,
          phone: form.phone || null,
          businessName: form.businessName || null,
          status: form.status,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      onClose();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mut.mutate();
      }}
    >
      <label className="label">Email</label>
      <input
        className="input mb-3"
        type="email"
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
        required
      />
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">First name</label>
          <input
            className="input"
            value={form.firstName}
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Last name</label>
          <input
            className="input"
            value={form.lastName}
            onChange={(e) => setForm({ ...form, lastName: e.target.value })}
          />
        </div>
      </div>
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label">Phone number <span className="text-slate-550">(optional)</span></label>
          <PhoneInput value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
        </div>
        <div>
          <label className="label">Business name <span className="text-slate-550">(optional)</span></label>
          <input
            className="input"
            value={form.businessName}
            onChange={(e) => setForm({ ...form, businessName: e.target.value })}
          />
        </div>
      </div>
      <label className="label">Status</label>
      <select
        className="input mb-3"
        value={form.status}
        onChange={(e) => setForm({ ...form, status: e.target.value })}
      >
        {CONTACT_STATUSES.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      {mut.error && <ErrorNote error={mut.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn-primary"
          // An unchanged stored number is kept as is, even if it predates the stricter check.
          disabled={mut.isPending || (form.phone !== (contact.phone ?? "") && !phoneOk(form.phone))}
        >
          {mut.isPending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
