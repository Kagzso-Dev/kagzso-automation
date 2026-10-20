import { z } from "zod";

/* ------------------------------------------------------------------ Call Flows (AI voice calls) */
// The UI-editable form of a voice agent's script. Mirrors the voice backend's
// validator (kagzso-voice-backend-english/app/flows/schema.py), which stays the
// authority: a flow is checked there again before it is published or dialled.
// Keys are snake_case because the definition is sent to the voice backend as-is.

export const CALL_FLOW_BASES = ["nila", "followup"] as const;
export type CallFlowBase = (typeof CALL_FLOW_BASES)[number];

/** Variables a script may use. phone_number is deliberately absent: it is never spoken. */
export const CALL_FLOW_VARIABLES = [
  "customer_name",
  "name",
  "honorific",
  "title",
  "gender",
  "addressed_name",
  "follow_up_detail",
  "company_name",
  "business_type",
  "title_to_use",
  "time_greeting",
] as const;

export const CALL_FLOW_GROUPS = ["greeting", "main_script", "questions", "objections", "closing", "tone", "rules"] as const;
export type CallFlowGroup = (typeof CALL_FLOW_GROUPS)[number];

/** Safety blocks each base must keep exactly once, text owned by the voice backend (builtin/locked_blocks.json). */
export const CALL_FLOW_LOCKED_KEYS: Record<CallFlowBase, readonly string[]> = {
  nila: ["nila_data_safety", "nila_runtime_data"],
  followup: ["followup_runtime_data", "followup_situations"],
};

/**
 * Safety blocks that are editable text now (voice backend schema.UNLOCKED_KEYS). Versions saved
 * before still carry them as { id, locked: key }: accepted at most once and rendered from the
 * catalog byte for byte. The editor turns them into text blocks (materializeUnlockedBlocks) so a
 * new draft saves them as editable text with the same words.
 */
export const CALL_FLOW_UNLOCKED_KEYS: Record<string, { base: CallFlowBase; group: CallFlowGroup }> = {
  nila_do_not_call: { base: "nila", group: "closing" },
  nila_wrong_person: { base: "nila", group: "closing" },
  nila_callback_request: { base: "nila", group: "closing" },
  nila_outcome_rules: { base: "nila", group: "rules" },
  nila_rules_safety: { base: "nila", group: "rules" },
};

/** Block ids of the formerly locked safety blocks (built-in Nila and every copy of it). */
export const CALL_FLOW_SAFETY_BLOCK_IDS = ["do_not_call", "wrong_person", "callback_request", "outcome_rules", "rules_safety"] as const;

/** Outcome keys the voice backend classifies calls with: an edited outcome_rules block must keep all of them. */
export const CALL_FLOW_OUTCOME_KEYS = ["interested", "busy", "not_interested", "do_not_call", "wrong_person", "callback_requested"] as const;

/** Outcome keys missing from an outcome_rules text (whole words, so "interested" isn't found inside "not_interested"). */
export function missingOutcomeKeys(text: string): string[] {
  return CALL_FLOW_OUTCOME_KEYS.filter((k) => !new RegExp(`(^|[^a-z_])${k}([^a-z_]|$)`, "i").test(text));
}

/** True when a do_not_call text no longer handles a do-not-call request by ending the call. Warning only. */
export function lacksDoNotCallHandling(text: string): boolean {
  const request = /(do not|don'?t|never|stop|no more)\s+(call|calling|contact)|remove my number|do[\s-]not[\s-]call|\bdnc\b/i;
  const ends = /end (the )?call|hang up|end the conversation/i;
  return !(request.test(text) && ends.test(text));
}

/** Old { id, locked } references to the unlocked safety blocks → editable text blocks with the catalog text. */
export function materializeUnlockedBlocks(definition: CallFlowDefinition, lockedText: Record<string, string>): CallFlowDefinition {
  return {
    ...definition,
    blocks: definition.blocks.map((b) => {
      if (!isLockedBlock(b)) return b;
      const unlocked = CALL_FLOW_UNLOCKED_KEYS[b.locked];
      const text = lockedText[b.locked];
      return unlocked && unlocked.base === definition.base && text ? { id: b.id, group: unlocked.group, text } : b;
    }),
  };
}

export const CALL_FLOW_MAX_BLOCK_CHARS = 8000;
export const CALL_FLOW_MAX_PROMPT_CHARS = 50_000;

const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
// Tab, LF and CR are allowed in scripts; every other control character is not.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Variables used in `text` that are not allowed (deduplicated). */
export function unknownCallFlowVariables(text: string): string[] {
  const allowed = new Set<string>(CALL_FLOW_VARIABLES);
  const out = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1] ?? "";
    if (!allowed.has(name)) out.add(name);
  }
  return [...out].sort();
}

