// AI Agents → Call Flow: an autonomous agent's settings and its APPROVED knowledge compiled into an ordinary
// schema-1 "executive" flow definition with `autonomous` settings. Pure (no I/O): the caller passes the language's
// built-in executive flow, exactly as its voice backend serves it.
//
// One flow serves every contact, so nothing about a contact's business is compiled here: the voice backend adds it to
// each call's prompt (llm_service.customer_business_rules), with one set of rules for a known business and another
// for none.
//
// An autonomous agent is LLM-driven, and since compiler 4 (2026-11-26) the admin's AI Conversation Instructions lead
// it: no fixed conversation sequence, greeting, question list, pitch, closing script, speaking style or reply length is
// compiled in. The executive flow only carries what must stay the same for every call (the locked safety blocks, the
// do-not-call handling, refusal handling, the outcomes and the rules). Guided Call Flows (the executive flow itself and
// every copy of it) are not touched.
//
// What changes compared with the built-in executive flow:
//   conversation_stages, opening, interested_close   removed: no sequence, no set opening, no set close
//   greeting             AI_AGENT_OPENINGS for the language (required by the schema; never spoken: natural_lines,
//                        unless the voice backend's AGENT_FIXED_GREETING says so)
//   identity             none: nobody is asked to confirm who they are as a routine step
//   blocks               "agent" (who, for whom, why, how to listen), "ai_instructions" (the admin's text, right after
//                        it), "customer_business" and "objections" as truthfulness rules only, "next_step" as what the
//                        agent can and cannot do on a call, "speaking_style" only where a name needs its script, the
//                        busy / not-interested / end closings as refusal handling, plus "voice_delivery" (what the
//                        text-to-speech voice needs) and "call_length" (the agent's own target and the hard stop);
//                        {{title_to_use}} -> {{title}} everywhere, so a contact without a gender gets no sir / madam
//   training             agent profile (name, company, the agent's personality) + approved knowledge, all Active
//   limits / autonomous  max = the agent's maximum (the hard stop), target = its target, voice_pace = its voice speed,
//                        contact_business = each call uses the contact's own business, instructions_lead = the voice
//                        backend adds no conversation rules of its own (only safety, truthfulness, privacy, technical)
// Everything the voice backend appends to every prompt (voice output rules, safety rules, do-not-call, AI disclosure,
// privacy, language and script rule) still comes after these blocks and can't be overridden by them, and the backend
// itself enforces do-not-call and the time limit whatever the LLM says.

import {
  AI_AGENT_OPENINGS,
  AI_AGENT_PERSONALITY_TONE,
  AI_KNOWLEDGE_MAX_APPROVED,
  businessDisplayName,
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
  /** APPROVED items of this agent only. */
  knowledge: CompileKnowledgeItem[];
  /** The language's built-in "executive" flow (GET /api/flows/builtin of that language's voice backend). */
  base: CallFlowDefinition;
  /** The AI's picked voice (Settings → AI Voice); null = the built-in flow's voice (the backend default), as before. */
  voice?: { id: string; gender: "female" | "male" | null } | null;
}

/**
 * Bumped whenever the compiler changes what an agent's calls do. Part of agentInputsHash, so an agent published
 * with an older compiler shows "unpublished changes" until an admin publishes it again: a published flow is a
 * stored copy, and compiler changes only reach it through a new publish.
 */
export const AI_AGENT_COMPILER_VERSION = 5;

/**
 * A compiler change that reaches one language only: its agents show "unpublished changes" (agentInputsHash), every
 * other language's hash stays exactly as before. Tamil 1 (2026-11-24): the discovery-first business sentence.
 * Tamil 2 (2026-11-26): no "the team will confirm" for an unknown detail or price.
 * Tamil 3 (2026-11-26): the speaking style follows the customer's language (LANGUAGE_STYLE.ta).
 * Version 4 (2026-11-26, every language): the admin's instructions lead (autonomous.instructions_lead). Tamil keeps
 * its revision only so that its hash stays as distinct as before.
 * Version 5 (2026-11-26, every language): the company name is written with readable casing (businessDisplayName).
 */
