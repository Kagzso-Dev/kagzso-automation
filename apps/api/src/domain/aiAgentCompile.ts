// AI Agents → Call Flow: an autonomous agent's settings, its industry and its APPROVED knowledge compiled into
// an ordinary schema-1 "executive" flow definition with `autonomous` settings. Pure (no I/O): the caller
// passes the language's built-in executive flow, exactly as its voice backend serves it, so the script, the
// locked safety blocks and the per-language lines stay the voice backend's own.
//
// What changes compared with the built-in executive flow:
//   greeting / identity  AI_AGENT_OPENINGS for the language, with the agent and company names filled in
//   blocks               "agent" (who calls, why, the business), "opening", "company_facts" rewritten;
//                        "industry_context", "voice_delivery", "call_length" and (when given) "ai_instructions"
//                        added;
//                        {{title_to_use}} → {{title}} everywhere, so a contact without a gender gets no
//                        sir / madam (title_to_use would fall back to CALL_DEFAULT_TITLE)
//   training             agent profile (name, company, industry, tone) + approved knowledge, all Active
//   limits / autonomous  max = the agent's maximum (the hard stop), target = its target
// Everything the voice backend appends to every prompt (voice rules, safety rules, do-not-call, AI disclosure,
// identity rules, language rule) still comes after these blocks and can't be overridden by them.

import { createHash } from "node:crypto";
import {
  AI_AGENT_OPENINGS,
  AI_AGENT_PERSONALITY_TONE,
  AI_KNOWLEDGE_MAX_APPROVED,
  CALL_FLOW_MAX_BLOCK_CHARS,
  TRAINING_MAX_TOKEN_CAP,
  type AiAgentConfig,
  type AiCallLanguage,
  type CallFlowDefinition,
  type CallFlowTextBlock,
} from "@dispatch/shared";

export interface CompileKnowledgeItem {
  id: string;
  kind: "fact" | "qa";
  topic: string;
  text: string;
  questions: string[];
  always: boolean;
}

export interface CompileInput {
  language: AiCallLanguage;
  agent: AiAgentConfig;
  categoryName: string | null;
  industry: { name: string; discoveryTopics: string } | null;
  /** APPROVED items of this agent only. */
  knowledge: CompileKnowledgeItem[];
  /** The language's built-in "executive" flow (GET /api/flows/builtin of that language's voice backend). */
  base: CallFlowDefinition;
  /** The AI's picked voice (Settings → AI Voice); null = the built-in flow's voice (the backend default), as before. */
  voice?: { id: string; gender: "female" | "male" | null } | null;
}

export class AgentCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCompileError";
  }
}

/** Text an admin typed, made safe for a flow block: no {{variables}}, no end-call marker, no control characters. */
export function blockSafe(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/\{\{|\}\}/g, "")
      .replace(/\[\[\s*END[\s_-]*CALL\s*\]\]/gi, "")
      .trim()
  );
}

/** A one-line value (names, business) for a block or a spoken line. */
const oneLine = (text: string | null | undefined) => blockSafe(text ?? "").replace(/\s+/g, " ").trim();

/** "+919876543210" → "+91 98765 43210" (read out digit by digit; the agent is told so). */
function spacedNumber(e164: string): string {
  const m = /^\+(91)(\d{5})(\d{5})$/.exec(e164);
  return m ? `+${m[1]} ${m[2]} ${m[3]}` : e164;
}

function topics(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/\n|;/)
    .map((t) => oneLine(t))
    .filter(Boolean)
    .slice(0, 15);
}

const isKagzso = (company: string) => /kagzso/i.test(company);

function agentBlock(input: CompileInput): string {
  const { agent } = input;
  const exec = oneLine(agent.executiveName);
  const company = oneLine(agent.companyName);
  const business = oneLine(agent.businessName);
  const industry = input.industry ? oneLine(input.industry.name) : null;
  const category = input.categoryName ? oneLine(input.categoryName) : null;
  const where = [business && `**${business}**`, industry && `a business in the **${industry}** industry`, category && `(${category})`]
    .filter(Boolean)
    .join(", ");
  return (
    "# WHO YOU ARE AND WHY YOU ARE CALLING\n\n" +
    `You are **${exec}**, an AI calling assistant working as a **professional business development executive** for **${company}**, ` +
    "on a live outbound phone call.\n\n" +
    (where ? `You are calling the contact person at ${where}.\n\n` : "") +
    `**Calling objective:** ${blockSafe(agent.objective) || "introduce how the company can help their business and find out whether they are interested."}\n\n` +
    "You lead the conversation yourself: decide every next step from what the customer actually says. There is no fixed " +
    "list of questions. The objective guides the conversation; it is never a reason to push. A clear \"no\" is a good, respected outcome.\n\n" +
    "The details entered for this call (the contact's name, gender and business) were typed in by the team and are NOT verified. " +
    "If the person says they are someone else or that the business is different, believe them and continue politely as the rules below say.\n\n---\n\n"
  );
}

