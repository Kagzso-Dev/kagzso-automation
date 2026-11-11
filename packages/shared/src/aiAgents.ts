// AI Agents (Calls → each language → "AI Agents"): an AI business executive configured once per business.
//
// Two modes:
//   guided      the agent calls with an existing published Call Flow of its language (Nila, Follow-up,
//               Executive or a copy): nothing is generated, the flow runs exactly as it does today.
//   autonomous  the agent's settings are compiled (apps/api/src/domain/aiAgentCompile.ts) into an ordinary
//               "executive" Call Flow version with `autonomous` settings: the LLM leads the conversation within
//               the fixed safety rules. Calls then use the same queue, voice backend, STT / TTS, recordings and
//               history as every other flow. There is no separate LLM pipeline.
//
// Knowledge: uploaded files (CSV, XLSX, PDF, DOCX, TXT) are turned into fact / Q&A items, each Draft until an
// admin approves it. Only approved items of that agent are compiled into that agent's flow, so one agent's
// knowledge never reaches another agent's calls.
//
// An agent has no business of its own: each call uses the business of the contact it is calling (Voicecall Contact),
// and with none on file the AI asks. The old agent-level fields stay in the database, unused (`retired` below).

import { z } from "zod";
import { aiCallLanguage, type AiCallLanguage } from "./aiCallLanguages.js";
import { agentReplySpeedInput } from "./aiCallVoiceTuning.js";

export const AI_AGENT_MODES = ["guided", "autonomous"] as const;
export type AiAgentMode = (typeof AI_AGENT_MODES)[number];

/** Contact gender. "unspecified" = a neutral greeting (no sir / madam); never guessed from the name. */
export const AI_AGENT_GENDERS = ["male", "female", "unspecified"] as const;
export type AiAgentGender = (typeof AI_AGENT_GENDERS)[number];
export const AI_AGENT_GENDER_LABELS: Record<AiAgentGender, string> = { male: "Male", female: "Female", unspecified: "Not specified" };

export const AI_AGENT_PERSONALITIES = ["professional", "friendly", "consultative", "formal"] as const;
export type AiAgentPersonality = (typeof AI_AGENT_PERSONALITIES)[number];
export const AI_AGENT_PERSONALITY_LABELS: Record<AiAgentPersonality, string> = {
  professional: "Professional and calm",
  friendly: "Friendly and warm",
  consultative: "Consultative (asks, listens, advises)",
  formal: "Formal and respectful",
};
/** Training persona scales (1-5) per personality (voice backend training.TrainingPersona). */
export const AI_AGENT_PERSONALITY_TONE: Record<AiAgentPersonality, { formality: number; warmth: number; energy: number; politeness: number }> = {
  professional: { formality: 3, warmth: 4, energy: 3, politeness: 4 },
  friendly: { formality: 2, warmth: 5, energy: 4, politeness: 4 },
  consultative: { formality: 3, warmth: 4, energy: 2, politeness: 5 },
  formal: { formality: 5, warmth: 3, energy: 2, politeness: 5 },
};

export const AI_AGENT_DEFAULTS = {
  executiveName: "Thaara",
  companyName: "Kagzso Technology Services",
  personality: "professional" as AiAgentPersonality,
  contactGender: "male" as AiAgentGender,
  /** Target call length: the agent is told to wrap up after it (never cutting the customer off). */
  targetDurationSec: 60,
  /** Hard stop: the Plivo / Twilio time limit of every call this agent places. */
  maxDurationSec: 105,
  /** How fast the AI speaks (a level of AI_AGENT_VOICE_SPEEDS, or typed within AI_AGENT_VOICE_SPEED_LIMITS). */
  voiceSpeed: 0.9,
} as const;
/** maxMax: 3 minutes at most, on the slider or typed. The voice backend's MAX_CALL_DURATION_SECONDS still wins when a call is placed. */
export const AI_AGENT_DURATION_LIMITS = { minTarget: 30, maxTarget: 105, minMax: 45, maxMax: 180 } as const;
const MAX_DURATION_RULE = `Enter whole seconds from ${AI_AGENT_DURATION_LIMITS.minMax} to ${AI_AGENT_DURATION_LIMITS.maxMax}`;