export const AI_AGENT_COMPILER_LANGUAGE_REVISION: Partial<Record<AiCallLanguage, number>> = { ta: 3 };

/** What agentInputsHash hashes as the compiler: AI_AGENT_COMPILER_VERSION itself for a language without a revision. */
export function aiAgentCompilerVersion(language: string): number | string {
  const revision = AI_AGENT_COMPILER_LANGUAGE_REVISION[language as AiCallLanguage];
  return revision ? `${AI_AGENT_COMPILER_VERSION}.${language}${revision}` : AI_AGENT_COMPILER_VERSION;
}

/**
 * A detail the approved information doesn't answer, and a price it doesn't state. Tamil (approved 2026-11-26): no
 * team at all - real calls turned "needs confirmation from the team" into "the team will confirm". Every other
 * language: as before (businessBlock, honestAnswersBlock).
 */
const UNKNOWN_DETAIL_REPLY: Partial<Record<AiCallLanguage, string>> = {
  ta:
    "right now. Never say that the team, the company or anyone else will confirm it, explain it or get back to them.",
};
const UNKNOWN_PRICE_REPLY: Partial<Record<AiCallLanguage, string>> = {
  ta: "requirements and that you don't have the exact price. Never estimate, and never say that the team or anyone else will confirm it.\n",
};

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

/**
 * The agent's company as the AI writes and says it: readable casing whatever was typed ("KAGZSO TECHNOLOGY SERVICES" ->
 * "Kagzso Technology Services"; acronyms and brand spellings kept). The saved setting itself is never changed.
 */
const companyName = (agent: Pick<AiAgentConfig, "companyName">) => businessDisplayName(oneLine(agent.companyName));

/** "+919876543210" → "+91 98765 43210" (read out digit by digit; the agent is told so). */
function spacedNumber(e164: string): string {
  const m = /^\+(91)(\d{5})(\d{5})$/.exec(e164);
  return m ? `+${m[1]} ${m[2]} ${m[3]}` : e164;
}

const isKagzso = (company: string) => /kagzso/i.test(company);

function agentBlock(input: CompileInput): string {
  const { agent } = input;
  const exec = oneLine(agent.executiveName);
  const company = companyName(agent);
  return (
    "# WHO YOU ARE AND WHY YOU ARE CALLING\n\n" +
    `You are **${exec}**, an AI calling assistant for **${company}**, on a live outbound phone call.\n\n` +
    `**Calling objective:** ${blockSafe(agent.objective) || "introduce how the company can help their business and find out whether they are interested."}\n\n` +
    "You are having a real conversation. Before every reply, understand what the customer just said in the light of " +
    "the whole conversation so far. Answer what they asked first. Then decide yourself what to say next and whether to " +
    "ask anything: there is no script, no fixed order and no fixed list of questions. Never repeat an introduction, an " +
    "explanation, a question or a sentence you have already said. A clear \"no\" is a good, respected outcome.\n\n" +
    `Your name is always written exactly as ${exec}, in those letters, in every language.\n\n` +
    "The details entered for this call (the contact's name, gender and business) were typed in by the team and are NOT verified. " +
    "If the person says they are someone else or that the business is different, believe them and continue politely as the rules below say.\n\n---\n\n"
  );
}

/** How the customer can find out more, if they ask, or "" when nothing is configured. Never a promise of contact. */
function detailsPointer(input: CompileInput): string {
  const company = companyName(input.agent);
  const ways = [
    ...(isKagzso(company) ? ["visit kagzso.com"] : []),
    ...(input.agent.callbackNumber
      ? [`call ${company} on ${spacedNumber(input.agent.callbackNumber)} (say the number slowly, digit by digit, and only when they ask how to reach the company)`]
      : []),
  ];
  return ways.length ? `they can ${ways.join(" or ")}` : "";
}

