// Row limit for bulk file imports. A file with more data rows than the limit is not refused: the
// first rows, in file order, are imported with the usual checks, and the rest are counted and
// reported (skippedOverLimit) so they can be uploaded in another file. Never dropped silently.
// No email / WhatsApp dependencies, so every import module can use it.

/**
 * The most data rows one bulk import takes: Contacts, WhatsApp Contacts and AI Call Customers.
 * (AI calls from a file and Data Quality uploads keep AI_CALL_IMPORT_MAX_ROWS, 5,000.)
 */
export const IMPORT_MAX_ROWS = 1000;

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

/**
 * Counts for a file read as a stream (importStream.ts): `kept` rows of the first maxRows, out of
 * `counted` rows in the file. A kept row found blank only once its text was read is not counted.
 */
export function streamedLimit(kept: number, counted: number, maxRows: number): ImportLimit {
  const skippedOverLimit = Math.max(0, counted - maxRows);
  return { totalRows: kept + skippedOverLimit, maxRows, selectedRows: kept, skippedOverLimit };
}

/** True when the row has at least one non-blank value. A blank row is not a record. */
export function hasData(row: Record<string, unknown>): boolean {
  return Object.values(row).some((v) => v != null && String(v).trim() !== "");
}