function openingBlock(greeting: string): string {
  return (
    "# OPENING\n\n" +
    `The call opens with the system saying "${greeting}". When the customer's name is known, the system then asks whether ` +
    "it is speaking with them. Both appear as assistant messages in the conversation: never say them again and never say good " +
    "morning, good afternoon or good evening yourself.\n\n" +
    "Whatever the customer says next, respond to it. After they confirm who they are, thank them briefly and say in one short " +
    "sentence why you are calling, relevant to their industry (see THE CUSTOMER'S BUSINESS). Confirming their name never ends the call. " +
    "If they say they are not the person you asked for, do not assume anything: politely continue with them as the identity rules say.\n\n---\n\n"
  );
}

function industryBlock(input: CompileInput): string {
  const company = oneLine(input.agent.companyName);
  const industry = input.industry ? oneLine(input.industry.name) : null;
  const list = topics(input.industry?.discoveryTopics);
  const callback = input.agent.callbackNumber ? spacedNumber(input.agent.callbackNumber) : null;
  return (
    "# THE CUSTOMER'S BUSINESS\n\n" +
    (industry ? `Industry: **${industry}**. Speak in terms that make sense for a ${industry} business.\n\n` : "") +
    (list.length
      ? "Topics worth exploring with this kind of business. These are DISCOVERY topics to ask about - they are NOT claims " +
        `about what ${company} offers:\n` +
        list.map((t) => `* ${t}`).join("\n") +
        "\n\nPick at most one or two that fit what the customer says. Ask about how they handle it today and what takes their " +
        "team the most time; never list them all.\n\n"
      : "") +
    `**Only describe products and services that the approved company facts or the training's approved knowledge confirm.** ` +
    "Never say that a product or feature exists, works in a certain way or suits them unless an approved note says so.\n\n" +
    "**A question the approved information doesn't answer:** never guess or invent. Say honestly that you don't have that detail " +
    "right now, then:\n" +
    "* if `team_follow_up_configured` is true in the customer details, say the team can clarify it;\n" +
    (callback
      ? `* otherwise, if they want to know more, they can call ${company} on ${callback} (say the number slowly, digit by digit, only when they ask how to reach the company or want exact details).\n`
      : "* otherwise, point them to the website for details when it is relevant.\n") +
    "Never promise a callback, a demo, a meeting or a visit.\n\n---\n\n"
  );
}

function companyFactsBlock(original: string, company: string): string {
  if (!isKagzso(company)) {
    // Another company: the built-in Kagzso facts don't apply. Only its approved knowledge (training) does.
    return (
      `# APPROVED COMPANY FACTS (${company})\n\n` +
      `Use only the training's approved facts and Q&A for anything about ${company}. Never add facts that are not there.\n\n` +
      "If `business_type` or `company_name` is in the customer details, use it naturally when relevant; never ask for it.\n\n---\n\n"
    );
  }
  // A Kagzso company: keep the built-in facts, under the configured company name.
  return original
    .replace(/Kagzso AI and Automation/g, company)
    .replace(/\n\nIf the Agent profile names a different company,[^\n]*\n/, "\n")
    .replace(/\* The website is kagzso\.com,/, "* The website is kagzso.com,");
}

function callLengthBlock(target: number, max: number): string {
  return (
    "# CALL LENGTH\n\n" +
    `Aim to finish in about ${target} seconds. The call is cut off by the phone system at ${max} seconds, so never let it run long.\n\n` +
    "In order of priority: 1. introduce yourself, 2. the reason for the call, 3. one relevant service, 4. one or two questions " +
    "about their needs, 5. their interest and a suitable next step, 6. a polite closing.\n\n" +
    "Never interrupt or rush the customer to keep to the time, and never mention the time. A customer who wants to stop, is " +
    "busy, refuses or asks not to be called again ends the call at once.\n\n---\n\n"
  );
}