/**
 * What holds for every customer's business. What is known about THIS customer's business differs per call, so the
 * voice backend adds it to each call's prompt (`customer_business` and llm_service.customer_business_rules).
 */
function businessBlock(input: CompileInput): string {
  const company = companyName(input.agent);
  const pointer = detailsPointer(input);
  return (
    "# THE CUSTOMER'S BUSINESS AND WHAT YOU MAY SAY\n\n" +
    "Never assume which products or services the customer's business offers, how it works or what it needs: go by what " +
    "the customer says. If they run a different kind of business from the one you were told, believe them.\n\n" +
    `**Only describe products and services that the approved company facts or the training's approved knowledge confirm.** ` +
    "Never say that a product, feature or integration exists, works in a certain way or suits them unless an approved note says so.\n\n" +
    "**A question the approved information doesn't answer:** never guess or invent. Say honestly that you don't have that detail " +
    (UNKNOWN_DETAIL_REPLY[input.language] ??
      `and that it needs confirmation from the ${company} team. That is a statement about the detail, not a promise that anyone will contact them.`) +
    (pointer ? ` If they want to know more, ${pointer}.` : "") +
    "\n\nNever promise a callback, a demo, a meeting, a visit, a WhatsApp message or an email.\n\n---\n\n"
  );
}

// The built-in flows' line for a business field a call may carry. An agent's calls have their own rules for it
// (llm_service.customer_business_rules), and those do ask, so the line would contradict them.
const BUILTIN_BUSINESS_RULE = "If `business_type` or `company_name` is in the customer details, use it naturally when relevant; never ask for it. ";

function companyFactsBlock(original: string, company: string): string {
  if (!isKagzso(company)) {
    // Another company: the built-in Kagzso facts don't apply. Only its approved knowledge (training) does.
    return (
      `# APPROVED COMPANY FACTS (${company})\n\n` +
      `Use only the training's approved facts and Q&A for anything about ${company}. Never add facts that are not there.\n\n---\n\n`
    );
  }
  if (!original.includes(BUILTIN_BUSINESS_RULE)) {
    throw new AgentCompileError("The built-in Business executive flow's company facts changed — update the AI Agents compiler");
  }
  // A Kagzso company: keep the built-in facts, under the configured company name.
  return original
    .replace(BUILTIN_BUSINESS_RULE, "")
    .replace(/Kagzso AI and Automation/g, company)
    .replace(/\n\nIf the Agent profile names a different company,[^\n]*\n/, "\n")
    .replace(/\* The website is kagzso\.com,/, "* The website is kagzso.com,");
}

function callLengthBlock(target: number, max: number): string {
  return (
    "# CALL LENGTH\n\n" +
    `The agent's target is a conversation of about ${target} seconds. The call is cut off by the phone system at ${max} seconds, ` +
    `so start moving towards a polite closing near ${Math.max(target, max - 15)} seconds when the conversation allows it, and make sure your goodbye is finished in time.\n\n` +
    "If the customer is interested and asking relevant questions, continue naturally past the target. Never stretch a call " +
    "just to reach it.\n\n" +
    "Never interrupt or rush the customer to keep to the time, and never mention the time. A customer who is not interested, " +
    "is busy or wants to stop gets one short, warm closing: acknowledge them, thank them for their time and say goodbye, with " +
    "no further pitch, then end the call. A request not to be called again ends the call at once, as the do-not-call rule " +
    "says.\n\n---\n\n"
  );
}

/**
 * What the text-to-speech voice needs. How the agent talks (tone, length, manner) is the admin's instructions'
 * business; the voice itself (one speaker, its speed) is set by the voice backend for agent calls (AGENT_TTS_*).
 */
