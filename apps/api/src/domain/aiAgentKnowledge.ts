// AI Agent knowledge files → fact / Q&A items (each Draft until an admin approves it).
//
//   csv / xlsx  structured: one item per row. Recognised columns (any case): a topic (topic, product, service,
//               title, name, category), the text (answer, description, details, fact, text, information,
//               content), questions (question, questions, faq; several separated by "|" or ";") and an industry
//               (industry, sector). A row with a question and an answer is a Q&A, otherwise a fact.
//   pdf / docx / txt  free text: split into paragraphs, then into pieces of at most 500 characters at sentence
//               ends. A short line that looks like a heading becomes the topic of what follows.
//
// Every item is checked with knowledgeTextIssues (the voice backend's training rules) and for missing fields;
// items with issues can be edited, but not approved, until they are fixed. A row naming another industry than
// the agent's keeps its industry in industryHint so the admin sees it before approving.

import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import {
  AI_KNOWLEDGE_QUESTIONS_MAX,
  AI_KNOWLEDGE_QUESTION_MAX,
  AI_KNOWLEDGE_TEXT_MAX,
  AI_KNOWLEDGE_TOPIC_MAX,
  knowledgeTextIssues,
  type AiKnowledgeFormat,
} from "@dispatch/shared";

export interface ExtractedItem {
  kind: "fact" | "qa";
  topic: string;
  text: string;
  questions: string[];
  issues: string[];
  source: string | null;
  industryHint: string | null;
}

export interface Extraction {
  items: ExtractedItem[];
  /** Notes about the whole file (e.g. "rows 12-14 had no text and were skipped"). */
  notes: string[];
}

/** Items one file may add (the voice backend accepts at most 120 approved per agent; drafts may be more). */
export const MAX_ITEMS_PER_FILE = 300;

const TOPIC_COLS = ["topic", "product", "service", "title", "name", "category", "subject", "feature"];
const TEXT_COLS = ["answer", "description", "details", "detail", "fact", "text", "information", "info", "content", "notes"];
const QUESTION_COLS = ["question", "questions", "faq", "query"];
const INDUSTRY_COLS = ["industry", "sector", "business type", "business_type"];

const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, " ");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function pick(headers: string[], wanted: string[]): string | null {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  for (const w of wanted) {
    const h = byNorm.get(w);
    if (h) return h;
  }
  return null;
}

