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

export interface DqStatusInfo {
  ollama: { configured: boolean; available: boolean; model: string | null; reason: string | null };
  liveCalls: boolean;
}

const ISSUE_LABELS: Record<string, string> = {
  bad_phone: "Bad phone number",
  missing_phone: "No phone number",
  missing_name: "No name",
  suspicious_name: "Name looks wrong",
  missing_business: "No business name",
  bad_email: "Bad email",
  in_voicecall: "Already in Voicecall Contact",
  in_whatsapp: "Already in WhatsApp Contacts",
  in_email_contacts: "Already in Email Contacts",
};

export const EXCLUDED_LABELS: Record<string, string> = {
  do_not_call: "Do not call",
  not_interested: "Not interested",
  wrong_person: "Wrong person",
};

/** "duplicate_of_row_5" → "Same number as row 5"; other codes from ISSUE_LABELS. */
export function issueLabel(code: string): string {
  const dup = /^duplicate_of_row_(\d+)$/.exec(code);
  if (dup) return `Same number as row ${dup[1]}`;
  return ISSUE_LABELS[code] ?? code.replace(/_/g, " ");
}

/** Save the CSV export (an authenticated fetch, like the Send Queue export). */
export async function downloadDataQualityExport(jobId: string, rows: "approved" | "valid") {
  const token = getAccessToken();
  const res = await fetch(`/api/data-quality/jobs/${encodeURIComponent(jobId)}/export?rows=${rows}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `data-quality-${rows}.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