/**
 * The AI's own voice (Settings → AI Voice, autonomous agents). It has nothing to do with the contact's gender:
 * the customer is addressed by contactGender (sir / madam) whatever voice speaks. Only voices the language's voice
 * backend offers WITH a gender (GET /api/flows/builtin → voices, app/core/voices.py) can be picked; the API stores
 * the backend's own id, name and gender, never one typed in the browser.
 */
export const AI_AGENT_VOICE_GENDERS = ["female", "male"] as const;
export type AiAgentVoiceGender = (typeof AI_AGENT_VOICE_GENDERS)[number];
export const AI_AGENT_VOICE_GENDER_LABELS: Record<AiAgentVoiceGender, string> = { female: "Female", male: "Male" };
/** The voice a new agent starts with, per language (none = the voice backend's default voice, as before). */
export const AI_AGENT_DEFAULT_VOICE: Partial<Record<AiCallLanguage, string>> = { ta: "roopa" };
/**
 * How fast the agent speaks (Settings → AI Voice, autonomous agents): the text-to-speech pace of every line of its
 * calls. Compiled into its flow (autonomous.voice_pace), so a new speed reaches calls with the next publish. The
 * levels are shortcuts: any speed within AI_AGENT_VOICE_SPEED_LIMITS can be typed instead.
 */
export const AI_AGENT_VOICE_SPEEDS = [
  { value: 0.8, label: "Slow" },
  { value: 0.9, label: "Relaxed" },
  { value: 1, label: "Normal" },
  { value: 1.1, label: "Brisk" },
  { value: 1.2, label: "Fast" },
] as const;
/** The speeds a voice takes: Sarvam's pace range, which the published flow (voice_pace) and Listen check as well. */
export const AI_AGENT_VOICE_SPEED_LIMITS = { min: 0.5, max: 2 } as const;
const VOICE_SPEED_RULE = `Enter a speed from ${AI_AGENT_VOICE_SPEED_LIMITS.min.toFixed(1)} to ${AI_AGENT_VOICE_SPEED_LIMITS.max.toFixed(1)}`;
/** A Sarvam Bulbul speaker id as the voice backend lists it (app/core/voices.py _VOICE_ID_RE). */
export const AI_AGENT_VOICE_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const AI_AGENT_INSTRUCTIONS_MAX = 4000;
export const AI_AGENT_OBJECTIVE_MAX = 500;

/** Letters (any script), spaces and . ' - only: it is spoken in the greeting and kept in the training profile. */
const PERSON_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
const e164 = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Use E.164, e.g. +919876543210");
// eslint-disable-next-line no-control-regex
const SINGLE_LINE_RE = /^[^\u0000-\u001f\u007f]*$/;
const line = (max: number) => z.string().trim().max(max).regex(SINGLE_LINE_RE, "Must be a single line");
// eslint-disable-next-line no-control-regex
const multiline = (max: number) => z.string().max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "Contains control characters");

/**
 * The agent-level business fields the form no longer has. Still accepted, so a browser tab left open or an older API
 * client can save, but never checked further, stored or compiled: an agent's calls use each contact's own business.
 */
const retired = (max: number) => z.string().max(max).nullable().optional();

