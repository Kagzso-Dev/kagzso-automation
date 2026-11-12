// AI-call file reader (csv / xlsx). Returns the sheet as raw header-keyed rows
// so the browser can show a preview and let the user remap columns. Same
// libraries and cell handling as domain/whatsappImport.ts, kept standalone so
// the AI-call module has no email/WhatsApp dependencies.

import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { detectAiCallColumns, type AiCallColumnMapping } from "@dispatch/shared";
import { applyImportLimit } from "./importLimit.js";

export type AiCallImportFormat = "csv" | "xlsx";

export const AI_CALL_IMPORT_MAX_ROWS = 5000;

export interface AiCallSheet {
  headers: string[];
  /** The first AI_CALL_IMPORT_MAX_ROWS data rows, in file order. */
  rows: Record<string, string>[];
  mapping: AiCallColumnMapping;
  /** True when the file had more than AI_CALL_IMPORT_MAX_ROWS data rows. */
  truncated: boolean;
  /** Data rows in the file (blank rows not counted); rows beyond `rows` are not imported. */
  totalRows: number;
  /** The most rows one file gives (AI_CALL_IMPORT_MAX_ROWS). */
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

function finish(headers: string[], rows: Record<string, string>[]): AiCallSheet {
  const clean = rows.filter((r) => Object.values(r).some((v) => v.trim() !== ""));
  const { rows: selected, limit } = applyImportLimit(clean, AI_CALL_IMPORT_MAX_ROWS);
  return {
    headers,
    rows: selected,
    mapping: detectAiCallColumns(headers),
    truncated: limit.skippedOverLimit > 0,
    totalRows: limit.totalRows,
    maxRows: limit.maxRows,
  };
}

async function readXlsx(buf: Buffer): Promise<AiCallSheet> {
  const wb = new ExcelJS.Workbook();
  await (wb.xlsx.load as unknown as (data: Uint8Array) => Promise<unknown>)(buf);
  const ws = wb.worksheets[0];
  if (!ws) return finish([], []);

  const byCol: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    byCol[col] = cellText(cell).trim();
  });
  const headers = byCol.filter(Boolean);
  if (headers.length === 0) return finish([], []);

  const rows: Record<string, string>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, string> = {};
    for (const h of headers) obj[h] = "";
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const header = byCol[col];
      if (header) obj[header] = cellText(cell).trim();
    });
    rows.push(obj);
  });
  return finish(headers, rows);
}

function readCsv(buf: Buffer): AiCallSheet {
  const records = parseCsv(buf.toString("utf8").replace(/^﻿/, ""), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];
  const headers = records.length > 0 ? Object.keys(records[0]!).filter((h) => h.trim() !== "") : [];
  return finish(
    headers,
    records.map((r) => Object.fromEntries(headers.map((h) => [h, String(r[h] ?? "").trim()]))),
  );
}

export async function readAiCallSheet(buf: Buffer, format: AiCallImportFormat): Promise<AiCallSheet> {
  return format === "csv" ? readCsv(buf) : readXlsx(buf);
}
