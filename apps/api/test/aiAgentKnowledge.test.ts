import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { knowledgeFormatFromFilename } from "@dispatch/shared";
import { chunkText, docxText, extractKnowledge, itemIssues, rowsToItems, textToItems } from "../src/domain/aiAgentKnowledge.js";

// AI Agent knowledge files → Draft items. Files are built in the test (no fixtures on disk, no network).

const CSV = [
  "Product,Description,Question,Industry",
  "Billing automation,Kagzso automates billing follow-ups and payment reminders.,,Hospital",
  "Integration,It works alongside the software you already use.,Will it replace our software?|Do we need new software?,Hospital",
  "KOT,Kitchen order tickets go straight to the kitchen screen.,,Hotel",
  "Pricing,The package costs Rs 25000 per month.,,Hospital",
  ",,,",
  "Contact,Call us on 98765 43210.,,",
].join("\n");

async function xlsx(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Knowledge");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function docx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

// pdf-parse (already used by contact import) is replaced by a stand-in that renders two pages through the
// `pagerender` hook, the way the real library calls it: this tests the page numbering and text joining here.
// The real library on real PDF files: aiAgentKnowledgePdf.test.ts.
vi.mock("pdf-parse/lib/pdf-parse.js", () => ({
  default: async (buf: Uint8Array, opts: { pagerender: (p: unknown) => Promise<string> }) => {
    const pages = Buffer.from(buf).toString("utf8").split("\f");
    for (const text of pages) {
      await opts.pagerender({
        getTextContent: async () => ({ items: text.split("\n").map((str) => ({ str, hasEOL: true })) }),
      });
    }
    return { text: pages.join("\n\n") };
  },
}));

describe("structured files (csv / xlsx)", () => {
  it("one item per row: facts, Q&A from the question column, industry hint, issues, empty rows skipped", async () => {
    const out = await extractKnowledge(Buffer.from(CSV), "csv", "kagzso.csv", "Hospital");
    expect(out.items.map((i) => [i.kind, i.topic, i.source])).toEqual([
      ["fact", "Billing automation", "row 2"],
      ["qa", "Integration", "row 3"],
      ["fact", "KOT", "row 4"],
      ["fact", "Pricing", "row 5"],
      ["fact", "Contact", "row 7"],
    ]);
    const [billing, qa, kot, price, contact] = out.items;
    expect(billing!.issues).toEqual([]);
    expect(qa!.questions).toEqual(["Will it replace our software?", "Do we need new software?"]);
    expect(qa!.issues).toEqual([]);
    expect(kot!.industryHint).toBe("Hotel"); // another industry than the agent's: shown before approving
    expect(billing!.industryHint).toBeNull();
    expect(price!.issues.join()).toMatch(/price/);
    expect(contact!.issues.join()).toMatch(/phone number/);
    expect(out.notes.join()).toMatch(/1 empty row/);
  });

  it("xlsx reads the same way", async () => {
    const buf = await xlsx([
      ["Topic", "Answer", "FAQ"],
      ["Appointments", "Patients get appointment reminders on WhatsApp.", "Do you send reminders?"],
    ]);
    const out = await extractKnowledge(buf, "xlsx", "faq.xlsx", null);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ kind: "qa", topic: "Appointments", questions: ["Do you send reminders?"], issues: [] });
  });

  it("no recognised text column: each row becomes one fact from its cells, with a note", () => {
    const out = rowsToItems(["Module", "Benefit"], [{ Module: "HMS", Benefit: "Room booking" }], null);
    expect(out.notes[0]).toMatch(/No text column/);
    expect(out.items[0]!.text).toBe("Module: HMS. Benefit: Room booking");
    expect(out.items[0]!.topic).toBe("General");
    expect(out.items[0]!.issues[0]).toMatch(/no topic/);
  });

  it("a long description is split into facts of at most 500 characters", () => {
    const long = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} explains one more useful detail about the product.`).join(" ");
    const out = rowsToItems(["Topic", "Description"], [{ Topic: "HMS", Description: long }], null);
    expect(out.items.length).toBeGreaterThan(1);
    expect(out.items.every((i) => i.text.length <= 500 && i.topic === "HMS")).toBe(true);
    expect(out.items[0]!.source).toMatch(/row 2 \(1\/\d\)/);
  });
});

describe("free text (txt / docx / pdf)", () => {
  it("txt: headings become topics, paragraphs become facts", async () => {
    const txt = "Billing\nKagzso automates billing follow-ups.\nIt sends payment reminders.\n\nAppointments:\nPatients get reminders before visits.";
    const out = await extractKnowledge(Buffer.from(txt), "txt", "notes.txt", null);
    expect(out.items.map((i) => [i.topic, i.text])).toEqual([
      ["Billing", "Kagzso automates billing follow-ups. It sends payment reminders."],
      ["Appointments", "Patients get reminders before visits."],
    ]);
  });

  it("docx: paragraphs are read from word/document.xml", async () => {
    const buf = await docx(["School solutions", "Attendance is marked from the teacher's phone & synced.", "", "Timetable", "Timetables are built automatically."]);
    expect(await docxText(buf)).toContain("Attendance is marked from the teacher's phone & synced.");
    const out = await extractKnowledge(buf, "docx", "school.docx", null);
    expect(out.items.map((i) => i.topic)).toEqual(["School solutions", "Timetable"]);
  });

  it("pdf: text per page, with page numbers", async () => {
    const twoPages = Buffer.from("Hotel solutions\n\nKOT orders reach the kitchen screen instantly.\fReservations\n\nRoom bookings sync with the front desk.");
    const out = await extractKnowledge(twoPages, "pdf", "hotel.pdf", null);
    expect(out.items.map((i) => [i.topic, i.text, i.source])).toEqual([
      ["Hotel solutions", "KOT orders reach the kitchen screen instantly.", "page 1"],
      ["Reservations", "Room bookings sync with the front desk.", "page 2"],
    ]);
  });

  it("a file that is not what it says fails with a readable message", async () => {
    await expect(extractKnowledge(Buffer.from("not a zip"), "docx", "x.docx", null)).rejects.toThrow();
  });

  it("an empty text file gives a note, no items", () => {
    const out = textToItems("   \n\n", "empty");
    expect(out.items).toEqual([]);
    expect(out.notes[0]).toMatch(/No text/);
  });

  it("an upload with no text is refused (never an 'extracted' file with 0 items)", async () => {
    await expect(extractKnowledge(Buffer.from("  \n\n"), "txt", "empty.txt", null)).rejects.toThrow("the file has no text to use");
    await expect(extractKnowledge(await docx([]), "docx", "empty.docx", null)).rejects.toThrow("the file has no text to use");
  });
});

describe("helpers", () => {
  it("formats by file name", () => {
    expect(["a.CSV", "b.xlsx", "c.pdf", "d.docx", "e.txt", "f.doc", "g"].map(knowledgeFormatFromFilename)).toEqual([
      "csv", "xlsx", "pdf", "docx", "txt", null, null,
    ]);
  });

  it("chunkText keeps sentences together and never exceeds the limit", () => {
    const chunks = chunkText("One. Two two. " + "x".repeat(1200), 500);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks[0]).toBe("One. Two two.");
  });

  it("itemIssues: missing fields and the Q&A rule", () => {
    expect(itemIssues({ kind: "qa", topic: "", text: "", questions: [] })).toEqual(
      expect.arrayContaining(["missing topic", "missing answer", "a Q&A needs at least one question"]),
    );
    // A customer's question may mention price or a demo; only personal data is refused there.
    expect(itemIssues({ kind: "qa", topic: "Cost", text: "It depends on the scope.", questions: ["How much per month?"] })).toEqual([]);
  });
});

describe("upload safety", () => {
  // A few hundred KB that would unpack to ~60 MB: refused from the zip's directory, before anything is unpacked.
  async function bomb(entry: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(entry, "0".repeat(60 * 1024 * 1024));
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  }
  it("a .docx or .xlsx that unpacks to more than 50 MB is refused", async () => {
    const docxBomb = await bomb("word/document.xml");
    expect(docxBomb.length).toBeLessThan(1024 * 1024);
    await expect(extractKnowledge(docxBomb, "docx", "big.docx", null)).rejects.toThrow(/unpacks to more than 50 MB/);
    await expect(extractKnowledge(await bomb("xl/worksheets/sheet1.xml"), "xlsx", "big.xlsx", null)).rejects.toThrow(/unpacks to more than 50 MB/);
  }, 30_000); // building the 60 MB test archives is slow under a full parallel run
  it("a .docx / .xlsx that is not a zip says so", async () => {
    await expect(extractKnowledge(Buffer.from("plain text"), "docx", "x.docx", null)).rejects.toThrow(/not a valid Office file/);
    await expect(extractKnowledge(Buffer.from("plain text"), "xlsx", "x.xlsx", null)).rejects.toThrow(/not a valid Office file/);
  });
});