export const aiAgentInput = z
  .object({
    name: line(100).min(1, "Give the agent a name"),
    mode: z.enum(AI_AGENT_MODES).default("autonomous"),
    categoryId: retired(64),
    customCategory: retired(80),
    industryId: retired(64),
    customIndustry: retired(80),
    businessName: retired(160),
    objective: multiline(AI_AGENT_OBJECTIVE_MAX).default(""),
    // Contact
    contactName: line(100).nullable().optional(),
    contactGender: z.enum(AI_AGENT_GENDERS).default(AI_AGENT_DEFAULTS.contactGender),
    contactPhone: e164.nullable().optional(),
    // AI executive
    executiveName: line(40).regex(PERSON_NAME_RE, "Letters, spaces, . ' - only").default(AI_AGENT_DEFAULTS.executiveName),
    companyName: line(100).min(1).default(AI_AGENT_DEFAULTS.companyName),
    callbackNumber: e164.nullable().optional(),
    personality: z.enum(AI_AGENT_PERSONALITIES).default(AI_AGENT_DEFAULTS.personality),
    // Instructions
    instructions: multiline(AI_AGENT_INSTRUCTIONS_MAX).default(""),
    // Call settings
    targetDurationSec: z.coerce
      .number()
      .int()
      .min(AI_AGENT_DURATION_LIMITS.minTarget)
      .max(AI_AGENT_DURATION_LIMITS.maxTarget)
      .default(AI_AGENT_DEFAULTS.targetDurationSec),
    maxDurationSec: z.coerce
      .number({ invalid_type_error: MAX_DURATION_RULE })
      .int(MAX_DURATION_RULE)
      .min(AI_AGENT_DURATION_LIMITS.minMax, MAX_DURATION_RULE)
      .max(AI_AGENT_DURATION_LIMITS.maxMax, MAX_DURATION_RULE)
      .default(AI_AGENT_DEFAULTS.maxDurationSec),
    /** Guided mode: the published Call Flow (of the agent's language) it calls with. */
    guidedFlowId: z.string().min(1).max(64).nullable().optional(),
    /** Autonomous: the AI's voice (an offered voice of the agent's language). Null = the backend's default voice. */
    voiceId: z.string().trim().toLowerCase().regex(AI_AGENT_VOICE_ID_RE, "Pick one of the listed voices").nullable().optional(),
    /** Autonomous: how fast the AI speaks, a level or a typed speed. */
    voiceSpeed: z.coerce
      .number({ invalid_type_error: VOICE_SPEED_RULE })
      .min(AI_AGENT_VOICE_SPEED_LIMITS.min, VOICE_SPEED_RULE)
      .max(AI_AGENT_VOICE_SPEED_LIMITS.max, VOICE_SPEED_RULE)
      .default(AI_AGENT_DEFAULTS.voiceSpeed),
    /** Autonomous, in a language with voice response tuning: how soon the AI answers, a preset or Manual waits. Null = the language's setting. */
    replySpeed: agentReplySpeedInput.nullable().default(null),
  })
  .strict()
  .superRefine((a, ctx) => {
    // A maximum out of range has its own error: no reason to blame the target while "150" is being typed.
    if (a.targetDurationSec > a.maxDurationSec && a.maxDurationSec >= AI_AGENT_DURATION_LIMITS.minMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetDurationSec"], message: "The target must not exceed the maximum" });
    }
    if (a.mode === "guided" && !a.guidedFlowId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["guidedFlowId"], message: "Pick the Call Flow a guided agent uses" });
    }
    if (a.mode === "autonomous" && !a.objective.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objective"], message: "Enter the calling objective" });
    }
  });
export type AiAgentInput = z.input<typeof aiAgentInput>;
export type AiAgentConfig = z.output<typeof aiAgentInput>;

/** POST /api/ai-agents: the agent's language is the page's language and never changes. */
export const createAiAgentInput = z.object({ language: aiCallLanguage, agent: aiAgentInput }).strict();