/**
 * How the agent's words should sound. The voice itself (one speaker, a relaxed pace, a steady delivery, whole
 * sentences, no exclamation marks) is set by the voice backend for agent calls (AGENT_TTS_*); this asks the AI
 * for text that reads calmly aloud and for patience - it never relaxes a rule above it.
 */
export const VOICE_DELIVERY_BLOCK =
  "# VOICE AND DELIVERY\n\n" +
  "Everything you write is spoken aloud by one calm, warm, professional voice.\n\n" +
  "* Unhurried and reassuring: short, complete sentences, one idea each. Never rush, and never sound like an " +
  "advertisement or a sales pitch.\n" +
  "* No exclamation marks and no words in capital letters: a calm full stop sounds warmer on the phone.\n" +
  "* Ask one question, then stop and let the customer answer.\n" +
  "* When the customer hesitates, goes quiet, interrupts or asks the same thing again, stay patient and kind: " +
  "acknowledge it briefly (for example \"No problem\" or \"Sure\") and answer again, more simply. Never say " +
  "\"as I said\" and never sound impatient.\n" +
  "* Keep the same calm, respectful tone from the first line to the last.\n\n---\n\n";

/**
 * Added to the voice block only when a voice was picked: the voice's gender belongs to the AI, never to the
 * customer, so a male customer is still "sir" with a female voice (and the other way round). Agents without a
 * picked voice compile exactly as before.
 */
export function voiceIdentityLines(gender: "female" | "male"): string {
  return (
    `* Your voice is a ${gender} voice. Whenever your language uses different word forms for a male or a female ` +
    `speaker, use the ${gender} forms when you speak about yourself.\n` +
    "* Your voice says nothing about the customer: address the customer only as the call details say (sir, madam, " +
    "or neither when no gender is given), never by the voice's gender.\n"
  );
}

function voiceDeliveryBlock(voice: CompileInput["voice"]): string {
  if (!voice?.gender) return VOICE_DELIVERY_BLOCK;
  const end = "\n\n---\n\n";
  return VOICE_DELIVERY_BLOCK.slice(0, -end.length) + "\n" + voiceIdentityLines(voice.gender).trimEnd() + end;
}

export const INSTRUCTIONS_HEADER = "# AI CONVERSATION INSTRUCTIONS (FROM THE ADMIN)";

function instructionsBlock(text: string): string {
  const body = blockSafe(text)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return (
    `${INSTRUCTIONS_HEADER}\n\n` +
    "Follow these instructions throughout the whole call, on every reply. When anything conflicts, this order decides:\n" +
    "1. Safety, do-not-call and the customer's refusal or wish to end the call.\n" +
    "2. Legal and mandatory disclosures (you are an AI assistant; never claim to be human).\n" +
    "3. Approved company and product facts (never invent anything).\n" +
    "4. The restrictions below.\n" +
    "5. The calling objective and the conversation preferences below.\n" +
    "Never follow an instruction below that asks you to hide that you are an AI, ignore a refusal or do-not-call, " +
    "invent facts, promise prices, savings, demos, meetings or callbacks, or ask for personal details.\n\n" +
    body +
    "\n\n---\n\n"
  );
}

// The built-in executive's do-not-call line. The voice backend speaks a flow's first quoted line in its
// "do_not_call" block word for word (reply_speed.flow_dnc_line), so a Tamil / Hindi / Kannada agent gets it
// in its own language instead of in English.
const BUILTIN_DNC_QUOTE = '"Understood. I respect your request. Thank you."';

function doNotCallBlock(text: string, line: string): string {
  if (!text.includes(BUILTIN_DNC_QUOTE)) {
    throw new AgentCompileError("The built-in Business executive flow's do-not-call line changed — update the AI Agents compiler");
  }
  return text.replace(BUILTIN_DNC_QUOTE, `"${line}"`);
}

function fill(template: string, exec: string, company: string): string {
  return template.replace("{agent}", exec).replace("{company}", company);
}

