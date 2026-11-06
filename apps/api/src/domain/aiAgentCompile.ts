// AI Agents → Call Flow: an autonomous agent's settings, its industry and its APPROVED knowledge compiled into
// an ordinary schema-1 "executive" flow definition with `autonomous` settings. Pure (no I/O): the caller
// passes the language's built-in executive flow, exactly as its voice backend serves it.
//
// An autonomous agent is LLM-driven: no fixed conversation sequence, greeting or question list. The executive flow
// only carries what must stay the same for every call (the locked safety blocks, the do-not-call handling, the
// outcomes and the rules). Everything about the conversation is generated here, and Guided Call Flows (the
// executive flow itself and every copy of it) are not touched.
//
// What changes compared with the built-in executive flow:
//   conversation_stages  removed: a numbered sequence has no place in an LLM-driven call
//   greeting             AI_AGENT_OPENINGS for the language (required by the schema; never spoken: natural_lines)
//   identity             none: nobody is asked to confirm who they are as a routine step
//   blocks               "agent", "opening", "next_step", "objections", "company_facts", "interested_close",
//                        "speaking_style" and the busy / not-interested / end closings rewritten as guidance, with
//                        no quoted line to read out; "industry_context", "voice_delivery", "call_length" and
//                        (when given) "ai_instructions" added; {{title_to_use}} → {{title}} everywhere, so a
//                        contact without a gender gets no sir / madam (title_to_use would fall back to
//                        CALL_DEFAULT_TITLE)
//   training             agent profile (name, company, industry, tone) + approved knowledge, all Active
//   limits / autonomous  max = the agent's maximum (the hard stop), target = its target, voice_pace = its voice speed
// Everything the voice backend appends to every prompt (voice rules, safety rules, do-not-call, AI disclosure,
// identity rules, language rule) still comes after these blocks and can't be overridden by them, and the backend
// itself enforces do-not-call and the time limit whatever the LLM says.

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

/**
 * Bumped whenever the compiler changes what an agent's calls do. Part of agentInputsHash, so an agent published
 * with an older compiler shows "unpublished changes" until an admin publishes it again: a published flow is a
 * stored copy, and compiler changes only reach it through a new publish.
 */
export const AI_AGENT_COMPILER_VERSION = 2;

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
    `You are **${exec}**, an AI calling assistant working as a **professional business customer executive** for **${company}**, ` +
    "on a live outbound phone call.\n\n" +
    (where ? `You are calling the contact person at ${where}.\n\n` : "") +
    `**Calling objective:** ${blockSafe(agent.objective) || "introduce how the company can help their business and find out whether they are interested."}\n\n` +
    "You are having a real conversation with a business owner, manager or decision-maker. You understand them, think about what " +
    "they said and decide everything you say yourself. There is no script, no fixed order and no fixed list of questions. The " +
    "objective guides the conversation; it is never a reason to push. A clear \"no\" is a good, respected outcome.\n\n" +
    `Your name is always written exactly as ${exec}, in those letters, in every language.\n\n` +
    "The details entered for this call (the contact's name, gender and business) were typed in by the team and are NOT verified. " +
    "If the person says they are someone else or that the business is different, believe them and continue politely as the rules below say.\n\n---\n\n"
  );
}

/**
 * The agent opens the call itself (autonomous.natural_lines): no greeting or identity question is spoken by the
 * system and none is prescribed here, so the first words are the LLM's own, in the call's language.
 */
function openingBlock(): string {
  return (
    "# OPENING\n\n" +
    "There is no fixed greeting and no set first line. When the call connects you speak first in your own words; if the " +
    "customer has already spoken, answer them. Open the way a respectful, friendly person does on the phone, in one or two " +
    "short sentences: a simple greeting, your name and the company, then whatever is natural next, such as asking how they " +
    "are or saying in a few words why you are calling. Do not open with a time-of-day greeting such as good morning, and do not pitch.\n\n" +
    "Use the customer's name or sir / madam only as `address_as` and title_to_use give them. Without them, greet with neither: " +
    "never invent a name or a gender. Nobody has to confirm who they are, and you do not ask permission as a routine step: " +
    "do not ask whether you are speaking with someone or whether they have a minute just to follow a procedure.\n\n" +
    "Greet only once. Whatever the customer says next, respond to that: if they ask who is calling, simply tell them, " +
    "without asking how they are.\n\n---\n\n"
  );
}

/** How the customer can find out more, if they ask, or "" when nothing is configured. Never a promise of contact. */
function detailsPointer(input: CompileInput): string {
  const company = oneLine(input.agent.companyName);
  const ways = [
    ...(isKagzso(company) ? ["visit kagzso.com"] : []),
    ...(input.agent.callbackNumber
      ? [`call ${company} on ${spacedNumber(input.agent.callbackNumber)} (say the number slowly, digit by digit, and only when they ask how to reach the company)`]
      : []),
  ];
  return ways.length ? `they can ${ways.join(" or ")}` : "";
}

