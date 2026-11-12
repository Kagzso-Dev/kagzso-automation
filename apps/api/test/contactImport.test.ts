import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  domainOf,
  domainAllowed,
} from "../src/domain/allowedDomains.js";
import {
  extractEmails,
  formatFromFilename,
  parseContactFile,
  rowsToContacts,
} from "../src/domain/contactImport.js";

describe("domain allowlist", () => {
  it("extracts the bare domain", () => {
    expect(domainOf("Ada@Example.COM")).toBe("example.com");
    expect(domainOf("nope")).toBe("");
  });

  it("allows everything when the list is empty", () => {
    expect(domainAllowed("a@anything.dev", [])).toBe(true);
    expect(domainAllowed("a@anything.dev", null)).toBe(true);
  });

  it("restricts to listed domains", () => {
    const allowed = ["gmail.com", "kagzso.com"];
    expect(domainAllowed("a@gmail.com", allowed)).toBe(true);
    expect(domainAllowed("a@KAGZSO.com", allowed)).toBe(true);
    expect(domainAllowed("a@evil.com", allowed)).toBe(false);
    expect(domainAllowed("garbage", allowed)).toBe(false);
  });
});

describe("formatFromFilename", () => {
  it("maps known extensions", () => {
    expect(formatFromFilename("list.csv")).toBe("csv");
    expect(formatFromFilename("Contacts.XLSX")).toBe("xlsx");
    expect(formatFromFilename("scan.pdf")).toBe("pdf");
    expect(formatFromFilename("notes.txt")).toBeNull();
  });
});

describe("extractEmails", () => {
  it("pulls distinct, lowercased addresses from free text", () => {
    const text = "Contact Ada@Example.com or sales@acme.io. Again: ada@example.com";
    expect(extractEmails(text).sort()).toEqual(["ada@example.com", "sales@acme.io"]);
  });
});

describe("rowsToContacts", () => {
  it("maps header aliases and keeps unknown columns as customFields", () => {
    const [c] = rowsToContacts([
      { Email: "Ada@Example.com", "First Name": "Ada", company: "Acme", Tier: "gold" },
    ]);
    expect(c).toEqual({
      email: "ada@example.com",
      firstName: "Ada",
      businessName: "Acme",
      customFields: { Tier: "gold" },
    });
  });

  it("drops rows without an email", () => {
    expect(rowsToContacts([{ "First Name": "NoEmail" }])).toHaveLength(0);
  });

  it("normalizes a 10-digit phone and drops anything else", () => {
    const [ok] = rowsToContacts([{ Email: "a@x.com", Phone: "(555) 123-4567" }]);
    expect(ok.phone).toBe("5551234567");
    const [short] = rowsToContacts([{ Email: "b@x.com", Phone: "555-1" }]);
    expect(short.phone).toBeUndefined();
    // Previously dropped: numbers with a country code.
    expect(rowsToContacts([{ Email: "c@x.com", Phone: "+91 98765 43210" }])[0]!.phone).toBe("9876543210");
    expect(rowsToContacts([{ Email: "d@x.com", Phone: "+971 50 123 4567" }])[0]!.phone).toBe("+971501234567");
  });
});

describe("parseContactFile", () => {
  it("parses CSV", async () => {
    const csv = "email,first name,phone\nada@gmail.com,Ada,555-123-4567\nbademail,X,Y\n";
    const { contacts: rows } = await parseContactFile(Buffer.from(csv), "csv");
    expect(rows).toEqual([
      { email: "ada@gmail.com", firstName: "Ada", phone: "5551234567", customFields: {} },
    ]);
  });

  it("parses XLSX", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["email", "Last Name", "Business Name"]);
    ws.addRow(["grace@kagzso.com", "Hopper", "Navy"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const { contacts: rows } = await parseContactFile(buf, "xlsx");
    expect(rows).toEqual([
      { email: "grace@kagzso.com", lastName: "Hopper", businessName: "Navy", customFields: {} },
    ]);
  });
});
