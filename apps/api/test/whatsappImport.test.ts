import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  formatFromFilename,
  parseWhatsAppContactFile,
  rowsToWhatsAppContacts,
} from "../src/domain/whatsappImport.js";

describe("formatFromFilename", () => {
  it("accepts csv + xlsx only", () => {
    expect(formatFromFilename("list.csv")).toBe("csv");
    expect(formatFromFilename("Contacts.XLSX")).toBe("xlsx");
    expect(formatFromFilename("scan.pdf")).toBeNull();
    expect(formatFromFilename("notes.txt")).toBeNull();
  });
});

describe("rowsToWhatsAppContacts", () => {
  it("maps header aliases and drops rows with no usable phone", () => {
    const out = rowsToWhatsAppContacts(
      [
        { Phone: "+91 98765 43210", "First Name": "Ada", company: "Acme" },
        { "Mobile Number": "9123456789", last_name: "Lovelace" },
        { "First Name": "NoPhone" },
        { Phone: "+1 (415) 555-2671" }, // other country: kept with its code
        { Phone: "12345" }, // unusable: dropped
      ],
      "91",
    );
    expect(out).toEqual([
      { phone: "919876543210", firstName: "Ada", businessName: "Acme" },
      { phone: "919123456789", lastName: "Lovelace" },
      { phone: "14155552671" },
    ]);
  });
});

describe("parseWhatsAppContactFile", () => {
  it("parses CSV with a required phone column", async () => {
    const csv = "phone,first name,business name\n+919876543210,Ada,Acme\n,Missing,Skip\n";
    const { contacts: rows } = await parseWhatsAppContactFile(Buffer.from(csv), "csv");
    expect(rows).toEqual([{ phone: "919876543210", firstName: "Ada", businessName: "Acme" }]);
  });

  it("parses XLSX", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["phone", "Last Name", "Business Name"]);
    ws.addRow(["+919876543210", "Hopper", "Navy"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const { contacts: rows } = await parseWhatsAppContactFile(buf, "xlsx");
    expect(rows).toEqual([{ phone: "919876543210", lastName: "Hopper", businessName: "Navy" }]);
  });
});
