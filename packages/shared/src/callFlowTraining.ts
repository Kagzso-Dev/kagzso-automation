// Call flow training (Voice Call Flows → Training tab): a flow's tone and knowledge notes, compiled by
// the voice backend into one compact prompt block (kagzso-voice-backend-english/app/flows/training.py).
// No model is fine-tuned: the block is prompt text, sent to the enabled LLM providers during calls.
//
// This schema checks the structure and limits. The content rules (no personal data, no override or
// false-promise wording, the token cap) are the voice backend's, applied whenever training is saved.

import { z } from "zod";

export const TRAINING_STATUSES = ["draft", "active", "archived"] as const;
export type TrainingStatus = (typeof TRAINING_STATUSES)[number];

/** In conversation order (the voice backend's training.SITUATIONS has the same keys). */
export const TRAINING_SITUATIONS = [
  "greeting",
  "acknowledge",
  "agree",
  "empathy",
  "busy",
  "uncertain",
  "clarify",
  "reask",
  "transition",
  "price",
  "objection",
  "refuse",
  "identity",
  "disclosure",
  "thanks",
  "closing",
] as const;
export type TrainingSituation = (typeof TRAINING_SITUATIONS)[number];
export const TRAINING_SITUATION_LABELS: Record<TrainingSituation, string> = {
  greeting: "Greeting",
  acknowledge: "Acknowledge",
  agree: "Agree",
  empathy: "Empathy",
  busy: "Customer is busy",
  uncertain: "Customer is unsure",
  clarify: "Clarification",
  reask: "Gentle re-ask",
  transition: "Transition",
  price: "Price question",
  objection: "Objection",
  refuse: "Polite refusal",
  identity: "Who is calling",
  disclosure: "AI disclosure",
  thanks: "Thanks",
  closing: "Closing",
};

export const TRAINING_PHRASE_STYLES = ["english", "mixed", "pure"] as const;
export const TRAINING_AVOID = ["slang", "exaggeration", "pushiness", "jargon", "fillers"] as const;

export const TRAINING_DEFAULT_TOKEN_CAP = 900;
/**
 * Non-English flows start with a larger cap: Indic scripts cost more tokens per word (the voice backend
 * estimates ~1.5 characters per token), so the same training needs more room. Only a NEW training starts
 * with it; a saved training keeps its own cap, and English stays at 900 (voice backend: training.default_token_cap).
 */
export const TRAINING_INDIC_DEFAULT_TOKEN_CAP = 1200;
export function trainingDefaultTokenCap(language: string): number {
  return language === "en" ? TRAINING_DEFAULT_TOKEN_CAP : TRAINING_INDIC_DEFAULT_TOKEN_CAP;
}
export const TRAINING_MIN_TOKEN_CAP = 200;
export const TRAINING_MAX_TOKEN_CAP = 1500;

const entryId = z.string().regex(/^[a-z0-9_-]{1,40}$/, "Use 1-40 lowercase letters, digits, - or _");
const status = z.enum(TRAINING_STATUSES).default("draft");
const scale = z.number().int().min(1).max(5);
const line = (max: number) =>
  z
    .string()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "Must be a single line");

/** Agent profile (who calls, for which company, and why). All optional; empty = not said. */
export const TRAINING_PROFILE_FIELDS = [
  { key: "agent_name", label: "Agent name", max: 40, placeholder: "e.g. Thaara" },
  { key: "company", label: "Company", max: 100, placeholder: "e.g. Kagzso AI and Automation" },
  { key: "business_type", label: "Business type", max: 100, placeholder: "e.g. AI and automation services for businesses" },
  { key: "objective", label: "Business objective", max: 300, placeholder: "e.g. Introduce our AI automation services and find out whether the customer is interested" },
  { key: "call_purpose", label: "Why we are calling", max: 200, placeholder: "e.g. A short introduction to what we do for businesses like theirs" },
  { key: "target_customer", label: "Who we call", max: 200, placeholder: "e.g. Owners and managers of small and mid-size businesses" },
  { key: "intro", label: "Approved company introduction", max: 300, placeholder: "e.g. We help businesses automate their daily repetitive work using AI." },
  { key: "desired_outcome", label: "Good outcome of the call", max: 200, placeholder: "e.g. The customer says it could be useful and is open to hearing more" },
] as const;
export type TrainingProfileKey = (typeof TRAINING_PROFILE_FIELDS)[number]["key"];

