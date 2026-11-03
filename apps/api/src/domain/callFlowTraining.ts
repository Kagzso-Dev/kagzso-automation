// Call flow training: "Create training from this turn" on a call's transcript.
//
// The admin picks an Agent line of a call that used a call flow and writes the better reply; it is
// saved into that flow's training as a Draft "bad example" (never Active, never published here).
// Only text is copied (never audio), and personal details are removed first: the call's own name and
// follow-up detail, emails, links, long numbers, and "my name is …" style introductions.

import {
  callFlowDefinition,
  newTrainingId,
  trainingDefaultTokenCap,
  type CallFlowAgentSummary,
  type CallFlowDefinition,
  type CallFlowTraining,
  type TrainingCallTurn,
  type TrainingExample,
} from "@dispatch/shared";

const MAX_LINE = 300;
/** The customer line used for an Agent line nothing came before (e.g. the greeting). */
export const CALL_START = "(the call has just connected)";

export type TranscriptLine = { speaker: "customer" | "agent"; text: string };

/** "Customer: …" / "Agent: …" lines (aiCalls.formatTranscript); a line without a prefix continues the last one. */
export function parseTranscript(transcript: string | null | undefined): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of (transcript ?? "").split(/\r?\n/)) {
    const m = /^(Customer|Agent):\s?(.*)$/.exec(raw);
    if (m) out.push({ speaker: m[1] === "Customer" ? "customer" : "agent", text: m[2]!.trim() });
    else if (out.length && raw.trim()) out[out.length - 1]!.text += ` ${raw.trim()}`;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_NAMES = new Set(["kagzso", "kexo", "sir", "madam", "the", "from", "here", "speaking", "calling"]);
const INTRO_RE = /\b(my name is|name is|this is|i am|i'm|call me)\s+([A-Z][a-z'-]+)/gi;
const isName = (word: string) => !NOT_NAMES.has(word.toLowerCase()) && word[0] === word[0]!.toUpperCase();

/** Names someone introduced in the text ("my name is Priya"), so later mentions are removed too. */
export function introducedNames(text: string): string[] {
  return [...text.matchAll(INTRO_RE)].map((m) => m[2]!).filter(isName);
}

