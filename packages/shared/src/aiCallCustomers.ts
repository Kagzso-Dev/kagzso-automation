import { z } from "zod";
import { aiCallGreetingDelay, isAiCallGender, normalizeAiCallGender, normalizePhoneE164, type AiCallGender } from "./aiCalls.js";
import { aiCallLanguage, DEFAULT_AI_CALL_LANGUAGE } from "./aiCallLanguages.js";

/* ------------------------------------------------------------------ AI Call Customers (isolated) */
// Saved customers for AI voice calls, their call stage and follow-up rules.
// Shared so the browser preview and the API validate identically. Phone
// numbers go through the one normaliser, normalizePhoneE164 (+91 default).

export const AI_CALL_STAGES = [
  "NOT_CALLED",
  "QUEUED",
  "CALLING",
  "NO_ANSWER",
  "FAILED",
  "INTERESTED",
  "NOT_INTERESTED",
  "FOLLOW_UP_NEEDED",
  "CALLBACK_REQUESTED",
  "DO_NOT_CALL",
  "APPROVED",
  "REJECTED",
] as const;
export type AiCallStage = (typeof AI_CALL_STAGES)[number];

export const AI_CALL_STAGE_LABELS: Record<AiCallStage, string> = {
  NOT_CALLED: "Not called",
  QUEUED: "Queued",
  CALLING: "Calling",
  NO_ANSWER: "No answer",
  FAILED: "Failed",
  INTERESTED: "Interested",
  NOT_INTERESTED: "Not interested",
  FOLLOW_UP_NEEDED: "Follow-up needed",
  CALLBACK_REQUESTED: "Callback requested",
  DO_NOT_CALL: "Do not call",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

/** Stages an admin may pick by hand. Queued / Calling are set by the dialler only. */
export const AI_CALL_MANUAL_STAGES: readonly AiCallStage[] = AI_CALL_STAGES.filter(
  (s) => s !== "QUEUED" && s !== "CALLING",
);

/** Stages that create follow-up drafts (all wait for admin approval). */
export const FOLLOW_UP_STAGES: readonly AiCallStage[] = ["INTERESTED", "FOLLOW_UP_NEEDED", "APPROVED"];

/* ------------------------------------------------------------------ phone display */

/**
 * "+919876543210" → "+91 98765 43210". Other country codes: "+<cc-ish> <rest>"
 * is not reliably splittable, so they are shown as stored. Non-E.164 input is
 * normalised first; anything unparseable is returned unchanged.
 */
export function formatPhoneDisplay(phone: string | null | undefined, defaultCountryCode = "91"): string {
  const raw = String(phone ?? "").trim();
  if (!raw) return "";
  const e164 = normalizePhoneE164(raw, defaultCountryCode);
  if (!e164) return raw;
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/* ------------------------------------------------------------------ import columns */

export const AI_CALL_CUSTOMER_FIELDS = [
  "customer_name",
  "gender",
  "phone",
  "business_name",
  "follow_up_detail",
  "email",
  "whatsapp_opt_in",
] as const;
export type AiCallCustomerField = (typeof AI_CALL_CUSTOMER_FIELDS)[number];
export type AiCallCustomerColumnMapping = Record<AiCallCustomerField, string | null>;

const CUSTOMER_HEADER_ALIASES: Record<AiCallCustomerField, string[]> = {
  customer_name: [
    "customer_name", "customer name", "customer", "name", "full name", "full_name", "fullname",
    "contact name", "contact_name",
  ],
  gender: ["gender", "sex"],
  phone: [
    "phone", "phone number", "phone_number", "phone no", "mobile", "mobile number", "mobile_number",
    "mobile no", "contact number", "number",
  ],
  business_name: [
    "business_name", "business name", "business", "company", "company name", "company_name", "organisation",
    "organization", "firm",
  ],
  follow_up_detail: [
    "follow_up_detail", "follow up detail", "follow-up detail", "follow up", "follow-up", "followup",
    "follow_up", "follow up details", "notes", "note", "remarks", "details",
  ],
  email: ["email", "e-mail", "email address", "email_address", "mail"],
  whatsapp_opt_in: [
    "whatsapp_opt_in", "whatsapp opt in", "whatsapp opt-in", "whatsapp optin", "whatsapp", "opt in", "opt-in",
    "optin",
  ],
};

const headerKey = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

/** Auto-detect which column holds each field. Alias order is priority; a column is used once. */
export function detectAiCallCustomerColumns(headers: string[]): AiCallCustomerColumnMapping {
  const mapping = Object.fromEntries(AI_CALL_CUSTOMER_FIELDS.map((f) => [f, null])) as AiCallCustomerColumnMapping;
  const used = new Set<string>();
  for (const field of AI_CALL_CUSTOMER_FIELDS) {
    for (const alias of CUSTOMER_HEADER_ALIASES[field]) {
      const hit = headers.find((h) => !used.has(h) && headerKey(h) === alias);
      if (hit) {
        mapping[field] = hit;
        used.add(hit);
        break;
      }
    }
  }
  return mapping;
}

/** yes / y / true / 1 / opted in → true; anything else (incl. blank) → false. */
export function parseOptIn(raw: unknown): boolean {
  return ["yes", "y", "true", "1", "opted in", "opt in", "opt-in", "optin"].includes(
    String(raw ?? "").trim().toLowerCase(),
  );
}

/* ------------------------------------------------------------------ row validation */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AiCallCustomerRowInput {
  customerName?: string | null;
  gender?: string | null;
  phone?: string | null;
  businessName?: string | null;
  followUpDetail?: string | null;
  email?: string | null;
  whatsappOptIn?: boolean | string | null;
}

export interface AiCallCustomerRowCheck {
  phone: string | null;
  gender: AiCallGender;
  email: string | null;
  /** Blocking — the row is not imported. */
  errors: string[];
  /** Non-blocking — imported with a fallback. */
  warnings: string[];
}

/**
 * Validate one customer row. Errors: missing / invalid phone, a gender value
 * that isn't recognised is saved as Male (a warning, never an error), invalid email.
 */
export function checkAiCallCustomerRow(row: AiCallCustomerRowInput, defaultCountryCode = "91"): AiCallCustomerRowCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawPhone = String(row.phone ?? "").trim();
  const phone = rawPhone ? normalizePhoneE164(rawPhone, defaultCountryCode) : null;
  if (!rawPhone) errors.push("Missing phone");
  else if (!phone) errors.push("Invalid phone");

  // Only Male / Female: a missing or unrecognised gender is saved as Male (never an error).
  const rawGender = String(row.gender ?? "").trim();
  const gender = normalizeAiCallGender(rawGender);
  if (!isAiCallGender(rawGender)) warnings.push(rawGender ? `Gender "${rawGender.slice(0, 20)}" — saved as Male` : "No gender — saved as Male");

  const rawEmail = String(row.email ?? "").trim().toLowerCase();
  const email = rawEmail || null;
  if (email && !EMAIL_RE.test(email)) errors.push("Invalid email");

  if (!String(row.customerName ?? "").trim()) warnings.push("No name — greeting without a name");
  return { phone, gender, email, errors, warnings };
}

/* ------------------------------------------------------------------ outcome → stage */

/**
 * Suggested stage once a call has a final status (and maybe an AI-classified
 * outcome from the voice backend). The status decides unanswered / failed
 * calls; the classifier's outcome decides answered ones.
 */
export function stageForCallResult(status: string, outcome: string | null | undefined): AiCallStage {
  const o = (outcome ?? "").toLowerCase();
  if (o === "do_not_call") return "DO_NOT_CALL"; // always wins
  switch (status) {
    case "NO_ANSWER":
    case "BUSY":
      return "NO_ANSWER";
    case "FAILED":
    case "CANCELLED":
      return "FAILED";
  }
  switch (o) {
    case "interested":
      return "INTERESTED";
    case "not_interested":
      return "NOT_INTERESTED";
    case "callback_requested":
      return "CALLBACK_REQUESTED";
    case "no_answer":
    case "busy":
    case "voicemail":
      return "NO_ANSWER";
    case "call_failed":
      return "FAILED";
    default:
      // completed / unknown / not classified yet; also wrong_person: someone else answering, or an
      // unclear identity, is never "not interested" - the stage follows the answer to the pitch.
      return "FOLLOW_UP_NEEDED";
  }
}

/* ------------------------------------------------------------------ follow-up rules */

export type AiCallFollowupChannel = "WHATSAPP" | "CALL";

export interface FollowupDraftPlan {
  channel: AiCallFollowupChannel;
  /** Hours from now for a CALL draft (the admin can change it before approving). */
  callInHours?: number;
}

/**
 * Which follow-up drafts a stage creates. Every draft waits for admin approval.
 *  - Interested / Follow-up needed / Approved → WhatsApp (if opted in), else a call-again.
 *  - Callback requested → a call-again.
 *  - No answer → a call-again, only while `noAnswerRetries` < `maxRetries`.
 *  - Not interested, Do not call, Failed and the rest → nothing.
 */
export function followupsForStage(
  stage: AiCallStage,
  ctx: { whatsappOptIn: boolean; doNotCall: boolean; noAnswerRetries: number; maxRetries: number },
): FollowupDraftPlan[] {
  if (ctx.doNotCall || stage === "DO_NOT_CALL") return [];
  if (FOLLOW_UP_STAGES.includes(stage)) {
    return ctx.whatsappOptIn ? [{ channel: "WHATSAPP" }] : [{ channel: "CALL", callInHours: 24 }];
  }
  if (stage === "CALLBACK_REQUESTED") return [{ channel: "CALL", callInHours: 24 }];
  if (stage === "NO_ANSWER" && ctx.noAnswerRetries < ctx.maxRetries) return [{ channel: "CALL", callInHours: 4 }];
  return [];
}

/* ------------------------------------------------------------------ API inputs */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const aiCallCustomerInput = z.object({
  customerName: optionalText(100),
  gender: z.string().trim().max(20).optional().nullable(),
  phone: z.string().trim().min(1, "Phone is required").max(40),
  businessName: optionalText(160),
  followUpDetail: optionalText(500),
  email: z
    .string()
    .trim()
    .max(191)
    .optional()
    .nullable()
    .transform((v) => (v ? v.toLowerCase() : null))
    .refine((v) => !v || EMAIL_RE.test(v), "Invalid email"),
  whatsappOptIn: z.boolean().default(false),
});
export type AiCallCustomerInput = z.infer<typeof aiCallCustomerInput>;

export const listAiCallCustomersQuery = z.object({
  /** The language list (absent = English). */
  language: aiCallLanguage.default(DEFAULT_AI_CALL_LANGUAGE),
  search: z.string().trim().max(100).optional(),
  gender: z.enum(["male", "female"]).optional(),
  stage: z.enum(AI_CALL_STAGES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const importAiCallCustomersInput = z.object({
  rows: z
    .array(
      z.object({
        customerName: z.string().max(200).optional().nullable(),
        gender: z.string().max(40).optional().nullable(),
        phone: z.string().max(60).optional().nullable(),
        businessName: z.string().max(300).optional().nullable(),
        followUpDetail: z.string().max(2000).optional().nullable(),
        email: z.string().max(300).optional().nullable(),
        whatsappOptIn: z.union([z.boolean(), z.string().max(20)]).optional().nullable(),
      }),
    )
    .min(1, "No rows to import")
    .max(5000),
});

export const bulkIdsInput = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });

/* ------------------------------------------------------------------ several language lists (admin) */
// The same number may be in each language's list. The server accepts only languages switched on in Settings.

/** Language lists to add / copy / import into, each once. */
export const aiCallLanguageList = z
  .array(aiCallLanguage)
  .min(1, "Pick at least one language")
  .max(20)
  .transform((l) => [...new Set(l)]);

/** Add one customer to several language lists at once (the page's own language first). */
export const addCustomerToLanguagesInput = z.object({ customer: aiCallCustomerInput, languages: aiCallLanguageList }).strict();

/** Copy ticked customers into other language lists. dryRun = the preview (counts only, nothing saved). */
export const copyCustomersToLanguagesInput = z
  .object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500), targets: aiCallLanguageList, dryRun: z.boolean().default(false) })
  .strict();

