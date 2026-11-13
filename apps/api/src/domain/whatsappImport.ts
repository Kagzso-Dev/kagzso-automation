// WhatsApp contact import (csv / xlsx). Standalone — deliberately not shared
// with domain/contactImport.ts so the WhatsApp module has no email dependencies.

import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { normalizeWhatsAppPhone } from "./whatsappPhone.js";
import { applyImportLimit, hasData, IMPORT_MAX_ROWS, streamedLimit, type ImportLimit } from "./importLimit.js";
import { streamCsvRows, streamXlsxRows } from "./importStream.js";

/** Files up to this size are read into memory, exactly as before; bigger ones are streamed. */
export const WHATSAPP_FILE_IN_MEMORY_BYTES = 10 * 1024 * 1024;

const CSV_OPTIONS = { columns: true, skip_empty_lines: true, trim: true } as const;

export type WhatsAppImportFormat = "csv" | "xlsx";

export interface ParsedWhatsAppContact {
  phone: string; // normalised digits
  firstName?: string;
  lastName?: string;
  businessName?: string;
}

/** Column header → canonical field. Anything unmatched is ignored. */
const HEADER_ALIASES: Record<string, keyof ParsedWhatsAppContact> = {
  phone: "phone",
  "phone number": "phone",
  "phone_number": "phone",
  mobile: "phone",
  "mobile number": "phone",
  whatsapp: "phone",
  "whatsapp number": "phone",
  number: "phone",
  firstname: "firstName",
  "first name": "firstName",
  first: "firstName",
  first_name: "firstName",
  lastname: "lastName",
  "last name": "lastName",
  last: "lastName",
  last_name: "lastName",
  business: "businessName",
  "business name": "businessName",
  business_name: "businessName",
  company: "businessName",
  "company name": "businessName",
  organisation: "businessName",
  organization: "businessName",
};

export function formatFromFilename(filename: string): WhatsAppImportFormat | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "xlsx") return "xlsx";
  return null;
}

/**
 * Turn header-keyed rows into ParsedWhatsAppContact records. Rows without a
 * usable phone number are dropped.
 */
export function rowsToWhatsAppContacts(
  rows: Record<string, unknown>[],
  defaultCountryCode?: string,
): ParsedWhatsAppContact[] {
  const out: ParsedWhatsAppContact[] = [];
  for (const row of rows) {
    const rec: Partial<ParsedWhatsAppContact> = {};
    for (const [rawKey, rawVal] of Object.entries(row)) {
      const key = String(rawKey).trim().toLowerCase();
      const val = rawVal == null ? "" : String(rawVal).trim();
      if (!val) continue;
      const field = HEADER_ALIASES[key];
      if (!field) continue;
      if (field === "phone") {
        const phone = normalizeWhatsAppPhone(val, defaultCountryCode);
        if (phone) rec.phone = phone;
      } else {
        rec[field] = val;
      }
    }
    if (rec.phone) out.push({ phone: rec.phone, ...rec } as ParsedWhatsAppContact);
  }
  return out;
}

/** ExcelJS cell values can be strings, numbers, dates, or rich objects. */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("text" in v && v.text != null) return String(v.text);
    if ("result" in v && v.result != null) return String(v.result);
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  }
  return "";
}

async function readXlsxRows(buf: Buffer): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  await (wb.xlsx.load as unknown as (data: Uint8Array) => Promise<unknown>)(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const headers = sheetHeaders(ws.getRow(1));
  if (headers.filter(Boolean).length === 0) return [];

  const rows: Record<string, string>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = sheetRecord(row, headers);
    if (obj) rows.push(obj);
  });
  return rows;
}

/** Header name by column number (row 1). */
function sheetHeaders(row: ExcelJS.Row | undefined): string[] {
  const headers: string[] = [];
  row?.eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col] = cellText(cell).trim();
  });
  return headers;
}

/** One data row keyed by header; null when nothing is under a header. */
function sheetRecord(row: ExcelJS.Row, headers: string[]): Record<string, string> | null {
  const obj: Record<string, string> = {};
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const header = headers[col];
    if (header) obj[header] = cellText(cell);
  });
  return Object.keys(obj).length > 0 ? obj : null;
}

export interface WhatsAppContactFileRead {
  /** Selected rows that have a usable phone number, in file order. */
  contacts: ParsedWhatsAppContact[];
  /** Selected rows without a usable phone number. Not imported. */
  noPhone: number;
  /** Rows in the file, and how many were taken (the first maxRows) or left for another file. */
  limit: ImportLimit;
}

/**
 * Read an import file. Only the first `maxRows` data rows are taken; `limit` counts the rest.
 * Rows without a usable phone number are counted in `noPhone`, not dropped silently.
 */
export async function parseWhatsAppContactFile(
  buf: Buffer,
  format: WhatsAppImportFormat,
  defaultCountryCode?: string,
  maxRows: number = IMPORT_MAX_ROWS,
): Promise<WhatsAppContactFileRead> {
  const all =
    format === "csv"
      ? (parseCsv(buf.toString("utf8"), CSV_OPTIONS) as Record<string, string>[])
      : await readXlsxRows(buf);
  const { rows, limit } = applyImportLimit(all.filter(hasData), maxRows);
  const contacts = rowsToWhatsAppContacts(rows, defaultCountryCode);
  return { contacts, noPhone: rows.length - contacts.length, limit };
}

/**
 * Read an uploaded import file from disk. Up to WHATSAPP_FILE_IN_MEMORY_BYTES:
 * parseWhatsAppContactFile, as before. Bigger files are streamed: the first `maxRows` rows are
 * kept and the rest only counted, whatever the size.
 */
export async function parseWhatsAppContactUpload(
  path: string,
  size: number,
  format: WhatsAppImportFormat,
  defaultCountryCode?: string,
  maxRows: number = IMPORT_MAX_ROWS,
): Promise<WhatsAppContactFileRead> {
  if (size <= WHATSAPP_FILE_IN_MEMORY_BYTES) {
    return parseWhatsAppContactFile(await readFile(path), format, defaultCountryCode, maxRows);
  }
  let rows: Record<string, string>[];
  let counted: number;
  if (format === "csv") {
    ({ rows, totalRows: counted } = await streamCsvRows(path, CSV_OPTIONS, maxRows, (r) => (hasData(r) ? r : null)));
  } else {
    const sheet = await streamXlsxRows(path, maxRows);
    const headers = sheetHeaders(sheet.header);
    rows = sheet.rows.map((r) => sheetRecord(r, headers)).filter((r): r is Record<string, string> => r !== null && hasData(r));
    counted = sheet.totalRows;
  }
  const contacts = rowsToWhatsAppContacts(rows, defaultCountryCode);
  return { contacts, noPhone: rows.length - contacts.length, limit: streamedLimit(rows.length, counted, maxRows) };
}