/** Split long text into pieces of at most `max` characters, at sentence ends where possible. */
export function chunkText(text: string, max = AI_KNOWLEDGE_TEXT_MAX): string[] {
  const sentences = oneLine(text).split(/(?<=[.!?।])\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (let s of sentences) {
    while (s.length > max) {
      // A sentence longer than max: cut at the last space before max.
      const cut = s.lastIndexOf(" ", max) > max / 2 ? s.lastIndexOf(" ", max) : max;
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (!s) continue;
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function clipTopic(topic: string): string {
  const t = oneLine(topic).replace(/[{}[\]]/g, "");
  return t.length <= AI_KNOWLEDGE_TOPIC_MAX ? t : t.slice(0, AI_KNOWLEDGE_TOPIC_MAX).replace(/\s+\S*$/, "").trim() || t.slice(0, AI_KNOWLEDGE_TOPIC_MAX);
}

/** The issues of one item (content rules + missing fields). */
export function itemIssues(item: Pick<ExtractedItem, "kind" | "topic" | "text" | "questions">): string[] {
  const issues: string[] = [];
  if (!item.topic.trim()) issues.push("missing topic");
  if (!item.text.trim()) issues.push(item.kind === "qa" ? "missing answer" : "missing text");
  if (item.text.length > AI_KNOWLEDGE_TEXT_MAX) issues.push(`text is longer than ${AI_KNOWLEDGE_TEXT_MAX} characters`);
  if (item.kind === "qa" && item.questions.length === 0) issues.push("a Q&A needs at least one question");
  for (const i of knowledgeTextIssues(item.text)) issues.push(i);
  for (const i of knowledgeTextIssues(item.topic)) if (!issues.includes(`topic ${i}`)) issues.push(`topic ${i}`);
  for (const q of item.questions) {
    if (q.length > AI_KNOWLEDGE_QUESTION_MAX) issues.push(`a question is longer than ${AI_KNOWLEDGE_QUESTION_MAX} characters`);
    for (const i of knowledgeTextIssues(q, { policy: false })) if (!issues.includes(`question ${i}`)) issues.push(`question ${i}`);
  }
  return [...new Set(issues)];
}

function withIssues(item: Omit<ExtractedItem, "issues">): ExtractedItem {
  return { ...item, issues: itemIssues(item) };
}

/** A sheet row with its row number in the file (the header is row 1). */
export type SheetRow = Record<string, string> & { __row?: string };

/** Structured rows (csv / xlsx) → items. A row's `__row` is its row number in the file (else its position + 1). */
export function rowsToItems(headers: string[], rows: SheetRow[], agentIndustry: string | null): Extraction {
  const topicCol = pick(headers, TOPIC_COLS);
  const textCol = pick(headers, TEXT_COLS);
  const questionCol = pick(headers, QUESTION_COLS);
  const industryCol = pick(headers, INDUSTRY_COLS);
  const notes: string[] = [];
  if (!textCol && !questionCol) {
    notes.push(
      `No text column found (expected one of: ${TEXT_COLS.join(", ")}). Each row is read as one fact from all its cells.`,
    );
  }
  const items: ExtractedItem[] = [];
  const skipped: number[] = [];
  rows.forEach((row, i) => {
    const rowNo = Number(row.__row) || i + 2; // the header is row 1
    const topic = clipTopic(topicCol ? row[topicCol] ?? "" : "");
    const questions = (questionCol ? row[questionCol] ?? "" : "")
      .split(/[|;\n]/)
      .map(oneLine)
      .filter(Boolean)
      .slice(0, AI_KNOWLEDGE_QUESTIONS_MAX);
    let text = textCol ? oneLine(row[textCol] ?? "") : "";
    if (!textCol && !questionCol) {
      text = oneLine(
        headers
          .filter((h) => h !== topicCol && h !== industryCol)
          .map((h) => (row[h] ? `${h}: ${row[h]}` : ""))
          .filter(Boolean)
          .join(". "),
      );
    }
    if (!text && questions.length === 0 && !topic) {
      skipped.push(rowNo);
      return;
    }
    const industry = industryCol ? oneLine(row[industryCol] ?? "") : "";
    const industryHint =
      industry && (!agentIndustry || norm(industry) !== norm(agentIndustry)) ? industry.slice(0, 80) : null;
    const kind = questions.length > 0 ? "qa" : "fact";
    // A text over 500 characters: a fact is split into several facts with the same topic, a Q&A keeps its
    // full answer and is flagged (an approved answer is said with its meaning kept: an admin shortens it).
    const pieces = kind === "fact" && text.length > AI_KNOWLEDGE_TEXT_MAX ? chunkText(text) : [text];
    pieces.forEach((piece, n) =>
      items.push(
        withIssues({
          kind,
          topic: topic || "General",
          text: piece,
          questions,
          source: pieces.length > 1 ? `row ${rowNo} (${n + 1}/${pieces.length})` : `row ${rowNo}`,
          industryHint,
        }),
      ),
    );
    if (!topic) items[items.length - 1]!.issues.unshift("no topic column value - \"General\" used");
  });
  if (skipped.length) notes.push(`${skipped.length} empty row(s) skipped`);
  return { items: items.slice(0, MAX_ITEMS_PER_FILE), notes: items.length > MAX_ITEMS_PER_FILE ? [...notes, `only the first ${MAX_ITEMS_PER_FILE} items were kept`] : notes };
}

const HEADING_RE = /^(?:#+\s*)?([^.!?।:]{2,60}):?$/;

/** Free text (pdf / docx / txt) → fact items. `pages` (pdf) gives "page n" sources. */
export function textToItems(text: string, fallbackTopic: string, pageOf?: (offset: number) => number): Extraction {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const items: ExtractedItem[] = [];
  let topic = clipTopic(fallbackTopic) || "General";
  let para: string[] = [];
  let paraStart = 0;
  let offset = 0;
  const flush = () => {
    const body = oneLine(para.join(" "));
    para = [];
    if (!body) return;
    for (const piece of chunkText(body)) {
      items.push(withIssues({ kind: "fact", topic, text: piece, questions: [], source: pageOf ? `page ${pageOf(paraStart)}` : null, industryHint: null }));
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (HEADING_RE.test(line) && line.split(/\s+/).length <= 8 && !/[,;]/.test(line)) {
      // A short line without sentence punctuation: a heading - the topic of the paragraphs after it.
      flush();
      topic = clipTopic(line.replace(/^#+\s*/, "").replace(/:$/, "")) || topic;
    } else {
      if (para.length === 0) paraStart = offset;
      para.push(line);
    }
    offset += raw.length + 1;
  }
  flush();
  const notes = items.length ? [] : ["No text found in the file (a scanned PDF needs a text layer)."];
  return { items: items.slice(0, MAX_ITEMS_PER_FILE), notes: items.length > MAX_ITEMS_PER_FILE ? [...notes, `only the first ${MAX_ITEMS_PER_FILE} items were kept`] : notes };
}

/** The text of a .docx: every paragraph (w:p) on its own line, table cells too. */
export async function docxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file("word/document.xml");
  if (!doc) throw new Error("not a Word document (word/document.xml is missing)");
  const xml = await doc.async("string");
  const decode = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return xml
    .split(/<\/w:p>/)
    .map((p) => decode([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")))
    .join("\n");
}

/** Text with page numbers for a pdf: pdf-parse's per-page render, joined with blank lines. */
async function pdfText(buf: Buffer): Promise<{ text: string; pageOf: (offset: number) => number }> {
  const starts: number[] = [];
  let all = "";
  await pdfParse(buf, {
    pagerender: async (page: { getTextContent: () => Promise<{ items: { str: string; hasEOL?: boolean }[] }> }) => {
      const content = await page.getTextContent();
      const text = content.items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join("");
      starts.push(all.length);
      all += text + "\n\n";
      return text;
    },
  } as never);
  return {
    text: all,
    pageOf: (offset) => {
      let page = 1;
      starts.forEach((s, i) => {
        if (offset >= s) page = i + 1;
      });
      return page;
    },
  };
}

/** ExcelJS cell values can be strings, numbers, dates or rich objects (as domain/aiCallImport.ts reads them). */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("text" in v && v.text != null) return String(v.text);
    if ("result" in v && v.result != null) return String(v.result);
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  }
  return "";
}

export const MAX_SHEET_ROWS = 5000;

/** The first sheet of a csv / xlsx, keeping each row's number in the file (empty rows stay counted). */
export async function readSheet(buf: Buffer, format: "csv" | "xlsx"): Promise<{ headers: string[]; rows: SheetRow[] }> {
  if (format === "csv") {
    const records = parseCsv(buf.toString("utf8").replace(/^﻿/, ""), {
      skip_empty_lines: false,
      relax_column_count: true,
      trim: true,
      info: true,
    }) as { record: string[]; info: { lines: number } }[];
    const [head, ...rest] = records;
    const headers = (head?.record ?? []).map((h) => h.trim());
    const rows = rest.slice(0, MAX_SHEET_ROWS).map(({ record, info }) => {
      const obj: SheetRow = { __row: String(info.lines) };
      headers.forEach((h, i) => h && (obj[h] = String(record[i] ?? "").trim()));
      return obj;
    });
    return { headers: headers.filter(Boolean), rows };
  }
  const wb = new ExcelJS.Workbook();
  await (wb.xlsx.load as unknown as (data: Uint8Array) => Promise<unknown>)(buf);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const byCol: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    byCol[col] = cellText(cell).trim();
  });
  const rows: SheetRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || rows.length >= MAX_SHEET_ROWS) return;
    const obj: SheetRow = { __row: String(rowNumber) };
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = byCol[col];
      if (h) obj[h] = cellText(cell).trim();
    });
    rows.push(obj);
  });
  return { headers: byCol.filter(Boolean), rows };
}

/** Read one uploaded file. Throws with a readable message when the file can't be read. */
export async function extractKnowledge(
  buf: Buffer,
  format: AiKnowledgeFormat,
  fileName: string,
  agentIndustry: string | null,
): Promise<Extraction> {
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  if (format === "csv" || format === "xlsx") {
    const sheet = await readSheet(buf, format);
    if (sheet.headers.length === 0) throw new Error("the file has no header row");
    const out = rowsToItems(sheet.headers, sheet.rows, agentIndustry);
    if (sheet.rows.length >= MAX_SHEET_ROWS) out.notes.push(`only the first ${MAX_SHEET_ROWS} rows were read`);
    return out;
  }
  if (format === "pdf") {
    const { text, pageOf } = await pdfText(buf);
    return textToItems(text, stem, pageOf);
  }
  if (format === "docx") return textToItems(await docxText(buf), stem);
  return textToItems(buf.toString("utf8").replace(/^﻿/, ""), stem);
}
