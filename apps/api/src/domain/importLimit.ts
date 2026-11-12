// Row limit for bulk file imports. A file with more data rows than the limit is not refused: the
// first rows, in file order, are imported with the usual checks, and the rest are counted and
// reported (skippedOverLimit) so they can be uploaded in another file. Never dropped silently.
// No email / WhatsApp dependencies, so every import module can use it.

/**
 * The most data rows one Contacts or WhatsApp Contacts import takes. The same number as the
 * AI call customer import (AI_CALL_IMPORT_MAX_ROWS, which keeps its own constant).
 */
export const IMPORT_MAX_ROWS = 5000;

export interface ImportLimit {
  /** Data rows in the file. Blank rows are not counted. */
  totalRows: number;
  /** The most rows one import takes. */
  maxRows: number;
  /** Rows taken for this import: the first maxRows, in file order. */
  selectedRows: number;
  /** Rows after the limit. Not imported; upload them in another file. */
  skippedOverLimit: number;
}

/** The first `maxRows` rows, in their original order, and the counts for the import summary. */
export function applyImportLimit<T>(rows: readonly T[], maxRows: number = IMPORT_MAX_ROWS): { rows: T[]; limit: ImportLimit } {
  const selected = rows.slice(0, maxRows);
  return {
    rows: selected,
    limit: {
      totalRows: rows.length,
      maxRows,
      selectedRows: selected.length,
      skippedOverLimit: rows.length - selected.length,
    },
  };
}

/** True when the row has at least one non-blank value. A blank row is not a record. */
export function hasData(row: Record<string, unknown>): boolean {
  return Object.values(row).some((v) => v != null && String(v).trim() !== "");
}