/** Import mapped rows into several language lists (the page's own language first). */
export const importAiCallCustomersToLanguagesInput = importAiCallCustomersInput.extend({ languages: aiCallLanguageList }).strict();

export const setAiCallStageInput = z.object({
  stage: z.enum(AI_CALL_STAGES).refine((s) => s !== "QUEUED" && s !== "CALLING", "That stage is set by the dialler"),
  note: z.string().trim().max(500).optional(),
});

/** Start AI calls for saved customers: same options as /api/ai-calls/start, rows come from the DB. */
export const callAiCallCustomersInput = z
  .object({
    customerIds: z.array(z.string().min(1).max(64)).min(1).max(5000),
    mode: z.enum(["random", "selected", "all"]),
    randomCount: z.coerce.number().int().min(1).max(500).default(1),
    selectedIndexes: z.array(z.number().int().min(0)).max(5000).default([]),
    gapSeconds: z.coerce.number().int().min(5).max(3600).default(30),
    greetingDelaySec: aiCallGreetingDelay,
    maxCalls: z.coerce.number().int().min(1).max(500).default(10),
    dryRun: z.boolean().default(false),
    flowId: z.string().min(1).max(64).optional().nullable(),
    /** The language list being called: only its customers, with one of its flows. */
    language: aiCallLanguage.default(DEFAULT_AI_CALL_LANGUAGE),
  })
  .refine((v) => v.mode !== "selected" || v.selectedIndexes.length > 0, {
    message: "Select at least one customer to call",
    path: ["selectedIndexes"],
  });

export const createFollowupInput = z.object({
  channel: z.enum(["WHATSAPP", "CALL"]),
  whatsappTemplateId: z.string().min(1).max(64).optional().nullable(),
  scheduledAt: z.coerce.date().optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
});

export const editFollowupInput = z.object({
  whatsappTemplateId: z.string().min(1).max(64).optional().nullable(),
  scheduledAt: z.coerce.date().optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
});

export const listFollowupsQuery = z.object({
  status: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED", "CANCELLED", "FAILED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
