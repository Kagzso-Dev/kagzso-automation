import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CallRecording, RecordingBadge, useRecordingStatuses } from "./CallRecording";
import {
  AI_CALL_CUSTOMER_FIELDS,
  AI_CALL_LANGUAGE_NAMES,
  AI_CALL_MANUAL_STAGES,
  AI_CALL_STAGE_LABELS,
  AI_CALL_STAGES,
  checkAiCallCustomerRow,
  formatPhoneDisplay,
  parseOptIn,
  type AiCallCustomerColumnMapping,
  type AiCallCustomerField,
  type AiCallLanguage,
  type AiCallStage,
} from "@dispatch/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAiCallsConfig, type AiCallsConfig } from "../lib/aiCalls";
import { isEnglish, titleFor, useAiCallLanguage, useLanguageReady, withLanguage } from "../lib/aiCallLanguage";
import { AiCallLanguageNotice } from "./AiCallLanguageNotice";
import { RunningCallsNote } from "./RunningCallsNote";
import {
  downloadSample,
  openLanguages,
  STAGE_TONE,
  useAiCallCustomerDetail,
  type AddToLanguageResult,
  type AiCallCustomer,
  type AiCallCustomerPage,
  type CopyToLanguageResult,
  type CustomerSheet,
  type ImportSummary,
  type LanguageImportSummary,
} from "../lib/aiCallCustomers";
import { formatDateTime } from "../lib/schedule";
import { PageHeader } from "./Layout";
import { AiCallModal } from "./AiCallModal";
import { Icon } from "./icons";
import { PhoneInput, phoneInputOk } from "./PhoneInput";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { Badge, EmptyState, ErrorNote, Modal, Spinner, Table, type BadgeTone } from "./ui";

/**
 * "AI Call Customers" page (/ai-call-customers): saved customers for AI voice calls.
 * Separate from the email contacts table (own API: /api/ai-call-customers).
 * "Call selected" opens the AI Call modal with the ticked customers preloaded;
 * call results set a suggested stage that an admin reviews in the detail view.
 */
