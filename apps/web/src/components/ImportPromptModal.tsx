import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CallFlowImportPreview, CallFlowImportResult, CallFlowImportSection } from "@dispatch/shared";
import { api } from "../lib/api";
import { Badge, ErrorNote, Modal } from "./ui";

/**
 * "Import full prompt" (Voice Call Flows editor, admins): paste a whole prompt, see how it splits
 * into this flow's blocks (import-preview saves nothing), change any target or Skip it, then
 * "Apply to new draft". Never publishes. Undo discards the new draft, or for a never-published flow
 * saves the previous text back.
 */

const STATUS: Record<CallFlowImportSection["status"], { label: string; tone: "ok" | "neutral" | "warn" | "crit" }> = {
  matched: { label: "Matched", tone: "ok" },
  unchanged: { label: "Unchanged", tone: "neutral" },
  unmatched: { label: "Unmatched", tone: "warn" },
  skipped: { label: "Skipped", tone: "neutral" },
  locked: { label: "Locked/ignored", tone: "neutral" },
  too_long: { label: "Too long", tone: "crit" },
  unknown_variable: { label: "Unknown variable", tone: "crit" },
  rendered_value: { label: "Rendered value", tone: "crit" },
  invalid: { label: "Invalid", tone: "crit" },
};

export function ImportPromptModal({
  open,
  onClose,
  flowId,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  flowId: string;
  /** Reload the editor after an apply or an undo. */
  onChanged: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [strip, setStrip] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [confirmDnc, setConfirmDnc] = useState(false);
  const [preview, setPreview] = useState<CallFlowImportPreview | null>(null);
  const [result, setResult] = useState<CallFlowImportResult | null>(null);
  const [undone, setUndone] = useState(false);

  const analyze = useMutation({
    mutationFn: (m: Record<string, string>) =>
      api<CallFlowImportPreview>(`/api/call-flows/${flowId}/import-preview`, {
        method: "POST",
        json: { prompt, stripSpokenMarkdown: strip, mapping: m },
        notify: false,
      }),
    onSuccess: setPreview,
  });
  const apply = useMutation({
    mutationFn: () =>
      api<CallFlowImportResult>(`/api/call-flows/${flowId}/import-apply`, {
        method: "POST",
        json: { prompt, stripSpokenMarkdown: strip, mapping, confirmDncWarning: confirmDnc },
        notify: false,
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.changed) onChanged();
    },
  });
  const undo = useMutation({
    mutationFn: (u: NonNullable<CallFlowImportResult["undo"]>) =>
      u.kind === "discard"
        ? api(`/api/call-flows/${flowId}/draft`, { method: "DELETE", notify: "Import undone" })
        : api(`/api/call-flows/${flowId}/draft`, { method: "PUT", json: { definition: u.definition }, notify: "Import undone" }),
    onSuccess: () => {
      setUndone(true);
      onChanged();
    },
  });

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setStrip(false);
    setMapping({});
    setConfirmDnc(false);
    setPreview(null);
    setResult(null);
    setUndone(false);
    analyze.reset();
    apply.reset();
    undo.reset();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const remap = (index: number, target: string) => {
    const next = { ...mapping, [String(index)]: target };
    setMapping(next);
    analyze.mutate(next);
  };
  const busy = analyze.isPending || apply.isPending;
  const canApply =
    !!preview && preview.changed && preview.blocking.length === 0 && !preview.draftConflict && (!preview.dncWarning || confirmDnc);

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Import full prompt" wide>
      {result ? (
        <div className="space-y-3 text-sm">
          {result.changed ? (
            <p>
              Saved as <b>draft v{result.version}</b>. Nothing was published: test it, then Publish in the editor.
            </p>
          ) : (
            <p>No changes: the prompt already matches this flow.</p>
          )}
          <ul className="grid gap-2 sm:grid-cols-4">
            {(
              [
                ["Blocks updated", result.summary.updated],
                ["Blocks unchanged", result.summary.unchanged],
                ["Sections skipped", result.summary.skipped],
                ["Sections unmatched", result.summary.unmatched],
              ] as const
            ).map(([label, n]) => (
              <li key={label} className="rounded-lg border border-line/70 px-3 py-2">
                <div className="text-lg font-semibold">{n}</div>
                <div className="text-xs text-slate-550">{label}</div>
              </li>
            ))}
          </ul>
          {result.changedBlocks.length > 0 && (
            <p className="text-xs text-slate-550">Updated: {result.changedBlocks.join(", ")}</p>
          )}
          {undo.error && <ErrorNote error={undo.error} />}
          <div className="flex justify-end gap-2 pt-1">
            {result.undo && !undone && (
              <button type="button" className="btn-ghost" disabled={undo.isPending} onClick={() => undo.mutate(result.undo!)}>
                {undo.isPending ? "Undoing…" : "Undo"}
              </button>
            )}
            {undone && <span className="self-center text-xs text-slate-550">Undone: the previous version is back.</span>}
            <button type="button" className="btn-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <label className="label" htmlFor="import-prompt">
              Paste the whole prompt
            </label>
            <textarea
              id="import-prompt"
              className="input h-56 font-mono text-xs"
              value={prompt}
              disabled={busy}
              onChange={(e) => {
                setPrompt(e.target.value);
                setPreview(null);
                setMapping({});
              }}
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-550">
              <input
                type="checkbox"
                checked={strip}
                disabled={busy}
                onChange={(e) => {
                  setStrip(e.target.checked);
                  setPreview(null);
                }}
              />
              Remove ** and backticks from quoted spoken lines (lines starting with &gt;)
            </label>
          </div>

          {analyze.error && <ErrorNote error={analyze.error} />}
          {preview && <ImportPreviewTable preview={preview} disabled={busy} onRemap={remap} />}
          {preview?.dncWarning && (
            <label className="flex items-start gap-2 rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-xs text-crit">
              <input type="checkbox" className="mt-0.5" checked={confirmDnc} onChange={(e) => setConfirmDnc(e.target.checked)} />
              The DO NOT CALL block would no longer say to end the call when the customer asks not to be called. I understand
              and want to save it anyway.
            </label>
          )}
          {apply.error && <ErrorNote error={apply.error} />}

          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn-ghost" disabled={busy || !prompt.trim()} onClick={() => analyze.mutate(mapping)}>
              {analyze.isPending ? "Analyzing…" : "Analyze"}
            </button>
            <button type="button" className="btn-primary" disabled={busy || !canApply} onClick={() => apply.mutate()}>
              {apply.isPending ? "Applying…" : "Apply to new draft"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ImportPreviewTable({
  preview,
  disabled,
  onRemap,
}: {
  preview: CallFlowImportPreview;
  disabled: boolean;
  onRemap: (index: number, target: string) => void;
}) {
  const over = preview.sizeAfter > preview.warnAboveChars;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-surface-muted px-3 py-2 text-xs">
        <span>
          Prompt size: {preview.sizeBefore.toLocaleString()} → <b>{preview.sizeAfter.toLocaleString()}</b> characters
        </span>
        <span>
          {preview.summary.updated} to update · {preview.summary.unchanged} unchanged · {preview.summary.unmatched} unmatched ·{" "}
          {preview.summary.skipped} skipped · {preview.summary.locked} locked
        </span>
      </div>
      {over && (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          The prompt would be over {preview.warnAboveChars.toLocaleString()} characters. Long prompts make every reply slower.
        </p>
      )}
      {preview.draftConflict && (
        <p className="rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-xs text-crit">{preview.draftConflict}</p>
      )}
      {preview.blocking.length > 0 && (
        <div className="rounded-lg border border-crit-line bg-crit-soft px-3 py-2 text-xs text-crit">
          <div className="font-semibold">Fix or skip these sections before applying:</div>
          {preview.blocking.map((b, i) => (
            <div key={i}>{b}</div>
          ))}
        </div>
      )}

      <ul className="divide-y divide-line/70 rounded-lg border border-line/70">
        {preview.sections.map((s) => {
          const st = STATUS[s.status];
          const lockedRow = s.status === "locked";
          return (
            <li key={s.index} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block truncate font-medium" title={s.heading}>
                    {s.index + 1}. {s.heading}
                  </span>
                  <span className="block text-[11px] text-slate-550">
                    {s.chars.toLocaleString()} characters
                    {s.target && !s.manual && s.confidence < 1 ? ` · match ${Math.round(s.confidence * 100)}%` : ""}
                    {s.manual ? " · chosen by you" : ""}
                  </span>
                </span>
                {!lockedRow && (
                  <select
                    className="input h-8 w-auto max-w-[16rem] py-0 text-xs"
                    aria-label={`Target block for section ${s.index + 1}`}
                    disabled={disabled}
                    value={s.status === "skipped" ? "skip" : (s.target ?? "")}
                    onChange={(e) => onRemap(s.index, e.target.value || "skip")}
                  >
                    {!s.target && s.status !== "skipped" && <option value="">Choose a block…</option>}
                    <option value="skip">Skip</option>
                    {preview.targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                )}
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              {s.issues.map((m, i) => (
                <p key={`i${i}`} className={`text-xs ${lockedRow || s.status === "unmatched" ? "text-slate-550" : "text-crit"}`}>
                  {m}
                </p>
              ))}
              {s.warnings.map((m, i) => (
                <p key={`w${i}`} className="text-xs text-warn">
                  Warning: {m}
                </p>
              ))}
              {s.stripped.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-550">Removed markdown in {s.stripped.length} spoken line(s)</summary>
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                    {s.stripped.map((line, i) => (
                      <li key={i} className="break-words">
                        {line}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {s.diff && (s.diff.removed.length > 0 || s.diff.added.length > 0) && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-550">Show the change</summary>
                  <pre className="scroll-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-muted p-2 font-mono text-[11px] leading-relaxed">
                    {s.diff.removed.map((l) => `- ${l}`).join("\n")}
                    {s.diff.removed.length && s.diff.added.length ? "\n" : ""}
                    {s.diff.added.map((l) => `+ ${l}`).join("\n")}
                    {s.diff.more ? `\n… ${s.diff.more} more changed line(s)` : ""}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