export const trainingPersona = z
  .object({
    status,
    agent_name: line(40)
      .refine((v) => v === "" || /^[\p{L}][\p{L}\p{M} .'-]*$/u.test(v), "Letters, spaces, . ' - only")
      .default(""),
    company: line(100).default(""),
    business_type: line(100).default(""),
    objective: line(300).default(""),
    call_purpose: line(200).default(""),
    target_customer: line(200).default(""),
    intro: line(300).default(""),
    desired_outcome: line(200).default(""),
    role: line(300).default(""),
    formality: scale.default(3),
    warmth: scale.default(4),
    energy: scale.default(3),
    politeness: scale.default(4),
    pace: z.enum(["slow", "steady"]).default("steady"),
    sentence_length: z.enum(["short", "medium"]).default("short"),
    title_use: z.enum(["never", "rarely", "sometimes", "often"]).default("sometimes"),
    /** Non-English "mixed" flows only. Absent = not said. */
    english_mix: z.enum(["light", "medium", "heavy"]).nullable().optional(),
    avoid: z.array(z.enum(TRAINING_AVOID)).max(TRAINING_AVOID.length).default([]),
    notes: line(300).default(""),
  })
  .strict();

export const trainingPhrase = z
  .object({
    id: entryId,
    status,
    situation: z.enum(TRAINING_SITUATIONS),
    style: z.enum(TRAINING_PHRASE_STYLES).default("english"),
    text: line(120).pipe(z.string().min(1, "Write the phrase")),
    when: line(160).default(""),
    /** Native-speaker review. */
    reviewed: z.boolean().default(false),
  })
  .strict();

export const trainingKnowledge = z
  .object({
    id: entryId,
    status,
    kind: z.enum(["fact", "qa"]),
    topic: line(40).pipe(z.string().min(1, "Give it a topic")),
    /** Facts only: included in every reply (else picked when relevant). */
    always: z.boolean().default(false),
    /** Q&A only: the ways customers ask it. */
    questions: z.array(line(200)).max(8).default([]),
    /** The fact, or the exact approved answer. */
    text: line(500).pipe(z.string().min(1, "Write the fact or answer")),
  })
  .strict();

export const trainingExample = z
  .object({
    id: entryId,
    status,
    kind: z.enum(["good", "bad"]),
    source: z.enum(["manual", "call"]).default("manual"),
    /** Optional metadata: helps pick the example for the right moment. Absent = any. */
    situation: z.enum(TRAINING_SITUATIONS).nullable().optional(),
    topic: line(40).optional(),
    /** Language style of the example (english / mixed / pure). Absent = used for any. */
    style: z.enum(TRAINING_PHRASE_STYLES).nullable().optional(),
    customer: line(300).pipe(z.string().min(1, "Write what the customer said")),
    agent: line(300).pipe(z.string().min(1, "Write the agent's reply")),
    reason: line(200).default(""),
    better: line(300).default(""),
  })
  .strict();

export const callFlowTraining = z
  .object({
    /** The per-flow switch: off = calls use the prompt exactly as without training. */
    enabled: z.boolean().default(false),
    token_cap: z.number().int().min(TRAINING_MIN_TOKEN_CAP).max(TRAINING_MAX_TOKEN_CAP).default(TRAINING_DEFAULT_TOKEN_CAP),
    persona: trainingPersona.nullable().optional(),
    phrases: z.array(trainingPhrase).max(120).default([]),
    knowledge: z.array(trainingKnowledge).max(120).default([]),
    examples: z.array(trainingExample).max(80).default([]),
  })
  .strict();

export type TrainingPersona = z.infer<typeof trainingPersona>;
export type TrainingPhrase = z.infer<typeof trainingPhrase>;
export type TrainingKnowledge = z.infer<typeof trainingKnowledge>;
export type TrainingExample = z.infer<typeof trainingExample>;
export type CallFlowTraining = z.infer<typeof callFlowTraining>;

/** A new entry id (unique enough within one flow). */
export function newTrainingId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
}

/** What the admin must read before typing anything into the Training tab (also in the README). */
export const TRAINING_PRIVACY_NOTICE =
  "Training text is included in call prompts and sent to the enabled LLM providers during calls (and in tests). " +
  "Never enter secrets, passwords or anyone's personal data.";

/* ------------------------------------------------------------------ correction from a call */

/** POST /api/call-flows/training/calls/:logId — `turn` is the index of an Agent line from GET …/turns. */
export const trainingFromCallInput = z
  .object({
    turn: z.number().int().min(0).max(500),
    better: line(300).pipe(z.string().trim().min(1, "Write the better reply")),
    reason: line(200).default(""),
    situation: z.enum(TRAINING_SITUATIONS).nullable().optional(),
    topic: line(40).optional(),
    style: z.enum(TRAINING_PHRASE_STYLES).nullable().optional(),
  })
  .strict();

export type TrainingCallTurn = { turn: number; customer: string; agent: string };
export type TrainingCallTurns = {
  flowId: string;
  flowName: string;
  version: number;
  turns: TrainingCallTurn[];
};

/* ------------------------------------------------------------------ test panel */

/**
 * "mock" (default): no provider is asked — the reply is simulated from the picked training entries, so
 * it costs nothing. "real": two real provider requests (tokens are used) and needs confirmCost: true.
 */
export const TRAINING_TEST_MODES = ["mock", "real"] as const;
export type TrainingTestMode = (typeof TRAINING_TEST_MODES)[number];

export const trainingTestInput = z
  .object({
    /** The editor's current definition (saved or not). */
    definition: z.record(z.unknown()),
    mode: z.enum(TRAINING_TEST_MODES).default("mock"),
    /** Real mode only (a mock test never asks a provider). */
    providerId: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
    /** Real mode: the admin confirmed that the test uses provider tokens. */
    confirmCost: z.boolean().optional(),
    message: z.string().trim().min(1, "Type what the customer says").max(300),
  })
  .strict()
  .refine((v) => v.mode !== "real" || !!v.providerId, { message: "Pick an LLM provider", path: ["providerId"] })
  .refine((v) => v.mode !== "real" || v.confirmCost === true, {
    message: "A real test uses provider tokens — confirm it first",
    path: ["confirmCost"],
  });

export type TrainingTestReply = {
  reply?: string;
  error?: string;
  ends_call?: boolean;
  prompt_tokens: number;
  first_token_ms?: number | null;
  total_ms?: number;
};
export type TrainingTestResult = {
  mode: TrainingTestMode;
  /** Real mode: the provider and model asked. Mock: "mock". */
  provider_id: string;
  model: string;
  without: TrainingTestReply;
  with: TrainingTestReply;
  /** Training lines picked for this message (the per-reply part of the block). */
  selected: string[];
  /** Relevant lines left out because the token cap was reached. */
  dropped: string[];
};

/* ------------------------------------------------------------------ copy a flow */

/** POST /api/call-flows/:id/copy — a new flow (Draft v1) from this flow's newest version. */
export const copyCallFlowInput = z
  .object({
    name: z.string().trim().min(1, "Give the copy a name").max(100),
    /** false = the copy starts without training. */
    includeTraining: z.boolean().default(true),
  })
  .strict();
export type CopyCallFlowInput = z.infer<typeof copyCallFlowInput>;

/** GET /api/call-flows list: the published version's agent profile (Simple AI Call shows it). */
export type CallFlowAgentSummary = {
  agentName: string;
  role: string;
  company: string;
  objective: string;
  /** Training switched on with an Active persona in the published version. */
  trainingOn: boolean;
};
