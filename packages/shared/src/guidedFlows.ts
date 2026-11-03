import { z } from "zod";
import { CALL_FLOW_VARIABLES } from "./callFlows.js";
import { callFlowTraining } from "./callFlowTraining.js";

/* ------------------------------------------------------------------ Guided call flows (schema_version 2)
 * The flow is the business process; the AI holds the conversation and a runner on the voice backend owns the
 * call's position (kagzso-voice-backend-english/app/flows/runner.py). This mirrors the backend's validator
 * (app/flows/guided.py) rule for rule and code for code: kagzso-voice-backend-english/tests/fixtures/guided/
 * validation_cases.json runs through both. Version-1 flows (callFlows.ts) are a different format.
 * Phase 1: not used by any route or page yet - Dispatch still saves and sends version-1 flows only. */

export const GUIDED_LANGUAGES = ["en", "ta", "hi", "te", "kn", "ml", "mr", "gu", "bn", "pa", "od"] as const;
export const GUIDED_STANDARD_FIELDS = [
  "business_type", "current_system", "current_process", "requirements", "pain_points",
  "interest_level", "existing_software", "preferred_follow_up",
] as const;
export const GUIDED_RUNNER_FIELDS = ["meeting_requested", "call_outcome"] as const;
export const GUIDED_INTENTS = [
  "answered", "agreed", "interested", "uncertain", "question", "objection", "not_interested", "busy",
  "do_not_call", "ai_question", "wrong_person", "end_request", "meeting_request", "unclear", "other",
] as const;
export const GUIDED_OUTCOMES = [
  "interested", "not_interested", "busy", "do_not_call", "wrong_person", "callback_requested", "meeting_requested", "completed",
] as const;
export const GUIDED_REQUIRED_CLOSINGS = ["do_not_call", "not_interested", "busy", "end_request", "no_response"] as const;
const REFUSAL_INTENTS = new Set(["not_interested", "busy", "end_request"]);
const SENSITIVE_PARTS = new Set(["phone", "mobile", "email", "mail", "otp", "password", "pin", "card", "cvv", "bank",
  "aadhaar", "aadhar", "pan", "account", "address", "whatsapp", "contact", "number"]);

export const GUIDED_ISSUE_CODES = [
  "schema", "language_style", "identity_needs_name", "duplicate_stage", "unknown_start", "unknown_target",
  "missing_closing", "unreachable_stage", "unreachable_rule", "duplicate_field", "forbidden_field",
  "unknown_condition_field", "unknown_knowledge", "safety_override", "refusal_continues", "disclosure_not_ai",
  "end_call_marker", "unknown_variable", "personal_data", "link", "price", "promise", "team_followup_in_text",
] as const;
export type GuidedIssueCode = (typeof GUIDED_ISSUE_CODES)[number];
export type GuidedIssue = { code: GuidedIssueCode; path: string; message: string };

const ID = /^[a-z][a-z0-9_]{0,39}$/;
const TARGET = /^(close:)?[a-z][a-z0-9_]{0,39}$/;
// eslint-disable-next-line no-control-regex
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/;
const line = (max: number, min = 1) => z.string().min(min).max(max).regex(SINGLE_LINE);
const id = z.string().regex(ID);

