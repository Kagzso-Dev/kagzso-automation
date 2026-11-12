import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { applyImportLimit, hasData, IMPORT_MAX_ROWS } from "../src/domain/importLimit.js";
import { parseContactFile } from "../src/domain/contactImport.js";
import { parseWhatsAppContactFile } from "../src/domain/whatsappImport.js";
import { AI_CALL_IMPORT_MAX_ROWS, readAiCallSheet } from "../src/domain/aiCallImport.js";

// Import row limit: a file over the limit is not refused. The first rows, in file order, are
// read for the import; the rest are counted (skippedOverLimit), never dropped silently. Files
// below, at and above the real limit (5,000), as csv and xlsx, for every bulk import.

const LIMIT = 5000;
const SIZES: [number, number, number][] = [
  // rows in the file, rows taken, rows skipped over the limit
  [LIMIT - 1, LIMIT - 1, 0],
  [LIMIT, LIMIT, 0],
  [LIMIT + 1, LIMIT, 1],
];

const email = (i: number) => `user${i}@example.com`;
const phone = (i: number) => `+91 9${String(i).padStart(9, "0")}`;
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

const csv = (header: string, lines: string[]) => Buffer.from([header, ...lines].join("\n") + "\n");
async function xlsx(header: string[], rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("applyImportLimit", () => {
  it("the configured limits: 5,000 rows per import (Contacts / WhatsApp Contacts, and AI Call Customers' own)", () => {
    expect(IMPORT_MAX_ROWS).toBe(LIMIT);
    expect(AI_CALL_IMPORT_MAX_ROWS).toBe(LIMIT);
  });

  it("below the limit: every row, nothing skipped", () => {
    expect(applyImportLimit([1, 2, 3], 5)).toEqual({
      rows: [1, 2, 3],
      limit: { totalRows: 3, maxRows: 5, selectedRows: 3, skippedOverLimit: 0 },
    });
  });

  it("at the limit: every row, nothing skipped", () => {
    expect(applyImportLimit([1, 2, 3, 4, 5], 5).limit).toEqual({ totalRows: 5, maxRows: 5, selectedRows: 5, skippedOverLimit: 0 });
  });

  it("above the limit: the first rows in file order; the rest are counted, not dropped", () => {
    // The example: 2,000 uploaded, 1,000 allowed → the first 1,000 taken, 1,000 skipped.
    const rows = range(2000);
    const { rows: taken, limit } = applyImportLimit(rows, 1000);
    expect(taken).toEqual(range(1000));
    expect(limit).toEqual({ totalRows: 2000, maxRows: 1000, selectedRows: 1000, skippedOverLimit: 1000 });
  });

  it("an empty file: nothing taken, nothing skipped", () => {
    expect(applyImportLimit([]).limit).toEqual({ totalRows: 0, maxRows: LIMIT, selectedRows: 0, skippedOverLimit: 0 });
  });

  it("a blank row is not a record", () => {
    expect(hasData({ a: "", b: "  " })).toBe(false);
    expect(hasData({})).toBe(false);
    expect(hasData({ a: "", b: "x" })).toBe(true);
  });
});

describe("Contacts → Import file (email)", () => {
  it.each(SIZES)("csv with %i rows: %i taken, %i skipped over the limit", async (n, taken, skipped) => {
    const { contacts, noEmail, limit } = await parseContactFile(csv("email,first name", range(n).map((i) => `${email(i)},N${i}`)), "csv");
    expect(limit).toEqual({ totalRows: n, maxRows: LIMIT, selectedRows: taken, skippedOverLimit: skipped });
    expect(contacts).toHaveLength(taken);
    expect(noEmail).toBe(0);
    // File order: the first rows, never a row after the limit.
    expect(contacts[0]!.email).toBe(email(1));
    expect(contacts.at(-1)!.email).toBe(email(taken));
    expect(contacts.some((c) => c.email === email(LIMIT + 1))).toBe(false);
  });

  it("xlsx above the limit: the first 5,000 rows, in order", async () => {
    const buf = await xlsx(["Email", "First Name"], range(LIMIT + 1).map((i) => [email(i), `N${i}`]));
    const { contacts, limit } = await parseContactFile(buf, "xlsx");
    expect(limit).toEqual({ totalRows: LIMIT + 1, maxRows: LIMIT, selectedRows: LIMIT, skippedOverLimit: 1 });
    expect(contacts.map((c) => c.email)).toEqual(range(LIMIT).map(email));
  });

  it("a row without an email takes its place in the limit and is counted, not dropped silently", async () => {
    const file = csv("email,first name", ["a@x.com,A", ",NoEmail", "b@x.com,B", "c@x.com,C"]);
    const { contacts, noEmail, limit } = await parseContactFile(file, "csv", 3);
    expect(contacts.map((c) => c.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(noEmail).toBe(1);
    expect(limit).toEqual({ totalRows: 4, maxRows: 3, selectedRows: 3, skippedOverLimit: 1 });
  });

  it("blank rows are not counted", async () => {
    const { limit } = await parseContactFile(csv("email,first name", ["a@x.com,A", ",", " , ", "b@x.com,B"]), "csv");
    expect(limit.totalRows).toBe(2);
  });
});

describe("WhatsApp Contacts → Import file", () => {
  it.each(SIZES)("csv with %i rows: %i taken, %i skipped over the limit", async (n, taken, skipped) => {
    const { contacts, noPhone, limit } = await parseWhatsAppContactFile(csv("phone,first name", range(n).map((i) => `${phone(i)},N${i}`)), "csv", "91");
    expect(limit).toEqual({ totalRows: n, maxRows: LIMIT, selectedRows: taken, skippedOverLimit: skipped });
    expect(contacts).toHaveLength(taken);
    expect(noPhone).toBe(0);
    expect(contacts[0]!.phone).toBe("919000000001");
    expect(contacts.at(-1)!.phone).toBe(`919${String(taken).padStart(9, "0")}`);
  });

  it("xlsx above the limit: the first 5,000 rows, in order", async () => {
    const buf = await xlsx(["Phone", "First Name"], range(LIMIT + 1).map((i) => [phone(i), `N${i}`]));
    const { contacts, limit } = await parseWhatsAppContactFile(buf, "xlsx", "91");
    expect(limit).toEqual({ totalRows: LIMIT + 1, maxRows: LIMIT, selectedRows: LIMIT, skippedOverLimit: 1 });
    expect(contacts.at(-1)!.phone).toBe(`919${String(LIMIT).padStart(9, "0")}`);
  });

  it("a row without a usable number takes its place in the limit and is counted, not dropped silently", async () => {
    const file = csv("phone,first name", ["+919000000001,A", "12345,Bad", ",NoPhone", "+919000000002,B"]);
    const { contacts, noPhone, limit } = await parseWhatsAppContactFile(file, "csv", "91", 3);
    expect(contacts.map((c) => c.phone)).toEqual(["919000000001"]);
    expect(noPhone).toBe(2);
    expect(limit).toEqual({ totalRows: 4, maxRows: 3, selectedRows: 3, skippedOverLimit: 1 });
  });
});

describe("AI Call Customers → Import (file read)", () => {
  it.each(SIZES)("csv with %i rows: %i rows to import, %i over the limit", async (n, taken, skipped) => {
    const sheet = await readAiCallSheet(csv("customer_name,phone", range(n).map((i) => `C${i},${phone(i)}`)), "csv");
    expect(sheet.rows).toHaveLength(taken);
    expect(sheet.totalRows).toBe(n);
    expect(sheet.maxRows).toBe(LIMIT);
    expect(sheet.totalRows - sheet.rows.length).toBe(skipped);
    expect(sheet.truncated).toBe(skipped > 0);
    expect(sheet.rows[0]!.customer_name).toBe("C1");
    expect(sheet.rows.at(-1)!.customer_name).toBe(`C${taken}`);
  });

  it("xlsx above the limit: the first 5,000 rows, in order", async () => {
    const buf = await xlsx(["customer_name", "phone"], range(LIMIT + 1).map((i) => [`C${i}`, phone(i)]));
    const sheet = await readAiCallSheet(buf, "xlsx");
    expect(sheet.rows).toHaveLength(LIMIT);
    expect({ totalRows: sheet.totalRows, maxRows: sheet.maxRows, truncated: sheet.truncated }).toEqual({ totalRows: LIMIT + 1, maxRows: LIMIT, truncated: true });
    expect(sheet.rows.at(-1)!.customer_name).toBe(`C${LIMIT}`);
  });
});
