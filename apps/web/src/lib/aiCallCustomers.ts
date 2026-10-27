import { useQuery } from "@tanstack/react-query";
import type { AiCallCustomerColumnMapping, AiCallLanguage, AiCallLanguageInfo, AiCallStage } from "@dispatch/shared";
import { api, getAccessToken } from "./api";
import type { BadgeTone } from "../components/ui";

export interface AiCallCustomer {
  id: string;
  customerName: string | null;
  gender: "male" | "female" | "unknown" | string;
  phone: string;
  businessName: string | null;
  followUpDetail: string | null;
  email: string | null;
  whatsappOptIn: boolean;
  stage: AiCallStage;
  needsReview: boolean;
  doNotCall: boolean;
  /** Do not call was set for this number in another language's list (this row's own flag is false). */
  doNotCallSetIn?: AiCallLanguage | null;
  lastCalledAt: string | null;
  createdAt: string;
}

/** The lists a customer can also go into: languages switched on in Settings, this page's own first. */
export function openLanguages(languages: AiCallLanguageInfo[] | undefined, current: AiCallLanguage): AiCallLanguage[] {
  return [current, ...(languages ?? []).filter((l) => l.enabled && l.code !== current).map((l) => l.code)];
}

export interface AddToLanguageResult {
  language: AiCallLanguage;
  status: "added" | "exists" | "failed";
  message: string | null;
  customerId: string | null;
}

export interface CopyToLanguageResult {
  language: AiCallLanguage;
  added: number;
  exists: number;
  doNotCall: number;
  failed: number;
}

export interface AiCallCustomerPage {
  items: AiCallCustomer[];
  total: number;
  page: number;
  pageSize: number;
}

export type FollowupStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "CANCELLED" | "FAILED";

export interface AiCallFollowup {
  id: string;
  customerId: string;
  channel: "WHATSAPP" | "CALL";
  status: FollowupStatus;
  reason: string | null;
  whatsappTemplateId: string | null;
  whatsappTemplateName?: string | null;
  scheduledAt: string | null;
  attempt: number;
  note: string | null;
  error: string | null;
  createdByEmail: string | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
  createdAt: string;
  delivery: { status: string; at: string | null; detail: string | null } | null;
  customer?: {
    id: string;
    customerName: string | null;
    phone: string;
    businessName: string | null;
    stage: AiCallStage;
    whatsappOptIn: boolean;
    deletedAt: string | null;
    doNotCall: boolean;
    /** The customer's language list (absent on an older API = English). */
    language?: AiCallLanguage;
  };
}

export interface AiCallCustomerCall {
  id: string;
  runId: string;
  status: string;
  outcome: string | null;
  summary: string | null;
  transcript: string | null;
  error: string | null;
  durationSec: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface TimelineItem {
  at: string;
  type: string;
  stage: AiCallStage | null;
  detail: string | null;
  actor: string | null;
}

export interface AiCallCustomerDetail {
  customer: AiCallCustomer & { deletedAt: string | null };
  calls: AiCallCustomerCall[];
  followups: AiCallFollowup[];
  timeline: TimelineItem[];
}

export interface CustomerSheet {
  headers: string[];
  rows: Record<string, string>[];
  truncated: boolean;
  mapping: AiCallCustomerColumnMapping;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  duplicates: number;
  doNotCall: number;
  problems: { row: number; errors: string[] }[];
}

export type LanguageImportSummary = ImportSummary & { language: AiCallLanguage; failed: boolean };

export const STAGE_TONE: Record<AiCallStage, BadgeTone> = {
  NOT_CALLED: "neutral",
  QUEUED: "accent",
  CALLING: "accent",
  NO_ANSWER: "warn",
  FAILED: "crit",
  INTERESTED: "ok",
  NOT_INTERESTED: "neutral",
  FOLLOW_UP_NEEDED: "warn",
  CALLBACK_REQUESTED: "warn",
  DO_NOT_CALL: "crit",
  APPROVED: "ok",
  REJECTED: "neutral",
};

export function useAiCallCustomerDetail(id: string | null) {
  return useQuery({
    queryKey: ["ai-call-customer", id],
    queryFn: () => api<AiCallCustomerDetail>(`/api/ai-call-customers/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ["QUEUED", "CALLING"].includes(q.state.data.customer.stage) ? 4000 : false),
  });
}

/** WhatsApp templates for the follow-up template picker (existing endpoint). */
export function useWhatsAppTemplateOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp-templates"],
    queryFn: () =>
      api<{ items: { id: string; name: string; providerTemplateName: string | null }[] }>("/api/whatsapp/templates"),
    enabled,
    staleTime: 60_000,
  });
}

/** Save the sample .xlsx (binary, so a plain authenticated fetch rather than api()). */
export async function downloadSample() {
  const token = getAccessToken();
  const res = await fetch("/api/ai-call-customers/sample", {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = "sample-ai-call-customers.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