function flowText(max: number, { multiline }: { multiline: boolean }) {
  return z
    .string()
    .min(1)
    .max(max)
    .superRefine((v, ctx) => {
      if (CONTROL_RE.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Contains control characters" });
      if (!multiline && /[\r\n]/.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be a single line" });
      if (v.includes("[[END_CALL]]")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must not contain [[END_CALL]]" });
      const unknown = unknownCallFlowVariables(v);
      if (unknown.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown variable(s): ${unknown.map((u) => `{{${u}}}`).join(", ")}`,
        });
      }
    });
}

const blockId = z.string().regex(/^[a-z0-9_]{1,40}$/, "Use 1-40 lowercase letters, digits or _");

export const callFlowTextBlock = z
  .object({
    id: blockId,
    group: z.enum(CALL_FLOW_GROUPS),
    text: flowText(CALL_FLOW_MAX_BLOCK_CHARS, { multiline: true }),
  })
  .strict();
export const callFlowLockedBlock = z.object({ id: blockId, locked: z.string().max(60) }).strict();
export type CallFlowTextBlock = z.infer<typeof callFlowTextBlock>;
export type CallFlowLockedBlock = z.infer<typeof callFlowLockedBlock>;
export type CallFlowBlock = CallFlowTextBlock | CallFlowLockedBlock;

export const isLockedBlock = (b: CallFlowBlock): b is CallFlowLockedBlock => "locked" in b;

export const callFlowDefinition = z
  .object({
    schema_version: z.literal(1),
    base: z.enum(CALL_FLOW_BASES),
    name: z.string().trim().min(1).max(100),
    language: z.literal("en"),
    voice_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/, "Invalid voice id")
      .nullable()
      .optional(),
    greeting: z.object({ text: flowText(300, { multiline: false }) }).strict(),
    blocks: z.array(z.union([callFlowLockedBlock, callFlowTextBlock])).min(1).max(80),
    silence: z
      .object({ reprompt: flowText(200, { multiline: false }), closing: flowText(200, { multiline: false }) })
      .strict(),
    limits: z.object({ max_duration_sec: z.number().int().min(30).max(600) }).strict(),
    transfer: z
      .object({
        // Live transfer is not implemented yet: the number is stored only.
        enabled: z.literal(false),
        number: z
          .string()
          .regex(/^\+[1-9]\d{7,14}$/, "Use E.164, e.g. +919876543210")
          .nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((flow, ctx) => {
    const ids = flow.blocks.map((b) => b.id);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (dupes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: `Duplicate block id(s): ${dupes.join(", ")}` });
    const locked = flow.blocks.filter(isLockedBlock).map((b) => b.locked);
    const required = [...CALL_FLOW_LOCKED_KEYS[flow.base]].sort();
    const legacyOk = (k: string) => CALL_FLOW_UNLOCKED_KEYS[k]?.base === flow.base;
    const ok =
      required.every((k) => locked.includes(k)) &&
      locked.every((k) => required.includes(k) || legacyOk(k)) &&
      new Set(locked).size === locked.length;
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocks"],
        message: `Locked safety blocks can't be removed, added or duplicated (required: ${required.join(", ")})`,
      });
    }
    const outcome = flow.blocks.find((b) => b.id === "outcome_rules");
    if (outcome && !isLockedBlock(outcome)) {
      const missing = missingOutcomeKeys(outcome.text);
      if (missing.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blocks"],
          message: `Outcome rules must keep every outcome the system uses. Missing: ${missing.join(", ")}`,
        });
      }
    }
  });
export type CallFlowDefinition = z.infer<typeof callFlowDefinition>;

export const createCallFlowInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).optional().nullable(),
    base: z.enum(CALL_FLOW_BASES),
  })
  .strict();

export const saveCallFlowDraftInput = z
  .object({
    definition: callFlowDefinition,
    description: z.string().trim().max(1000).optional().nullable(),
  })
  .strict();

