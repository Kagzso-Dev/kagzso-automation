// AI-call file reader (csv / xlsx). Returns the sheet as raw header-keyed rows
// so the browser can show a preview and let the user remap columns. Same
// libraries and cell handling as domain/whatsappImport.ts, kept standalone so
// the AI-call module has no email/WhatsApp dependencies.

import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { detectAiCallColumns, type AiCallColumnMapping } from "@dispatch/shared";
import { applyImportLimit, streamedLimit } from "./importLimit.js";
import { streamCsvRows, streamXlsxRows } from "./importStream.js";

export type AiCallImportFormat = "csv" | "xlsx";

/** The default: AI calls from a file and Data Quality uploads. The AI Call Customers import passes IMPORT_MAX_ROWS. */
export const AI_CALL_IMPORT_MAX_ROWS = 5000;

/** AI Call Customers import: files up to this size are read into memory, exactly as before; bigger ones are streamed. */
export const AI_CALL_FILE_IN_MEMORY_BYTES = 5 * 1024 * 1024;

const CSV_OPTIONS = { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true } as const;

export interface AiCallSheet {
  headers: string[];
  /** The first maxRows data rows, in file order. */
  rows: Record<string, string>[];
  mapping: AiCallColumnMapping;
  /** True when the file had more than maxRows data rows. */
  truncated: boolean;
  /** Data rows in the file (blank rows not counted); rows beyond `rows` are not imported. */
  totalRows: number;
  /** The most rows one file gives. */
  maxRows: number;
}

export function aiCallFormatFromFilename(filename: string): AiCallImportFormat | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "xlsx") return "xlsx";
  return null;
}

/** ExcelJS cell values can be strings, numbers, dates, or rich objects. */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  // Long numbers (phones) must not turn into 9.87654321E9.
  if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("text" in v && v.text != null) return String(v.text);
    if ("result" in v && v.result != null) return String(v.result);
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  }
  return "";
}

/** A row with at least one non-blank value. */
const hasText = (r: Record<string, string>) => Object.values(r).some((v) => v.trim() !== "");

function finish(headers: string[], rows: Record<string, string>[], maxRows: number): AiCallSheet {
  const clean = rows.filter(hasText);
  const { rows: selected, limit } = applyImportLimit(clean, maxRows);
  return {
    headers,
    rows: selected,
    mapping: detectAiCallColumns(headers),
    truncated: limit.skippedOverLimit > 0,
    totalRows: limit.totalRows,
    maxRows: limit.maxRows,
  };
}

async function readXlsx(buf: Buffer, maxRows: number): Promise<AiCallSheet> {
  const wb = new ExcelJS.Workbook();
  await (wb.xlsx.load as unknown as (data: Uint8Array) => Promise<unknown>)(buf);
  const ws = wb.worksheets[0];
  if (!ws) return finish([], [], maxRows);

  const byCol = sheetColumns(ws.getRow(1));
  const headers = byCol.filter(Boolean);
  if (headers.length === 0) return finish([], [], maxRows);

  const rows: Record<string, string>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    rows.push(sheetRecord(row, byCol, headers));
  });
  return finish(headers, rows, maxRows);
}

/** Header name by column number (row 1). */
function sheetColumns(row: ExcelJS.Row | undefined): string[] {
  const byCol: string[] = [];
  row?.eachCell({ includeEmpty: false }, (cell, col) => {
    byCol[col] = cellText(cell).trim();
  });
  return byCol;
}

/** One data row with every header ("" when empty). */
function sheetRecord(row: ExcelJS.Row, byCol: string[], headers: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const h of headers) obj[h] = "";
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const header = byCol[col];
    if (header) obj[header] = cellText(cell).trim();
  });
  return obj;
}

/** Header names of a csv: the first record's keys, blanks left out. */
const csvHeaders = (record: Record<string, string>) => Object.keys(record).filter((h) => h.trim() !== "");
const csvRecord = (record: Record<string, string>, headers: string[]) =>
  Object.fromEntries(headers.map((h) => [h, String(record[h] ?? "").trim()]));

function readCsv(buf: Buffer, maxRows: number): AiCallSheet {
  const records = parseCsv(buf.toString("utf8").replace(/^﻿/, ""), CSV_OPTIONS) as Record<string, string>[];
  const headers = records.length > 0 ? csvHeaders(records[0]!) : [];
  return finish(
    headers,
    records.map((r) => csvRecord(r, headers)),
    maxRows,
  );
}

export async function readAiCallSheet(
  buf: Buffer,
  format: AiCallImportFormat,
  maxRows: number = AI_CALL_IMPORT_MAX_ROWS,
): Promise<AiCallSheet> {
  return format === "csv" ? readCsv(buf, maxRows) : readXlsx(buf, maxRows);
}

/**
 * AI Call Customers import: an uploaded file on disk. Up to AI_CALL_FILE_IN_MEMORY_BYTES:
 * readAiCallSheet, as before. Bigger files are streamed: the first `maxRows` rows are kept and the
 * rest only counted, whatever the size.
 */
export async function readAiCallSheetUpload(
  path: string,
  size: number,
  format: AiCallImportFormat,
  maxRows: number,
): Promise<AiCallSheet> {
  if (size <= AI_CALL_FILE_IN_MEMORY_BYTES) return readAiCallSheet(await readFile(path), format, maxRows);
  let headers: string[];
  let rows: Record<string, string>[];
  let counted: number;
  if (format === "csv") {
    const first: { headers?: string[] } = {};
    ({ rows, totalRows: counted } = await streamCsvRows(path, { ...CSV_OPTIONS, bom: true }, maxRows, (r) => {
      first.headers ??= csvHeaders(r);
      const row = csvRecord(r, first.headers);
      return hasText(row) ? row : null;
    }));
    headers = first.headers ?? [];
  } else {
    const sheet = await streamXlsxRows(path, maxRows);
    const byCol = sheetColumns(sheet.header);
    headers = byCol.filter(Boolean);
    rows = headers.length ? sheet.rows.map((r) => sheetRecord(r, byCol, headers)).filter(hasText) : [];
    counted = headers.length ? sheet.totalRows : 0;
  }
  const limit = streamedLimit(rows.length, counted, maxRows);
  return {
    headers,
    rows,
    mapping: detectAiCallColumns(headers),
    truncated: limit.skippedOverLimit > 0,
    totalRows: limit.totalRows,
    maxRows,
  };
}
