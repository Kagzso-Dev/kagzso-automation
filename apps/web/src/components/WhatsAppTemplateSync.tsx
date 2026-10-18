import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useToast } from "./toast";
import { Badge, ErrorNote, Modal, Spinner, type BadgeTone } from "./ui";
import { useBranding } from "../lib/branding";

/**
 * Meta → Dispatch: templates that exist in Meta (WhatsApp Manager) but aren't
 * registered here yet (imported as new rows), and registered templates whose
 * Meta version changed (body / variables / buttons follow Meta when picked).
 * Nothing changes until the admin applies the picked rows.
 */

export interface SyncCandidate {
  name: string;
  language: string;
  status: string | null;
  category: string | null;
  importable: boolean;
  reason: string | null;
  warnings: string[];
  displayName: string | null;
}

export interface SyncUpdate {
  id: string;
  name: string;
  providerTemplateName: string;
  languageCode: string;
  status: string | null;
  changes: string[];
  updatable: boolean;
  reason: string | null;
  warnings: string[];
  metaBody: string | null;
  metaButtons: string[];
}

const STATUS_TONE: Record<string, BadgeTone> = { APPROVED: "ok", PENDING: "warn", IN_APPEAL: "warn", REJECTED: "crit", PAUSED: "crit", DISABLED: "crit" };
const k = (c: { name: string; language: string }) => `${c.name}|${c.language}`;

/** Checked automatically when an admin opens the templates page (Meta's list is read, nothing changes). */
export function useMetaSyncCandidates(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp-meta-sync"],
    queryFn: () => api<{ items: SyncCandidate[] }>("/api/whatsapp/templates/meta-sync"),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function MetaSyncModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Sync templates from Meta" wide>
      {open && <SyncBody onClose={onClose} />}
    </Modal>
  );
}

