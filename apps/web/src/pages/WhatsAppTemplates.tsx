import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Badge, EmptyState, ErrorNote, Modal, Spinner, Table, Tabs, type BadgeTone } from "../components/ui";
import { useConfirm } from "../components/confirm";
import { useTemplateVerification, type TemplateVerification, type TemplateVerifyStatus } from "../lib/whatsapp";
import { ACCEPT, formatBytes, uploadWithProgress, type MediaView } from "../lib/whatsappMedia";
import { WhatsAppMedia } from "../components/WhatsAppMedia";
import { MetaSyncModal, useMetaSyncCandidates } from "../components/WhatsAppTemplateSync";
import { CreateInMetaForm } from "../components/WhatsAppTemplateCreate";
import { useAuth } from "../lib/auth";
import { useBranding } from "../lib/branding";

interface WTemplate {
  id: string;
  name: string;
  /** Exact Meta template name; null on templates registered before the Meta migration. */
  providerTemplateName: string | null;
  languageCode: string;
  body: string;
  variables: string[];
  buttonLabels: string[];
  updatedAt: string;
  _count?: { batches: number };
  /** Archived: hidden here (unless "Show archived") and from the Send dialog; never deleted. */
  archived?: boolean;
  /** Image / video / document the template is sent with (Meta media header). */
  headerMedia?: MediaView | null;
}

