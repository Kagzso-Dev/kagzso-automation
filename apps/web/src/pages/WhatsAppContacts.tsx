import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, ErrorNote, Modal, Spinner, Table } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { SendWhatsApp, type WhatsAppRecipient } from "../components/SendWhatsApp";
import { useWhatsAppConfig, WHATSAPP_NOT_CONFIGURED_HINT } from "../lib/whatsapp";
import { formatPhoneDisplay } from "@dispatch/shared";
import { PhoneInput, phoneInputOk } from "../components/PhoneInput";

interface WContact {
  id: string;
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
  status: string;
  createdAt: string;
  /** Display only: the latest WhatsApp send to this number (never hides the contact or blocks a send). */
  lastResult?: { status: string; errorCode: string | null; at: string; cooldownUntil: string | null } | null;
}
interface Page {
  items: WContact[];
  total: number;
  page: number;
  pageSize: number;
}

const RESULT_TONE: Record<string, "ok" | "warn" | "crit" | "neutral"> = {
  READ: "ok",
  DELIVERED: "ok",
  SENT: "neutral",
  QUEUED: "neutral",
  SENDING: "neutral",
  SKIPPED: "warn",
  FAILED: "crit",
};

/** "Failed · 131049", with the cooldown end when one applies. */
function LastResult({ r }: { r: WContact["lastResult"] }) {
  if (!r) return <span className="text-slate-400">—</span>;
  const label = `${r.status.charAt(0)}${r.status.slice(1).toLowerCase()}${r.errorCode ? ` · ${r.errorCode}` : ""}`;
  return (
    <span title={`Latest WhatsApp send: ${new Date(r.at).toLocaleString()}`}>
      <Badge tone={RESULT_TONE[r.status] ?? "neutral"}>{label}</Badge>
      {r.cooldownUntil && (
        <span className="mt-0.5 block text-[11px] text-slate-550">
          Marketing templates skipped until {new Date(r.cooldownUntil).toLocaleString()}
        </span>
      )}
    </span>
  );
}

const STATUSES = ["ACTIVE", "UNSUBSCRIBED", "BLOCKED"];
const statusTone: Record<string, "ok" | "warn" | "crit" | "neutral"> = {
  ACTIVE: "ok",
  UNSUBSCRIBED: "warn",
  BLOCKED: "crit",
};

/** Required, and valid for its country (shared PhoneInput rules; +91 = 10-digit mobile). */
const phoneOk = (s: string) => phoneInputOk(s, true);
/** Stored as digits with country code (919876543210) → "+91 98765 43210". */
const showPhone = (digits: string) => formatPhoneDisplay(`+${digits}`);