/** `text` without personal details. `known` = this call's own customer name and follow-up detail. */
export function scrubPersonalData(text: string, known: { name?: string | null; detail?: string | null } = {}): string {
  let out = text;
  const detail = known.detail?.trim();
  if (detail && detail.length >= 4) out = out.replace(new RegExp(escapeRe(detail), "gi"), "(detail)");
  out = out
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "(email)")
    .replace(/https?:\/\/\S+|\bwww\.\S+/gi, "(link)")
    .replace(/\b(?!kagzso\.com\b)[a-z0-9-]+\.(com|in|net|org|io|co|ai|app|info|biz)\b/gi, "(link)")
    // Phone numbers, account numbers, OTPs: any run with 5+ digits.
    .replace(/\+?\d[\d\s().-]*\d/g, (m) => (m.replace(/\D/g, "").length >= 5 ? "(number)" : m));
  const words = (known.name ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[.,]/g, ""))
    .filter((w) => w.length >= 2 && !NOT_NAMES.has(w.toLowerCase()));
  for (const w of words.sort((a, b) => b.length - a.length)) {
    // \b doesn't work for Tamil / Hindi letters: Latin names use word boundaries, others plain matches.
    const re = /^[\x20-\x7e]+$/.test(w) ? new RegExp(`\\b${escapeRe(w)}\\b`, "gi") : new RegExp(escapeRe(w), "g");
    out = out.replace(re, "(name)");
  }
  out = out
    .replace(/\b(Mr|Mrs|Ms|Miss|Dr)\.?\s+[A-Z][\w'-]*/g, "(name)")
    .replace(INTRO_RE, (m, intro: string, name: string) => (isName(name) ? `${intro} (name)` : m))
    .replace(/(என்\s*பெயர்|என்னோட\s*பெயர்|मेरा\s*नाम|నా\s*పేరు|ನನ್ನ\s*ಹೆಸರು)\s*\S+/g, "$1 (name)")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > MAX_LINE ? `${out.slice(0, MAX_LINE - 1)}…` : out;
}

/** Each Agent line with what the customer said just before it, personal details removed. */
export function transcriptTurns(transcript: string | null | undefined, known: { name?: string | null; detail?: string | null }): TrainingCallTurn[] {
  const lines = parseTranscript(transcript);
  // The call's own name plus every name introduced anywhere in the call, removed from every turn.
  const names = [known.name ?? "", ...lines.flatMap((l) => introducedNames(l.text))].join(" ");
  known = { ...known, name: names };
  const turns: TrainingCallTurn[] = [];
  let customer: string[] = [];
  lines.forEach((l, i) => {
    if (l.speaker === "customer") {
      if (l.text) customer.push(l.text);
      return;
    }
    const agent = scrubPersonalData(l.text, known);
    if (agent) turns.push({ turn: i, customer: scrubPersonalData(customer.join(" "), known) || CALL_START, agent });
    customer = [];
  });
  return turns;
}

/** Optional labels the admin picks for a correction (situation, topic, language style). */
export type CorrectionMeta = Pick<TrainingExample, "situation" | "topic" | "style">;

/** A Draft bad example made from one turn (the admin's better reply is checked, not changed). */
export function correctionFromTurn(turn: TrainingCallTurn, better: string, reason: string, meta: CorrectionMeta = {}): TrainingExample {
  const topic = meta.topic?.trim();
  return {
    id: newTrainingId("call"),
    status: "draft",
    kind: "bad",
    source: "call",
    ...(meta.situation ? { situation: meta.situation } : {}),
    ...(topic ? { topic } : {}),
    ...(meta.style ? { style: meta.style } : {}),
    customer: turn.customer,
    agent: turn.agent,
    reason: reason.trim() || "Corrected from a call",
    better: better.trim(),
  };
}

/** The published version's agent profile, for the Simple AI Call form (never the rest of the training). */
export function agentSummary(definition: unknown): CallFlowAgentSummary | null {
  const parsed = callFlowDefinition.safeParse(definition);
  const persona = parsed.success ? parsed.data.training?.persona : null;
  if (!parsed.success || !persona) return null;
  return {
    agentName: persona.agent_name,
    role: persona.role,
    company: persona.company,
    objective: persona.objective,
    trainingOn: !!parsed.data.training?.enabled && persona.status === "active",
  };
}

/** A definition for a copy of a flow: the new name, and its training kept or left out. */
export function copyDefinition(definition: CallFlowDefinition, name: string, includeTraining: boolean): CallFlowDefinition {
  const { training, ...rest } = structuredClone(definition);
  return { ...rest, name, ...(includeTraining && training ? { training } : {}) };
}

/** What a non-admin may see of a stored definition: everything but the training. */
export function withoutTraining<T>(definition: T): T {
  if (!definition || typeof definition !== "object" || Array.isArray(definition) || !("training" in definition)) return definition;
  const { training: _hidden, ...rest } = definition as Record<string, unknown>;
  return rest as T;
}

/** A flow's first training: switched off, the language's starting cap (larger for Indic scripts). */
const emptyTraining = (language: string): CallFlowTraining => ({
  enabled: false,
  token_cap: trainingDefaultTokenCap(language),
  phrases: [],
  knowledge: [],
  examples: [],
});

/** `definition` with the example added to its training (training starts switched off when it had none). */
export function withExample(definition: CallFlowDefinition, example: TrainingExample): CallFlowDefinition {
  const training = definition.training ?? emptyTraining(definition.language);
  return { ...definition, training: { ...training, examples: [...training.examples, example] } };
}