export function WhatsAppTemplatesPage() {
  const { appName } = useBranding();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<WTemplate | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [headerFor, setHeaderFor] = useState<WTemplate | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const isAdmin = useAuth().user?.role === "ADMIN";
  // Checked when an admin opens the page: Meta templates not registered here yet.
  const metaNew = useMetaSyncCandidates(isAdmin);
  const newInMeta = (metaNew.data?.items ?? []).filter((c) => c.importable);

  const query = useQuery({
    queryKey: ["whatsapp-templates"],
    queryFn: () => api<{ items: WTemplate[] }>("/api/whatsapp/templates"),
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/api/whatsapp/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-templates"] }),
  });

  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api(`/api/whatsapp/templates/${id}/${archived ? "archive" : "restore"}`, {
        method: "POST",
        notify: archived ? "Template archived" : "Template restored",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-templates"] }),
  });

  const all = query.data?.items ?? [];
  const items = all.filter((t) => !t.archived);
  const archivedItems = all.filter((t) => t.archived);
  const shown = showArchived ? [...items, ...archivedItems] : items;
  const verify = useTemplateVerification();

  return (
    <div>
      <PageHeader
        title="WhatsApp Templates"
        subtitle="Meta-approved message templates with quick-reply buttons. Create and get the template approved in WhatsApp Manager, then register its exact name and language here."
        action={
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <button className="btn-ghost" onClick={() => setSyncOpen(true)} title="Import new templates from WhatsApp Manager and update ones that changed there">
                Sync from Meta
              </button>
            )}
            <button className="btn-primary" onClick={() => setShowNew(true)}>
              New template
            </button>
          </div>
        }
      />

      {newInMeta.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-accent-soft px-3 py-2 text-sm">
          <span>
            {newInMeta.length} template{newInMeta.length === 1 ? "" : "s"} in Meta {newInMeta.length === 1 ? "isn't" : "aren't"} in {appName} yet:{" "}
            <span className="font-mono text-xs">{newInMeta.slice(0, 4).map((c) => c.name).join(", ")}{newInMeta.length > 4 ? " …" : ""}</span>
          </span>
          <button className="ml-auto text-xs font-medium text-accent-ink hover:underline" onClick={() => setSyncOpen(true)}>
            Review &amp; import
          </button>
        </div>
      )}

      {(del.error || archive.error) && (
        <div className="mb-3">
          <ErrorNote error={del.error ?? archive.error} />
        </div>
      )}

      {query.isLoading ? (
        <Spinner />
      ) : query.error ? (
        <ErrorNote error={query.error} />
      ) : all.length === 0 ? (
        <EmptyState icon="templates" title="No WhatsApp templates yet">
          Register your first approved Meta message template to start sending.
        </EmptyState>
      ) : (
        <>
        <div className="mb-2 flex flex-wrap items-center justify-end gap-3 text-xs text-slate-550">
          {verify.query.data && <span>Checked with Meta {new Date(verify.query.data.checkedAt).toLocaleTimeString()}</span>}
          <button
            type="button"
            className="btn-ghost py-1 text-xs"
            disabled={verify.refresh.isPending || verify.query.isFetching}
            onClick={() => verify.refresh.mutate()}
          >
            {verify.refresh.isPending ? "Verifying…" : "Verify with Meta"}
          </button>
        </div>
        <Table head={["Name", "Meta template", "Header", "Language", "Variables", "Buttons", "Updated", ""]}>
          {shown.map((t) => (
            <tr
              key={t.id}
              className={`border-b border-line-subtle last:border-0 ${t.archived ? "bg-surface-sunken opacity-60" : ""}`}
            >
              <td className="px-4 py-2.5 font-medium">
                {t.name}
                {t.archived && <span className="ml-2 text-[11px] font-normal text-slate-550">archived</span>}
              </td>
              <td className="max-w-[16rem] px-4 py-2.5">
                {t.providerTemplateName ? (
                  <MetaStatus
                    name={t.providerTemplateName}
                    verification={verify.byId.get(t.id)}
                    loading={verify.query.isLoading || verify.refresh.isPending}
                    error={verify.query.error ?? verify.refresh.error}
                  />
                ) : (
                  <span title="Registered before the move to Meta — edit it and add the Meta template name to send it.">
                    <Badge tone="warn">Needs Meta name</Badge>
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5">
                <HeaderCell
                  template={t}
                  needs={verify.byId.get(t.id)?.headerNeedsParameter ?? null}
                  onEdit={() => setHeaderFor(t)}
                />
              </td>
              <td className="px-4 py-2.5 font-mono text-xs">{t.languageCode}</td>
              <td className="px-4 py-2.5 text-xs">
                {t.variables.length ? t.variables.join(", ") : "—"}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap gap-1">
                  {t.buttonLabels.length ? (
                    t.buttonLabels.map((b) => (
                      <Badge key={b} tone="neutral">
                        {b}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-slate-550">—</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-2.5 text-slate-550">
                {new Date(t.updatedAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-2.5">
                {t.archived ? (
                  <div className="flex items-center justify-end">
                    <button
                      className="text-xs text-accent-ink hover:underline disabled:opacity-50"
                      disabled={archive.isPending}
                      onClick={() => archive.mutate({ id: t.id, archived: false })}
                    >
                      Restore
                    </button>
                  </div>
                ) : (
                <div className="flex items-center justify-end gap-3">
                  <button
                    className="text-xs text-accent-ink hover:underline"
                    onClick={() => setEditing(t)}
                  >
                    Edit
                  </button>
                  <button
                    className="text-xs text-slate-550 hover:underline disabled:opacity-50"
                    disabled={archive.isPending}
                    title="Hide from this page and the Send dialog. Nothing is deleted; send history stays."
                    onClick={() => archive.mutate({ id: t.id, archived: true })}
                  >
                    Archive
                  </button>
                  <button
                    className="text-xs text-crit hover:underline disabled:opacity-50"
                    disabled={del.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete "${t.name}"?`,
                        body: "This removes the template registration.",
                        confirmText: "Delete",
                        tone: "danger",
                      });
                      if (ok) del.mutate(t.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {shown.length === 0 && <p className="mt-3 text-sm text-slate-550">All templates are archived.</p>}
        {archivedItems.length > 0 && (
          <div className="mt-3 flex justify-end">
            <button type="button" className="text-xs text-slate-550 hover:underline" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "Hide" : "Show"} archived ({archivedItems.length})
            </button>
          </div>
        )}
        </>
      )}

      <HeaderMediaModal
        template={headerFor}
        needs={headerFor ? (verify.byId.get(headerFor.id)?.headerNeedsParameter ?? null) : null}
        onClose={() => setHeaderFor(null)}
      />
      <TemplateModal open={showNew} onClose={() => setShowNew(false)} canCreateInMeta={isAdmin} />
      <MetaSyncModal open={syncOpen} onClose={() => setSyncOpen(false)} />
      <TemplateModal
        open={!!editing}
        template={editing ?? undefined}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- header media */

/** Meta header format -> the media kind it takes (TEXT variables / LOCATION aren't media). */
const KIND_FOR_FORMAT: Record<string, "image" | "video" | "document"> = { IMAGE: "image", VIDEO: "video", DOCUMENT: "document" };

function HeaderCell({ template: t, needs, onEdit }: { template: WTemplate; needs: string | null; onEdit: () => void }) {
  const wanted = needs ? KIND_FOR_FORMAT[needs] : undefined;
  const h = t.headerMedia;
  if (t.archived) return <span className="text-xs text-slate-550">{h ? h.kind : "—"}</span>;
  if (h) {
    const mismatch = wanted && h.kind !== wanted;
    return (
      <div className="text-xs">
        <button className="text-left text-accent-ink hover:underline" onClick={onEdit} title={h.filename ?? undefined}>
          {h.kind.charAt(0).toUpperCase() + h.kind.slice(1)} · {formatBytes(h.sizeBytes)}
        </button>
        {mismatch && <div className="text-crit">Meta expects a {wanted}</div>}
      </div>
    );
  }
  if (needs && !wanted) {
    return (
      <span className="text-xs text-slate-550" title="Header variables and location headers aren't supported yet">
        {needs.toLowerCase()} header — not supported
      </span>
    );
  }
  return wanted ? (
    <button onClick={onEdit} title={`Meta requires a header ${wanted} for this template`}>
      <Badge tone="warn">Needs header {wanted}</Badge>
    </button>
  ) : (
    <button className="text-xs text-slate-550 hover:text-accent-ink hover:underline" onClick={onEdit}>
      Add
    </button>
  );
}

function HeaderMediaModal({ template, needs, onClose }: { template: WTemplate | null; needs: string | null; onClose: () => void }) {
  return (
    <Modal open={!!template} onClose={onClose} title={template ? `Header media — ${template.name}` : "Header media"}>
      {template && <HeaderMediaForm key={template.id} template={template} needs={needs} onClose={onClose} />}
    </Modal>
  );
}

function HeaderMediaForm({ template, needs, onClose }: { template: WTemplate; needs: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const wanted = needs ? KIND_FOR_FORMAT[needs] : undefined;
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["whatsapp-templates"] });
  const save = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append("file", file!);
      setProgress(0);
      return uploadWithProgress<{ headerMedia: MediaView }>("PUT", `/api/whatsapp/templates/${template.id}/header-media`, form, setProgress);
    },
    onSettled: () => setProgress(null),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/whatsapp/templates/${template.id}/header-media`, { method: "DELETE", notify: "Header media removed" }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const accept = wanted ? ACCEPT[wanted] : [ACCEPT.image, ACCEPT.video, ACCEPT.document].join(",");
  const article = wanted === "image" ? "an image" : `a ${wanted}`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-550">
        {wanted ? (
          <>
            In Meta this template has <b>{article}</b> header. Every send attaches this file as the header.
          </>
        ) : (
          <>Attach an image, video or document as the header of every send. Only add one if the Meta template has a media header.</>
        )}{" "}
        Images: JPG / PNG up to 5 MB · video: MP4 / 3GP up to 16 MB · documents: PDF, Word, Excel, PowerPoint, TXT up to 100 MB.
      </p>
      {template.headerMedia && (
        <div>
          <div className="label">Current</div>
          <WhatsAppMedia media={template.headerMedia} compact />
        </div>
      )}
      <div>
        <label className="label">{template.headerMedia ? "Replace with" : "File"}</label>
        <input type="file" accept={accept} className="block text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && (
          <p className="mt-1 text-xs text-slate-550">
            {file.name} · {formatBytes(file.size)}
          </p>
        )}
      </div>
      {progress !== null && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full bg-gradient-accent transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {(save.error || remove.error) && <ErrorNote error={save.error ?? remove.error} />}
      <div className="flex justify-between gap-2">
        <div>
          {template.headerMedia && (
            <button type="button" className="btn-ghost text-crit" disabled={remove.isPending || save.isPending} onClick={() => remove.mutate()}>
              Remove header
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!file || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? `Uploading… ${progress ?? 0}%` : "Save header"}
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<TemplateVerifyStatus, { label: string; tone: BadgeTone }> = {
  verified: { label: "Verified", tone: "ok" },
  pending: { label: "Pending", tone: "warn" },
  failed: { label: "Failed", tone: "crit" },
  not_found: { label: "Not found", tone: "crit" },
  unchecked: { label: "Couldn't check", tone: "neutral" },
};

/** Meta verification badge; the full Meta name and the reason are in the tooltip. */
function MetaStatus({
  name,
  verification,
  loading,
  error,
}: {
  name: string;
  verification?: TemplateVerification;
  loading: boolean;
  error: unknown;
}) {
  const badge = verification
    ? STATUS_BADGE[verification.status]
    : loading
      ? { label: "Checking…", tone: "neutral" as BadgeTone }
      : STATUS_BADGE.unchecked;
  const reason = verification?.reason ?? (error instanceof Error ? error.message : loading ? "" : "Not checked yet");
  return (
    <div title={[name, reason].filter(Boolean).join(" — ")}>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </div>
  );
}

function TemplateModal({
  open,
  template,
  onClose,
  canCreateInMeta = false,
}: {
  open: boolean;
  template?: WTemplate;
  onClose: () => void;
  /** Admins can build a template here and submit it to Meta; everyone can register an existing one. */
  canCreateInMeta?: boolean;
}) {
  const [mode, setMode] = useState<"create" | "register">("create");
  const creating = !template && canCreateInMeta && mode === "create";
  return (
    <Modal open={open} onClose={onClose} title={template ? "Edit template" : "New WhatsApp template"} wide={creating}>
      {open && !template && canCreateInMeta && (
        <Tabs
          tabs={[
            { value: "create", label: "Create in Meta" },
            { value: "register", label: "Register existing" },
          ]}
          value={mode}
          onChange={setMode}
        />
      )}
      {open ? (
        creating ? (
          <CreateInMetaForm onClose={onClose} />
        ) : (
          <TemplateForm key={template?.id ?? "new"} template={template} onClose={onClose} />
        )
      ) : null}
    </Modal>
  );
}

function TemplateForm({ template, onClose }: { template?: WTemplate; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: template?.name ?? "",
    providerTemplateName: template?.providerTemplateName ?? "",
    languageCode: template?.languageCode ?? "en",
    body: template?.body ?? "",
    variables: (template?.variables ?? []).join(", "),
    buttonLabels: (template?.buttonLabels ?? ["Interested", "Not Interested"]).join(", "),
  });

  const toList = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const mut = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name,
        providerTemplateName: form.providerTemplateName.trim(),
        languageCode: form.languageCode.trim(),
        body: form.body,
        variables: toList(form.variables),
        buttonLabels: toList(form.buttonLabels),
      };
      return template
        ? api(`/api/whatsapp/templates/${template.id}`, { method: "PUT", json: payload })
        : api("/api/whatsapp/templates", { method: "POST", json: payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp-templates"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-template-verify"] }); // badge follows the edited name / language
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
      <label className="label">Name</label>
      <input
        className="input mb-3"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        required
      />

      <div className="mb-1 grid grid-cols-[1fr_8rem] gap-3">
        <div>
          <label className="label">Meta template name</label>
          <input
            className="input font-mono text-xs"
            value={form.providerTemplateName}
            onChange={(e) => setForm({ ...form, providerTemplateName: e.target.value })}
            placeholder="kagzso_greeting_new_contact"
            required
          />
        </div>
        <div>
          <label className="label">Language</label>
          <input
            className="input font-mono text-xs"
            value={form.languageCode}
            onChange={(e) => setForm({ ...form, languageCode: e.target.value })}
            placeholder="en"
            required
          />
        </div>
      </div>
      <p className="mb-3 text-xs text-slate-550">
        Exactly as shown in WhatsApp Manager → Message templates, and only once Meta has approved it.
      </p>

      <label className="label">Body preview</label>
      <textarea
        className="input mb-1 min-h-[96px]"
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
        placeholder="Hi {{first_name}}, we work with businesses like {{business_name}}…"
        required
      />
      <p className="mb-3 text-xs text-slate-550">
        Must match the approved template text. Use <code>{"{{first_name}}"}</code>,{" "}
        <code>{"{{last_name}}"}</code>, <code>{"{{business_name}}"}</code>, <code>{"{{phone}}"}</code>.
      </p>

      <label className="label">Variables (in order, comma-separated)</label>
      <input
        className="input mb-1"
        value={form.variables}
        onChange={(e) => setForm({ ...form, variables: e.target.value })}
        placeholder="first_name, business_name"
      />
      <p className="mb-3 text-xs text-slate-550">
        Maps to the template's positional body parameters ({"{{1}}"}, {"{{2}}"}, …) in this order.
      </p>

      <label className="label">Quick-reply button labels (comma-separated, max 10)</label>
      <input
        className="input mb-3"
        value={form.buttonLabels}
        onChange={(e) => setForm({ ...form, buttonLabels: e.target.value })}
        placeholder="Interested, Not Interested"
      />

      {mut.error && <ErrorNote error={mut.error} />}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={mut.isPending}>
          {mut.isPending ? "Saving…" : template ? "Save changes" : "Create"}
        </button>
      </div>
    </form>
  );
}