export const VOICE_DELIVERY_BLOCK =
  "# VOICE\n\n" +
  "Everything you write is spoken aloud by one voice.\n\n" +
  "* No exclamation marks and no words in capital letters: they sound wrong when spoken.\n\n---\n\n";

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
    "These instructions were written for you by the administrator. They decide how you talk and behave on this call: " +
    "your role and personality, your language and speaking style, your objective, what you ask and how you answer. " +
    "Understand what each one is for and apply it to what the customer is saying now: they are guidance, not lines to " +
    "read out or steps to follow in order.\n\n" +
    body +
    "\n\n---\n\n"
  );
}

/**
 * The built-in closings quote one fixed English line ("Okay, no problem. Thank you ..."), which an LLM tends to read
 * word for word, in English even on a Tamil call. An agent says them in its own words, in the call's language.
 */
export const NATURAL_CLOSINGS: Record<string, string> = {
  busy:
    "# BUSY / NOT NOW\n\n" +
    "If the customer is busy, in a meeting, driving, or asks you to call later: apologise briefly for disturbing them, thank " +
    "them for their time and say goodbye, in your own words and in the call's language, in one or two short sentences. Then end " +
    "the call. Do not ask when to call back and never promise a callback.\n\n---\n\n",
  not_interested:
    "# NOT INTERESTED\n\n" +
    "If the customer says they are not interested, don't need it, or are fine: acknowledge it kindly, thank them warmly " +
    "for their time and say goodbye, in your own words and in the call's language, in one or two short sentences. Then " +
    "end the call. Do not ask why, do not re-pitch.\n\n---\n\n",
  end_call_request:
    "# THE CUSTOMER WANTS TO END\n\n" +
    "If the customer says bye, has to go, or asks to end the call: thank them for their time and say goodbye, in your " +
    "own words and in the call's language, in one short sentence. Then end the call.\n\n---\n\n",
};

/** What an agent can and cannot do on a call: true for every agent, whatever its instructions say. */
export const CALL_CAPABILITIES_BLOCK =
  "# WHAT YOU CAN AND CANNOT DO ON THIS CALL\n\n" +
  "Talking is all you can do on this call.\n\n" +
  "* Never claim to check, look up, note, send or book anything, and never say that anything was done or will be done.\n" +
  "* Never ask how to reach the customer or for any contact details.\n" +
  "* Never end the call while the customer is asking a question or asking you to explain something.\n" +
  "* Your spoken words always come first: the end-of-call marker is the very last thing you write, never the start of a reply.\n\n---\n\n";

/** What is true and allowed when these subjects come up: facts and honesty, never a line to read out. */
function honestAnswersBlock(input: CompileInput): string {
  const pointer = detailsPointer(input);
  return (
    "# HONEST ANSWERS\n\n" +
    "None of these is a line to say. Keep the meaning and use your own words.\n\n" +
    "* **Price** - give a price only if the approved information states it. Otherwise say honestly that it depends on their " +
    (UNKNOWN_PRICE_REPLY[input.language] ?? "requirements and that the team needs to confirm it. Never estimate.\n") +
    "* **Savings or results** - only what the approved information states; never a guess, a percentage or a guarantee.\n" +
    "* **Are you a robot, an AI or a real person** - say honestly that you are an AI assistant calling on behalf of the company, then continue only if they want to.\n" +
    "* **WhatsApp, email, details, a demo, a meeting or a callback** - you cannot send or book anything on this call, and no follow-up is " +
    "arranged. Say so honestly; never promise one or say the team will do it." +
    (pointer ? ` If they want more information, ${pointer}.` : "") +
    "\n\n---\n\n"
  );
}

/** Languages with their own script. A name typed in Latin letters stays in them: a model tends to respell it. */
const OWN_SCRIPT: Partial<Record<AiCallLanguage, string>> = { ta: "Tamil", hi: "Hindi", kn: "Kannada" };