/** Call one number with the agent (the agent's own contact when the fields are left out). */
export const aiAgentCallInput = z
  .object({
    phone: e164.optional(),
    customerName: line(100).optional(),
    gender: z.enum(AI_AGENT_GENDERS).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type AiAgentCallInput = z.input<typeof aiAgentCallInput>;

/* ------------------------------------------------------------------ category / industry library */
// No agent, call or screen reads it any more. The API and its tables stay, so nothing already saved is lost.
export const aiCategoryInput = z.object({ name: line(80).min(1) }).strict();
export const aiIndustryInput = z
  .object({
    categoryId: z.string().min(1).max(64),
    name: line(80).min(1),
    /** What to explore with a business of this industry (discovery topics, not product claims), one per line. */
    discoveryTopics: multiline(1500).default(""),
  })
  .strict();

/* ------------------------------------------------------------------ knowledge */
export const AI_KNOWLEDGE_FORMATS = ["csv", "xlsx", "pdf", "docx", "txt"] as const;
export type AiKnowledgeFormat = (typeof AI_KNOWLEDGE_FORMATS)[number];
export const AI_KNOWLEDGE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const AI_KNOWLEDGE_MAX_FILES_PER_UPLOAD = 10;
/** The voice backend's training limits (training.FlowTraining / TrainingKnowledge). */
export const AI_KNOWLEDGE_MAX_APPROVED = 120;
export const AI_KNOWLEDGE_TEXT_MAX = 500;
export const AI_KNOWLEDGE_TOPIC_MAX = 40;
export const AI_KNOWLEDGE_QUESTION_MAX = 200;
export const AI_KNOWLEDGE_QUESTIONS_MAX = 8;
export const AI_KNOWLEDGE_STATUSES = ["draft", "approved", "rejected"] as const;
export type AiKnowledgeStatus = (typeof AI_KNOWLEDGE_STATUSES)[number];

export function knowledgeFormatFromFilename(name: string): AiKnowledgeFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (AI_KNOWLEDGE_FORMATS as readonly string[]).includes(ext) ? (ext as AiKnowledgeFormat) : null;
}

export const aiKnowledgeItemUpdate = z
  .object({
    kind: z.enum(["fact", "qa"]).optional(),
    topic: line(AI_KNOWLEDGE_TOPIC_MAX).min(1).optional(),
    text: line(AI_KNOWLEDGE_TEXT_MAX).min(1).optional(),
    questions: z.array(line(AI_KNOWLEDGE_QUESTION_MAX).min(1)).max(AI_KNOWLEDGE_QUESTIONS_MAX).optional(),
    always: z.boolean().optional(),
  })
  .strict();
export const aiKnowledgeDecision = z
  .object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500), status: z.enum(AI_KNOWLEDGE_STATUSES) })
  .strict();