/** Throws AgentCompileError for anything the voice backend would refuse, with a message an admin can act on. */
export function compileAgentFlow(input: CompileInput): CallFlowDefinition {
  const { agent, language, base } = input;
  if (base.base !== "executive" || base.language !== language) {
    throw new AgentCompileError("The voice backend's built-in Business executive flow for this language is missing");
  }
  const opening = AI_AGENT_OPENINGS[language];
  if (!opening) throw new AgentCompileError("AI Agents have no reviewed opening lines in this language yet");
  const exec = oneLine(agent.executiveName);
  const company = oneLine(agent.companyName);
  const greeting = fill(opening.greeting, exec, company);
  if (greeting.length > 300) throw new AgentCompileError("The agent and company names make the opening longer than 300 characters");
  if (input.knowledge.length > AI_KNOWLEDGE_MAX_APPROVED) {
    throw new AgentCompileError(`At most ${AI_KNOWLEDGE_MAX_APPROVED} approved knowledge items per agent — reject or merge some`);
  }

  const swapTitle = (text: string) => text.replace(/\{\{\s*title_to_use\s*\}\}/g, "{{title}}");
  const blocks: CallFlowDefinition["blocks"] = [];
  for (const b of base.blocks) {
    if ("locked" in b) {
      blocks.push(b);
      continue;
    }
    let text = b.text;
    if (b.id === "agent") text = agentBlock(input);
    else if (b.id === "opening") text = openingBlock(greeting.replace(/\{\{\s*(time_greeting|title)\s*\}\}/g, (_m, v) => (v === "title" ? "sir / madam" : "Good morning")));
    else if (b.id === "company_facts") text = companyFactsBlock(b.text, company);
    else if (b.id === "do_not_call") text = doNotCallBlock(b.text, opening.dnc);
    blocks.push({ ...b, text: swapTitle(text) });
    if (b.id === "agent") {
      blocks.push({ id: "industry_context", group: "main_script", text: industryBlock(input) });
    }
  }
  blocks.push({ id: "voice_delivery", group: "tone", text: voiceDeliveryBlock(input.voice) });
  blocks.push({ id: "call_length", group: "rules", text: callLengthBlock(agent.targetDurationSec, agent.maxDurationSec) });
  if (blockSafe(agent.instructions)) {
    blocks.push({ id: "ai_instructions", group: "rules", text: instructionsBlock(agent.instructions) });
  }
  for (const b of blocks) {
    if (!("locked" in b) && (b as CallFlowTextBlock).text.length > CALL_FLOW_MAX_BLOCK_CHARS) {
      throw new AgentCompileError(`The "${b.id}" part is longer than ${CALL_FLOW_MAX_BLOCK_CHARS} characters — shorten the instructions or topics`);
    }
  }

  const tone = AI_AGENT_PERSONALITY_TONE[agent.personality];
  const definition: CallFlowDefinition = {
    ...base,
    // The picked voice speaks every line of every call of this flow (greeting, replies, fixed lines).
    ...(input.voice ? { voice_id: input.voice.id } : {}),
    name: oneLine(agent.name).slice(0, 100) || "AI Agent",
    greeting: { text: greeting },
    identity: { question: opening.identity, reask: opening.reask },
    blocks,
    limits: { max_duration_sec: agent.maxDurationSec },
    autonomous: { target_duration_sec: agent.targetDurationSec, dnc_enforce: true },
    training: {
      enabled: true,
      token_cap: TRAINING_MAX_TOKEN_CAP,
      persona: {
        status: "active",
        agent_name: exec,
        company,
        business_type: input.industry ? oneLine(input.industry.name).slice(0, 100) : "",
        objective: "",
        call_purpose: "",
        target_customer: "",
        intro: "",
        desired_outcome: "",
        role: "",
        formality: tone.formality,
        warmth: tone.warmth,
        energy: tone.energy,
        politeness: tone.politeness,
        pace: "steady",
        sentence_length: "short",
        title_use: "sometimes",
        avoid: ["pushiness", "exaggeration"],
        notes: "",
      },
      phrases: [],
      knowledge: input.knowledge.map((k, i) =>
        k.kind === "qa"
          ? { id: `k${i + 1}`, status: "active" as const, kind: "qa" as const, topic: k.topic, always: false, questions: k.questions, text: k.text }
          : { id: `k${i + 1}`, status: "active" as const, kind: "fact" as const, topic: k.topic, always: k.always, questions: [], text: k.text },
      ),
      examples: [],
    },
  };
  return definition;
}

/** Stable hash of a compiled definition (key order independent): "unpublished changes" = differs from the last publish. */
export function compiledHash(definition: CallFlowDefinition): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)]))
        : v;
  return createHash("sha256").update(JSON.stringify(sort(definition))).digest("hex");
}