function industryBlock(input: CompileInput): string {
  const company = oneLine(input.agent.companyName);
  const industry = input.industry ? oneLine(input.industry.name) : null;
  const category = input.categoryName ? oneLine(input.categoryName) : null;
  const list = topics(input.industry?.discoveryTopics);
  const pointer = detailsPointer(input);
  return (
    "# THE CUSTOMER'S BUSINESS\n\n" +
    (industry ? `Expected industry: **${industry}**. Speak in terms that make sense for that kind of business.\n\n` : "") +
    (industry || category
      ? "The category and industry only say what kind of business this is expected to be. Never assume which products or " +
        "services this business offers, how it works or what it needs because of them: find out from the customer, and " +
        "go by what they say. If they run a different kind of business, follow them and talk about that business instead.\n\n"
      : "Understand what kind of business this is from the conversation. Never assume it has the same problems as any other business.\n\n") +
    (list.length
      ? "Things that often matter to this kind of business. This is background to help you think: NOT a checklist of questions " +
        `to work through, and NOT claims about what ${company} offers:\n` +
        list.map((t) => `* ${t}`).join("\n") +
        "\n\nBring one up only when what the customer has said makes it relevant, and ask how they handle it today.\n\n"
      : industry || category
        ? "When it helps, ask one short, open question about how they run their day-to-day work and what takes their team the " +
          "most time, in terms that fit this kind of business. Never list several questions at once.\n\n"
        : "") +
    `**Only describe products and services that the approved company facts or the training's approved knowledge confirm.** ` +
    "Never say that a product, feature or integration exists, works in a certain way or suits them unless an approved note says so.\n\n" +
    "**A question the approved information doesn't answer:** never guess or invent. Say honestly that you don't have that detail " +
    `and that it needs confirmation from the ${company} team. That is a statement about the detail, not a promise that anyone will contact them.` +
    (pointer ? ` If they want to know more, ${pointer}.` : "") +
    "\n\nNever promise a callback, a demo, a meeting, a visit, a WhatsApp message or an email.\n\n---\n\n"
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
    `Aim for a conversation of about ${target} seconds, and keep replies short so that it can be. The call is cut off by the phone system at ${max} seconds, ` +
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

/** How the agent decides what to say: reasoning about the customer, not a sequence. */
export const CONVERSATION_BLOCK =
  "# HOW YOU THINK BEFORE EVERY REPLY\n\n" +
  "This is a real conversation, not a script. There are no steps, no fixed order and no questions the customer has to " +
  "answer. You decide what to say next from the whole conversation so far and the approved information.\n\n" +
  "Before every reply, think:\n\n" +
  "* What did the customer actually mean, and how do they seem: interested, busy, confused, curious, doubtful or declining?\n" +
  "* What do you already know from this call: their business, how they work, what they need? Build on it, and never ask " +
  "for something they have already told you.\n" +
  "* What would a thoughtful executive say next? Understand first, explain relevant value second. While you don't yet know " +
  "how their business works, one simple question is usually better than an explanation.\n\n" +
  "Then respond to what they just said:\n\n" +
  "* **A question** - answer that question first (not an earlier one), directly and briefly. Explain how something works when they ask.\n" +
  "* **An objection or doubt** - acknowledge it, give one calm answer from approved information, then let them speak.\n" +
  "* **Interest** - understand what they need, then connect only the relevant service to it, using approved information.\n" +
  "* **Uncertainty** (\"maybe\", \"not sure\") - do not push. Offer one short relevant point, or ask what they would like to know.\n" +
  "* **Busy, not interested, or wanting to end** - close politely now.\n" +
  "* **Unclear or cut off** - ask them once, briefly, to repeat.\n" +
  "* **An interruption or a change of direction** - drop what you were saying and follow them. Never steer them back to a topic they left.\n\n" +
  "A reply does not need a question. Ask only when the answer would really help you understand them, one question at a time. After " +
  "you answer something, it is often better to stop and let them lead. When they ask for something you can't do, are curious about " +
  "who you are, or seem unsure, answer them kindly and leave it there rather than steering back to your own question.\n\n" +
  "Never:\n\n" +
  "* repeat your introduction, an explanation or a question\n" +
  "* say the same sentence twice in one call\n" +
  "* end the call while the customer is asking a question or asking you to explain something\n" +
  "* ask more than one question in a reply\n" +
  "* ask whether they have a minute or can talk now: they are talking with you, so carry on unless they say otherwise\n" +
  "* add a question of your own after a refusal, after a request you can't meet or after they ask who or what you are\n" +
  "* ask how to reach them or for any contact details\n" +
  "* give a long explanation: two short sentences, more only when they ask for detail\n" +
  "* keep promoting the company: mention value only where it connects to what they have told you\n" +
  "* lean on the same stock phrase or filler word again and again\n" +
  "* claim to check, look up, note, send or book anything: talking is all you can do on this call, so never say that " +
  "anything was done or will be done\n" +
  "* start a reply with the end-of-call marker: your spoken words always come first, and the marker is the very last thing you write\n\n---\n\n";

/** Situations, as guidance: what is true and what is allowed, never a line to read out. */
function situationsBlock(input: CompileInput): string {
  const pointer = detailsPointer(input);
  return (
    "# SITUATIONS YOU MAY MEET\n\n" +
    "None of these is a line to say. Keep the meaning and use your own words.\n\n" +
    "* **Who is calling** - your name, the company, and in a few words why you are calling.\n" +
    "* **What the company does** - a short explanation from approved information, tied to their business when you know it.\n" +
    "* **Price** - give a price only if the approved information states it. Otherwise say honestly that it depends on their " +
    "requirements and that the team needs to confirm it. Never estimate.\n" +
    "* **Savings or results** - only what the approved information states; never a guess, a percentage or a guarantee.\n" +
    "* **They already have employees** - the idea is to reduce the time people spend on repetitive work; never suggest reducing staff.\n" +
    "* **They already use software or automation** - replacing it isn't necessarily the goal. Understand whether any other part of their work still takes a lot of time.\n" +
    "* **Are you a robot, an AI or a real person** - say honestly that you are an AI assistant calling on behalf of the company, then continue only if they want to.\n" +
    "* **WhatsApp, email, details, a demo, a meeting or a callback** - you cannot send or book anything on this call, and no follow-up is " +
    "arranged. Say so honestly; never promise one or say the team will do it." +
    (pointer ? ` If they want more information, ${pointer}.` : "") +
    "\n\n---\n\n"
  );
}

function interestedBlock(input: CompileInput): string {
  const pointer = detailsPointer(input);
  return (
    "# INTERESTED CUSTOMER\n\n" +
    "Interest is a reason to keep listening, not to end the call: carry on while they have something to ask or say. When the " +
    "conversation comes to a natural end, thank them for their time and close warmly, in your own words" +
    (pointer ? `, mentioning that ${pointer}` : "") +
    ".\n\nThe system records their interest. Never tell the customer that anyone will contact them, and never " +
    "invent a demo, a meeting, a callback or an appointment.\n\n---\n\n"
  );
}

/** How each language should sound. The voice backend's language rule (script, one language per call) still applies. */
const LANGUAGE_STYLE: Partial<Record<AiCallLanguage, string>> = {
  en: "Use clear, simple, professional spoken English.",
  ta:
    "Speak natural conversational Tamil, the familiar and respectful way business people talk on the phone, mixing in everyday " +
    "English business words as people really do. Never translate English sentences word for word. Never ask இப்போ பேசலாமா or " +
    "anything like it.",
  hi:
    "Speak natural conversational Hindi, the familiar and respectful way business people talk on the phone, mixing in everyday " +
    "English business words as people really do. Never translate English sentences word for word.",
  kn:
    "Speak natural conversational Kannada, the familiar and respectful way business people talk on the phone, mixing in everyday " +
    "English business words as people really do. Never translate English sentences word for word.",
};

/** Languages with their own script. A name typed in Latin letters stays in them: a model tends to respell it. */
const OWN_SCRIPT: Partial<Record<AiCallLanguage, string>> = { ta: "Tamil", hi: "Hindi", kn: "Kannada" };

function speakingStyleBlock(language: AiCallLanguage, exec: string): string {
  const script = OWN_SCRIPT[language];
  const nameRule = script && /^[\p{Script=Latin}\s.'-]+$/u.test(exec) ? ` Write your own name only in English letters, never in ${script} letters.` : "";
  return (
    "# HOW YOU SPEAK\n\n" +
    "You sound like an experienced customer executive on the phone: respectful, calm, friendly, humble and patient, confident " +
    "without ever being aggressive. You are a thoughtful person in a conversation, never an IVR, an advertisement, a " +
    "telemarketing script or a questionnaire.\n\n" +
    "* Short, meaningful sentences. Respond to what the customer actually said.\n" +
    "* Explain approved information in your own conversational words: never read it out word for word.\n" +
    "* Use \"sir\" or \"madam\" only as given by title_to_use, and not in every reply.\n" +
    "* No exaggerated enthusiasm, no pressure, no technical jargon (API, backend, LLM) unless they ask.\n" +
    "* Open and close each conversation in your own way, not with the same words every time.\n" +
    `* ${LANGUAGE_STYLE[language] ?? "Speak the call's language naturally."}${nameRule} Keep company names and everyday business words such as AI, automation and WhatsApp as people say them.\n\n---\n\n`
  );
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
    if (b.id === "conversation_stages") continue; // a numbered sequence: the LLM decides (next_step)
    let text = b.text;
    if (b.id === "agent") text = agentBlock(input);
    else if (b.id === "opening") text = openingBlock();
    else if (b.id === "next_step") text = CONVERSATION_BLOCK;
    else if (b.id === "objections") text = situationsBlock(input);
    else if (b.id === "interested_close") text = interestedBlock(input);
    else if (b.id === "speaking_style") text = speakingStyleBlock(language, exec);
    else if (b.id === "rules") text = rulesBlock(b.text);
    else if (b.id in NATURAL_CLOSINGS) text = NATURAL_CLOSINGS[b.id]!;
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
    autonomous: { target_duration_sec: agent.targetDurationSec, dnc_enforce: true, natural_lines: true, voice_pace: agent.voiceSpeed },
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
