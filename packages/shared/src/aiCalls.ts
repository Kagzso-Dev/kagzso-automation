import { z } from "zod";

/* ------------------------------------------------------------------ AI calls (isolated) */
// Parsing / validation helpers for the "AI Call" flow on the Contacts page.
// Shared so the browser preview and the API validate rows identically. No
// dependency on the email or WhatsApp schemas.

export const AI_CALL_FIELDS = ["customer_name", "gender", "follow_up_detail", "phone"] as const;
export type AiCallField = (typeof AI_CALL_FIELDS)[number];

/** Column → field. `null` means the field is not mapped to any column. */
export type AiCallColumnMapping = Record<AiCallField, string | null>;

const HEADER_ALIASES: Record<AiCallField, string[]> = {
  customer_name: [
    "customer_name", "customer name", "customer", "name", "full name", "full_name", "fullname",
    "contact name", "contact_name",
  ],
  gender: ["gender", "sex"],
  follow_up_detail: [
    "follow_up_detail", "follow up detail", "follow-up detail", "follow up", "follow-up", "followup",
    "follow_up", "follow up details", "notes", "note", "remarks", "details",
  ],
  phone: [
    "phone", "phone number", "phone_number", "phone no", "mobile", "mobile number", "mobile_number",
    "mobile no", "contact number", "number",
  ],
};

const headerKey = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

/** Auto-detect which column holds each field. First matching header wins. */
export function detectAiCallColumns(headers: string[]): AiCallColumnMapping {
  const mapping = { customer_name: null, gender: null, follow_up_detail: null, phone: null } as AiCallColumnMapping;
  const used = new Set<string>();
  for (const field of AI_CALL_FIELDS) {
    // Alias order is the priority order ("customer name" beats "name").
    for (const alias of HEADER_ALIASES[field]) {
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

/**
 * Normalise a phone number to E.164 (+<country><number>), or null if it isn't
 * dialable. Numbers without an explicit international prefix get
 * `defaultCountryCode` (India, 91, by default). Indian national numbers must
 * be exactly 10 digits not starting with 0 (after stripping a trunk 0).
 */
export function normalizePhoneE164(raw: unknown, defaultCountryCode = "91"): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Spreadsheet numbers can arrive as 9.87654321E9.
  if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = n.toFixed(0);
  }
  const cc = defaultCountryCode.replace(/\D/g, "") || "91";
  let international = false;
  if (s.startsWith("+")) international = true;
  let digits = s.replace(/\D/g, "");
  if (!international && digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
  if (!digits) return null;

  if (!international) {
    if (cc === "91") {
      if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
      if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
      if (digits.length !== 10) return null;
      digits = cc + digits; // always: a mobile like 91234 56789 itself starts with "91"
    } else {
      digits = digits.replace(/^0+/, "");
      if (!digits.startsWith(cc)) digits = cc + digits;
    }
  }

  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  if (digits.startsWith("91") && !/^91[1-9]\d{9}$/.test(digits)) return null;
  return `+${digits}`;
}

export type AiCallGender = "male" | "female" | "unknown";

/** male / female from common spellings; anything else (incl. blank) is unknown. */
export function normalizeAiCallGender(raw: unknown): AiCallGender {
  const v = String(raw ?? "").trim().toLowerCase().replace(/\./g, "");
  if (["m", "male", "man", "mr", "boy", "gents"].includes(v)) return "male";
  if (["f", "female", "woman", "ms", "mrs", "miss", "girl", "ladies"].includes(v)) return "female";
  return "unknown";
}

/** "+919876543210" → "+91******3210". For logs and anywhere a full number isn't needed. */
export function maskPhone(phone: string | null | undefined): string {
  const s = String(phone ?? "");
  if (s.length <= 6) return s.replace(/\d/g, "*");
  const keepStart = s.startsWith("+") ? 3 : 2;
  return s.slice(0, keepStart) + "*".repeat(s.length - keepStart - 4) + s.slice(-4);
}

export interface AiCallRowInput {
  customerName?: string | null;
  gender?: string | null;
  followUpDetail?: string | null;
  phone?: string | null;
}

export interface AiCallRowCheck {
  phone: string | null;
  gender: AiCallGender;
  /** Blocking problems — the row can't be called. */
  errors: string[];
  /** Non-blocking — the row is called, but with a fallback (e.g. neutral greeting). */
  warnings: string[];
}

export function checkAiCallRow(row: AiCallRowInput, defaultCountryCode = "91"): AiCallRowCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawPhone = String(row.phone ?? "").trim();
  const phone = rawPhone ? normalizePhoneE164(rawPhone, defaultCountryCode) : null;
  if (!rawPhone) errors.push("Missing phone");
  else if (!phone) errors.push("Invalid phone");
  const gender = normalizeAiCallGender(row.gender);
  if (gender === "unknown") warnings.push("Unknown gender — neutral greeting");
  if (!String(row.customerName ?? "").trim()) warnings.push("No name — greeting without a name");
  return { phone, gender, errors, warnings };
}

/** Values as read from the file, already mapped to fields by the browser. */
export const aiCallRow = z.object({
  customerName: z.string().trim().max(100).optional().nullable(),
  gender: z.string().trim().max(20).optional().nullable(),
  followUpDetail: z.string().trim().max(500).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
});
export type AiCallRow = z.infer<typeof aiCallRow>;

export const aiCallMode = z.enum(["random", "selected", "all"]);
export type AiCallMode = z.infer<typeof aiCallMode>;

/** "AI Greeting Delay (seconds)" in the Start AI Calls window: default and maximum. */
export const AI_CALL_DEFAULT_GREETING_DELAY_SEC = 2;
export const AI_CALL_MAX_GREETING_DELAY_SEC = 10;
/** Seconds after the customer answers before the AI greets (if they speak first it greets at once). */
export const aiCallGreetingDelay = z.coerce
  .number()
  .min(0, "AI greeting delay must be 0 to 10 seconds")
  .max(AI_CALL_MAX_GREETING_DELAY_SEC, "AI greeting delay must be 0 to 10 seconds")
  .refine((v) => Number.isInteger(v * 2), "Use whole or half seconds (e.g. 1.5)")
  .default(AI_CALL_DEFAULT_GREETING_DELAY_SEC);

export const startAiCallsInput = z
  .object({
    rows: z.array(aiCallRow).min(1, "No rows to call").max(5000),
    mode: aiCallMode,
    /** random mode: how many rows to pick. */
    randomCount: z.coerce.number().int().min(1).max(500).default(1),
    /** selected mode: indexes into `rows`. */
    selectedIndexes: z.array(z.number().int().min(0)).max(5000).default([]),
    gapSeconds: z.coerce.number().int().min(5).max(3600).default(30),
    greetingDelaySec: aiCallGreetingDelay,
    maxCalls: z.coerce.number().int().min(1).max(500).default(10),
    /** true: validate and report what would happen, create nothing. */
    dryRun: z.boolean().default(false),
    /** Call flow to use (its latest published version is pinned to the run). Absent = the default agent. */
    flowId: z.string().min(1).max(64).optional().nullable(),
  })
  .refine((v) => v.mode !== "selected" || v.selectedIndexes.length > 0, {
    message: "Select at least one row to call",
    path: ["selectedIndexes"],
  });
export type StartAiCallsInput = z.infer<typeof startAiCallsInput>;