/* ------------------------------------------------------------------ knowledge content checks */
// The same rules the voice backend applies to every training text (training.format_issues / policy_issues).
// Shown in the upload preview so an admin fixes or rejects an item before approving it; the voice backend
// still checks the compiled flow when the agent is published (it is the authority).
// Cross-checked with tests/fixtures/autonomous/knowledge_cases.json on both sides.
const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const NUMBERISH_RE = /\+?\d[\d\s().-]*\d/g;
const LINK_RE = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|in|net|org|io|co|ai|app|info|biz)\b/i;
const OWN_SITE_RE = /\bkagzso\.com\b/gi;
const HTML_RE = /<\s*\/?\s*[a-zA-Z!][^>]*>|&(?:lt|gt|amp|nbsp|#\d+);/i;
const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const POLICY: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
  ["tries to override the rules (training only guides tone and knowledge)", [
    /\b(ignore|disregard|forget|override|bypass|skip)\b.{0,40}\b(rules?|instructions?|prompt|script|safety|above|guidelines?|policy)\b/i,
    /\b(new|updated|different) (rules?|instructions?)\b/i,
    /\bsystem prompt\b|\btake(s)? priority\b|\b(highest|top) priority\b/i,
  ]],
  ["tells the agent to claim to be human or hide that it is an AI", [
    /\b(i am|i'm|i’m|you are|you're|you’re|pretend to be|act as|claim to be|say (that )?you are)\s+(a\s+|an\s+)?(real\s+)?(human|person|man|woman|lady|girl|boy)\b/i,
    /\b(not|never)\s+(an?\s+)?(ai|bot|robot|machine|computer|automated)\b/i,
    /\b(don'?t|do not|never|avoid)\s+(say|tell|admit|mention|reveal|disclose)\b.{0,30}\b(ai|bot|robot|automated|recording|machine)\b/i,
    /\b(hide|deny|conceal)\b.{0,30}\b(ai|bot|robot|automated|machine)\b/i,
  ]],
  ["tries to change do-not-call handling (a do-not-call request always ends the call)", [
    /\b(keep|continue|still|try to)\b.{0,30}\b(call(ing)?|talking|persuad\w*|convinc\w*|push\w*)\b.{0,40}\b(stop|don'?t call|do not call|remove|not interested|no more calls)\b/i,
    /\b(don'?t|do not|never)\s+(end|hang up|stop|close)\b.{0,20}\b(call|conversation)\b/i,
    /\b(ignore|skip|refuse)\b.{0,20}\b(do[- ]not[- ]call|dnc|opt[- ]?out|remove (my|their|the) number)\b/i,
  ]],
  ["sets call outcomes (only the system sets them)", [
    /\b(set|mark|change|record|choose)\b.{0,20}\boutcomes?\b|\boutcome\s*(is|=|:|to be)\b|\bmark (it|the call|them|the customer) as\b|\bset (the )?status\b/i,
  ]],
  ["promises a price, discount or cost (the safety rules forbid it)", [
    /₹|\brs\.?\s*\d|\binr\b|\brupees?\b|\$\s*\d|\blakhs?\b|\bcrores?\b|\bdiscount|\bper month\b|\bprice is\b|\bcosts? (only |just |around |about )?\d|\bfree of cost\b|\bfor free\b|\bfree (trial|demo|setup|service|consultation)\b/i,
  ]],
  ["promises savings or guarantees (the safety rules forbid it)", [
    /\b(save|saving|savings|cut|reduce)\b.{0,25}(\d+\s*(%|percent)|\bhalf\b|\bdouble\b)|\bguarantee\w*|\b100\s*%|\bassured\b|\b(you will|you'll|you’ll) save\b/i,
  ]],
  ["promises a demo, meeting or callback (the safety rules forbid it)", [
    /\b(book|schedule|fix|arrange|set up|setup|confirm|give you|send you|offer)\b.{0,25}\b(demo|meeting|appointment|call ?back|visit)\b/i,
    /\b(we|i|our team|someone)\s*('ll|’ll| will| shall| can)\s+(call you back|visit|meet|send (you )?a demo|show you a demo)\b/i,
  ]],
  ["asks for another person's contact details", [
    /\b(number|phone|mobile|email|e-mail|contact|whatsapp)\b.{0,25}\b(of|for)\s+(your|the|their|his|her)\s+(manager|boss|owner|colleague|friend|partner|team|hr|md|ceo|someone|person|husband|wife|son|daughter)\b/i,
    /\b(manager|boss|owner|colleague|friend|partner|md|ceo|husband|wife|son|daughter)('s|’s)?\s+(number|phone|mobile|email|contact|whatsapp)\b/i,
    /\b(who|whom)\s+(else\s+)?(should|can|could)\s+(i|we)\s+(call|contact|reach)\b/i,
  ]],
  ["asks for sensitive personal details", [/\b(otp|password|pin number|card number|cvv|bank account|aadhaa?r|pan (card|number))\b/i]],
  ["fakes a human action (breathing, typing, 'let me check' or looking something up)", [
    /\*[^*]{1,40}\*|\[[^\]]{1,40}\]|\((sighs?|laughs?|pauses?|breath\w*|typing|coughs?)\)/i,
    /\b(let me|i'?ll|i’ll|i will|allow me to)\s+(just\s+|quickly\s+)?(check|look|see|find|verify|search|pull up|confirm)\b/i,
    /\b(one|a|just a) (sec|second|moment|minute)\b|\bhold on\b|\bgive me a (sec|second|moment|minute)\b/i,
    /\b(breath\w*|typing|sigh\w*|clears? (my |his |her )?throat)\b|\blooking (it )?up\b|\bchecking (my|the|our) (system|records|computer|screen|database)\b/i,
    /ஒரு\s*(நிமிஷம்|நிமிடம்|செகண்ட்)|செக்\s*பண்ண|\bcheck panni|\boru nimisham|एक\s*(मिनट|सेकंड)|चेक\s*कर|ಒಂದು\s*ನಿಮಿಷ/i,
  ]],
];

/**
 * Why `text` can't be used as approved knowledge ([] = fine). `policy: false` for a customer's question
 * (it may mention a price or a demo): personal data and format only, as the voice backend does.
 */
export function knowledgeTextIssues(text: string, { policy = true }: { policy?: boolean } = {}): string[] {
  const v = text.trim();
  const issues: string[] = [];
  if (CONTROL_RE.test(v)) issues.push("must be a single line without control characters");
  if (v.includes("[[END_CALL]]")) issues.push("must not contain [[END_CALL]]");
  const vars = [...v.matchAll(VAR_RE)].map((m) => m[1]).filter((n) => n !== "title_to_use");
  if (vars.length) issues.push("contains a {{variable}} (only {{title_to_use}} is allowed)");
  if (HTML_RE.test(v)) issues.push("contains HTML");
  if (EMAIL_RE.test(v)) issues.push("contains an email address (personal data)");
  if ([...v.matchAll(NUMBERISH_RE)].some((m) => (m[0].match(/\d/g) ?? []).length >= 7)) {
    issues.push("contains a phone number or long number (personal data)");
  }
  const withoutOwn = v.replace(new RegExp(EMAIL_RE.source, "g"), " ").replace(OWN_SITE_RE, " ");
  if (LINK_RE.test(withoutOwn)) issues.push("contains a link or web address (only kagzso.com is allowed)");
  if (policy) for (const [reason, patterns] of POLICY) if (patterns.some((p) => p.test(v))) issues.push(reason);
  return issues;
}

/* ------------------------------------------------------------------ spoken openings per language */
// greeting: required by the flow schema but never spoken: an autonomous agent's LLM opens the call in its own words
// (autonomous.natural_lines). {agent} / {company} are filled in when the agent is compiled, {{title}} (sir / madam
// from a GIVEN gender, empty when not specified) when the call is placed.
// Only the standard languages have lines: an agent can't be compiled for another language (never translated).
// dnc: the do-not-call line, spoken word for word when the backend detects a do-not-call request (autonomous
// agents always enforce it), in the call's language. Hindi lines avoid gendered verbs (रहा / रही): the executive
// name is editable, so the line must fit any name.
// The AI voice's gender plays no part. In the conversation the voice backend gives the AI the customer's name with
// the title as the language does it (address_as).
// Reviewed 2026-11-03 (grammar, respectful address, gender handling) - STILL NEEDS a native speaker to listen
// to the TTS before release: ta, hi, kn.
export interface AiAgentOpening {
  greeting: string;
  dnc: string;
}
export const AI_AGENT_OPENINGS: Partial<Record<AiCallLanguage, AiAgentOpening>> = {
  en: {
    greeting: "Hello {{title}}. This is {agent} calling from {company}.",
    dnc: "Understood. I respect your request. Thank you.",
  },
  ta: {
    greeting: "வணக்கம் {{title}}. நான் {agent}, {company}-ல இருந்து பேசறேன்.",
    dnc: "சரி, புரியுது. உங்க request-ஐ மதிக்கிறோம். நன்றி.",
  },
  hi: {
    greeting: "नमस्ते {{title}}. मेरा नाम {agent} है, {company} से.",
    dnc: "ठीक है, आपकी request का पूरा सम्मान है. धन्यवाद.",
  },
  kn: {
    greeting: "ನಮಸ್ಕಾರ {{title}}. ನಾನು {agent}, {company} ಕಡೆಯಿಂದ ಕರೆ ಮಾಡುತ್ತಿದ್ದೇನೆ.",
    dnc: "ಸರಿ, ಅರ್ಥ ಆಯ್ತು. ನಿಮ್ಮ request-ಅನ್ನು ಗೌರವಿಸುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು.",
  },
};

export function aiAgentLanguageSupported(language: AiCallLanguage): boolean {
  return !!AI_AGENT_OPENINGS[language];
}

/**
 * Languages whose live AUTONOMOUS AI Agent calls are paused (temporary). Only calls are blocked: agents in these
 * languages can still be created, edited, given knowledge, previewed and published, and Guided agents (and every
 * ordinary Call Flow) call as before. Remove a language here - and from AUTONOMOUS_CALLS_BLOCKED in the voice
 * backend's call_service.py - once its native-speaker review is done.
 */
export const AI_AGENT_AUTONOMOUS_CALLS_BLOCKED: Partial<Record<AiCallLanguage, string>> = {
  kn:
    "Kannada Autonomous AI calls are paused until a native speaker has reviewed the Kannada do-not-call phrases " +
    "and opening lines. You can still set up, edit, add knowledge to, preview and publish Kannada agents; " +
    "Guided agents call as usual.",
};

/** Why live calls with this flow version are paused (an autonomous flow of a blocked language), or null. */
export function autonomousCallBlockedReason(language: string, definition: unknown): string | null {
  const autonomous = !!definition && typeof definition === "object" && !!(definition as { autonomous?: unknown }).autonomous;
  return autonomous ? (AI_AGENT_AUTONOMOUS_CALLS_BLOCKED[language as AiCallLanguage] ?? null) : null;
}

/* ------------------------------------------------------------------ API shapes */
export interface AiIndustryView {
  id: string;
  categoryId: string;
  name: string;
  discoveryTopics: string;
  archivedAt: string | null;
}
export interface AiCategoryView {
  id: string;
  name: string;
  archivedAt: string | null;
  industries: AiIndustryView[];
}

export interface AiAgentView extends AiAgentConfig {
  id: string;
  language: AiCallLanguage;
  callFlowId: string | null;
  /** The live version of the agent's generated flow (autonomous) or of its guided flow. */
  liveVersion: number | null;
  /** The settings or approved knowledge changed since the last publish (autonomous only). */
  unpublishedChanges: boolean;
  knowledge: { draft: number; approved: number; rejected: number; files: number };
  /** The picked voice as the voice backend described it when it was saved (null = none picked). */
  voiceGender: AiAgentVoiceGender | null;
  voiceDisplayName: string | null;
  voiceLanguage: AiCallLanguage | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiKnowledgeFileView {
  id: string;
  fileName: string;
  format: AiKnowledgeFormat;
  sizeBytes: number;
  status: "extracted" | "failed" | "replaced";
  error: string | null;
  itemCount: number;
  uploadedByEmail: string | null;
  createdAt: string;
}

export interface AiKnowledgeItemView {
  id: string;
  fileId: string | null;
  kind: "fact" | "qa";
  topic: string;
  text: string;
  questions: string[];
  always: boolean;
  status: AiKnowledgeStatus;
  /** Why it can't be approved as it is (knowledgeTextIssues) and missing fields. Empty = ready. */
  issues: string[];
  /** Where it came from, e.g. "row 4" or "page 2". */
  source: string | null;
  /** The industry a structured row names. */
  industryHint: string | null;
}
