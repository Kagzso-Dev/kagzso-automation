import { parse as parseCsv } from "csv-parse/sync";
import { toContactPhone } from "@dispatch/shared";
import ExcelJS from "exceljs";
// pdf-parse's package entry runs a debug block when required as the main module;
// the lib path is the plain function with no side effects.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { readFile } from "node:fs/promises";
import { applyImportLimit, hasData, IMPORT_MAX_ROWS, streamedLimit, type ImportLimit } from "./importLimit.js";
import { ImportFileError, streamCsvRows, streamXlsxRows } from "./importStream.js";

/** Files up to this size are read into memory, exactly as before; bigger ones are streamed (a pdf can't be). */
export const CONTACT_FILE_IN_MEMORY_BYTES = 10 * 1024 * 1024;

const CSV_OPTIONS = { columns: true, skip_empty_lines: true, trim: true } as const;

export interface ParsedContact {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  businessName?: string;
  customFields: Record<string, string>;
}

export type ImportFormat = "csv" | "xlsx" | "pdf";

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Column header → canonical field. Everything unmatched becomes a customField. */
const HEADER_ALIASES: Record<string, keyof Omit<ParsedContact, "customFields">> = {
  email: "email",
  "email address": "email",
  "e-mail": "email",
  firstname: "firstName",
  "first name": "firstName",
  first: "firstName",
  first_name: "firstName",
  lastname: "lastName",
  "last name": "lastName",
  last: "lastName",
  last_name: "lastName",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  telephone: "phone",
  business: "businessName",
  "business name": "businessName",
  company: "businessName",
  "company name": "businessName",
  organisation: "businessName",
  organization: "businessName",
};

export function formatFromFilename(filename: string): ImportFormat | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "xlsx") return "xlsx";
  if (ext === "pdf") return "pdf";
  return null;
}

/**
 * Phone in email-contact format (shared rules): Indian numbers as 10 digits,
 * other countries as E.164 "+…". No country code = India. Undefined if invalid.
 */
export function normalizePhone(raw: string): string | undefined {
  const r = toContactPhone(raw);
  return r.ok ? r.phone : undefined;
}

/** Every distinct email address found in free text, lowercased. */
export function extractEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.match(EMAIL_RE) ?? []) seen.add(m.toLowerCase());
  return [...seen];
}

/** Turn header-keyed rows into ParsedContact records. Rows with no `@` are dropped. */
export function rowsToContacts(rows: Record<string, unknown>[]): ParsedContact[] {
  const out: ParsedContact[] = [];
  for (const row of rows) {
    const contact: ParsedContact = { email: "", customFields: {} };
    for (const [rawKey, rawVal] of Object.entries(row)) {
      const key = String(rawKey).trim().toLowerCase();
      const val = rawVal == null ? "" : String(rawVal).trim();
      if (!val) continue;
      const field = HEADER_ALIASES[key];
      if (field === "email") contact.email = val.toLowerCase();
      else if (field === "phone") {
        const phone = normalizePhone(val);
        if (phone) contact.phone = phone;
      } else if (field) contact[field] = val;
      else contact.customFields[String(rawKey).trim()] = val;
    }
    if (contact.email.includes("@")) out.push(contact);
  }
  return out;
}

async function readXlsxRows(buf: Buffer): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS ships older Buffer typings than @types/node; a Uint8Array is accepted at runtime.
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
    if ("hyperlink" in v && v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, "");
  }
  return "";
}

export interface ContactFileRead {
  /** Selected rows that have an email address, in file order. */
  contacts: ParsedContact[];
  /** Selected rows without an email address. Not imported. */
  noEmail: number;
  /** Rows in the file, and how many were taken (the first maxRows) or left for another file. */
  limit: ImportLimit;
}

/**
 * Read an import file. Only the first `maxRows` data rows (a pdf: distinct email addresses, in
 * the order they appear) are taken; `limit` counts the rest. Rows without an email are counted
 * in `noEmail`, not dropped silently.
 */
export async function parseContactFile(
  buf: Buffer,
  format: ImportFormat,
  maxRows: number = IMPORT_MAX_ROWS,
): Promise<ContactFileRead> {
  if (format === "pdf") {
    const { text } = await pdfParse(buf);
    const { rows: emails, limit } = applyImportLimit(extractEmails(text), maxRows);
    return { contacts: emails.map((email) => ({ email, customFields: {} })), noEmail: 0, limit };
  }
  const all =
    format === "csv"
      ? (parseCsv(buf.toString("utf8"), CSV_OPTIONS) as Record<string, string>[])
      : await readXlsxRows(buf);
  const { rows, limit } = applyImportLimit(all.filter(hasData), maxRows);
  const contacts = rowsToContacts(rows);
  return { contacts, noEmail: rows.length - contacts.length, limit };
}

/**
 * Read an uploaded import file from disk. Up to CONTACT_FILE_IN_MEMORY_BYTES: parseContactFile,
 * as before. Bigger csv / xlsx files are streamed: the first `maxRows` rows are kept and the rest
 * only counted, whatever the size. A bigger pdf is refused (it can only be read whole).
 */
export async function parseContactUpload(
  path: string,
  size: number,
  format: ImportFormat,
  maxRows: number = IMPORT_MAX_ROWS,
): Promise<ContactFileRead> {
  if (size <= CONTACT_FILE_IN_MEMORY_BYTES) return parseContactFile(await readFile(path), format, maxRows);
  if (format === "pdf") {
    throw new ImportFileError("A PDF can be up to 10 MB. Save the list as .csv or .xlsx (any size up to 500 MB), or split the PDF.");
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
  const contacts = rowsToContacts(rows);
  return { contacts, noEmail: rows.length - contacts.length, limit: streamedLimit(rows.length, counted, maxRows) };
}
