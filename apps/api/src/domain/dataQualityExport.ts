// Data Quality filters and the filtered export (admin only, read only). Rows are read in chunks of
// 500, never the whole file at once. The only write is one audit row in data_quality_export_logs,
// which holds no contact data. No row's status, score or review and no contact is changed, and
// nothing is called, sent or fetched.

import { once } from "node:events";
import { freemem } from "node:os";
import type { Response } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { ISSUE_PENALTY, overallScore } from "./dataQuality.js";

/* ------------------------------------------------------------------ derived values */

export const PHONE_TYPES = ["mobile", "landline", "tollfree", "international", "unusable", "none"] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];
const PHONE_TYPE_LABELS: Record<PhoneType, string> = {
  mobile: "Mobile",
  landline: "Landline",
  tollfree: "Toll-free",
  international: "Other country",
  unusable: "Unusable number",
  none: "No phone",
};

/** From the stored numbers: +91 6-9 mobile, 1800 / 1860 toll-free, other +91 landline. */
export function phoneType(phone: string | null, phoneRaw: string | null): PhoneType {
  if (!phone) {
    const digits = (phoneRaw ?? "").replace(/\D/g, "");
    if (!digits) return "none";
    return /^(?:0?91)?(?:1800|1860)/.test(digits) ? "tollfree" : "unusable";
  }
  const national = /^\+91(\d{10})$/.exec(phone)?.[1];
  if (!national) return "international";
  if (/^(?:1800|1860)/.test(national)) return "tollfree";
  return /^[6-9]/.test(national) ? "mobile" : "landline";
}

