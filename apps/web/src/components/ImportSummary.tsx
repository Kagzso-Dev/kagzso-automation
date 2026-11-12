// The summary after a bulk file import (Contacts, WhatsApp Contacts, AI Call Customers): rows in
// the file, the most one import takes, what was imported, and what was left out. A file over the
// limit is not refused: its first rows are imported and the rest are reported here, never
// dropped silently.

import type { ReactNode } from "react";
import { fullNumber } from "../lib/numberFormat";
import { Icon } from "./icons";

/** imported + failed + duplicates = selectedRows; selectedRows + skippedOverLimit = totalRows. */
export interface ImportCounts {
  /** Data rows in the uploaded file. */
  totalRows: number;
  /** The most rows one import takes. */
  maxRows: number;
  /** Rows taken for this import: the first maxRows, in file order. */
  selectedRows: number;
  imported: number;
  failed: number;
  duplicates: number;
  /** Rows after the limit. Not imported. */
  skippedOverLimit: number;
}

type Tone = "ok" | "warn" | "crit" | "neutral";
const TONE_CLASS: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", crit: "text-crit", neutral: "text-ink" };

export interface ExtraCount {
  label: string;
  value: number;
  tone?: Tone;
}

const n = (v: number) => fullNumber.format(v);
const rowsText = (v: number) => `${n(v)} row${v === 1 ? "" : "s"}`;

function Count({ label, value, tone = "neutral" }: ExtraCount) {
  return (
    <div className="flex flex-col-reverse rounded-lg border border-line px-3 py-2">
      <dt className="text-xs text-slate-550">{label}</dt>
      <dd className={`text-xl font-semibold ${TONE_CLASS[tone]}`}>{n(value)}</dd>
    </div>
  );
}

export function ImportCountsSummary({ counts, extra = [], details }: { counts: ImportCounts; extra?: ExtraCount[]; details?: ReactNode }) {
  const c = counts;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Import summary">
        <Count label="Uploaded" value={c.totalRows} />
        <Count label="Maximum allowed" value={c.maxRows} />
        <Count label="Selected for import" value={c.selectedRows} />
        <Count label="Successfully imported" value={c.imported} tone="ok" />
        <Count label="Failed" value={c.failed} tone={c.failed > 0 ? "crit" : "neutral"} />
        <Count label="Duplicates" value={c.duplicates} tone={c.duplicates > 0 ? "warn" : "neutral"} />
        <Count label="Skipped due to limit" value={c.skippedOverLimit} tone={c.skippedOverLimit > 0 ? "warn" : "neutral"} />
        {extra.map((e) => (
          <Count key={e.label} {...e} />
        ))}
      </dl>
      {details && <p className="mt-2 text-xs text-slate-550">{details}</p>}
      {c.skippedOverLimit > 0 && (
        <div className="mt-3">
          <OverLimitNote totalRows={c.totalRows} maxRows={c.maxRows} skippedOverLimit={c.skippedOverLimit} imported />
        </div>
      )}
    </div>
  );
}

/**
 * A file with more rows than one import takes: how many rows are left out, and how to import
 * them. `imported`: worded for after the import; otherwise for before it.
 */
export function OverLimitNote({
  totalRows,
  maxRows,
  skippedOverLimit,
  imported = false,
}: {
  totalRows: number;
  maxRows: number;
  skippedOverLimit: number;
  imported?: boolean;
}) {
  if (skippedOverLimit <= 0) return null;
  const one = skippedOverLimit === 1;
  const them = one ? "it" : "them";
  return (
    <p role="note" className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
      This file has {rowsText(totalRows)} and one import takes up to {n(maxRows)}, so only the first {rowsText(maxRows)}{" "}
      {imported ? "were used" : "will be used"}. The last {rowsText(skippedOverLimit)}{" "}
      {imported ? (
        <>
          {one ? "was" : "were"} <b>not imported</b>. To import {them}, upload {them} in a separate file.
        </>
      ) : (
        <>
          will <b>not be imported</b>. Upload {them} in a separate file afterwards.
        </>
      )}
    </p>
  );
}

/** A page-level import summary with a dismiss button (Contacts, WhatsApp Contacts). */
export function ImportSummaryCard({ title, onDismiss, children }: { title: string; onDismiss: () => void; children: ReactNode }) {
  return (
    <section className="card mb-4" aria-label={title}>
      <div className="mb-3 flex items-start justify-between gap-4">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss import summary"
          className="-m-1.5 grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-tint hover:text-ink"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {children}
    </section>
  );
}
