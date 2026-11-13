// Big import files, read as a stream: only the first `maxRows` data rows are kept and the rest are
// only counted, so memory stays small whatever the file size (up to the 500 MB import upload).
// Used by the bulk imports (Contacts, WhatsApp Contacts, AI Call Customers) for files over the
// size they read into memory; smaller files are read exactly as before.

import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { parse as parseCsv, type Options as CsvOptions } from "csv-parse";
import ExcelJS from "exceljs";
import type { SaxesParser as SaxesParserType } from "saxes";

/** A problem with the uploaded file, shown to the user as it is (HTTP 400). */
export class ImportFileError extends Error {}

/** csv: `toRow` turns each record into a row, or null for a blank one (not counted). */
export async function streamCsvRows<T>(
  path: string,
  options: CsvOptions,
  maxRows: number,
  toRow: (record: Record<string, string>) => T | null,
): Promise<{ rows: T[]; totalRows: number }> {
  const parser = parseCsv(options);
  const input = createReadStream(path);
  input.on("error", (err) => parser.destroy(err));
  input.pipe(parser);
  const rows: T[] = [];
  let totalRows = 0;
  for await (const record of parser) {
    const row = toRow(record as Record<string, string>);
    if (row === null) continue;
    totalRows++;
    if (rows.length < maxRows) rows.push(row);
  }
  return { rows, totalRows };
}

export interface XlsxRows {
  /** Row 1, the header row; undefined when the sheet has none. */
  header: ExcelJS.Row | undefined;
  /** The first `maxRows` data rows with a value under a header, in file order. */
  rows: ExcelJS.Row[];
  /** Every such data row in the sheet. */
  totalRows: number;
}

type SharedStringRef = { sharedString: number };
const isSharedString = (v: unknown): v is SharedStringRef => typeof v === "object" && v !== null && "sharedString" in v;
/** A value that makes a row count. Text from Excel's string table counts; it is read later, for kept rows only. */
const hasValue = (v: ExcelJS.CellValue) => v != null && (typeof v !== "string" || v.trim() !== "");

/** WorkbookReader's own steps, called one by one (its zip loop can stop early on some files). */
interface ReaderSteps {
  model?: { sheets?: { rId: string }[] };
  workbookRels?: { Id: string; Target: string }[];
  _parseRels(entry: NodeJS.ReadableStream): Promise<void>;
  _parseWorkbook(entry: NodeJS.ReadableStream): Promise<void>;
  _parseStyles(entry: NodeJS.ReadableStream): Promise<void>;
  _parseWorksheet(iterator: NodeJS.ReadableStream, sheetNo: string): Iterable<{ value: AsyncIterable<ExcelJS.Row> }>;
}

/**
 * The first worksheet of an .xlsx file, as a stream. Excel keeps cell text in one shared table,
 * and holding all of it can take over 1 GB for a big file. So the sheet is read first, keeping
 * only the rows needed (text cells as table indexes), then only the text those rows use is read
 * from the table. Values (dates, numbers, formulas, rich text) are ExcelJS's, as in memory.
 *
 * The zip is opened by its index: workbook, relationships and styles first (dates need styles),
 * then only the first sheet, streamed straight into ExcelJS's sheet reader. No temp copies.
 */
export async function streamXlsxRows(path: string, maxRows: number): Promise<XlsxRows> {
  const zip = await unzipper.Open.file(path);
  const entry = (name: string) => zip.files.find((f) => f.path === name);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    sharedStrings: "ignore", // text cells stay table indexes: read below for kept rows only
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit",
    entries: "ignore",
  });
  const steps = reader as unknown as ReaderSteps;
  const rels = entry("xl/_rels/workbook.xml.rels");
  const book = entry("xl/workbook.xml");
  if (!rels || !book) throw new ImportFileError("This file is not a valid .xlsx workbook.");
  await steps._parseRels(rels.stream());
  await steps._parseWorkbook(book.stream());
  const styles = entry("xl/styles.xml");
  if (styles) await steps._parseStyles(styles.stream());

  // The first sheet in the workbook's own order, like the in-memory reader's worksheets[0].
  const first = steps.model?.sheets?.[0];
  const target = first && steps.workbookRels?.find((r) => r.Id === first.rId)?.Target;
  const sheetPath = target && (target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  const sheet = sheetPath ? entry(sheetPath) : undefined;
  if (!sheet || !sheetPath) return { header: undefined, rows: [], totalRows: 0 };
  const [{ value: worksheet }] = [...steps._parseWorksheet(sheet.stream(), sheetPath.match(/(\d+)\.xml$/)?.[1] ?? "1")];

  let header: ExcelJS.Row | undefined;
  const headerCols = new Set<number>();
  const rows: ExcelJS.Row[] = [];
  let totalRows = 0;
  for await (const row of worksheet) {
    if (row.number === 1) {
      header = row;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        if (hasValue(cell.value)) headerCols.add(col);
      });
      continue;
    }
    let counts = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (!counts && headerCols.has(col) && hasValue(cell.value)) counts = true;
    });
    if (!counts) continue;
    totalRows++;
    if (rows.length < maxRows) rows.push(row);
  }

  const kept = header ? [header, ...rows] : rows;
  const needed = new Set<number>();
  for (const row of kept) {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (isSharedString(cell.value)) needed.add(cell.value.sharedString);
    });
  }
  if (needed.size > 0) {
    const table = entry("xl/sharedStrings.xml");
    const text = table ? await readSharedStrings(table, needed) : new Map<number, string | null>();
    for (const row of kept) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (isSharedString(cell.value)) cell.value = text.get(cell.value.sharedString) ?? null;
      });
    }
  }
  return { header, rows, totalRows };
}

// The zip and XML readers ExcelJS itself uses, from ExcelJS's own dependencies.
const exceljsRequire = createRequire(createRequire(import.meta.url).resolve("exceljs"));
const { SaxesParser } = exceljsRequire("saxes") as { SaxesParser: typeof SaxesParserType };
interface ZipEntry {
  path: string;
  stream(): NodeJS.ReadableStream & { destroy(): void };
}
const unzipper = exceljsRequire("unzipper") as { Open: { file(path: string): Promise<{ files: ZipEntry[] }> } };

/**
 * Text of the shared strings at `needed` indexes (rich text joined into plain text). Same reading
 * as ExcelJS's streaming reader: a <t> starts the text, each <r> run is one piece.
 */
async function readSharedStrings(entry: ZipEntry, needed: Set<number>): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const last = Math.max(...needed);
  const parser = new SaxesParser();
  let index = 0;
  let text: string | null = null;
  let runs: (string | null)[] = [];
  let failure: Error | null = null;
  parser.on("opentag", (node) => {
    if (node.name === "si") {
      runs = [];
      text = null;
    } else if (node.name === "t") {
      text = null;
    }
  });
  parser.on("text", (value) => {
    text = text ? text + value : value;
  });
  parser.on("closetag", (node) => {
    if (node.name === "r") {
      runs.push(text);
      text = null;
    } else if (node.name === "si") {
      if (needed.has(index)) out.set(index, runs.length ? runs.map((r) => r ?? "").join("") : text);
      index++;
      runs = [];
      text = null;
    }
  });
  parser.on("error", (err) => {
    failure = err;
  });
  const stream = entry.stream();
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    parser.write(chunk as string);
    if (failure) throw failure;
    if (index > last) break; // every needed string read
  }
  stream.destroy();
  return out;
}
