import { getAccessToken } from "./api";

/** Data Quality (admin only): staging jobs + rows from /api/data-quality. */
export type DqJobStatus = "RUNNING" | "PAUSED" | "CANCELLED" | "DONE";
export type DqRecordStatus = "VALID" | "INVALID" | "DUPLICATE" | "EXCLUDED";
export type DqReview = "PENDING" | "APPROVED" | "REJECTED";

export interface DqJob {
  id: string;
  filename: string;
  status: DqJobStatus;
  mapping: Record<"name" | "phone" | "business" | "email", string | null>;
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  excluded: number;
  aiStatus: "pending" | "done" | "unavailable" | "cancelled";
  aiModel: string | null;
  aiDone: number;
  aiFailures: number;
  note: string | null;
  waitingReason: string | null;
  createdByEmail: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DqRecord {
  id: string;
  rowIndex: number;
  name: string | null;
  phoneRaw: string | null;
  phone: string | null;
  businessName: string | null;
  email: string | null;
  status: DqRecordStatus;
  excludedReason: "do_not_call" | "not_interested" | "wrong_person" | null;
  issues: string[];
  flags: string[];
  ruleScore: number | null;
  aiState: "PENDING" | "DONE" | "ERROR" | "SKIPPED" | "NONE";
  aiScore: number | null;
  aiNotes: string | null;
  review: DqReview;
  score: number | null;
}

export type AiProvider = "ollama" | "groq" | "gemini";
export const AI_PROVIDER_LABELS: Record<AiProvider, string> = { ollama: "Ollama", groq: "Groq", gemini: "Gemini" };

export interface DqStatusInfo {
  /** The AI service picked by DATA_QUALITY_AI_PROVIDER on the server. */
  ai: { provider: AiProvider; configured: boolean; available: boolean; model: string | null; reason: string | null };
  liveCalls: boolean;
}

const ISSUE_LABELS: Record<string, string> = {
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

export const EXCLUDED_LABELS: Record<string, string> = {
  do_not_call: "Do not call",
  not_interested: "Not interested",
  wrong_person: "Wrong person",
};

/** "duplicate_of_row_5" → "Same number as row 5", "same_email_as_row_5" → "Same email as row 5"; other codes from ISSUE_LABELS. */
export function issueLabel(code: string): string {
  const dup = /^duplicate_of_row_(\d+)$/.exec(code);
  if (dup) return `Same number as row ${dup[1]}`;
  const sameEmail = /^same_email_as_row_(\d+)$/.exec(code);
  if (sameEmail) return `Same email as row ${sameEmail[1]}`;
  return ISSUE_LABELS[code] ?? code.replace(/_/g, " ");
}

/** Save a download response as a file (the name from Content-Disposition, else `fallback`). */
async function saveDownload(res: Response, fallback: string) {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Save the CSV export (an authenticated fetch, like the Send Queue export). */
export async function downloadDataQualityExport(jobId: string, rows: "approved" | "valid") {
  const token = getAccessToken();
  const res = await fetch(`/api/data-quality/jobs/${encodeURIComponent(jobId)}/export?rows=${rows}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  await saveDownload(res, `data-quality-${rows}.csv`);
}

/* ------------------------------------------------------------------ filters + filtered export */

export type DqPhoneType = "mobile" | "landline" | "tollfree" | "international" | "unusable" | "none";
export type DqTier = "HIGH_PRIORITY" | "GOOD" | "REVIEW" | "REJECT";
export type DqExtraField = "city" | "state" | "district" | "pincode" | "category" | "source" | "dateAdded";

/** Same shape as the server's dqFiltersSchema (apps/api/src/domain/dataQualityExport.ts). */
export interface DqFilters {
  business?: string;
  name?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  district?: string;
  pincode?: string;
  category?: string;
  source?: string;
  dateAdded?: string;
  status?: ("VALID" | "INVALID" | "DUPLICATE" | "EXCLUDED" | "LANDLINE")[];
  phoneType?: DqPhoneType[];
  hasEmail?: boolean;
  hasPhone?: boolean;
  scoreMin?: number;
  scoreMax?: number;
  tier?: DqTier[];
  review?: DqReview[];
}

export interface DqFacets {
  headers: string[] | null;
  columns: Record<DqExtraField, string | null>;
  values: Partial<Record<DqExtraField, { value: string; count: number }[]>>;
}

export const EXTRA_FIELD_LABELS: Record<DqExtraField, string> = {
  city: "City",
  state: "State",
  district: "District",
  pincode: "Pincode",
  category: "Category / industry",
  source: "Source",
  dateAdded: "Date added",
};
export const CHECK_STATUS_OPTIONS = [
  ["VALID", "Valid"],
  ["INVALID", "Invalid"],
  ["DUPLICATE", "Duplicate"],
  ["EXCLUDED", "Excluded"],
  ["LANDLINE", "Likely landline"],
] as const;
export const PHONE_TYPE_OPTIONS: [DqPhoneType, string][] = [
  ["mobile", "Mobile"],
  ["landline", "Landline"],
  ["tollfree", "Toll-free"],
  ["international", "Other country"],
  ["unusable", "Unusable"],
  ["none", "No phone"],
];
export const TIER_OPTIONS: [DqTier, string][] = [
  ["HIGH_PRIORITY", "High priority (85+)"],
  ["GOOD", "Good (70–84)"],
  ["REVIEW", "Review (50–69)"],
  ["REJECT", "Reject (below 50)"],
];

/** Drop empty values so "no filter" is {} (the server then shows the file as before). */
export function cleanFilters(f: DqFilters): DqFilters {
  return Object.fromEntries(
    Object.entries(f).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "number" && Number.isNaN(v))),
  ) as DqFilters;
}

export const DQ_COMPUTED_COLUMNS = [
  ["dq:phone", "Phone (normalised)"],
  ["dq:phone_extension", "Phone extension"],
  ["dq:phone_type", "Phone type"],
  ["dq:check_status", "Check status"],
  ["dq:excluded_reason", "Excluded reason"],
  ["dq:score", "Score"],
  ["dq:rule_score", "Rules score"],
  ["dq:ai_score", "AI score"],
  ["dq:score_breakdown", "Score breakdown"],
  ["dq:tier", "Tier"],
  ["dq:notes", "Notes / reasons"],
  ["dq:ai_notes", "AI result"],
  ["dq:review", "Review status"],
  ["dq:file_name", "File name"],
  ["dq:row", "Row number"],
  ["dq:upload_date", "Upload date"],
] as const;
/** The mapped values as stored (the only original data kept for files uploaded before this update). */
export const DQ_STORED_COLUMNS = [
  ["dq:name", "Name"],
  ["dq:phone_raw", "Phone (as written)"],
  ["dq:business_name", "Business name"],
  ["dq:email", "Email"],
] as const;

export type ExportPreset = "all" | "call" | "email" | "custom";
export const EXPORT_PRESETS: [ExportPreset, string][] = [
  ["all", "All details"],
  ["call", "Call-ready (name, phone, business)"],
  ["email", "Email-ready (name, email, business)"],
  ["custom", "Choose columns"],
];

/** The columns of a preset. "All details": every original column (or the stored ones) + every Data Quality column. */
export function presetColumns(preset: Exclude<ExportPreset, "custom">, headers: string[] | null): string[] {
  if (preset === "call") return ["dq:name", "dq:phone", "dq:business_name"];
  if (preset === "email") return ["dq:name", "dq:email", "dq:business_name"];
  const originals = headers?.length ? headers.map((h) => `col:${h}`) : DQ_STORED_COLUMNS.map(([k]) => k);
  return [...originals, ...DQ_COMPUTED_COLUMNS.map(([k]) => k)];
}

export interface FilteredExportRequest {
  filters: DqFilters;
  view: { status?: DqRecordStatus; minScore?: number };
  columns: string[];
  format: "csv" | "xlsx";
  includeExcluded: boolean;
}

/** Download the filtered export; returns how many rows the server wrote. */
export async function downloadFilteredExport(jobId: string, body: FilteredExportRequest): Promise<number> {
  const token = getAccessToken();
  const res = await fetch(`/api/data-quality/jobs/${encodeURIComponent(jobId)}/export-filtered`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  await saveDownload(res, `dataquality-export.${body.format}`);
  return Number(res.headers.get("x-row-count") ?? 0);
}