function SyncBody({ onClose }: { onClose: () => void }) {
  const { appName } = useBranding();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useMetaSyncCandidates(true);
  const changed = useQuery({
    queryKey: ["whatsapp-meta-sync-updates"],
    queryFn: () => api<{ items: SyncUpdate[] }>("/api/whatsapp/templates/meta-sync/updates"),
    retry: false,
  });
  const items = list.data?.items ?? [];
  const updates = changed.data?.items ?? [];
  const importable = items.filter((c) => c.importable);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedUpdates, setPickedUpdates] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set(importable.map(k))), [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPickedUpdates(new Set(updates.filter((u) => u.updatable).map((u) => u.id))), [changed.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = picked.size + pickedUpdates.size;

  const run = useMutation({
    mutationFn: async () => {
      const imp = picked.size
        ? await api<{ imported: { name: string }[]; skipped: { name: string; reason: string }[] }>("/api/whatsapp/templates/meta-sync", {
            method: "POST",
            json: { templates: items.filter((c) => picked.has(k(c))).map(({ name, language }) => ({ name, language })) },
            notify: false,
          })
        : { imported: [], skipped: [] };
      const upd = pickedUpdates.size
        ? await api<{ updated: { name: string }[]; skipped: { name: string; reason: string }[] }>("/api/whatsapp/templates/meta-sync/updates", {
            method: "POST",
            json: { ids: [...pickedUpdates] },
            notify: false,
          })
        : { updated: [], skipped: [] };
      return { imp, upd };
    },
    onSuccess: ({ imp, upd }) => {
      const parts = [
        ...(imp.imported.length ? [`${imp.imported.length} imported`] : []),
        ...(upd.updated.length ? [`${upd.updated.length} updated`] : []),
      ];
      toast.success(
        parts.length ? `Templates synced from Meta: ${parts.join(", ")}` : "Nothing changed",
        [...imp.skipped, ...upd.skipped].map((s) => `${s.name}: ${s.reason}`),
      );
      void qc.invalidateQueries({ queryKey: ["whatsapp-templates"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp-template-verify"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp-meta-sync"] });
      void qc.invalidateQueries({ queryKey: ["whatsapp-meta-sync-updates"] });
      onClose();
    },
  });

  if (list.isLoading || changed.isLoading) return <Spinner />;
  if (list.error) return <ErrorNote error={list.error} />;
  if (changed.error) return <ErrorNote error={changed.error} />;
  if (items.length === 0 && updates.length === 0) {
    return (
      <div>
        <p className="text-sm text-slate-550">Every template in your WhatsApp Business Account is registered here and matches Meta.</p>
        <div className="mt-4 flex justify-end">
          <button className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {items.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">New in Meta</h3>
          <p className="mb-3 text-sm text-slate-550">
            These templates exist in Meta but not in {appName}. Importing adds them with the exact Meta name and language;{" "}
            <code>{"{{1}}"}</code> is filled with the contact's first name and <code>{"{{2}}"}</code> with the business name.
          </p>
          <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-line">
            <table className="table-soft w-full min-w-[36rem] text-sm">
              <thead className="sticky top-0 z-10 bg-surface-sunken">
                <tr className="border-b border-line text-left text-xs uppercase tracking-[0.06em] text-slate-550">
                  <th className="px-3 py-2" />
                  <th className="px-3 py-2">Meta template</th>
                  <th className="px-3 py-2">Language</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={k(c)} className={`border-b border-line-subtle last:border-0 ${c.importable ? "" : "opacity-60"}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Import ${c.name}`}
                        disabled={!c.importable}
                        checked={picked.has(k(c))}
                        onChange={(e) =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(k(c));
                            else next.delete(k(c));
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{c.name}</div>
                      {c.displayName && <div className="text-xs text-slate-550">as “{c.displayName}”</div>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{c.language}</td>
                    <td className="px-3 py-2">
                      {c.status && <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status.toLowerCase()}</Badge>}
                      {c.category && <div className="mt-0.5 text-[11px] text-slate-400">{c.category}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {c.reason && <div className="text-crit">{c.reason}</div>}
                      {c.warnings.map((w) => (
                        <div key={w} className="text-warn">
                          {w}
                        </div>
                      ))}
                      {!c.reason && c.warnings.length === 0 && <span className="text-slate-550">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {updates.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">Changed in Meta</h3>
          <p className="mb-3 text-sm text-slate-550">
            These templates are registered here, but their Meta version is different. Updating copies Meta's body, variables and
            buttons; the name in {appName}, which field fills each variable, and send history stay as they are.
          </p>
          <ul className="max-h-[40vh] space-y-2 overflow-y-auto">
            {updates.map((u) => (
              <li key={u.id} className={`rounded-lg border border-line px-3 py-2.5 text-sm ${u.updatable ? "" : "opacity-60"}`}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Update ${u.name} from Meta`}
                    disabled={!u.updatable}
                    checked={pickedUpdates.has(u.id)}
                    onChange={(e) =>
                      setPickedUpdates((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{u.name}</span>{" "}
                    <span className="font-mono text-xs text-slate-550">
                      {u.providerTemplateName} · {u.languageCode}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      {u.status && <Badge tone={STATUS_TONE[u.status] ?? "neutral"}>{u.status.toLowerCase()}</Badge>}
                      {u.changes.map((c) => (
                        <Badge key={c} tone="warn">
                          {c} changed
                        </Badge>
                      ))}
                    </span>
                    {u.reason && <span className="mt-1 block text-xs text-crit">{u.reason}</span>}
                    {u.warnings.map((w) => (
                      <span key={w} className="mt-1 block text-xs text-warn">
                        {w}
                      </span>
                    ))}
                  </span>
                </label>
                {u.metaBody !== null && (
                  <details className="mt-2 pl-6">
                    <summary className="cursor-pointer text-xs text-accent-ink">Meta's version</summary>
                    <div className="mt-1 whitespace-pre-wrap break-words rounded bg-surface-muted px-2.5 py-2 text-xs">{u.metaBody}</div>
                    {u.metaButtons.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {u.metaButtons.map((b) => (
                          <Badge key={b} tone="neutral">
                            {b}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.error && <ErrorNote error={run.error} />}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={total === 0 || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Syncing…" : `Sync ${total} template${total === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