export function AiCallCustomersPanel({ config }: { config: AiCallsConfig }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  // This page's list: English, or another language's own list (/ta/ai-call-customers, …).
  const language = useAiCallLanguage();
  const [search, setSearch] = useState("");
  const [gender, setGender] = useState("");
  const [stage, setStage] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<AiCallCustomer | "new" | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [callIds, setCallIds] = useState<string[] | null>(null);
  const [copyIds, setCopyIds] = useState<string[] | null>(null);
  const isAdmin = useAuth().user?.role === "ADMIN";
  // Other language lists the ticked customers can be copied into (switched on in Settings).
  const copyTargets = openLanguages(config.languages, language).slice(1);

  const query = useQuery({
    queryKey: ["ai-call-customers", language, search, gender, stage, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (!isEnglish(language)) p.set("language", language);
      if (search) p.set("search", search);
      if (gender) p.set("gender", gender);
      if (stage) p.set("stage", stage);
      return api<AiCallCustomerPage>(`/api/ai-call-customers?${p}`);
    },
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((c) => c.stage === "QUEUED" || c.stage === "CALLING") ? 5000 : false),
  });
  useEffect(() => setSelected(new Set()), [search, gender, stage, page]);

  const items = query.data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((c) => selected.has(c.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const del = useMutation({
    mutationFn: (ids: string[]) =>
      api<{ deleted: number }>("/api/ai-call-customers/delete", { method: "POST", json: { ids }, notify: false }),
    onSuccess: (r) => {
      toast.success(`${r.deleted} customer${r.deleted === 1 ? "" : "s"} deleted`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["ai-call-customers"] });
    },
    onError: (err) => toast.fromError(err, "Could not delete"),
  });

  async function confirmDelete(ids: string[], label: string) {
    const ok = await confirm({
      title: `Delete ${label}?`,
      body: "They leave this list and their pending follow-ups are cancelled. Call history and do-not-call status are kept.",
      confirmText: "Delete",
      tone: "danger",
    });
    if (ok) del.mutate(ids);
  }

  // Calls need this language's voice backend (Tamil / Hindi / Kannada pages exist before it is set up).
  const { ready } = useLanguageReady();
  const canCall = ready && config.canStart;

  return (
    <div>
      <PageHeader
        title={titleFor("Voicecall Contact", language)}
        subtitle={
          isEnglish(language)
            ? "Customers for AI voice calls, their call stage and follow-ups. Separate from email and WhatsApp contacts."
            : "This language's own customer list: they are called only with its call flows, in its language. The same number can also be in other languages' lists; do-not-call applies to every list."
        }
        action={
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-ghost"
              disabled={!canCall}
              title={
                canCall
                  ? "Call the ticked customers with the AI voice agent"
                  : isEnglish(language)
                    ? "Set VOICE_BACKEND_URL and VOICE_BACKEND_API_KEY to enable AI calls"
                    : `Set VOICE_BACKEND_URL_${language.toUpperCase()} (this language's voice backend) to enable calls`
              }
              onClick={() => setCallIds([...selected])}
            >
              <Icon name="phone" size={16} />
              {selected.size > 0 ? `Call selected (${selected.size})` : "AI Call"}
            </button>
            {selected.size > 0 && (
              <button
                className="btn-ghost text-crit"
                disabled={del.isPending}
                onClick={() => confirmDelete([...selected], `${selected.size} customer${selected.size === 1 ? "" : "s"}`)}
              >
                <Icon name="trash" size={16} />
                Delete ({selected.size})
              </button>
            )}
            {selected.size > 0 && isAdmin && copyTargets.length > 0 && (
              <button className="btn-ghost" onClick={() => setCopyIds([...selected])}>
                Copy to other languages ({selected.size})
              </button>
            )}
            <button className="btn-ghost" onClick={() => setImportOpen(true)}>
              Import file
            </button>
            <button className="btn-primary" onClick={() => setEditing("new")}>
              Add customer
            </button>
          </div>
        }
      />

      <AiCallLanguageNotice>You can already add and import this language's customers; calling them starts working once it is.</AiCallLanguageNotice>
      <RunningCallsNote />

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          className="input sm:max-w-xs"
          placeholder="Search name, business, phone, email"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          className="input sm:max-w-[10rem]"
          aria-label="Gender filter"
          value={gender}
          onChange={(e) => {
            setGender(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All genders</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
        <select
          className="input sm:max-w-[13rem]"
          aria-label="Call stage filter"
          value={stage}
          onChange={(e) => {
            setStage(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All call stages</option>
          {AI_CALL_STAGES.map((s) => (
            <option key={s} value={s}>
              {AI_CALL_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <Spinner />
      ) : query.error ? (
        <ErrorNote error={query.error} />
      ) : items.length === 0 && !search && !gender && !stage && page === 1 ? (
        <EmptyState icon="phone" title="No AI call customers yet">
          Add customers one by one or import an Excel / CSV file, then call them with the AI voice agent.
        </EmptyState>
      ) : (
        <>
          <Table
            head={[
              <input
                key="all"
                type="checkbox"
                className="align-middle"
                aria-label="Select all customers on this page"
                checked={allOnPage}
                ref={(el) => {
                  if (el) el.indeterminate = !allOnPage && items.some((c) => selected.has(c.id));
                }}
                disabled={items.length === 0}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const c of items) e.target.checked ? next.add(c.id) : next.delete(c.id);
                    return next;
                  })
                }
              />,
              "Name",
              "Gender",
              "Phone",
              "Business",
              "Follow-up detail",
              "Call stage",
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
                    aria-label={`Select ${c.customerName ?? c.phone}`}
                    checked={selected.has(c.id)}
                    onChange={(e) => toggle(c.id, e.target.checked)}
                  />
                </td>
                <td className="px-4 py-2.5 font-medium">
                  <button className="text-left hover:underline" onClick={() => setDetailId(c.id)}>
                    {c.customerName || "—"}
                  </button>
                </td>
                <td className="px-4 py-2.5 capitalize text-slate-550">{c.gender}</td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{formatPhoneDisplay(c.phone)}</td>
                <td className="px-4 py-2.5">{c.businessName || "—"}</td>
                <td className="max-w-[16rem] px-4 py-2.5">
                  <span className="block truncate text-slate-550" title={c.followUpDetail ?? undefined}>
                    {c.followUpDetail || "—"}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <button onClick={() => setDetailId(c.id)} title="Open call detail">
                    <StageBadge stage={c.stage} />
                  </button>
                  {c.needsReview && <div className="mt-0.5 text-[11px] text-warn">suggested — review</div>}
                  {c.doNotCallSetIn && (
                    <div className="mt-0.5 text-[11px] text-crit" title="Never called from any list">
                      Do not call (set in {AI_CALL_LANGUAGE_NAMES[c.doNotCallSetIn]})
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-550">{new Date(c.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-3">
                    <button className="text-xs text-accent-ink hover:underline" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                    <button
                      className="text-xs text-crit hover:underline disabled:opacity-50"
                      disabled={del.isPending}
                      onClick={() => confirmDelete([c.id], c.customerName || formatPhoneDisplay(c.phone))}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
          {items.length === 0 && <p className="mt-3 text-sm text-slate-550">No customers match these filters.</p>}
          <Pager page={query.data!.page} pageSize={query.data!.pageSize} total={query.data!.total} onChange={setPage} />
        </>
      )}

      <CustomerFormModal
        key={editing === "new" ? "new" : (editing?.id ?? "none")}
        customer={editing}
        onClose={() => setEditing(null)}
      />
      <ImportCustomersModal open={importOpen} onClose={() => setImportOpen(false)} />
      <CopyToLanguagesModal
        key={copyIds ? copyIds.join(",") : "none"}
        ids={copyIds}
        onClose={(copied) => {
          setCopyIds(null);
          if (copied) setSelected(new Set());
        }}
      />
      <CustomerDetailModal id={detailId} onClose={() => setDetailId(null)} />
      <AiCallModal
        open={callIds !== null}
        onClose={() => {
          setCallIds(null);
          void qc.invalidateQueries({ queryKey: ["ai-call-customers"] });
        }}
        config={config}
        preselectedCustomerIds={callIds ?? undefined}
      />
    </div>
  );
}

export function StageBadge({ stage }: { stage: AiCallStage }) {
  return <Badge tone={STAGE_TONE[stage]}>{AI_CALL_STAGE_LABELS[stage]}</Badge>;
}

function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-550">
      <span>
        {total} customer{total === 1 ? "" : "s"}
      </span>
      <div className="flex items-center gap-2">
        <button className="btn-ghost py-1" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button className="btn-ghost py-1" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ add / edit */

function CustomerFormModal({ customer, onClose }: { customer: AiCallCustomer | "new" | null; onClose: () => void }) {
  const qc = useQueryClient();
  const language = useAiCallLanguage(); // a new customer goes into this page's language list
  const isAdmin = useAuth().user?.role === "ADMIN";
  const offered = openLanguages(useAiCallsConfig().data?.languages, language);
  const existing = customer && customer !== "new" ? customer : null;
  // Admins: also add the new customer to other language lists (this page's list is always included).
  const [also, setAlso] = useState<AiCallLanguage[]>([]);
  const [results, setResults] = useState<AddToLanguageResult[] | null>(null);
  const [form, setForm] = useState({
    customerName: existing?.customerName ?? "",
    gender: existing?.gender === "female" ? "female" : "male", // Male by default
    phone: existing?.phone ?? "",
    businessName: existing?.businessName ?? "",
    followUpDetail: existing?.followUpDetail ?? "",
    email: existing?.email ?? "",
    whatsappOptIn: existing?.whatsappOptIn ?? false,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: async (): Promise<AddToLanguageResult[] | null> => {
      if (existing) {
        await api(`/api/ai-call-customers/${existing.id}`, { method: "PUT", json: form, notify: "Customer saved" });
        return null;
      }
      if (also.length === 0) {
        // One list: exactly as before.
        await api(withLanguage("/api/ai-call-customers", language), { method: "POST", json: form, notify: "Customer added" });
        return null;
      }
      const r = await api<{ results: AddToLanguageResult[] }>("/api/ai-call-customers/add-to-languages", {
        method: "POST",
        json: { customer: form, languages: [language, ...also] },
        notify: false,
      });
      return r.results;
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["ai-call-customers"] });
      void qc.invalidateQueries({ queryKey: ["ai-call-customer"] });
      if (r) setResults(r);
      else onClose();
    },
  });
  const emailOk = !form.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
  const valid = phoneInputOk(form.phone, true) && emailOk;

  if (results) {
    return (
      <Modal open={customer !== null} onClose={onClose} title="Add customer">
        <AddResults results={results} />
        <div className="mt-4 flex justify-end">
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={customer !== null} onClose={onClose} title={existing ? "Edit customer" : "Add customer"}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Customer name</label>
            <input className="input" value={form.customerName} onChange={(e) => set("customerName", e.target.value)} maxLength={100} />
          </div>
          <div>
            <label className="label">Gender</label>
            <select className="input" value={form.gender} onChange={(e) => set("gender", e.target.value)}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label">
            Phone <span className="text-crit">*</span>
          </label>
          <PhoneInput value={form.phone} onChange={(v) => set("phone", v)} required />
          {existing?.doNotCall && <p className="mt-1 text-xs text-warn">On the do-not-call list — the number can't be changed.</p>}
        </div>
        <div>
          <label className="label">Business name</label>
          <input className="input" value={form.businessName} onChange={(e) => set("businessName", e.target.value)} maxLength={160} />
        </div>
        <div>
          <label className="label">Follow-up detail</label>
          <textarea
            className="input min-h-[4.5rem]"
            value={form.followUpDetail}
            onChange={(e) => set("followUpDetail", e.target.value)}
            maxLength={500}
            placeholder="What the AI agent should follow up on"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Email (optional)</label>
            <input className="input" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} aria-invalid={!emailOk} />
            {!emailOk && <p className="mt-1 text-xs text-crit">Enter a valid email or leave it blank.</p>}
          </div>
          <label className="mt-6 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.whatsappOptIn} onChange={(e) => set("whatsappOptIn", e.target.checked)} />
            Opted in to WhatsApp messages
          </label>
        </div>
        {!existing && isAdmin && offered.length > 1 && (
          <LanguageChecks label="Also add to these languages" current={language} offered={offered} value={also} onChange={setAlso} />
        )}
        {save.error && <ErrorNote error={save.error} />}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!valid || save.isPending}>
            {save.isPending ? "Saving…" : existing ? "Save" : "Add customer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ import */

const IMPORT_LABELS: Record<AiCallCustomerField, string> = {
  customer_name: "Customer name",
  gender: "Gender",
  phone: "Phone",
  business_name: "Business",
  follow_up_detail: "Follow-up detail",
  email: "Email",
  whatsapp_opt_in: "WhatsApp opt-in",
};
const IMPORT_PREVIEW = 300;

function ImportCustomersModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Import AI call customers" wide>
      {open ? <ImportFlow onClose={onClose} /> : null}
    </Modal>
  );
}

function ImportFlow({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const language = useAiCallLanguage(); // imported into this page's language list
  const isAdmin = useAuth().user?.role === "ADMIN";
  const offered = openLanguages(useAiCallsConfig().data?.languages, language);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<CustomerSheet | null>(null);
  const [mapping, setMapping] = useState<AiCallCustomerColumnMapping | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  // Admins: also import into other language lists (this page's list is always included).
  const [also, setAlso] = useState<AiCallLanguage[]>([]);
  const [perLanguage, setPerLanguage] = useState<LanguageImportSummary[] | null>(null);

  const parse = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api<CustomerSheet>("/api/ai-call-customers/parse", { method: "POST", body: fd, notify: false });
    },
    onSuccess: (s) => {
      setSheet(s);
      setMapping(s.mapping);
    },
  });

  const rows = useMemo(() => {
    if (!sheet || !mapping) return [];
    const col = (r: Record<string, string>, f: AiCallCustomerField) => (mapping[f] ? (r[mapping[f]!] ?? "") : "");
    return sheet.rows.map((r) => ({
      customerName: col(r, "customer_name"),
      gender: col(r, "gender"),
      phone: col(r, "phone"),
      businessName: col(r, "business_name"),
      followUpDetail: col(r, "follow_up_detail"),
      email: col(r, "email"),
      whatsappOptIn: parseOptIn(col(r, "whatsapp_opt_in")),
    }));
  }, [sheet, mapping]);

  const checks = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((r) => {
      const c = checkAiCallCustomerRow(r);
      const duplicate = !!c.phone && c.errors.length === 0 && seen.has(c.phone);
      if (c.phone) seen.add(c.phone);
      return { ...c, duplicate };
    });
  }, [rows]);
  const invalid = checks.filter((c) => c.errors.length > 0).length;
  const duplicates = checks.filter((c) => c.duplicate).length;
  const validRows = rows.filter((_, i) => checks[i]!.errors.length === 0 && !checks[i]!.duplicate);

  const doImport = useMutation({
    mutationFn: async () => {
      if (also.length === 0) {
        // One list: exactly as before.
        setResult(await api<ImportSummary>(withLanguage("/api/ai-call-customers/import", language), { method: "POST", json: { rows: validRows }, notify: false }));
        return;
      }
      const r = await api<{ results: LanguageImportSummary[] }>("/api/ai-call-customers/import-to-languages", {
        method: "POST",
        json: { rows: validRows, languages: [language, ...also] },
        notify: false,
      });
      setPerLanguage(r.results);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ai-call-customers"] }),
  });

  if (perLanguage) {
    return (
      <div>
        <p className="mb-2 text-sm text-slate-550">
          Each language list is imported on its own; a number already in a list is a duplicate there.
          {invalid > 0 || duplicates > 0 ? ` ${invalid} invalid and ${duplicates} repeated rows in the file were skipped for every list.` : ""}
        </p>
        <Table head={["Language", "Imported", "Duplicates", "Do not call", "Problem"]}>
          {perLanguage.map((r) => (
            <tr key={r.language} className="border-b border-line-subtle last:border-0">
              <td className="px-4 py-2 font-medium">{AI_CALL_LANGUAGE_NAMES[r.language]}</td>
              <td className="px-4 py-2 font-mono">{r.imported}</td>
              <td className="px-4 py-2 font-mono">{r.duplicates}</td>
              <td className="px-4 py-2 font-mono">{r.doNotCall}</td>
              <td className="px-4 py-2 text-xs text-crit">{r.failed ? "Failed — nothing imported into this list; try again" : ""}</td>
            </tr>
          ))}
        </Table>
        <div className="mt-4 flex justify-end">
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Imported" value={result.imported} tone="ok" />
          <Stat label="Skipped (invalid)" value={invalid + result.skipped} tone={invalid + result.skipped ? "crit" : "neutral"} />
          <Stat label="Duplicates" value={duplicates + result.duplicates} tone={duplicates + result.duplicates ? "warn" : "neutral"} />
          <Stat label="Do not call" value={result.doNotCall} tone={result.doNotCall ? "warn" : "neutral"} />
        </div>
        {result.doNotCall > 0 && (
          <p className="mb-3 text-sm text-slate-550">Numbers already on the do-not-call list were saved as “Do not call” and will never be dialled.</p>
        )}
        {result.problems.length > 0 && (
          <p className="mb-3 text-sm text-slate-550">
            {result.problems.length} row{result.problems.length === 1 ? " was" : "s were"} not imported because the number is already saved.
          </p>
        )}
        <div className="flex justify-end">
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (!sheet || !mapping) {
    return (
      <div>
        <p className="mb-3 text-sm text-slate-550">
          Upload a <b>.xlsx</b> or <b>.csv</b> file with columns like <code>customer_name</code>, <code>gender</code>,{" "}
          <code>phone</code>, <code>business_name</code>, <code>follow_up_detail</code>, <code>email</code> and{" "}
          <code>whatsapp_opt_in</code> (variants such as <i>name</i>, <i>mobile</i>, <i>company</i>, <i>notes</i> are detected).
          Numbers without a country code are treated as +91.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={parse.isPending} onClick={() => fileRef.current?.click()}>
            {parse.isPending ? "Reading file…" : "Choose file"}
          </button>
          <button
            type="button"
            className="text-sm text-accent-ink hover:underline"
            onClick={() => downloadSample().catch((err) => toast.fromError(err, "Could not download the sample"))}
          >
            <Icon name="download" size={14} className="mr-1 inline" />
            Download sample file
          </button>
        </div>
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

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          <b>{rows.length}</b> row{rows.length === 1 ? "" : "s"} read
          {sheet.truncated && <span className="text-warn"> (file truncated to the first {rows.length})</span>}
        </span>
        <button
          className="text-xs text-accent-ink hover:underline"
          onClick={() => {
            setSheet(null);
            setMapping(null);
          }}
        >
          Upload a different file
        </button>
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {AI_CALL_CUSTOMER_FIELDS.map((f) => (
          <div key={f}>
            <label className="label">
              {IMPORT_LABELS[f]}
              {f === "phone" && <span className="text-crit"> *</span>}
            </label>
            <select className="input" value={mapping[f] ?? ""} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || null })}>
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
        <span className="text-ok">{validRows.length} valid</span>
        {invalid > 0 && <span className="text-crit">{invalid} with errors (skipped)</span>}
        {duplicates > 0 && <span className="text-warn">{duplicates} duplicate numbers in the file (skipped)</span>}
      </div>
      <div className="mb-4 max-h-72 overflow-auto rounded-lg border border-line">
        <table className="table-soft w-full min-w-[48rem] text-xs">
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr className="border-b border-line text-left text-slate-550">
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">Gender</th>
              <th className="px-2 py-2">Phone</th>
              <th className="px-2 py-2">Business</th>
              <th className="px-2 py-2">Email</th>
              <th className="px-2 py-2">WhatsApp</th>
              <th className="px-2 py-2">Issues</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, IMPORT_PREVIEW).map((r, i) => {
              const c = checks[i]!;
              const bad = c.errors.length > 0;
              const issues = [...c.errors, ...(c.duplicate ? ["Duplicate number"] : []), ...c.warnings];
              return (
                <tr
                  key={i}
                  className={`border-b border-line-subtle last:border-0 ${bad ? "bg-crit-soft" : c.duplicate ? "bg-warn-soft" : ""}`}
                >
                  <td className="px-2 py-1.5 text-slate-550">{i + 1}</td>
                  <td className="px-2 py-1.5">{r.customerName || "—"}</td>
                  <td className={`px-2 py-1.5 ${c.errors.some((e) => e.startsWith("Unknown gender")) ? "text-crit" : ""}`}>{r.gender || "—"}</td>
                  <td className={`px-2 py-1.5 font-mono ${c.errors.some((e) => e.includes("phone")) || c.duplicate ? "text-crit" : ""}`}>
                    {c.phone ? formatPhoneDisplay(c.phone) : r.phone || "—"}
                  </td>
                  <td className="px-2 py-1.5">{r.businessName || "—"}</td>
                  <td className={`px-2 py-1.5 ${c.errors.includes("Invalid email") ? "text-crit" : ""}`}>{r.email || "—"}</td>
                  <td className="px-2 py-1.5">{r.whatsappOptIn ? "Yes" : "—"}</td>
                  <td className={`px-2 py-1.5 ${bad || c.duplicate ? "text-crit" : "text-warn"}`}>{issues.join("; ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > IMPORT_PREVIEW && (
        <p className="-mt-2 mb-4 text-xs text-slate-550">Showing the first {IMPORT_PREVIEW} rows; every valid row is imported.</p>
      )}
      {!mapping.phone && <p className="mb-3 text-sm text-warn">Map the Phone column to continue.</p>}
      {isAdmin && offered.length > 1 && (
        <div className="mb-3">
          <LanguageChecks label="Also import into other languages" current={language} offered={offered} value={also} onChange={setAlso} />
        </div>
      )}
      {doImport.error && <ErrorNote error={doImport.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn-primary"
          disabled={!mapping.phone || validRows.length === 0 || doImport.isPending}
          onClick={() => doImport.mutate()}
        >
          {doImport.isPending ? "Importing…" : `Import ${validRows.length} valid row${validRows.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ several language lists (admins) */

/** Language lists to use: this page's list (when given) ticked and locked, the others (switched on in Settings) to pick. */
function LanguageChecks({
  label,
  current,
  offered,
  value,
  onChange,
}: {
  label: string;
  current?: AiCallLanguage;
  offered: AiCallLanguage[];
  value: AiCallLanguage[];
  onChange: (v: AiCallLanguage[]) => void;
}) {
  return (
    <fieldset>
      <legend className="label">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {offered.map((l) => (
          <label key={l} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={l === current || value.includes(l)}
              disabled={l === current}
              onChange={(e) => onChange(e.target.checked ? [...value, l] : value.filter((x) => x !== l))}
            />
            {AI_CALL_LANGUAGE_NAMES[l]}
            {l === current && <span className="text-xs text-slate-550">(this list)</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const ADD_STATUS: Record<AddToLanguageResult["status"], [string, BadgeTone]> = {
  added: ["Added", "ok"],
  exists: ["Already in this list", "warn"],
  failed: ["Failed", "crit"],
};

function AddResults({ results }: { results: AddToLanguageResult[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {results.map((r) => (
        <li key={r.language} className="flex flex-wrap items-center gap-2">
          <span className="w-20 font-medium">{AI_CALL_LANGUAGE_NAMES[r.language]}</span>
          <Badge tone={ADD_STATUS[r.status][1]}>{ADD_STATUS[r.status][0]}</Badge>
          {r.message && <span className="text-xs text-slate-550">{r.message}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Copy ticked customers into other language lists: pick the lists, see what would happen (will add /
 * already there / do-not-call), then copy. The ticked customers are never changed; no call history,
 * follow-ups or recordings are copied.
 */
function CopyToLanguagesModal({ ids, onClose }: { ids: string[] | null; onClose: (copied: boolean) => void }) {
  const qc = useQueryClient();
  const language = useAiCallLanguage();
  const targetsOffered = openLanguages(useAiCallsConfig().data?.languages, language).slice(1);
  const [targets, setTargets] = useState<AiCallLanguage[]>([]);
  const [preview, setPreview] = useState<CopyToLanguageResult[] | null>(null);
  const [done, setDone] = useState<CopyToLanguageResult[] | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<{ customers: number; results: CopyToLanguageResult[] }>("/api/ai-call-customers/copy-to-languages", {
        method: "POST",
        json: { ids, targets, dryRun },
        notify: false,
      }),
    onSuccess: (r, dryRun) => {
      if (dryRun) return setPreview(r.results);
      setDone(r.results);
      void qc.invalidateQueries({ queryKey: ["ai-call-customers"] });
    },
  });
  const n = ids?.length ?? 0;
  const willAdd = (preview ?? []).reduce((s, r) => s + r.added, 0);
  const shown = done ?? preview;

  return (
    <Modal open={ids !== null} onClose={() => onClose(!!done)} title={`Copy ${n} customer${n === 1 ? "" : "s"} to other languages`}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-550">
          Name, gender, phone, business, follow-up detail, email and WhatsApp opt-in are copied. These customers are not changed, and no call
          history, follow-ups or recordings are copied.
        </p>
        {!done && (
          <LanguageChecks
            label="Copy into"
            offered={targetsOffered}
            value={targets}
            onChange={(v) => {
              setTargets(v);
              setPreview(null);
            }}
          />
        )}
        {shown && (
          <Table head={["Language", done ? "Added" : "Will add", "Already in that list", "Do not call (skipped)", ...(done ? ["Failed"] : [])]}>
            {shown.map((r) => (
              <tr key={r.language} className="border-b border-line-subtle last:border-0">
                <td className="px-4 py-2 font-medium">{AI_CALL_LANGUAGE_NAMES[r.language]}</td>
                <td className="px-4 py-2 font-mono">{r.added}</td>
                <td className="px-4 py-2 font-mono">{r.exists}</td>
                <td className="px-4 py-2 font-mono">{r.doNotCall}</td>
                {done && <td className={`px-4 py-2 font-mono ${r.failed ? "text-crit" : ""}`}>{r.failed}</td>}
              </tr>
            ))}
          </Table>
        )}
        {run.error && <ErrorNote error={run.error} />}
        <div className="flex justify-end gap-2 pt-1">
          {done ? (
            <button className="btn-primary" onClick={() => onClose(true)}>
              Done
            </button>
          ) : (
            <>
              <button className="btn-ghost" onClick={() => onClose(false)}>
                Cancel
              </button>
              {preview ? (
                <button className="btn-primary" disabled={willAdd === 0 || run.isPending} onClick={() => run.mutate(false)}>
                  {run.isPending ? "Copying…" : `Copy ${willAdd} customer${willAdd === 1 ? "" : "s"}`}
                </button>
              ) : (
                <button className="btn-primary" disabled={targets.length === 0 || run.isPending} onClick={() => run.mutate(true)}>
                  {run.isPending ? "Checking…" : "Preview"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: BadgeTone }) {
  const color = tone === "ok" ? "text-ok" : tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-slate-550">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ call detail + review */

const EVENT_LABEL: Record<string, string> = {
  created: "Added",
  edited: "Edited",
  deleted: "Deleted",
  call_queued: "Call queued",
  call_started: "Calling",
  call_cancelled: "Call cancelled before dialling",
  call_result: "Call result",
  do_not_call: "Do not call",
  stage_changed: "Stage changed",
  approved: "Approved",
  rejected: "Rejected",
  followup_created: "Follow-up created",
  followup_edited: "Follow-up edited",
  followup_approved: "Follow-up approved",
  followup_rejected: "Follow-up rejected",
  followup_cancelled: "Follow-up cancelled",
  followup_failed: "Follow-up failed",
  followup_handed_over: "Follow-up queued",
  whatsapp_sent: "WhatsApp sent",
  whatsapp_failed: "WhatsApp not sent",
  replied: "Replied",
};

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function CustomerDetailModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useAiCallCustomerDetail(id);
  const title = detail.data ? `Call detail — ${detail.data.customer.customerName || formatPhoneDisplay(detail.data.customer.phone)}` : "Call detail";
  return (
    <Modal open={id !== null} onClose={onClose} title={title} wide>
      {detail.isLoading ? <Spinner /> : detail.error ? <ErrorNote error={detail.error} /> : detail.data ? <DetailBody id={id!} onClose={onClose} /> : null}
    </Modal>
  );
}

function DetailBody({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const detail = useAiCallCustomerDetail(id);
  const recordings = useRecordingStatuses(detail.data?.calls.map((l) => l.id) ?? []); // admins only
  const d = detail.data!;
  const c = d.customer;
  const [pick, setPick] = useState<AiCallStage>(c.stage === "QUEUED" || c.stage === "CALLING" ? "FOLLOW_UP_NEEDED" : c.stage);
  const [fuChannel, setFuChannel] = useState<"WHATSAPP" | "CALL">("CALL");
  const [fuWhen, setFuWhen] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600_000)));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["ai-call-customer", id] });
    void qc.invalidateQueries({ queryKey: ["ai-call-customers"] });
    void qc.invalidateQueries({ queryKey: ["ai-call-followups"] });
  };
  const stage = useMutation({
    mutationFn: (s: AiCallStage) =>
      api(`/api/ai-call-customers/${id}/stage`, { method: "POST", json: { stage: s }, notify: `Stage set to ${AI_CALL_STAGE_LABELS[s]}` }),
    onSuccess: refresh,
  });
  const addFollowup = useMutation({
    mutationFn: () =>
      api(`/api/ai-call-customers/${id}/followups`, {
        method: "POST",
        json: { channel: fuChannel, ...(fuChannel === "CALL" ? { scheduledAt: new Date(fuWhen).toISOString() } : {}) },
        notify: "Follow-up added — approve it in Send Queue",
      }),
    onSuccess: refresh,
  });

  const locked = c.doNotCall || !!c.deletedAt;
  const busy = stage.isPending;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm">
          <div className="font-mono">{formatPhoneDisplay(c.phone)}</div>
          <div className="text-slate-550">
            {[c.businessName, c.gender, c.email, c.whatsappOptIn ? "WhatsApp opt-in" : null]
              .filter(Boolean)
              .join(" · ") || "—"}
          </div>
          {c.followUpDetail && <div className="mt-1 text-slate-550">Follow-up: {c.followUpDetail}</div>}
        </div>
        <div className="text-right">
          <StageBadge stage={c.stage} />
          {c.needsReview && <div className="mt-1 text-xs text-warn">Suggested from the call — please review</div>}
          {c.doNotCall && <div className="mt-1 text-xs text-crit">Permanently blocked from calls</div>}
          {c.deletedAt && <div className="mt-1 text-xs text-slate-550">Deleted</div>}
        </div>
      </div>

      {!locked && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-muted px-3 py-2.5">
          <button className="btn-primary py-1.5" disabled={busy} onClick={() => stage.mutate("APPROVED")}>
            <Icon name="check" size={14} />
            Approve
          </button>
          <button className="btn-ghost py-1.5" disabled={busy} onClick={() => stage.mutate("REJECTED")}>
            Reject
          </button>
          <span className="mx-1 h-5 w-px bg-line" />
          <select className="input w-auto py-1.5" aria-label="Change stage" value={pick} onChange={(e) => setPick(e.target.value as AiCallStage)}>
            {AI_CALL_MANUAL_STAGES.filter((s) => s !== "DO_NOT_CALL").map((s) => (
              <option key={s} value={s}>
                {AI_CALL_STAGE_LABELS[s]}
              </option>
            ))}
          </select>
          <button className="btn-ghost py-1.5" disabled={busy || pick === c.stage} onClick={() => stage.mutate(pick)}>
            Set stage
          </button>
          <button
            className="ml-auto text-xs text-crit hover:underline"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: "Mark as Do not call?",
                body: "This number will never be called again. This can't be undone.",
                confirmText: "Do not call",
                tone: "danger",
              });
              if (ok) stage.mutate("DO_NOT_CALL");
            }}
          >
            Mark Do not call
          </button>
        </div>
      )}
      {stage.error && <ErrorNote error={stage.error} />}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Calls</h3>
        {d.calls.length === 0 ? (
          <p className="text-sm text-slate-550">Not called yet.</p>
        ) : (
          <div className="space-y-2">
            {d.calls.map((l) => (
              <div key={l.id} className="rounded-lg border border-line px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={l.status === "COMPLETED" ? "ok" : l.status === "FAILED" ? "crit" : "neutral"}>{l.status.toLowerCase().replace(/_/g, " ")}</Badge>
                  {l.outcome && <span className="font-medium">{l.outcome.replace(/_/g, " ")}</span>}
                  {l.durationSec != null && <span className="text-xs text-slate-550">{l.durationSec}s</span>}
                  <RecordingBadge status={recordings[l.id]} />
                  <span className="ml-auto text-xs text-slate-550">{formatDateTime(l.startedAt ?? l.createdAt)}</span>
                </div>
                {l.summary && <p className="mt-1 text-slate-550">{l.summary}</p>}
                {l.error && <p className="mt-1 text-crit">{l.error}</p>}
                {l.transcript && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-accent-ink">Transcript</summary>
                    <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-sans text-xs text-slate-550">{l.transcript}</pre>
                  </details>
                )}
                <CallRecording logId={l.id} status={recordings[l.id]} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Follow-ups</h3>
        {d.followups.length === 0 ? (
          <p className="mb-2 text-sm text-slate-550">None yet.</p>
        ) : (
          <ul className="mb-2 space-y-1 text-sm">
            {d.followups.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={f.status === "PENDING_APPROVAL" ? "warn" : f.status === "APPROVED" ? "ok" : f.status === "FAILED" ? "crit" : "neutral"}>
                  {f.status.toLowerCase().replace(/_/g, " ")}
                </Badge>
                <span>{f.channel === "WHATSAPP" ? "WhatsApp message" : `Call again${f.scheduledAt ? ` · ${formatDateTime(f.scheduledAt)}` : ""}`}</span>
                {f.reason && <span className="text-xs text-slate-550">({f.reason})</span>}
                {f.delivery && <span className="text-xs text-slate-550">→ {f.delivery.status.toLowerCase().replace(/_/g, " ")}</span>}
                {f.error && <span className="text-xs text-crit">{f.error}</span>}
              </li>
            ))}
          </ul>
        )}
        {!locked && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select className="input w-auto py-1.5" aria-label="Follow-up channel" value={fuChannel} onChange={(e) => setFuChannel(e.target.value as "WHATSAPP" | "CALL")}>
              <option value="CALL">Call again</option>
              <option value="WHATSAPP" disabled={!c.whatsappOptIn}>
                WhatsApp message{c.whatsappOptIn ? "" : " (needs opt-in)"}
              </option>
            </select>
            {fuChannel === "CALL" && (
              <input type="datetime-local" className="input w-auto py-1.5" aria-label="Call again at" value={fuWhen} onChange={(e) => setFuWhen(e.target.value)} />
            )}
            <button className="btn-ghost py-1.5" disabled={addFollowup.isPending || (fuChannel === "CALL" && !fuWhen)} onClick={() => addFollowup.mutate()}>
              Add follow-up
            </button>
            <span className="text-xs text-slate-550">Nothing is sent until approved in Send Queue → AI Call follow-ups.</span>
          </div>
        )}
        {addFollowup.error && <ErrorNote error={addFollowup.error} />}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
        <ol className="max-h-72 space-y-2 overflow-auto border-l border-line pl-4">
          {d.timeline.map((t, i) => (
            <li key={i} className="relative text-sm">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-line-strong" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{EVENT_LABEL[t.type] ?? t.type.replace(/_/g, " ")}</span>
                {t.stage && t.type !== "call_queued" && <StageBadge stage={t.stage} />}
                <span className="text-xs text-slate-550">{formatDateTime(t.at)}</span>
                {t.actor && <span className="text-xs text-slate-400">{t.actor}</span>}
              </div>
              {t.detail && <div className="text-xs text-slate-550">{t.detail}</div>}
            </li>
          ))}
        </ol>
      </section>

      <div className="flex justify-end">
        <button className="btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