/** How the agent's own name is written where the language's script would change it; "" = nothing to say. */
function nameScriptBlock(language: AiCallLanguage, exec: string): string {
  const script = OWN_SCRIPT[language];
  if (!script || !/^[\p{Script=Latin}\s.'-]+$/u.test(exec)) return "";
  return `# YOUR NAME\n\nWrite your own name only in English letters, never in ${script} letters.\n\n---\n\n`;
}

// The built-in rule that gives its own call length: an agent's length comes from its target and maximum.
const BUILTIN_LENGTH_RULE = "5. Keep the call short: around one to two minutes unless the customer wants to talk more.";

function rulesBlock(text: string): string {
  if (!text.includes(BUILTIN_LENGTH_RULE)) {
    throw new AgentCompileError("The built-in Business executive flow's rules changed — update the AI Agents compiler");
  }
  return text.replace(BUILTIN_LENGTH_RULE, "5. CALL LENGTH says how long the conversation should take.");
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
  const company = companyName(agent);
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
    // No sequence, no set opening and no set close for an interested customer: the admin's instructions decide them.
    if (b.id === "conversation_stages" || b.id === "opening" || b.id === "interested_close") continue;
    let text = b.text;
    if (b.id === "agent") text = agentBlock(input);
    else if (b.id === "next_step") text = CALL_CAPABILITIES_BLOCK;
    else if (b.id === "objections") text = honestAnswersBlock(input);
    else if (b.id === "speaking_style") {
      text = nameScriptBlock(language, exec);
      if (!text) continue;
    } else if (b.id === "rules") text = rulesBlock(b.text);
    else if (b.id in NATURAL_CLOSINGS) text = NATURAL_CLOSINGS[b.id]!;
    else if (b.id === "company_facts") text = companyFactsBlock(b.text, company);
    else if (b.id === "do_not_call") text = doNotCallBlock(b.text, opening.dnc);
    blocks.push({ ...b, text: swapTitle(text) });
    if (b.id === "agent") {
      // The admin's instructions right after who the agent is: they lead the conversation.
      if (blockSafe(agent.instructions)) {
        blocks.push({ id: "ai_instructions", group: "main_script", text: instructionsBlock(agent.instructions) });
      }
      blocks.push({ id: "customer_business", group: "main_script", text: businessBlock(input) });
    }
  }
  blocks.push({ id: "voice_delivery", group: "tone", text: voiceDeliveryBlock(input.voice) });
  blocks.push({ id: "call_length", group: "rules", text: callLengthBlock(agent.targetDurationSec, agent.maxDurationSec) });
  for (const b of blocks) {
    if (!("locked" in b) && (b as CallFlowTextBlock).text.length > CALL_FLOW_MAX_BLOCK_CHARS) {
      throw new AgentCompileError(`The "${b.id}" part is longer than ${CALL_FLOW_MAX_BLOCK_CHARS} characters — shorten the instructions or topics`);
    }
  }

  const tone = AI_AGENT_PERSONALITY_TONE[agent.personality];
  const { identity: _noIdentityQuestion, ...baseSettings } = base;
  const definition: CallFlowDefinition = {
    ...baseSettings,
    // The picked voice speaks every line of every call of this flow (greeting, replies, fixed lines).
    ...(input.voice ? { voice_id: input.voice.id } : {}),
    name: oneLine(agent.name).slice(0, 100) || "AI Agent",
    greeting: { text: greeting },
    blocks,
    limits: { max_duration_sec: agent.maxDurationSec },
    // natural_lines: the agent opens the call and says the silence lines in its own words (the schema requires a
    // greeting, so the one above stays in the definition, but it is never spoken). Do-not-call stays fixed.
    autonomous: {
      target_duration_sec: agent.targetDurationSec,
      dnc_enforce: true,
      natural_lines: true,
      voice_pace: agent.voiceSpeed,
      contact_business: true,
      instructions_lead: true,
    },
    training: {
      enabled: true,
      token_cap: TRAINING_MAX_TOKEN_CAP,
      persona: {
        status: "active",
        agent_name: exec,
        company,
        business_type: "",
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
        // The least restrictive values: how long and in what manner the agent talks is its instructions' business.
        sentence_length: "medium",
        title_use: "sometimes",
        avoid: [],
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