export function WhatsAppContactsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const config = useWhatsAppConfig();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [editContact, setEditContact] = useState<WContact | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sendOpen, setSendOpen] = useState(false);
  // Shown when the send button is clicked with nothing selected — the button
  // itself stays enabled (unless WhatsApp isn't configured).
  const [sendHint, setSendHint] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: ["whatsapp-contacts", search, status, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (search) p.set("search", search);
      if (status) p.set("status", status);
      return api<Page>(`/api/whatsapp/contacts?${p}`);
    },
  });

  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, status, page]);

  useEffect(() => {
    setSendHint(null);
  }, [selectedIds]);

  const items = query.data?.items ?? [];
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

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/whatsapp/contacts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] }),
  });

  const importMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api<{ created: number; updated: number }>("/api/whatsapp/contacts/import", {
        method: "POST",
        body: fd,
        notify: "Contacts imported",
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] }),
  });

  const configured = config.data?.configured ?? false;
  const activeSelectedCount = items.filter(
    (c) => selectedIds.has(c.id) && c.status === "ACTIVE",
  ).length;

  function openSend() {
    if (activeSelectedCount > 0) {
      setSendHint(null);
      setSendOpen(true);
      return;
    }
    setSendHint("Select at least one active contact to send to, or use “Select all”.");
  }

  const sendTargets: WhatsAppRecipient[] | null = sendOpen
    ? items
        .filter((c) => selectedIds.has(c.id) && c.status === "ACTIVE")
        .map((c) => ({
          id: c.id,
          phone: c.phone,
          firstName: c.firstName,
          lastName: c.lastName,
          businessName: c.businessName,
        }))
    : null;

  return (
    <div>
      <PageHeader
        title="WhatsApp Contacts"
        action={
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-whatsapp"
              disabled={!configured}
              title={
                configured
                  ? "Send a template to the selected active contacts"
                  : WHATSAPP_NOT_CONFIGURED_HINT
              }
              onClick={openSend}
            >
              Send message{activeSelectedCount > 0 ? ` (${activeSelectedCount})` : ""}
            </button>
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
              Import file
            </button>
            <button className="btn-primary" onClick={() => setShowAdd(true)}>
              Add contact
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx"
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
        Import a <b>.csv</b> or <b>.xlsx</b> file with a <code>phone</code> column (plus optional{" "}
        <code>first name</code>, <code>last name</code>, <code>business name</code>).
      </p>

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
          placeholder="Search phone or name"
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
          {STATUSES.map((s) => (
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
              "Phone",
              "Name",
              "Business",
              "Status",
              "Last result",
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
                    aria-label={`Select ${c.phone}`}
                    checked={selectedIds.has(c.id)}
                    disabled={c.status !== "ACTIVE"}
                    title={c.status === "ACTIVE" ? undefined : "Contact is not active"}
                    onChange={(e) => toggleOne(c.id, e.target.checked)}
                  />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{showPhone(c.phone)}</td>
                <td className="px-4 py-2.5">
                  {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                </td>
                <td className="px-4 py-2.5">{c.businessName || "—"}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone[c.status] ?? "neutral"}>{c.status}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <LastResult r={c.lastResult} />
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
                          title: `Delete ${c.phone}?`,
                          body: "This removes the WhatsApp contact and its send history.",
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

      <AddContactModal open={showAdd} onClose={() => setShowAdd(false)} />
      <EditContactModal contact={editContact} onClose={() => setEditContact(null)} />
      <SendWhatsApp
        recipients={sendTargets}
        source="whatsapp"
        onClose={() => setSendOpen(false)}
        onSelectionConsumed={() => setSelectedIds(new Set())}
      />
    </div>
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
  const [phone, setPhone] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [businessName, setBusiness] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      api("/api/whatsapp/contacts", {
        method: "POST",
        json: {
          phone,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          businessName: businessName || undefined,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
      setPhone("");
      setFirst("");
      setLast("");
      setBusiness("");
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="Add WhatsApp contact">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
      >
        <label className="label">Phone number</label>
        <PhoneInput value={phone} onChange={setPhone} required />
        <div className="mb-3 mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">First name</label>
            <input className="input" value={firstName} onChange={(e) => setFirst(e.target.value)} />
          </div>
          <div>
            <label className="label">Last name</label>
            <input className="input" value={lastName} onChange={(e) => setLast(e.target.value)} />
          </div>
        </div>
        <div className="mb-3">
          <label className="label">
            Business name <span className="text-slate-550">(optional)</span>
          </label>
          <input className="input" value={businessName} onChange={(e) => setBusiness(e.target.value)} />
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

function EditContactModal({ contact, onClose }: { contact: WContact | null; onClose: () => void }) {
  return (
    <Modal open={!!contact} onClose={onClose} title={`Edit ${contact ? showPhone(contact.phone) : "contact"}`}>
      {contact ? <EditContactForm key={contact.id} contact={contact} onClose={onClose} /> : null}
    </Modal>
  );
}

function EditContactForm({ contact, onClose }: { contact: WContact; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    phone: contact.phone,
    firstName: contact.firstName ?? "",
    lastName: contact.lastName ?? "",
    businessName: contact.businessName ?? "",
    status: contact.status,
  });
  const mut = useMutation({
    mutationFn: () =>
      api(`/api/whatsapp/contacts/${contact.id}`, {
        method: "PUT",
        json: {
          phone: form.phone,
          firstName: form.firstName || null,
          lastName: form.lastName || null,
          businessName: form.businessName || null,
          status: form.status,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
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
      <label className="label">Phone number</label>
      <PhoneInput className="mb-3" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} required />
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
      <div className="mb-3">
        <label className="label">
          Business name <span className="text-slate-550">(optional)</span>
        </label>
        <input
          className="input"
          value={form.businessName}
          onChange={(e) => setForm({ ...form, businessName: e.target.value })}
        />
      </div>
      <label className="label">Status</label>
      <select
        className="input mb-3"
        value={form.status}
        onChange={(e) => setForm({ ...form, status: e.target.value })}
      >
        {STATUSES.map((s) => (
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
          // An unchanged stored number is kept as is.
          disabled={mut.isPending || (form.phone !== contact.phone && !phoneOk(form.phone))}
        >
          {mut.isPending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
