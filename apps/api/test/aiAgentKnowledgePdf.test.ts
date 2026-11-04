// AI Agents knowledge: the REAL pdf-parse (pdf.js 1.10, as installed) on real PDF files - no stand-in.
// test/fixtures/knowledge/*.pdf were printed by headless Chrome (Skia/PDF) from local HTML:
//   normal.pdf     one page, two headings with a paragraph each
//   multipage.pdf  three pages, one heading + paragraph per page
//   large.pdf      230 pages (more than MAX_PDF_PAGES)
//   blank.pdf      one empty page
//   scanned.pdf    one page that is only an image of text (what a scanner / phone photo produces)
// Malformed files are made here from them (truncated, corrupted xref, not a PDF, empty).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractKnowledge, MAX_PDF_PAGES, PDF_NO_TEXT_MESSAGE, pdfPageText } from "../src/domain/aiAgentKnowledge.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/knowledge/${name}`, import.meta.url));
/** A small Buffer inside Node's shared pool (byteOffset > 0), as multer hands small uploads over. */
const pooled = (b: Buffer) => {
  const p = Buffer.from(b); // < 4 KB: allocated from the pool
  return Buffer.byteLength(p) === b.length ? p : b;
};
const pdf = (buf: Buffer, name = "guide.pdf") => extractKnowledge(buf, "pdf", name, null);

describe("real text PDFs", () => {
  it("normal: headings become topics, paragraphs become facts, with page numbers", async () => {
    const out = await pdf(fixture("normal.pdf"));
    expect(out.notes).toEqual([]);
    expect(out.items.map((i) => [i.topic, i.source])).toEqual([
      ["Billing automation", "page 1"],
      ["Integration", "page 1"],
    ]);
    expect(out.items[0]!.text).toBe(
      "Kagzso automates billing follow-ups for hospitals. Reminders go out by WhatsApp and email, and every reply is logged against the patient account.",
    );
    expect(out.items[1]!.text).toBe("It works alongside the software the hospital already uses. No data migration is needed to get started.");
    expect(out.items.every((i) => i.kind === "fact" && i.issues.length === 0)).toBe(true);
  });

  it("multi-page: one item per page, each with its own page number", async () => {
    const out = await pdf(fixture("multipage.pdf"));
    expect(out.items.map((i) => [i.topic, i.source])).toEqual([
      ["Section 1", "page 1"],
      ["Section 2", "page 2"],
      ["Section 3", "page 3"],
    ]);
    expect(out.items[2]!.text).toContain("This is the text of page 3.");
  });

  it("large: only the first MAX_PDF_PAGES pages are read, and the notes say so", async () => {
    const started = Date.now();
    const out = await pdf(fixture("large.pdf"));
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(MAX_PDF_PAGES).toBe(200);
    expect(out.items).toHaveLength(200);
    expect(out.items.at(-1)!.source).toBe("page 200");
    expect(out.items.at(-1)!.topic).toBe("Chapter 200");
    expect(out.notes).toEqual(["only the first 200 of 230 pages were read"]);
  });

  it("a small PDF given as a Buffer inside Node's shared pool is read correctly (every time)", async () => {
    const small = fixture("blank.pdf");
    expect(small.length).toBeLessThan(4096);
    const views = [pooled(small), pooled(small), pooled(small)];
    expect(views.some((v) => v.byteOffset > 0)).toBe(true); // the case pdf.js used to misread ("bad XRef entry")
    for (const v of views) await expect(pdf(v)).rejects.toThrow(PDF_NO_TEXT_MESSAGE); // read: 1 page, no text
  });
});

describe("PDFs without usable text are refused with a clear message (never accepted as empty)", () => {
  it("scanned / image-only", async () => {
    await expect(pdf(fixture("scanned.pdf"))).rejects.toThrow(PDF_NO_TEXT_MESSAGE);
    expect(PDF_NO_TEXT_MESSAGE).toMatch(/scanned or image-only.*not supported.*selectable text/);
  });

  it("blank page", async () => {
    await expect(pdf(fixture("blank.pdf"))).rejects.toThrow(PDF_NO_TEXT_MESSAGE);
  });
});

describe("malformed PDFs fail with a readable message", () => {
  const normal = fixture("normal.pdf");
  const cases: [string, Buffer][] = [
    ["truncated (first 40%)", normal.subarray(0, Math.floor(normal.length * 0.4))],
    ["not a PDF at all", Buffer.from("hello, this is a text file renamed to .pdf")],
    ["a PDF header and junk", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000, 0x41)])],
    ["empty file", Buffer.alloc(0)],
  ];
  it.each(cases)("%s", async (_name, buf) => {
    await expect(pdf(buf)).rejects.toThrow(/^this is not a readable PDF \(it may be damaged or not really a PDF\): /);
  });

  it("a corrupted xref table: pdf.js rebuilds it and the text is still read", async () => {
    const s = normal.toString("latin1");
    const at = s.lastIndexOf("startxref");
    const broken = Buffer.from(s.slice(0, at) + "startxref\n99999\n%%EOF\n", "latin1");
    const out = await pdf(broken);
    expect(out.items.map((i) => i.topic)).toEqual(["Billing automation", "Integration"]);
  });
});

describe("pdfPageText: line and paragraph breaks from the text positions (pdf.js 1.10 has no hasEOL)", () => {
  const item = (str: string, y: number, size = 10) => ({ str, transform: [size, 0, 0, size, 72, y] });
  it("same baseline = same line; next line = newline; a bigger gap = new paragraph", () => {
    expect(pdfPageText([item("Heading", 700, 14), item("Line one ", 676), item("continues", 676), item("Line two", 664), item("Next para", 640)])).toBe(
      "Heading\n\nLine one continues\nLine two\n\nNext para",
    );
  });
  it("hasEOL (newer pdf.js) still ends a line", () => {
    expect(pdfPageText([{ str: "a", hasEOL: true }, { str: "b" }])).toBe("a\nb");
  });
});