// ------------------------------------------------------------------ text checks (mirrored in guided.py)
const VAR = /\{\{\s*([^{}]*?)\s*\}\}/g;
const EMAIL = /[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;
const EMAIL_G = /[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;
const NUMBERISH = /\+?[0-9][0-9\s().-]*[0-9]/g;
const LINK = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|in|net|org|io|co|ai|app|info|biz)\b/i;
const OWN_SITE = /\bkagzso\.com\b/gi;
const PRICE = /₹|\brs\.?\s*[0-9]|\binr\b|\brupees?\b|\$\s*[0-9]|\blakhs?\b|\bcrores?\b|\bdiscount|\bper month\b|\bfree of cost\b|\bfor free\b/i;
const PROMISE =
  /\b(book|schedule|fix|arrange|set up|confirm)\b.{0,25}\b(demo|meeting|appointment|call ?back|visit)\b|\b(we|i|our team|someone)\s*('ll| will| shall)\s+(call you back|visit|meet)\b|\bguarantee|\b100\s*%/i;
const TEAM_FOLLOWUP = /\bour team\b.{0,30}\b(contact|call|reach|get in touch)\b/i;
const AI_WORDS = /\bA\.?I\b|artificial intelligence|virtual assistant|automated assistant|ஏஐ|एआई|ಎಐ|ఏఐ|എഐ/i;

export function guidedTextCodes(text: string, { spoken }: { spoken: boolean }): GuidedIssueCode[] {
  const codes: GuidedIssueCode[] = [];
  const allowed = new Set<string>(CALL_FLOW_VARIABLES);
  if (text.includes("[[END_CALL]]")) codes.push("end_call_marker");
  if ([...text.matchAll(VAR)].some((m) => !allowed.has(m[1] ?? ""))) codes.push("unknown_variable");
  const longNumber = [...text.matchAll(NUMBERISH)].some((m) => (m[0].match(/[0-9]/g) ?? []).length >= 7);
  if (EMAIL.test(text) || longNumber) codes.push("personal_data");
  if (LINK.test(text.replace(EMAIL_G, " ").replace(OWN_SITE, " "))) codes.push("link");
  if (spoken && PRICE.test(text)) codes.push("price");
  if (spoken && PROMISE.test(text)) codes.push("promise");
  return codes;
}

// ------------------------------------------------------------------ structure
const collectField = z
  .object({
    field: id,
    /** exact: said as written; natural: the reference the AI may rephrase. */
    question: line(300),
    wording: z.enum(["exact", "natural"]).default("natural"),
    required: z.boolean().default(true),
  })
  .strict();

const when = z
  .object({
    intent: z.array(z.enum(GUIDED_INTENTS)).min(1).max(GUIDED_INTENTS.length).nullable().optional(),
    all_required: z.boolean().nullable().optional(),
    field_set: id.nullable().optional(),
    field_missing: id.nullable().optional(),
  })
  .strict();

const stage = z
  .object({
    id,
    objective: line(300),
    guidance: z.string().max(800).default(""),
    mandatory: z.array(z.object({ id, text: line(500) }).strict()).max(4).default([]),
    collect: z.array(collectField).max(8).default([]),
    knowledge: z.array(z.string()).max(10).default([]),
    next: z.array(z.object({ when: when.default({}), go: z.string().regex(TARGET) }).strict()).min(1).max(12),
    retries: z
      .object({
        unclear: z.number().int().min(0).max(3).default(1),
        line: line(300).nullable().optional(),
        then: z.string().regex(/^close:[a-z][a-z0-9_]{0,39}$/).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const closing = z
  .object({
    text: line(500),
    outcome: z.enum(GUIDED_OUTCOMES),
    /** Said after `text` only when team follow-up is switched on. */
    team_followup_text: line(300).nullable().optional(),
  })
  .strict();

export const guidedFlowDefinition = z
  .object({
    schema_version: z.literal(2),
    kind: z.literal("guided"),
    name: line(100),
    language: z.enum(GUIDED_LANGUAGES),
    language_style: z.enum(["mixed", "pure"]).nullable().optional(),
    voice_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).nullable().optional(),
    greeting: z.object({ text: line(300) }).strict(),
    identity: z.object({ question: line(200), reask: z.string().max(200).regex(SINGLE_LINE).nullable().optional() }).strict().nullable().optional(),
    silence: z.object({ reprompt: line(200), closing: line(200) }).strict(),
    limits: z.object({ max_duration_sec: z.number().int().min(30).max(600) }).strict(),
    pauses: z
      .object({
        short_ms: z.number().int().min(0).max(3000).default(300),
        medium_ms: z.number().int().min(0).max(3000).default(700),
        long_ms: z.number().int().min(0).max(3000).default(1200),
      })
      .strict()
      .nullable()
      .optional(),
    recording_notice: line(300).nullable().optional(),
    disclosures: z.object({ ai: line(300) }).strict(),
    clarify_line: line(300),
    start: id,
    stages: z.array(stage).min(1).max(30),
    closings: z.record(id, closing).refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= 20),
    training: callFlowTraining.nullable().optional(),
  })
  .strict();
export type GuidedFlowDefinition = z.infer<typeof guidedFlowDefinition>;

// ------------------------------------------------------------------ semantics
function fieldAllowed(name: string): boolean {
  if ((GUIDED_RUNNER_FIELDS as readonly string[]).includes(name)) return false;
  if ((GUIDED_STANDARD_FIELDS as readonly string[]).includes(name)) return true;
  return /^custom_[a-z0-9_]{1,32}$/.test(name) && !name.split("_").slice(1).some((p) => SENSITIVE_PARTS.has(p));
}

function semanticIssues(flow: GuidedFlowDefinition): GuidedIssue[] {
  const out: GuidedIssue[] = [];
  const add = (code: GuidedIssueCode, path: string, message: string) => out.push({ code, path, message });
  const texts = (text: string | null | undefined, path: string, spoken = true) => {
    if (text) for (const code of guidedTextCodes(text, { spoken })) add(code, path, `text check failed: ${code}`);
  };

  if (flow.language === "en" && flow.language_style != null) add("language_style", "language_style", "an English flow has no language style");
  if (flow.identity && !/\{\{\s*(customer_name|name)\s*\}\}/.test(flow.identity.question)) {
    add("identity_needs_name", "identity.question", "must contain {{customer_name}}");
  }
  const stageIds = flow.stages.map((s) => s.id);
  for (const sid of [...new Set(stageIds.filter((s, i) => stageIds.indexOf(s) !== i))].sort()) {
    add("duplicate_stage", "stages", `stage id '${sid}' is used twice`);
  }
  const stages = new Set(stageIds);
  if (!stages.has(flow.start)) add("unknown_start", "start", `no stage '${flow.start}'`);
  for (const name of GUIDED_REQUIRED_CLOSINGS) {
    if (!(name in flow.closings)) add("missing_closing", "closings", `closing '${name}' is required`);
  }
  const targetOk = (t: string) => (t.startsWith("close:") ? t.slice(6) in flow.closings : stages.has(t));

  const collected = new Map<string, string>();
  const topics = new Set((flow.training?.knowledge ?? []).map((k) => k.topic));
  flow.stages.forEach((s, si) => {
    const p = `stages.${si}`;
    texts(s.objective, `${p}.objective`, false);
    texts(s.guidance, `${p}.guidance`, false);
    s.mandatory.forEach((st, mi) => {
      texts(st.text, `${p}.mandatory.${mi}.text`);
      if (TEAM_FOLLOWUP.test(st.text)) add("team_followup_in_text", `${p}.mandatory.${mi}.text`, "say it in a closing's team_followup_text");
    });
    s.collect.forEach((c, ci) => {
      if (!fieldAllowed(c.field)) add("forbidden_field", `${p}.collect.${ci}.field`, `'${c.field}' can't be collected`);
      if (collected.has(c.field)) add("duplicate_field", `${p}.collect.${ci}.field`, `'${c.field}' is already collected in '${collected.get(c.field)}'`);
      if (!collected.has(c.field)) collected.set(c.field, s.id);
      texts(c.question, `${p}.collect.${ci}.question`);
    });
    s.knowledge.forEach((topic, ki) => {
      if (!topics.has(topic)) add("unknown_knowledge", `${p}.knowledge.${ki}`, `no training knowledge topic '${topic}'`);
    });
    if (s.retries) {
      texts(s.retries.line, `${p}.retries.line`);
      if (s.retries.then && !targetOk(s.retries.then)) add("unknown_target", `${p}.retries.then`, `'${s.retries.then}' does not exist`);
    }
    s.next.forEach((tr, ti) => {
      const tp = `${p}.next.${ti}`;
      if (!targetOk(tr.go)) add("unknown_target", `${tp}.go`, `'${tr.go}' does not exist`);
      const w = tr.when;
      const isDefault = !(w.intent && w.intent.length) && !w.all_required && !w.field_set && !w.field_missing;
      if (isDefault && ti !== s.next.length - 1) add("unreachable_rule", tp, "a rule without conditions must be the last one");
      const intents = new Set<string>(w.intent ?? []);
      if (intents.has("do_not_call") && tr.go !== "close:do_not_call") {
        add("safety_override", `${tp}.go`, "do_not_call always ends the call with close:do_not_call");
      }
      if ([...intents].some((i) => REFUSAL_INTENTS.has(i)) && !tr.go.startsWith("close:")) {
        add("refusal_continues", `${tp}.go`, "a refusal, busy or end request may only lead to a closing");
      }
    });
  });
  flow.stages.forEach((s, si) =>
    s.next.forEach((tr, ti) => {
      for (const key of ["field_set", "field_missing"] as const) {
        const name = tr.when[key];
        if (name && !collected.has(name)) add("unknown_condition_field", `stages.${si}.next.${ti}.when.${key}`, `no stage collects '${name}'`);
      }
    }),
  );

  if (stages.has(flow.start)) {
    const seen = new Set([flow.start]);
    const todo = [flow.start];
    while (todo.length) {
      const current = todo.pop()!;
      for (const tr of flow.stages.find((s) => s.id === current)!.next) {
        if (stages.has(tr.go) && !seen.has(tr.go)) {
          seen.add(tr.go);
          todo.push(tr.go);
        }
      }
    }
    for (const sid of stageIds) if (!seen.has(sid)) add("unreachable_stage", "stages", `stage '${sid}' can't be reached from '${flow.start}'`);
  }

  if (!AI_WORDS.test(flow.disclosures.ai)) add("disclosure_not_ai", "disclosures.ai", "must say honestly that the agent is an AI assistant");
  const fixed: [string, string | null | undefined][] = [
    ["greeting.text", flow.greeting.text], ["disclosures.ai", flow.disclosures.ai], ["clarify_line", flow.clarify_line],
    ["silence.reprompt", flow.silence.reprompt], ["silence.closing", flow.silence.closing], ["recording_notice", flow.recording_notice],
    ["identity.question", flow.identity?.question], ["identity.reask", flow.identity?.reask],
  ];
  for (const [path, text] of fixed) texts(text, path);
  for (const [name, c] of Object.entries(flow.closings)) {
    texts(c.text, `closings.${name}.text`);
    texts(c.team_followup_text, `closings.${name}.team_followup_text`);
    if (TEAM_FOLLOWUP.test(c.text)) add("team_followup_in_text", `closings.${name}.text`, "say it in team_followup_text");
  }
  return out;
}

/** Every issue of a guided flow definition: one "schema" issue when its shape is wrong, else the semantic issues
 * ([] = valid). The same codes as check_guided_flow() on the voice backend. */
export function guidedFlowIssues(raw: unknown): GuidedIssue[] {
  const parsed = guidedFlowDefinition.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return [{ code: "schema", path: first?.path.join(".") ?? "", message: first?.message ?? "invalid" }];
  }
  return semanticIssues(parsed.data);
}
