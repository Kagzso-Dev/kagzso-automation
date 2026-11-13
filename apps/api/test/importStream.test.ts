import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { CONTACT_FILE_IN_MEMORY_BYTES, parseContactFile, parseContactUpload } from "../src/domain/contactImport.js";
import { parseWhatsAppContactFile, parseWhatsAppContactUpload, WHATSAPP_FILE_IN_MEMORY_BYTES } from "../src/domain/whatsappImport.js";
import { AI_CALL_FILE_IN_MEMORY_BYTES, readAiCallSheet, readAiCallSheetUpload } from "../src/domain/aiCallImport.js";
import { ImportFileError } from "../src/domain/importStream.js";

// Big import files (over the size read into memory) are read row by row. The same file must give
// exactly what the in-memory reader gives: the size passed in picks the reader, so small files
// test the streamed one here. Then the limit: only the first 1,000 rows kept, all counted.

const dir = mkdtempSync(join(tmpdir(), "import-stream-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const save = (buf: Buffer, ext: string) => {
  const path = join(dir, `f${++n}.${ext}`);
  writeFileSync(path, buf);
  return path;
};
const BIG = (inMemory: number) => inMemory + 1; // just over: the streamed reader
const xlsxBuffer = async (fill: (wb: ExcelJS.Workbook) => void) => {
  const wb = new ExcelJS.Workbook();
  fill(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const tmpFiles = () => readdirSync(tmpdir()).filter((f) => f.startsWith("tmp-")).length;

/** Numbers, dates, formulas, rich text, links, booleans, Tamil, blank rows, a value under no header, a second sheet. */
const tricky = () =>
  xlsxBuffer((wb) => {
    const ws = wb.addWorksheet("Contacts");
    ws.addRow(["Email", "First Name", "Phone", "Business Name", "Joined", "Score", "Note"]);
    ws.addRow(["ada@x.com", "Ada", 9876543210, "Acme", new Date(Date.UTC(2024, 0, 15)), { formula: "1+1", result: 2 }, { richText: [{ text: "rich " }, { font: { bold: true }, text: "text" }] }]);
    ws.addRow([]);
    ws.addRow([{ text: "grace@x.com", hyperlink: "mailto:grace@x.com" }, "Grace", "+91 98765 43211", "Navy", null, true, "  "]);
    ws.addRow(["tamil@x.com", "தமிழ்செல்வி", "98765 43212", "கடை", null, 3.5, "வணக்கம்"]);
    ws.getCell("J6").value = "under no header";
    ws.addRow(["", "NoEmail", "98765 43213"]);
    wb.addWorksheet("Other").addRow(["not", "imported"]);
  });

describe("the streamed reader gives what the in-memory reader gives", () => {
  it("Contacts: xlsx", async () => {
    const buf = await tricky();
    const before = tmpFiles();
    const streamed = await parseContactUpload(save(buf, "xlsx"), BIG(CONTACT_FILE_IN_MEMORY_BYTES), "xlsx");
    expect(streamed).toEqual(await parseContactFile(buf, "xlsx"));
    expect(streamed.contacts.map((c) => c.email)).toEqual(["ada@x.com", "grace@x.com", "tamil@x.com"]);
    expect(streamed.contacts[2]!.firstName).toBe("தமிழ்செல்வி");
    expect(streamed.noEmail).toBe(1);
    expect(tmpFiles()).toBe(before); // no temp copy of a sheet left behind
  });

  it("WhatsApp Contacts: xlsx", async () => {
    const buf = await tricky();
    const streamed = await parseWhatsAppContactUpload(save(buf, "xlsx"), BIG(WHATSAPP_FILE_IN_MEMORY_BYTES), "xlsx", "91");
    expect(streamed).toEqual(await parseWhatsAppContactFile(buf, "xlsx", "91"));
    expect(streamed.contacts.map((c) => c.phone)).toEqual(["919876543210", "919876543211", "919876543212", "919876543213"]);
  });

  it("AI Call Customers: xlsx", async () => {
    const buf = await tricky();
    const streamed = await readAiCallSheetUpload(save(buf, "xlsx"), BIG(AI_CALL_FILE_IN_MEMORY_BYTES), "xlsx", 1000);
    expect(streamed).toEqual(await readAiCallSheet(buf, "xlsx", 1000));
    expect(streamed.rows[0]).toMatchObject({ Phone: "9876543210", Joined: "2024-01-15T00:00:00.000Z", Score: "2", Note: "rich text" });
  });

  it("csv: quotes, commas and line breaks in a field, a BOM, blank lines and rows, Tamil", async () => {
    const text = '﻿email,first name,phone,notes\n"ada@x.com","Ada, A.",9876543210,"line one\nline two"\n\n,,,\ntamil@x.com,தமிழ்,98765 43212,வணக்கம்\n';
    const buf = Buffer.from(text);
    const path = save(buf, "csv");
    expect(await parseContactUpload(path, BIG(CONTACT_FILE_IN_MEMORY_BYTES), "csv")).toEqual(await parseContactFile(buf, "csv"));
    expect(await parseWhatsAppContactUpload(path, BIG(WHATSAPP_FILE_IN_MEMORY_BYTES), "csv", "91")).toEqual(await parseWhatsAppContactFile(buf, "csv", "91"));
    const ai = await readAiCallSheetUpload(path, BIG(AI_CALL_FILE_IN_MEMORY_BYTES), "csv", 1000);
    expect(ai).toEqual(await readAiCallSheet(buf, "csv", 1000));
    expect(ai.rows).toHaveLength(2);
  });

  it("thousands of Tamil text cells: every row's text read right, across read chunks", async () => {
    const buf = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet("S");
      ws.addRow(["customer_name", "phone"]);
      for (let i = 1; i <= 3000; i++) ws.addRow([`வாடிக்கையாளர் ${i} தமிழ்செல்வி`, `98765${String(i).padStart(5, "0")}`]);
    });
    const streamed = await readAiCallSheetUpload(save(buf, "xlsx"), BIG(AI_CALL_FILE_IN_MEMORY_BYTES), "xlsx", 5000);
    expect(streamed).toEqual(await readAiCallSheet(buf, "xlsx", 5000));
    expect(streamed.rows[2999]!.customer_name).toBe("வாடிக்கையாளர் 3000 தமிழ்செல்வி");
  });
});

describe("a big file over the limit: the first 1,000 rows kept, every row counted", () => {
  const rows = 2500;
  it("csv", async () => {
    const lines = Array.from({ length: rows }, (_, i) => `user${i + 1}@x.com,N${i + 1}`);
    const path = save(Buffer.from(["email,first name", ...lines].join("\n")), "csv");
    const r = await parseContactUpload(path, BIG(CONTACT_FILE_IN_MEMORY_BYTES), "csv");
    expect(r.limit).toEqual({ totalRows: rows, maxRows: 1000, selectedRows: 1000, skippedOverLimit: 1500 });
    expect(r.contacts.map((c) => c.email)).toEqual(Array.from({ length: 1000 }, (_, i) => `user${i + 1}@x.com`));
  });

  it("xlsx", async () => {
    const buf = await xlsxBuffer((wb) => {
      const ws = wb.addWorksheet("S");
      ws.addRow(["phone", "first name"]);
      for (let i = 1; i <= rows; i++) ws.addRow([`+91 9${String(i).padStart(9, "0")}`, `N${i}`]);
    });
    const r = await parseWhatsAppContactUpload(save(buf, "xlsx"), BIG(WHATSAPP_FILE_IN_MEMORY_BYTES), "xlsx", "91");
    expect(r.limit).toEqual({ totalRows: rows, maxRows: 1000, selectedRows: 1000, skippedOverLimit: 1500 });
    expect(r.contacts.at(-1)!).toEqual({ phone: "919000001000", firstName: "N1000" });
  });

  it("at or below the limit: nothing skipped", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `C${i + 1},+91 9${String(i + 1).padStart(9, "0")}`);
    const r = await readAiCallSheetUpload(save(Buffer.from(["customer_name,phone", ...lines].join("\n")), "csv"), BIG(AI_CALL_FILE_IN_MEMORY_BYTES), "csv", 1000);
    expect({ rows: r.rows.length, totalRows: r.totalRows, truncated: r.truncated }).toEqual({ rows: 1000, totalRows: 1000, truncated: false });
  });
});

describe("files up to the old size are read exactly as before", () => {
  it("a pdf over 10 MB is refused with a clear message (it can only be read whole)", async () => {
    await expect(parseContactUpload(save(Buffer.from("%PDF"), "pdf"), CONTACT_FILE_IN_MEMORY_BYTES + 1, "pdf")).rejects.toBeInstanceOf(ImportFileError);
    await expect(parseContactUpload(save(Buffer.from("%PDF"), "pdf"), CONTACT_FILE_IN_MEMORY_BYTES + 1, "pdf")).rejects.toThrow("A PDF can be up to 10 MB");
  });

  it("the old sizes: 10 MB for Contacts and WhatsApp Contacts, 5 MB for AI Call Customers", () => {
    expect(CONTACT_FILE_IN_MEMORY_BYTES).toBe(10 * 1024 * 1024);
    expect(WHATSAPP_FILE_IN_MEMORY_BYTES).toBe(10 * 1024 * 1024);
    expect(AI_CALL_FILE_IN_MEMORY_BYTES).toBe(5 * 1024 * 1024);
  });
});