export const callFlowSample = z
  .object({
    customer_name: z.string().trim().max(100).optional().nullable(),
    gender: z.string().trim().max(20).optional().nullable(),
    company_name: z.string().trim().max(150).optional().nullable(),
    business_type: z.string().trim().max(100).optional().nullable(),
    follow_up_detail: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

/** Preview takes any JSON object: the voice backend reports validation errors in the response. */
export const previewCallFlowInput = z
  .object({ definition: z.record(z.unknown()), sample: callFlowSample.default({}) })
  .strict();

export const callFlowVersionParam = z.object({ id: z.string().min(1), version: z.coerce.number().int().min(1) });

/** `numberId` is an id from GET /api/call-flows/test-numbers — never a typed-in number. */
export const testCallFlowInput = z
  .object({
    version: z.number().int().min(1),
    numberId: z.string().trim().min(1).max(64),
    customerName: z.string().trim().max(100).optional().nullable(),
    gender: z.string().trim().max(20).optional().nullable(),
    followUpDetail: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

/* ------------------------------------------------------------------ import a full prompt */

/** Default "large prompt" warning for an import (CALL_FLOW_IMPORT_WARN_CHARS overrides it on the API). */
export const CALL_FLOW_IMPORT_WARN_CHARS = 30_000;

/**
 * POST /api/call-flows/:id/import-preview and /import-apply. `mapping` overrides the detected
 * target per section index: a block id, or "skip". Apply re-runs the same analysis, so the two
 * always agree; `confirmDncWarning` is required when the do-not-call block loses its handling.
 */
export const callFlowImportInput = z
  .object({
    prompt: z.string().min(1, "Paste the prompt first").max(200_000),
    stripSpokenMarkdown: z.boolean().default(false),
    mapping: z.record(z.string().regex(/^\d{1,3}$/), z.union([blockId, z.literal("skip")])).default({}),
  })
  .strict();
export const callFlowImportApplyInput = callFlowImportInput.extend({ confirmDncWarning: z.boolean().default(false) }).strict();
export type CallFlowImportInput = z.input<typeof callFlowImportInput>;

export type CallFlowImportStatus =
  | "matched" // will replace the block's text
  | "unchanged" // same text as the block already has
  | "unmatched" // no block found (pick one or leave it out)
  | "skipped" // you chose Skip
  | "locked" // locked block or text the system adds: never written
  | "too_long"
  | "unknown_variable"
  | "rendered_value" // a {{variable}} was replaced by a sample value (e.g. a name)
  | "invalid"; // other validation problem, e.g. a missing outcome key

export interface CallFlowImportSection {
  index: number;
  heading: string;
  chars: number;
  /** Block id it maps to (null = none). */
  target: string | null;
  /** 0..1; 1 = exact or chosen by you. */
  confidence: number;
  manual: boolean;
  status: CallFlowImportStatus;
  issues: string[];
  warnings: string[];
  /** Spoken lines changed by "remove ** and backticks": "before → after". */
  stripped: string[];
  diff: { removed: string[]; added: string[]; more: number } | null;
}

export interface CallFlowImportPreview {
  sections: CallFlowImportSection[];
  /** Blocks a section can map to. */
  targets: { id: string; label: string }[];
  sizeBefore: number;
  sizeAfter: number;
  warnAboveChars: number;
  maxChars: number;
  summary: { updated: number; unchanged: number; skipped: number; unmatched: number; locked: number };
  /** Reasons Apply is refused; empty = can apply. */
  blocking: string[];
  /** The do-not-call block no longer ends the call on a do-not-call request: Apply needs confirmDncWarning. */
  dncWarning: boolean;
  changed: boolean;
  changedBlocks: string[];
  /** Set when the flow has an open draft next to a live version: Apply is refused until it's published or discarded. */
  draftConflict: string | null;
}

export interface CallFlowImportResult {
  changed: boolean;
  version: number | null;
  summary: CallFlowImportPreview["summary"];
  changedBlocks: string[];
  /** discard = Undo discards the new draft (the live version stays); restore = Undo saves `definition` back into the draft. */
  undo: { kind: "discard" } | { kind: "restore"; definition: CallFlowDefinition } | null;
}

/* ------------------------------------------------------------------ test-call trial numbers */

/** Saved trial numbers per install (AI_CALL_FLOW_TEST_NUMBERS entries don't count). */
export const MAX_TEST_CALL_NUMBERS = 5;

export const addTestCallNumberInput = z
  .object({
    phone: z.string().trim().min(1, "Enter a phone number").max(40),
    label: z.string().trim().max(60).optional().nullable(),
  })
  .strict();

export interface TestCallNumber {
  /** "db:<id>" for a saved number, "env:<hash>" for an AI_CALL_FLOW_TEST_NUMBERS entry. */
  id: string;
  /** Masked for display, e.g. "+91 98XXX XXX10". */
  masked: string;
  label: string | null;
  source: "saved" | "env";
}

export interface TestCallNumberList {
  items: TestCallNumber[];
  max: number;
  /** True until migration 0023_ai_call_test_numbers is applied: only env numbers work. */
  tableMissing: boolean;
}

/** "+919876543210" → "+91 98XXX XXX10"; other E.164 numbers keep their first 3 and last 2 characters. */
export function maskTestCallNumber(phone: string): string {
  const m = /^\+91(\d{10})$/.exec(phone);
  if (m) return `+91 ${m[1]!.slice(0, 2)}XXX XXX${m[1]!.slice(-2)}`;
  if (phone.length <= 6) return phone.replace(/\d/g, "X");
  return phone.slice(0, 3) + "X".repeat(phone.length - 5) + phone.slice(-2);
}