/** "+91 44 2345 6789 ext 12" → "12"; null when the number has no extension. */
export function phoneExtension(phoneRaw: string | null): string | null {
  return /(?:\bext\.?|\bextn\.?|\bx|#)\s*(\d{1,6})\s*$/i.exec(phoneRaw ?? "")?.[1] ?? null;
}

export const TIERS = ["HIGH_PRIORITY", "GOOD", "REVIEW", "REJECT"] as const;
export type Tier = (typeof TIERS)[number];
const TIER_LABELS: Record<Tier, string> = { HIGH_PRIORITY: "HIGH PRIORITY", GOOD: "GOOD", REVIEW: "REVIEW", REJECT: "REJECT" };

/** 85+ HIGH PRIORITY, 70-84 GOOD, 50-69 REVIEW, below 50 REJECT; no score → no tier. */
export function tierFor(score: number | null): Tier | null {
  if (score == null) return null;
  return score >= 85 ? "HIGH_PRIORITY" : score >= 70 ? "GOOD" : score >= 50 ? "REVIEW" : "REJECT";
}

// Same wording as apps/web/src/lib/dataQuality.ts (ISSUE_LABELS / EXCLUDED_LABELS).
const NOTE_LABELS: Record<string, string> = {
  bad_phone: "Bad phone number",
  missing_phone: "No phone number",
  fake_phone: "Fake / placeholder number",
  not_mobile: "Not a mobile (landline: no WhatsApp)",
  missing_name: "No name",
  suspicious_name: "Name looks wrong",
  missing_business: "No business name",
  bad_email: "Bad or placeholder email",
  in_voicecall: "Already in Voicecall Contact",
  in_whatsapp: "Already in WhatsApp Contacts",
  in_email_contacts: "Already in Email Contacts",
};
const EXCLUDED_LABELS: Record<string, string> = { do_not_call: "Do not call", not_interested: "Not interested", wrong_person: "Wrong person" };

function noteLabel(code: string): string {
  const dup = /^duplicate_of_row_(\d+)$/.exec(code);
  if (dup) return `Same number as row ${dup[1]}`;
  const sameEmail = /^same_email_as_row_(\d+)$/.exec(code);
  if (sameEmail) return `Same email as row ${sameEmail[1]}`;
  return NOTE_LABELS[code] ?? code.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ columns of the file */

export const DQ_EXTRA_FIELDS = ["city", "state", "district", "pincode", "category", "source", "dateAdded"] as const;
export type DqExtraField = (typeof DQ_EXTRA_FIELDS)[number];
export type DqExtraColumns = Record<DqExtraField, string | null>;

const EXTRA_ALIASES: Record<DqExtraField, string[]> = {
  city: ["city", "town", "city name"],
  state: ["state", "state name"],
  district: ["district", "district name"],
  pincode: ["pincode", "pin code", "pin", "postal code", "postcode", "zip", "zip code"],
  category: ["category", "industry", "business category", "business type", "sector", "segment"],
  source: ["source", "connector", "lead source", "data source"],
  dateAdded: ["date added", "added on", "first seen", "created at", "created on", "date"],
};

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Which original column holds the city, state, … (null when the file has none, or was uploaded before 0028). */
export function detectExtraColumns(headers: string[] | null): DqExtraColumns {
  const found = Object.fromEntries(DQ_EXTRA_FIELDS.map((f) => [f, null])) as DqExtraColumns;
  for (const field of DQ_EXTRA_FIELDS) {
    for (const alias of EXTRA_ALIASES[field]) {
      const hit = (headers ?? []).find((h) => headerKey(h) === alias);
      if (hit) {
        found[field] = hit;
        break;
      }
    }
  }
  return found;
}

const rawValue = (raw: unknown, header: string | null): string =>
  header && raw && typeof raw === "object" ? String((raw as Record<string, unknown>)[header] ?? "").trim() : "";

/* ------------------------------------------------------------------ filters */

const search = z.string().trim().max(100).optional();
const pick = z.string().trim().max(300).optional();
export const dqFiltersSchema = z
  .object({
    business: search,
    name: search,
    email: search,
    phone: search,
    city: pick,
    state: pick,
    district: pick,
    pincode: pick,
    category: pick,
    source: pick,
    dateAdded: pick,
    // LANDLINE = "likely landline" (an Indian number that isn't a mobile), any check status.
    status: z.array(z.enum(["VALID", "INVALID", "DUPLICATE", "EXCLUDED", "LANDLINE"])).max(5).optional(),
    phoneType: z.array(z.enum(PHONE_TYPES)).max(PHONE_TYPES.length).optional(),
    hasEmail: z.boolean().optional(),
    hasPhone: z.boolean().optional(),
    scoreMin: z.number().int().min(0).max(100).optional(),
    scoreMax: z.number().int().min(0).max(100).optional(),
    tier: z.array(z.enum(TIERS)).max(TIERS.length).optional(),
    review: z.array(z.enum(["PENDING", "APPROVED", "REJECTED"])).max(3).optional(),
  })
  .strict();
export type DqFilters = z.infer<typeof dqFiltersSchema>;

/** The table's own controls (status tab, "Only show rows scoring N+"), so the export matches the screen. */
export const dqViewSchema = z
  .object({ status: z.enum(["VALID", "INVALID", "DUPLICATE", "EXCLUDED"]).optional(), minScore: z.number().int().min(0).max(100).optional() })
  .strict();
export type DqView = z.infer<typeof dqViewSchema>;

/** The record fields a filter or an export reads (raw only when asked for). */
export interface DqRow {
  id: string;
  rowIndex: number;
  name: string | null;
  phoneRaw: string | null;
  phone: string | null;
  businessName: string | null;
  email: string | null;
  status: string;
  excludedReason: string | null;
  issues: unknown;
  flags: unknown;
  ruleScore: number | null;
  aiState: string;
  aiScore: number | null;
  aiNotes: string | null;
  review: string;
  raw?: unknown;
}

const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const digitsOf = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

const SEARCH_KEYS = ["business", "name", "email", "phone"] as const;
/** Filters that need the original row (city, state, …): only then is raw read. */
export const needsRaw = (f: DqFilters) => DQ_EXTRA_FIELDS.some((k) => !!f[k]);
export const hasFilters = (f: DqFilters) => Object.values(f).some((v) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0));

/** Every filter must match (AND); inside one group (statuses, phone types, tiers, reviews) any one will do. */
export function rowMatches(r: DqRow, f: DqFilters, view: DqView, cols: DqExtraColumns): boolean {
  const score = overallScore(r.ruleScore, r.aiScore);
  if (view.status && r.status !== view.status) return false;
  if (view.minScore != null && (score == null || score < view.minScore)) return false;

  const contains = (q: string | undefined, v: string | null) => !q || norm(v).includes(norm(q));
  if (!contains(f.business, r.businessName) || !contains(f.name, r.name) || !contains(f.email, r.email)) return false;
  if (f.phone) {
    const q = digitsOf(f.phone);
    if (!q || !(digitsOf(r.phone).includes(q) || digitsOf(r.phoneRaw).includes(q))) return false;
  }
  for (const field of DQ_EXTRA_FIELDS) {
    const want = f[field];
    if (want && rawValue(r.raw, cols[field]) !== want) return false;
  }

  const type = phoneType(r.phone, r.phoneRaw);
  if (f.status?.length && !f.status.some((s) => (s === "LANDLINE" ? type === "landline" : r.status === s))) return false;
  if (f.phoneType?.length && !f.phoneType.includes(type)) return false;
  if (f.hasEmail !== undefined && !!r.email !== f.hasEmail) return false;
  if (f.hasPhone !== undefined && !!r.phoneRaw !== f.hasPhone) return false;
  if (f.scoreMin !== undefined && (score == null || score < f.scoreMin)) return false;
  if (f.scoreMax !== undefined && (score == null || score > f.scoreMax)) return false;
  if (f.tier?.length) {
    const tier = tierFor(score);
    if (!tier || !f.tier.includes(tier)) return false;
  }
  if (f.review?.length && !f.review.includes(r.review as "PENDING")) return false;
  return true;
}

/** The filters as stored in the audit log: text searches become "[search]" (no contact data). */
export function filtersForLog(f: DqFilters, view: DqView): Record<string, unknown> {
  const out: Record<string, unknown> = { ...f };
  for (const k of SEARCH_KEYS) if (out[k]) out[k] = "[search]";
  if (view.status || view.minScore !== undefined) out.view = view;
  return out;
}

/* ------------------------------------------------------------------ reading in chunks */

export const DQ_CHUNK = 500;

/** Every record column except raw (the original row): what the results table needs. */
export const DQ_RECORD_SELECT = {
  id: true,
  jobId: true,
  rowIndex: true,
  name: true,
  phoneRaw: true,
  phone: true,
  businessName: true,
  email: true,
  status: true,
  excludedReason: true,
  issues: true,
  flags: true,
  ruleScore: true,
  aiState: true,
  aiScore: true,
  aiNotes: true,
  review: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The job's records in row order, DQ_CHUNK at a time (optionally only the given row numbers). */
async function* chunks(jobId: string, withRaw: boolean, rowIndexes?: number[]): AsyncGenerator<DqRow[]> {
  const select = { ...DQ_RECORD_SELECT, raw: withRaw };
  if (rowIndexes) {
    for (let i = 0; i < rowIndexes.length; i += DQ_CHUNK) {
      const slice = rowIndexes.slice(i, i + DQ_CHUNK);
      yield (await prisma.dataQualityRecord.findMany({ where: { jobId, rowIndex: { in: slice } }, orderBy: { rowIndex: "asc" }, select })) as DqRow[];
    }
    return;
  }
  let after = -1;
  for (;;) {
    const rows = (await prisma.dataQualityRecord.findMany({
      where: { jobId, rowIndex: { gt: after } },
      orderBy: { rowIndex: "asc" },
      take: DQ_CHUNK,
      select,
    })) as DqRow[];
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < DQ_CHUNK) return;
    after = rows[rows.length - 1]!.rowIndex;
  }
}

/** The rows the table shows for these filters (without raw). */
export async function filteredRecords(jobId: string, headers: string[] | null, f: DqFilters, view: DqView = {}): Promise<Omit<DqRow, "raw">[]> {
  const cols = detectExtraColumns(headers);
  const out: Omit<DqRow, "raw">[] = [];
  for await (const chunk of chunks(jobId, needsRaw(f))) {
    for (const { raw, ...row } of chunk) if (rowMatches({ ...row, raw }, f, view, cols)) out.push(row);
  }
  return out;
}

const FACET_LIMIT = 500;
export type DqFacets = { columns: DqExtraColumns; values: Partial<Record<DqExtraField, { value: string; count: number }[]>> };

/** The values in the file for each detected city / state / … column (for the dropdowns), most common first. */
export async function loadFacets(jobId: string, headers: string[] | null): Promise<DqFacets> {
  const columns = detectExtraColumns(headers);
  const present = DQ_EXTRA_FIELDS.filter((f) => columns[f]);
  const counts = new Map<DqExtraField, Map<string, number>>(present.map((f) => [f, new Map()]));
  if (present.length) {
    for await (const chunk of chunks(jobId, true)) {
      for (const r of chunk) {
        for (const f of present) {
          const v = rawValue(r.raw, columns[f]);
          if (v) counts.get(f)!.set(v, (counts.get(f)!.get(v) ?? 0) + 1);
        }
      }
    }
  }
  const values: DqFacets["values"] = {};
  for (const f of present) {
    values[f] = [...counts.get(f)!.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, FACET_LIMIT)
      .map(([value, count]) => ({ value, count }));
  }
  return { columns, values };
}

/* ------------------------------------------------------------------ export */

export const DQ_EXPORT_FIELDS = [
  "row", "name", "phone_raw", "business_name", "email", "phone", "phone_extension", "phone_type", "check_status",
  "excluded_reason", "score", "rule_score", "ai_score", "score_breakdown", "tier", "notes", "ai_notes", "review",
  "file_name", "upload_date",
] as const;
export type DqExportField = (typeof DQ_EXPORT_FIELDS)[number];

const FIELD_HEADERS: Record<DqExportField, string> = {
  row: "row",
  name: "name",
  phone_raw: "phone_as_written",
  business_name: "business_name",
  email: "email",
  phone: "phone_normalised",
  phone_extension: "phone_extension",
  phone_type: "phone_type",
  check_status: "check_status",
  excluded_reason: "excluded_reason",
  score: "score",
  rule_score: "rule_score",
  ai_score: "ai_score",
  score_breakdown: "score_breakdown",
  tier: "tier",
  notes: "notes",
  ai_notes: "ai_notes",
  review: "review",
  file_name: "file_name",
  upload_date: "upload_date",
};

/** Column keys: "col:<original header>" or "dq:<field>". Throws on an unknown key. */
export function checkColumns(columns: string[], headers: string[] | null): void {
  const known = new Set(headers ?? []);
  for (const c of columns) {
    if (c.startsWith("col:") && known.has(c.slice(4))) continue;
    if (c.startsWith("dq:") && (DQ_EXPORT_FIELDS as readonly string[]).includes(c.slice(3))) continue;
    throw new Error(`Unknown export column: ${c.slice(0, 80)}`);
  }
}

/** Header row: original headers as they were; a Data Quality name that clashes with one gets "dq_". */
export function exportHeaders(columns: string[]): string[] {
  const originals = new Set(columns.filter((c) => c.startsWith("col:")).map((c) => c.slice(4)));
  return columns.map((c) => {
    if (c.startsWith("col:")) return c.slice(4);
    const h = FIELD_HEADERS[c.slice(3) as DqExportField];
    return originals.has(h) ? `dq_${h}` : h;
  });
}

/** "rules 70 (No name -30) · AI 80 → 75"; empty for rows that are never scored. */
export function scoreBreakdown(r: Pick<DqRow, "ruleScore" | "aiScore" | "issues">): string {
  if (r.ruleScore == null) return "";
  const minus = ((r.issues as string[]) ?? []).filter((i) => ISSUE_PENALTY[i]).map((i) => `${noteLabel(i)} -${ISSUE_PENALTY[i]}`);
  const rules = `rules ${r.ruleScore}${minus.length ? ` (${minus.join(", ")})` : ""}`;
  return r.aiScore == null ? rules : `${rules} · AI ${r.aiScore} → ${overallScore(r.ruleScore, r.aiScore)}`;
}

/** Text a spreadsheet would run as a formula gets a leading '. A + or - followed only by a phone number stays. */
export function safeText(v: string): string {
  return /^[=@\t\r]/.test(v) || (/^[+-]/.test(v) && !/^[+-][\d\s().-]*$/.test(v)) ? `'${v}` : v;
}

type Cell = string | number | null;

function formatDate(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

interface ExportJob {
  id: string;
  filename: string;
  createdAt: Date;
  headers: string[] | null;
}

function cellFor(column: string, r: DqRow, job: ExportJob, uploaded: string): Cell {
  if (column.startsWith("col:")) return rawValue(r.raw, column.slice(4));
  const score = overallScore(r.ruleScore, r.aiScore);
  switch (column.slice(3) as DqExportField) {
    case "row": return r.rowIndex + 2; // spreadsheet row (header = row 1)
    case "name": return r.name;
    case "phone_raw": return r.phoneRaw;
    case "business_name": return r.businessName;
    case "email": return r.email;
    case "phone": return r.phone;
    case "phone_extension": return phoneExtension(r.phoneRaw);
    case "phone_type": return PHONE_TYPE_LABELS[phoneType(r.phone, r.phoneRaw)];
    case "check_status": return r.status;
    case "excluded_reason": return r.excludedReason ? (EXCLUDED_LABELS[r.excludedReason] ?? r.excludedReason) : null;
    case "score": return score;
    case "rule_score": return r.ruleScore;
    case "ai_score": return r.aiScore;
    case "score_breakdown": return scoreBreakdown(r);
    case "tier": {
      const tier = tierFor(score);
      return tier ? TIER_LABELS[tier] : null;
    }
    case "notes": return [...((r.issues as string[]) ?? []), ...((r.flags as string[]) ?? [])].map(noteLabel).join("; ");
    case "ai_notes": return r.aiNotes;
    case "review": return r.review.toLowerCase();
    case "file_name": return job.filename;
    case "upload_date": return uploaded;
  }
  return null;
}

const csvField = (v: Cell): string => {
  const s = v == null ? "" : typeof v === "number" ? String(v) : safeText(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const slug = (v: string, max: number) =>
  v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

/** dataquality_<file>_<filters>_<YYYYMMDD-HHMM>.<csv|xlsx>, ASCII only. Search text never goes in the name. */
export function exportFileName(filename: string, f: DqFilters, view: DqView, format: "csv" | "xlsx", now: Date, timeZone: string): string {
  const parts: string[] = [];
  for (const field of DQ_EXTRA_FIELDS) if (f[field]) parts.push(`${slug(field, 10)}-${slug(f[field]!, 20) || "x"}`);
  if (SEARCH_KEYS.some((k) => f[k])) parts.push("search");
  if (f.status?.length) parts.push(f.status.map((s) => s.toLowerCase()).join("-"));
  if (view.status) parts.push(view.status.toLowerCase());
  if (f.phoneType?.length) parts.push(`phone-${f.phoneType.join("-")}`);
  if (f.hasEmail !== undefined) parts.push(`email-${f.hasEmail ? "yes" : "no"}`);
  if (f.hasPhone !== undefined) parts.push(`phone-${f.hasPhone ? "yes" : "no"}`);
  if (f.scoreMin !== undefined || f.scoreMax !== undefined) parts.push(`score${f.scoreMin ?? 0}-${f.scoreMax ?? 100}`);
  if (view.minScore !== undefined) parts.push(`score${view.minScore}plus`);
  if (f.tier?.length) parts.push(`tier-${f.tier.map((t) => slug(t, 13)).join("-")}`);
  if (f.review?.length) parts.push(`review-${f.review.map((r) => r.toLowerCase()).join("-")}`);
  const summary = parts.join("_").slice(0, 60).replace(/[-_]+$/, "") || "all";
  const stamp = formatDate(now, timeZone).replace(/[-:]/g, "").replace(" ", "-");
  return `dataquality_${slug(filename.replace(/\.[^.]+$/, ""), 40) || "file"}_${summary}_${stamp}.${format}`;
}

const envInt = (name: string, fallback: number) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** One export holds at most this many rows (DATA_QUALITY_EXPORT_MAX_ROWS, default 50,000). */
export const exportMaxRows = () => envInt("DATA_QUALITY_EXPORT_MAX_ROWS", 50_000);

/** Low memory while a scoring job runs (free < DATA_QUALITY_EXPORT_MIN_FREE_MB, default 300): wait. */
export async function exportMustWait(): Promise<boolean> {
  if (freemem() / 1024 / 1024 >= envInt("DATA_QUALITY_EXPORT_MIN_FREE_MB", 300)) return false;
  return !!(await prisma.dataQualityJob.findFirst({ where: { status: "RUNNING" }, select: { id: true } }));
}

export interface ExportRequest {
  filters: DqFilters;
  view: DqView;
  columns: string[];
  format: "csv" | "xlsx";
  includeExcluded: boolean;
}

/**
 * The row numbers this export will hold, in order. Excluded rows (do not call, not interested,
 * wrong person) only when asked for. Ints only, so even the 50,000-row cap stays small.
 */
export async function matchingRows(job: ExportJob, req: ExportRequest): Promise<number[]> {
  const cols = detectExtraColumns(job.headers);
  const out: number[] = [];
  for await (const chunk of chunks(job.id, needsRaw(req.filters))) {
    for (const r of chunk) {
      if (r.status === "EXCLUDED" && !req.includeExcluded) continue;
      if (rowMatches(r, req.filters, req.view, cols)) out.push(r.rowIndex);
    }
  }
  return out;
}

/**
 * Stream the export: CSV (UTF-8 with BOM, so Tamil opens correctly in Excel) or XLSX (every value
 * a text cell, so phone numbers, pincodes and IDs keep their leading zeros and digits). Writes
 * exactly `rowIndexes`, DQ_CHUNK rows at a time, waiting for the connection when it is full.
 */
export async function streamExport(res: Response, job: ExportJob, req: ExportRequest, rowIndexes: number[], timeZone: string): Promise<void> {
  const withRaw = req.columns.some((c) => c.startsWith("col:"));
  const uploaded = formatDate(job.createdAt, timeZone);
  const headers = exportHeaders(req.columns);
  const values = (r: DqRow) => req.columns.map((c) => cellFor(c, r, job, uploaded));

  if (req.format === "csv") {
    const write = async (text: string) => {
      if (!res.write(text)) await once(res, "drain");
    };
    await write(`﻿${headers.map(csvField).join(",")}\r\n`);
    for await (const chunk of chunks(job.id, withRaw, rowIndexes)) {
      await write(chunk.map((r) => `${values(r).map(csvField).join(",")}\r\n`).join(""));
    }
    res.end();
    return;
  }

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: false, useSharedStrings: false });
  const ws = wb.addWorksheet("Data Quality");
  ws.addRow(headers).commit();
  for await (const chunk of chunks(job.id, withRaw, rowIndexes)) {
    for (const r of chunk) ws.addRow(values(r).map((v) => (typeof v === "string" ? safeText(v) : v))).commit();
  }
  ws.commit();
  await wb.commit();
}
