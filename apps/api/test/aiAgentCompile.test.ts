import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AI_AGENT_DEFAULTS,
  AI_AGENT_DURATION_LIMITS,
  AI_AGENT_INSTRUCTIONS_MAX,
  AI_AGENT_OPENINGS,
  AI_AGENT_VOICE_SPEED_LIMITS,
  AI_AGENT_VOICE_SPEEDS,
  AI_CALL_BUSINESS_MAX,
  aiAgentInput,
  businessDisplayName,
  callFlowDefinition,
  knowledgeTextIssues,
  knownBusiness,
  type AiAgentConfig,
  type AiCallLanguage,
  type CallFlowDefinition,
  type CallFlowTextBlock,
} from "@dispatch/shared";
import {
  AgentCompileError,
  AI_AGENT_COMPILER_VERSION,
  aiAgentCompilerVersion,
  compileAgentFlow,
  CALL_CAPABILITIES_BLOCK,
  INSTRUCTIONS_HEADER,
  NATURAL_CLOSINGS,
  VOICE_DELIVERY_BLOCK,
  type CompileInput,
} from "../src/domain/aiAgentCompile.js";
import { withoutNullOptionalSettings } from "../src/http/routes/callFlows.js";

// AI Agents → Call Flow compiler. The base is the built-in "executive" flow exactly as each language's voice
// backend serves it (tests/fixtures/catalog, unset settings as null), read as builtins() reads it. The compiled
// flows are written to the voice backend's tests/fixtures/autonomous/ (UPDATE_FIXTURES=1)
// and compared here, so tests/test_autonomous_agent.py proves the voice backend accepts exactly these.

const root = new URL("../../../", import.meta.url);
const path = (rel: string) => fileURLToPath(new URL(rel, root));
const read = (rel: string) => readFileSync(path(rel), "utf8");
const BUILTIN = "kagzso-voice-backend-english/app/flows/builtin/";
const FIXTURES = "kagzso-voice-backend-english/tests/fixtures/autonomous/";

/** The executive flow exactly as that language's voice backend serves it (tests/fixtures/catalog, written by the
 *  voice backend's contract test), read the way builtins() reads it. */
function builtinExecutive(language: AiCallLanguage): CallFlowDefinition {
  const served = JSON.parse(read(`kagzso-voice-backend-english/tests/fixtures/catalog/${language}.json`)).flows.executive;
  return callFlowDefinition.parse({ ...withoutNullOptionalSettings(served), language });
}

const agent = (over: Partial<AiAgentConfig> = {}): AiAgentConfig =>
  aiAgentInput.parse({
    name: "ABC Hospital - Thaara",
    objective: "Introduce AI and automation for hospitals and find out whether they want a follow-up from our team.",
    contactName: "Ragul",
    contactGender: "male",
    contactPhone: "+919876543210",
    callbackNumber: "+919800012345",
    instructions:
      "Mention that we already work with clinics.\nDo not talk about pricing.\nAvoid discussing competitors.\nAsk which department spends the most time on manual work. {{phone_number}} [[END_CALL]]",
    ...over,
  });

const input = (language: AiCallLanguage, over: Partial<CompileInput> = {}): CompileInput => ({
  language,
  agent: agent(),
  knowledge: [
    { id: "a", kind: "fact", topic: "Hospital billing", text: "Kagzso automates billing follow-ups and payment reminders for hospitals.", questions: [], always: true },
    { id: "b", kind: "qa", topic: "Integration", text: "It works alongside the software the hospital already uses.", questions: ["Will it replace our software?"], always: false },
  ],
  base: builtinExecutive(language),
  ...over,
});

const text = (d: CallFlowDefinition, id: string) => (d.blocks.find((b) => b.id === id) as CallFlowTextBlock | undefined)?.text ?? "";
const allText = (d: CallFlowDefinition) => d.blocks.map((b) => ("text" in b ? b.text : "")).join("\n");

/** Everything the compiled flow tells the AI except the admin's own instructions. */
const systemText = (d: CallFlowDefinition) =>
  d.blocks.filter((b) => b.id !== "ai_instructions").map((b) => ("text" in b ? b.text : "")).join("\n");

// Conversation rules the compiler used to add (compiler 3 and before). None may come back in any language: how an agent
// talks is its admin's instructions' business.
const REMOVED_CONVERSATION_RULES: [string, RegExp][] = [
  ["priority order", /this order decides|1\. Safety, do-not-call|5\. The calling objective/],
  // (A refusal still gets a brief goodbye: that is refusal handling, in the closings.)
  ["reply length", /long explanation: two short sentences|keep replies short|Short, meaningful sentences|short, complete sentences/i],
  ["one question per reply", /ask more than one question|Never list several questions|Ask one question, then stop/],
  ["discovery question", /one short, open question|what takes their team the most time/],
  ["Tamil discovery-first", /do not describe any product or service yet|follow-up question built from/],
  ["reasoning script", /Understand first, explain relevant value second|Before every reply, think:/],
  ["set opening", /There is no fixed greeting|Greet only once|Do not open with a time-of-day greeting/],
  ["set close for interest", /Interest is a reason to keep listening/],
  ["sales approach", /never suggest reducing staff|Understand whether any other part of their work|keep promoting the company/],
  ["role / persona", /business customer executive|respectful, calm, friendly, humble|experienced customer executive/],
  ["speaking style", /Speak natural conversational|clear, simple, professional spoken English|Speak the customer's language/],
  ["voice manner", /Unhurried and reassuring|stay patient and kind|same calm, respectful tone/],
  ["Tamil phrase ban", /இப்போ பேசலாமா/],
  ["minute question ban", /ask whether they have a minute/],
];

describe.each(["en", "ta", "hi", "kn"] as const)("compiled agent flow (%s)", (language) => {
  const out = compileAgentFlow(input(language));

  it("is a valid executive flow with the agent's limits and autonomous settings (instructions lead)", () => {
    expect(callFlowDefinition.safeParse(out).success).toBe(true);
    expect(out.base).toBe("executive");
    expect(out.language).toBe(language);
    expect(out.limits).toEqual({ max_duration_sec: 105 });
    expect(out.autonomous).toEqual({
      target_duration_sec: 60, dnc_enforce: true, natural_lines: true, voice_pace: 0.9, contact_business: true, instructions_lead: true,
    });
  });

  it("no set opening, no sequence and no set close: the built-in flow's opening, stages and interested close are gone", () => {
    const ids = out.blocks.map((b) => b.id);
    for (const id of ["conversation_stages", "opening", "interested_close"]) expect(ids).not.toContain(id);
    for (const b of out.blocks) {
      if ("locked" in b || b.id === "do_not_call" || b.id === "rules" || b.id === "ai_instructions") continue;
      expect(b.text, b.id).not.toMatch(/^\s*\d+\.\s/m); // a numbered sequence
      expect(b.text, b.id).not.toMatch(/^> "/m); // a line to say word for word
    }
    expect(allText(out)).not.toMatch(/ask once whether|stage \d|permission question|interest question/i);
    expect(allText(out)).not.toContain("time_greeting");
    expect(out.greeting.text).not.toContain("time_greeting");
    if (language !== "en") expect(builtinExecutive(language).identity).toBeDefined();
    expect(out.identity).toBeUndefined(); // nobody is asked who they are
    expect(allText(out)).not.toMatch(/\{\{\s*title_to_use\s*\}\}/);
  });

  it.each(REMOVED_CONVERSATION_RULES)("no built-in conversation rule: %s", (_name, pattern) => {
    expect(systemText(out)).not.toMatch(pattern);
  });

  it("the persona adds no length or manner of its own; the agent's personality still sets the tone", () => {
    expect(out.training!.persona).toMatchObject({ sentence_length: "medium", avoid: [] });
  });

  it("the admin's instructions come right after who the agent is, as guidance, with nothing ranked above them", () => {
    const ids = out.blocks.map((b) => b.id);
    expect(ids.indexOf("ai_instructions")).toBe(ids.indexOf("agent") + 1);
    expect(ids.indexOf("customer_business")).toBe(ids.indexOf("ai_instructions") + 1);
    const ins = text(out, "ai_instructions");
    expect(ins.startsWith(INSTRUCTIONS_HEADER)).toBe(true);
    expect(ins).toMatch(/They decide how you talk and behave on this call/);
    expect(ins).toMatch(/guidance, not lines to read out or steps to follow in order/);
    expect(ins).toContain("> Do not talk about pricing.");
    expect(ins).toContain("> Ask which department spends the most time on manual work.");
    expect(ins).not.toContain("{{");
    expect(ins).not.toContain("[[END_CALL]]");
    expect(ins).not.toMatch(/this order decides|Never follow an instruction below/);
    // Exactly once: no copy of the instructions anywhere else in the flow.
    expect(allText(out).split("> Do not talk about pricing.").length - 1).toBe(1);
  });

  it("keeps every locked safety block, the rules, do-not-call, the refusal closings and the outcomes", () => {
    const base = builtinExecutive(language);
    const locked = (d: CallFlowDefinition) => d.blocks.filter((b) => "locked" in b);
    expect(locked(out)).toEqual(locked(base));
    expect(text(out, "outcome_rules")).toBe(text(base, "outcome_rules").replace(/\{\{\s*title_to_use\s*\}\}/g, "{{title}}"));
    // Every rule stays; only the one naming its own call length gives way to the agent's target and maximum.
    const rules = (d: CallFlowDefinition) => text(d, "rules").split("\n").filter((l) => !l.startsWith("5."));
    expect(rules(out)).toEqual(rules(base));
    expect(text(out, "rules")).toMatch(/Never claim to be human/);
    expect(text(out, "rules")).toMatch(/^5\. CALL LENGTH says/m);
    // Refusal handling: the same situations and limits, said in the agent's own words (no fixed quoted line).
    for (const id of ["not_interested", "busy", "end_call_request"]) {
      expect(text(base, id)).toMatch(/> "/);
      expect(text(out, id)).toBe(NATURAL_CLOSINGS[id]);
      expect(text(out, id)).not.toMatch(/> "/);
      expect(text(out, id)).toMatch(/Then end the call/);
    }
    expect(text(out, "busy")).toMatch(/never promise a callback/);
    expect(text(out, "not_interested")).toMatch(/do not re-pitch/);
    // do_not_call: the same block, with the line the backend speaks word for word in the call's language.
    const dnc = AI_AGENT_OPENINGS[language]!.dnc;
    expect(text(out, "do_not_call")).toBe(
      text(base, "do_not_call").replace('"Understood. I respect your request. Thank you."', `"${dnc}"`),
    );
    expect(text(out, "do_not_call")).toContain(`> "${dnc}"`);
    expect(text(out, "do_not_call")).toMatch(/Do-not-call always overrides everything else/);
  });

  it("truthfulness and what a call can do stay, in every language", () => {
    expect(text(out, "next_step")).toBe(CALL_CAPABILITIES_BLOCK);
    expect(CALL_CAPABILITIES_BLOCK).toMatch(/Never claim to check, look up, note, send or book anything/);
    expect(CALL_CAPABILITIES_BLOCK).toMatch(/Never ask how to reach the customer or for any contact details/);
    expect(CALL_CAPABILITIES_BLOCK).toMatch(/the end-of-call marker is the very last thing you write/);
    const honest = text(out, "objections");
    expect(honest).toMatch(/give a price only if the approved information states it/);
    expect(honest).toMatch(/never a guess, a percentage or a guarantee/);
    expect(honest).toMatch(/say honestly that you are an AI assistant/);
    expect(honest).toMatch(/you cannot send or book anything on this call/);
    const biz = text(out, "customer_business");
    expect(biz).toMatch(/Only describe products and services that the approved/);
    expect(biz).toMatch(/never guess or invent/);
    expect(biz).toMatch(/Never promise a callback/);
  });

  it("speaks the language's own lines (do-not-call included); Hindi lines avoid gendered verbs", () => {
    const o = AI_AGENT_OPENINGS[language]!;
    for (const line of [o.greeting, o.dnc]) {
      expect(line.trim()).toBe(line);
      expect(line).not.toMatch(/[\r\n]/);
      if (language !== "en") expect(line).not.toBe(AI_AGENT_OPENINGS.en!.dnc);
    }
    // The executive talks about themself in these two (identity's "हो रही है" agrees with बात, not the speaker).
    if (language === "hi") for (const line of [o.greeting, o.dnc]) expect(line).not.toMatch(/रहा|रही|गया|गई|ता हूँ|ती हूँ/);
    if (language !== "en") expect(o.dnc).not.toMatch(/^[\x00-\x7f]*$/); // not an English-only line
  });

  it("writes / matches the fixture the voice backend validates", () => {
    const file = path(`${FIXTURES}${language}.json`);
    const json = JSON.stringify(out, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") {
      mkdirSync(path(FIXTURES), { recursive: true });
      writeFileSync(file, json);
    }
    expect(readFileSync(file, "utf8")).toBe(json);
  });
});

describe("one set of system rules for every language", () => {
  it("the same blocks in English, Tamil, Hindi and Kannada; only the own-name script line differs", () => {
    const ids = (language: AiCallLanguage) =>
      compileAgentFlow(input(language))
        .blocks.map((b) => b.id)
        .filter((id) => id !== "speaking_style" && id !== "reply_length");
    for (const language of ["ta", "hi", "kn"] as const) expect(ids(language)).toEqual(ids("en"));
    // The system text is the same apart from the language's own do-not-call line, its name rule and Tamil's
    // no-team-confirm truthfulness lines, own-knowledge-only facts and reply length (below): no other
    // language-specific rule is compiled in.
    const strip = (language: AiCallLanguage, skip: string[] = []) => {
      const flow = compileAgentFlow(input(language));
      return flow.blocks
        .filter((b) => !["speaking_style", "do_not_call", "customer_business", "objections", ...skip].includes(b.id))
        .map((b) => ("text" in b ? b.text : `locked:${b.locked}`));
    };
    for (const language of ["hi", "kn"] as const) expect(strip(language)).toEqual(strip("en"));
    expect(strip("ta", ["company_facts", "reply_length"])).toEqual(strip("en", ["company_facts"]));
  });

  it("an agent's own instructions reach its flow unchanged, in any language and any script", () => {
    const own = {
      en: "Speak like a friendly receptionist.\nAsk about their clinic's appointment load.",
      ta: "நீங்க ஒரு friendly receptionist மாதிரி பேசுங்க.\nClinic appointments பத்தி கேளுங்க.",
      hi: "आप एक friendly receptionist की तरह बात करें।\nClinic appointments के बारे में पूछें।",
      kn: "ನೀವು friendly receptionist ಹಾಗೆ ಮಾತನಾಡಿ.\nClinic appointments ಬಗ್ಗೆ ಕೇಳಿ.",
    } as const;
    for (const language of ["en", "ta", "hi", "kn"] as const) {
      const flow = compileAgentFlow(input(language, { agent: agent({ instructions: own[language] }) }));
      const ins = text(flow, "ai_instructions");
      for (const line of own[language].split("\n")) expect(ins).toContain(`> ${line}`);
      // Another language's instructions never leak in.
      for (const other of ["en", "ta", "hi", "kn"] as const) {
        if (other !== language) expect(allText(flow)).not.toContain(own[other].split("\n")[0]!);
      }
    }
  });
});

describe("what the compiled flow tells the AI", () => {
  const out = compileAgentFlow(input("en"));

  it("who calls and why - and that the entered details are not verified", () => {
    const who = text(out, "agent");
    expect(who).toContain("**Thaara**");
    expect(who).toContain("**Kagzso Technology Services**");
    expect(who).toContain("Introduce AI and automation for hospitals");
    expect(who).toMatch(/NOT verified/);
    expect(who).toMatch(/no script, no fixed order and no fixed list of questions/i);
    expect(who).toMatch(/Answer what they asked first/);
    expect(who).toMatch(/Never repeat an introduction, an explanation, a question or a sentence/);
    expect(who).toMatch(/an AI calling assistant for \*\*Kagzso Technology Services\*\*/);
    expect(who).toMatch(/Your name is always written exactly as Thaara, in those letters, in every language/);
  });

  it("the customer's business: nothing assumed, nothing compiled for one contact; unknown answers are never invented", () => {
    const biz = text(out, "customer_business");
    expect(biz).toMatch(/Never assume which products or services the customer's business offers/);
    expect(biz).toMatch(/If they run a different kind of business from the one you were told, believe them/);
    expect(biz).toMatch(/Only describe products and services that the approved/);
    expect(biz).toMatch(/never guess or invent/);
    expect(biz).toContain("+91 98000 12345"); // the callback number, only when asked
    expect(biz).toMatch(/Never promise a callback/);
  });

  it("the old agent-level fields never reach a flow, whatever an old agent has saved", () => {
    const old = compileAgentFlow(input("en", { agent: agent({ businessName: "Old Name Hospital", customCategory: "Old Category", customIndustry: "Old Industry" }) }));
    expect(JSON.stringify(old)).not.toMatch(/Old Name Hospital|Old Category|Old Industry/);
    expect(old).toEqual(out);
    expect(old.training?.persona?.business_type).toBe("");
  });

  it("no compiled text says never to ask for the business: the call's own rules do ask", () => {
    const other = compileAgentFlow(input("en", { agent: agent({ companyName: "Acme Robotics" }) }));
    for (const flow of [out, other]) expect(text(flow, "company_facts")).not.toMatch(/never ask for it|business_type/);
    expect(text(out, "company_facts")).toContain("`follow_up_detail`"); // the rest of that line stays
  });

  it("no instructions = no instructions block", () => {
    const plain = compileAgentFlow(input("en", { agent: agent({ instructions: "  " }) }));
    expect(plain.blocks.some((b) => b.id === "ai_instructions")).toBe(false);
  });

  it("voice: only what the text-to-speech voice needs - after the built-in blocks, before call length", () => {
    const ids = out.blocks.map((b) => b.id);
    expect(ids.indexOf("voice_delivery")).toBe(ids.indexOf("call_length") - 1);
    expect(ids.indexOf("voice_delivery")).toBeGreaterThan(ids.indexOf("rules"));
    const block = out.blocks.find((b) => b.id === "voice_delivery") as CallFlowTextBlock;
    expect(block).toMatchObject({ group: "tone", text: VOICE_DELIVERY_BLOCK });
    expect(block.text).toContain("No exclamation marks");
    expect(block.text).not.toMatch(/patient|calm|warm|short/i); // no manner of speaking: the instructions say it
    expect(block.text).not.toMatch(/\{\{|\[\[END_CALL\]\]/);
    for (const language of ["ta", "hi", "kn"] as const) {
      expect(text(compileAgentFlow(input(language)), "voice_delivery")).toBe(VOICE_DELIVERY_BLOCK); // every language
    }
  });

  it("call length: target and the hard stop", () => {
    const len = text(out, "call_length");
    expect(len).toContain("about 60 seconds");
    expect(len).toContain("at 105 seconds");
    expect(len).toMatch(/Never interrupt or rush/);
    // A refusal gets a warm closing (not an abrupt end); only do-not-call ends the call at once.
    expect(len).toMatch(/not interested, is busy or wants to stop gets one short, warm closing/);
    expect(len).toMatch(/not to be called again ends the call at once/);
    expect(len).not.toMatch(/refuses or asks not to be called again ends the call at once/);
    expect(len).toMatch(/interested and asking relevant questions, continue naturally past the target/);
    expect(len).toMatch(/polite closing near 90 seconds/);
    expect(len).not.toMatch(/priority/); // no order of topics to get through
    expect(len).not.toMatch(/keep replies short/i); // the target is the agent's own; reply length is its instructions' business
    // A short maximum: the closing never comes before the target.
    expect(text(compileAgentFlow(input("en", { agent: agent({ targetDurationSec: 40, maxDurationSec: 45 }) })), "call_length")).toMatch(/polite closing near 40 seconds/);
  });

  it("training: active profile and only the given (approved) knowledge, all active", () => {
    const t = out.training!;
    expect(t.enabled).toBe(true);
    expect(t.persona).toMatchObject({ status: "active", agent_name: "Thaara", company: "Kagzso Technology Services", business_type: "" });
    expect(t.persona).toMatchObject({ sentence_length: "medium", avoid: [] });
    expect(t.knowledge.map((k) => [k.kind, k.status, k.text])).toEqual([
      ["fact", "active", "Kagzso automates billing follow-ups and payment reminders for hospitals."],
      ["qa", "active", "It works alongside the software the hospital already uses."],
    ]);
    expect(t.knowledge[0]!.always).toBe(true);
    expect(t.phrases).toEqual([]);
  });

  it("company facts: a Kagzso company keeps the built-in facts under its own name", () => {
    const facts = text(out, "company_facts");
    expect(facts).toContain("Kagzso Technology Services helps businesses");
    expect(facts).not.toMatch(/different company/);
  });

  it("company facts: another company gets only its approved knowledge", () => {
    const other = compileAgentFlow(input("en", { agent: agent({ companyName: "Acme Robotics" }) }));
    const facts = text(other, "company_facts");
    expect(facts).toContain("(Acme Robotics)");
    expect(facts).not.toMatch(/Kagzso/);
    expect(other.greeting.text).toContain("Acme Robotics");
  });

  it("voice speed: a level or any typed speed within the limits goes into the flow as it is; nothing else is accepted", () => {
    const { min, max } = AI_AGENT_VOICE_SPEED_LIMITS;
    // A complete agent, so a refusal below can only be about the speed.
    const parsed = (voiceSpeed: unknown) =>
      aiAgentInput.safeParse({ name: "x", objective: "o", voiceSpeed });
    expect(compileAgentFlow(input("en")).autonomous?.voice_pace).toBe(AI_AGENT_DEFAULTS.voiceSpeed);
    for (const value of [...AI_AGENT_VOICE_SPEEDS.map((s) => s.value), min, 0.85, 1.37, max]) {
      expect(parsed(value).success).toBe(true);
      const flow = compileAgentFlow(input("en", { agent: agent({ voiceSpeed: value }) }));
      expect(flow.autonomous?.voice_pace).toBe(value);
      expect(callFlowDefinition.safeParse(flow).success).toBe(true);
    }
    expect(AI_AGENT_VOICE_SPEEDS.map((s) => s.value)).toContain(1); // the provider's ordinary speed is one of them
    for (const bad of [min - 0.01, max + 0.01, 0, -1, 3, "", "fast", null, Number.NaN]) {
      expect(parsed(bad).error?.issues.map((i) => i.message)).toEqual(["Enter a speed from 0.5 to 2.0"]);
    }
  });

  it("maximum duration: any whole seconds within the limits go into the flow and the prompt; nothing else is accepted", () => {
    const { minMax, maxMax } = AI_AGENT_DURATION_LIMITS;
    expect(AI_AGENT_DEFAULTS.maxDurationSec).toBe(105); // a new agent, and every existing one, keeps today's hard stop
    expect(maxMax).toBe(180); // 3 minutes at most
    // A complete agent, so a refusal below can only be about the maximum.
    const parsed = (maxDurationSec: unknown, targetDurationSec = 45) =>
      aiAgentInput.safeParse({ name: "x", objective: "o", targetDurationSec, maxDurationSec });
    for (const value of [minMax, 105, 147, maxMax]) {
      expect(parsed(value).success).toBe(true);
      const flow = compileAgentFlow(input("en", { agent: agent({ targetDurationSec: 45, maxDurationSec: value }) }));
      expect(flow.limits.max_duration_sec).toBe(value);
      expect(text(flow, "call_length")).toContain(`cut off by the phone system at ${value} seconds`);
      expect(callFlowDefinition.safeParse(flow).success).toBe(true);
    }
    for (const bad of [minMax - 1, maxMax + 1, 345, 0, 120.5, "", "long", null, Number.NaN]) {
      expect(parsed(bad).error?.issues.map((i) => i.message)).toEqual(["Enter whole seconds from 45 to 180"]);
    }
    expect(parsed(50, 60).error?.issues.map((i) => i.message)).toEqual(["The target must not exceed the maximum"]);
  });

  it("personality sets the tone scales", () => {
    const friendly = compileAgentFlow(input("en", { agent: agent({ personality: "friendly" }) }));
    expect(friendly.training!.persona).toMatchObject({ formality: 2, warmth: 5 });
  });

  it("no callback number: still valid, website instead of a number", () => {
    const bare = compileAgentFlow(input("en", { agent: agent({ callbackNumber: null }) }));
    expect(callFlowDefinition.safeParse(bare).success).toBe(true);
    expect(text(bare, "customer_business")).toMatch(/visit kagzso\.com/);
    // Another company with no number: nothing invented to point at.
    const other = compileAgentFlow(input("en", { agent: agent({ companyName: "Acme Foods", callbackNumber: null }) }));
    expect(allText(other)).not.toMatch(/visit kagzso\.com/);
  });

  it("verified information only, and nothing promised that no workflow delivers", () => {
    const situations = text(out, "objections");
    expect(situations).toMatch(/give a price only if the approved information states it/);
    expect(situations).toMatch(/you cannot send or book anything on this call/);
    expect(situations).toMatch(/say honestly that you are an AI assistant/);
    expect(situations).not.toMatch(/^> "/m);
    expect(text(out, "customer_business")).toMatch(/needs confirmation from the Kagzso Technology Services team/);
    expect(text(out, "customer_business")).toMatch(/not a promise that anyone will contact them/);
    // The flag must not reach the prompt: it would make a promise depend on an environment setting.
    expect(allText(out)).not.toContain("team_follow_up_configured");
    expect(allText(out)).not.toMatch(/Our team will get in touch/);
  });

  it("the only speaking rule left: an own name typed in English letters stays in them (Tamil, Hindi, Kannada)", () => {
    expect(text(compileAgentFlow(input("ta")), "speaking_style")).toBe(
      "# YOUR NAME\n\nWrite your own name only in English letters, never in Tamil letters.\n\n---\n\n",
    );
    expect(text(compileAgentFlow(input("hi")), "speaking_style")).toMatch(/never in Hindi letters/);
    expect(text(compileAgentFlow(input("kn")), "speaking_style")).toMatch(/never in Kannada letters/);
    expect(compileAgentFlow(input("en")).blocks.some((b) => b.id === "speaking_style")).toBe(false);
    const tamilName = compileAgentFlow(input("ta", { agent: agent({ executiveName: "தாரா" }) }));
    expect(tamilName.blocks.some((b) => b.id === "speaking_style")).toBe(false);
    expect(text(tamilName, "agent")).toContain("exactly as தாரா");
  });

  it("refuses a language without reviewed opening lines, and a base that is not executive", () => {
    expect(() => compileAgentFlow({ ...input("en"), language: "te", base: { ...builtinExecutive("en"), language: "te" } })).toThrow(AgentCompileError);
    const nila = callFlowDefinition.parse({ ...JSON.parse(read(BUILTIN + "nila.json")), language: "en" });
    expect(() => compileAgentFlow(input("en", { base: nila }))).toThrow(/Business executive/);
  });

  it("defaults: Thaara, Kagzso Technology Services, 60 s target, 1 min 45 s maximum, Male", () => {
    const min = { name: "x", objective: "o" };
    const d = aiAgentInput.parse(min);
    expect(d).toMatchObject({
      executiveName: AI_AGENT_DEFAULTS.executiveName,
      companyName: "Kagzso Technology Services",
      targetDurationSec: 60,
      maxDurationSec: 105,
      contactGender: "male",
      mode: "autonomous",
    });
    expect(aiAgentInput.safeParse({ ...min, targetDurationSec: 110 }).success).toBe(false);
    expect(aiAgentInput.safeParse({ name: "x", mode: "guided" }).success).toBe(false); // needs its Call Flow
    expect(aiAgentInput.safeParse({ ...min, executiveName: "Thaara2" }).success).toBe(false);
  });
});

describe("the agent form's retired business fields", () => {
  const base = { name: "x", objective: "o" };
  const issues = (v: Record<string, unknown>) => {
    const r = aiAgentInput.safeParse({ ...base, ...v });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("an autonomous agent needs no category, industry or business name: the objective stays required", () => {
    expect(issues({})).toEqual([]);
    expect(issues({ objective: "  " })).toEqual(["objective: Enter the calling objective"]);
    expect(aiAgentInput.safeParse({ name: "g", mode: "guided", guidedFlowId: "f" }).success).toBe(true);
  });

  it("a tab left open or an older client that still sends them can save, whatever they hold", () => {
    expect(issues({ categoryId: "c", customCategory: "X", industryId: "i", customIndustry: "  ", businessName: "" })).toEqual([]);
    expect(issues({ categoryId: null, customCategory: null, industryId: null, customIndustry: null })).toEqual([]);
  });
});

describe("a contact's Business field (same rule as the voice backend)", () => {
  const cases: { value: string | null; known: string | null }[] = JSON.parse(read("kagzso-voice-backend-english/tests/fixtures/business_cases.json"));
  it.each(cases)("$value → $known", ({ value, known }) => {
    expect(knownBusiness(value)).toBe(known);
  });

  it("is capped to what the voice backend accepts", () => {
    expect(knownBusiness("x".repeat(300))).toHaveLength(AI_CALL_BUSINESS_MAX);
  });

  it("a compiled agent says it uses the contact's business, which is what the voice backend goes by", () => {
    expect(compileAgentFlow(input("ta")).autonomous?.contact_business).toBe(true);
  });
});

describe("knowledge content checks (same rules as the voice backend)", () => {
  const cases: { text: string; policy: boolean; ok: boolean }[] = JSON.parse(read(FIXTURES + "knowledge_cases.json"));
  it.each(cases)("$text → ok=$ok", ({ text: t, policy, ok }) => {
    expect(knowledgeTextIssues(t, { policy }).length === 0).toBe(ok);
  });
});

describe("compiler 5: every agent shows unpublished changes until it is published again", () => {
  it("every language moves to compiler 5; Tamil keeps its revision so its hash stays distinct", () => {
    expect(AI_AGENT_COMPILER_VERSION).toBe(5);
    expect(aiAgentCompilerVersion("en")).toBe(5);
    expect(aiAgentCompilerVersion("hi")).toBe(5);
    expect(aiAgentCompilerVersion("kn")).toBe(5);
    expect(aiAgentCompilerVersion("ta")).toBe("5.ta5");
  });
});

describe("Tamil 5 (2026-11-28): a reply is up to four short sentences, ending with one question - Tamil only", () => {
  it("a Tamil agent's flow says it once, as a rule block between the rules and the voice block", () => {
    const flow = compileAgentFlow(input("ta"));
    const ids = flow.blocks.map((b) => b.id);
    expect(text(flow, "reply_length")).toBe(
      "# REPLY LENGTH\n\nA reply is up to four short sentences. Its last sentence is one question, so the customer " +
        "knows it is their turn to speak. A goodbye has no question.\n\n---\n\n",
    );
    expect(flow.blocks.find((b) => b.id === "reply_length")).toMatchObject({ group: "rules" });
    expect(ids.indexOf("reply_length")).toBe(ids.indexOf("voice_delivery") - 1);
    expect(ids.indexOf("reply_length")).toBeGreaterThan(ids.indexOf("rules"));
    // No other sentence limit for a normal reply anywhere in the flow (the goodbyes keep their own, shorter ones).
    const others = flow.blocks.filter((b) => !["reply_length", "busy", "not_interested", "end_call_request"].includes(b.id));
    expect(others.map((b) => ("text" in b ? b.text : "")).join("\n")).not.toMatch(/\b(one|two|three|four|1|2|3|4)\b[^.\n]*sentences?/i);
  });

  it.each(["en", "hi", "kn"] as const)("%s: no reply-length block; its flow is byte-for-byte as before (fixture)", (language) => {
    const flow = compileAgentFlow(input(language));
    expect(flow.blocks.some((b) => b.id === "reply_length")).toBe(false);
    expect(allText(flow)).not.toContain("REPLY LENGTH");
  });
});

describe("a full AI Conversation Instructions box (7,000 characters) always publishes in Tamil (2026-11-28)", () => {
  /** A box of exactly `total` characters made of lines of `lineLen` characters (Tamil letters). */
  const box = (lineLen: number, total = AI_AGENT_INSTRUCTIONS_MAX) => {
    const line = "க".repeat(lineLen - 1);
    let s = "";
    while (s.length + line.length + 1 <= total) s += (s ? "\n" : "") + line;
    const left = total - s.length; // filled up with one last line (or letter), never a trailing line break
    return left >= 2 ? `${s}\n${"ம".repeat(left - 1)}` : s + "ம".repeat(left);
  };
  const quoted = (t: string) => t.split("\n").map((l) => `> ${l}`).join("\n");
  const compiled = (language: AiCallLanguage, instructions: string) =>
    compileAgentFlow(input(language, { agent: agent({ instructions }) }));
  const parts = (d: CallFlowDefinition) => d.blocks.filter((b) => b.id.startsWith("ai_instructions")) as CallFlowTextBlock[];

  it.each([20, 10, 2])("7,000 characters in lines of %i: split at line breaks, joined back word for word", (lineLen) => {
    const text = box(lineLen);
    expect(text).toHaveLength(7000);
    const flow = compiled("ta", text);
    expect(callFlowDefinition.safeParse(flow).success).toBe(true);
    const ps = parts(flow);
    expect(ps.length).toBeGreaterThanOrEqual(2);
    expect(ps.map((b) => b.id)).toEqual(["ai_instructions", "ai_instructions_2", "ai_instructions_3"].slice(0, ps.length));
    for (const p of ps) expect(p.text.length).toBeLessThanOrEqual(8000);
    for (const p of ps.slice(0, -1)) expect(p.text.endsWith("\n")).toBe(true); // cut just after a line break
    const joined = ps.map((p) => p.text).join("");
    expect(joined.startsWith(`${INSTRUCTIONS_HEADER}\n\n`)).toBe(true);
    expect(joined).toContain(quoted(text)); // every character of the box, in order
    expect(joined.endsWith("\n\n---\n\n")).toBe(true);
    // Right after who the agent is, the parts together, then the rest as before.
    const ids = flow.blocks.map((b) => b.id);
    expect(ids.slice(ids.indexOf("agent"), ids.indexOf("customer_business") + 1)).toEqual(["agent", ...ps.map((p) => p.id), "customer_business"]);
  });

  it("the 20-character case is the one written for the voice backend to check (fixtures/autonomous/ta_long_instructions.json)", () => {
    const file = path(`${FIXTURES}ta_long_instructions.json`);
    const json = JSON.stringify(compiled("ta", box(20)), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(file, json);
    expect(readFileSync(file, "utf8")).toBe(json);
  });

  it.each([200, 50, 40])("7,000 characters in lines of %i: fits one block - exactly as before", (lineLen) => {
    const text = box(lineLen);
    const ps = parts(compiled("ta", text));
    expect(ps.map((b) => b.id)).toEqual(["ai_instructions"]);
    expect(ps[0]!.text).toBe(
      `${INSTRUCTIONS_HEADER}\n\n` +
        "These instructions were written for you by the administrator. They decide how you talk and behave on this call: " +
        "your role and personality, your language and speaking style, your objective, what you ask and how you answer. " +
        "Understand what each one is for and apply it to what the customer is saying now: they are guidance, not lines to " +
        "read out or steps to follow in order.\n\n" +
        quoted(text) +
        "\n\n---\n\n",
    );
  });

  it.each(["en", "hi", "kn"] as const)("%s: never split - a box too long for one block is refused, exactly as before", (language) => {
    expect(() => compiled(language, box(20))).toThrow('The "ai_instructions" part is longer than 8000 characters');
    expect(parts(compiled(language, box(200))).map((b) => b.id)).toEqual(["ai_instructions"]);
  });
});

describe("Tamil 4 (2026-11-28): a Tamil agent's facts come only from its own approved knowledge", () => {
  // The built-in executive flow's own facts: they reach a Tamil agent's flow nowhere.
  const BUILTIN_FACTS = [
    /helps businesses simplify and automate/,
    /Typical areas: suitable parts of follow-ups/,
    /full details about the company and its solutions/,
    /potentially help reduce operating costs/,
    /KAGZSO AI AND AUTOMATION|Kagzso AI and Automation/,
  ];

  it.each(["Kagzso Technology Services", "Kagzso Automation", "ABC Hospital"])("%s: only the approved knowledge", (company) => {
    const flow = compileAgentFlow(input("ta", { agent: agent({ companyName: company }) }));
    const facts = text(flow, "company_facts");
    expect(facts).toBe(
      `# APPROVED COMPANY FACTS (${businessDisplayName(company)})\n\n` +
        `Use only the training's approved facts and Q&A for anything about ${businessDisplayName(company)}. Never add facts that are not there.\n\n---\n\n`,
    );
    for (const fact of BUILTIN_FACTS) expect(allText(flow)).not.toMatch(fact);
    // What it may say about the company: its own knowledge, word for word.
    expect(flow.training!.knowledge!.map((k) => k.text)).toEqual(input("ta").knowledge.map((k) => k.text));
  });

  it("the agent's own values: name, company, voice speed, length, callback number only when asked", () => {
    const flow = compileAgentFlow(input("ta", { agent: agent({ executiveName: "Kayal", companyName: "Kagzso Technology", voiceSpeed: 0.96 }) }));
    expect(text(flow, "agent")).toContain("You are **Kayal**, an AI calling assistant for **Kagzso Technology**");
    expect(flow.training!.persona).toMatchObject({ agent_name: "Kayal", company: "Kagzso Technology" });
    expect(flow.autonomous).toMatchObject({ voice_pace: 0.96, target_duration_sec: 60 });
    expect(flow.limits).toEqual({ max_duration_sec: 105 });
    expect(allText(flow).match(/\+91 98000 12345/g)).toHaveLength(2); // the agent's own callback number, both "only when asked"
    expect(allText(compileAgentFlow(input("ta", { agent: agent({ callbackNumber: null }) })))).not.toMatch(/98000|\+91/);
  });

  it.each(["en", "hi", "kn"] as const)("%s: a Kagzso company keeps the built-in facts, exactly as before", (language) => {
    expect(text(compileAgentFlow(input(language)), "company_facts")).toContain("Kagzso Technology Services helps businesses");
  });
});

describe("F: the company name reads the same whatever its capitals", () => {
  const cases: { value: string; display: string }[] = JSON.parse(read("kagzso-voice-backend-english/tests/fixtures/business_display_cases.json"));
  it.each(cases)("$value -> $display (the same rule as the voice backend)", ({ value, display }) => {
    expect(businessDisplayName(value)).toBe(display);
  });

  it.each(["KAGZSO TECHNOLOGY SERVICES", "kagzso technology services", "kAgZsO TeChNoLoGy SeRvIcEs", "  Kagzso   Technology Services "])(
    "%s: the agent says Kagzso Technology Services, with its facts, greeting and profile",
    (typed) => {
      const saved = agent({ companyName: typed });
      const before = saved.companyName;
      const flow = compileAgentFlow(input("ta", { agent: saved }));
      expect(text(flow, "agent")).toContain("an AI calling assistant for **Kagzso Technology Services**");
      expect(flow.greeting.text).toContain("Kagzso Technology Services");
      expect(flow.training!.persona!.company).toBe("Kagzso Technology Services");
      // Tamil: its own approved knowledge only (Tamil 4), under the readable name.
      expect(text(flow, "company_facts")).toContain("# APPROVED COMPANY FACTS (Kagzso Technology Services)");
      expect(saved.companyName).toBe(before); // the saved setting itself is never changed
    },
  );

  it("acronyms, brands and other scripts keep their own spelling; another company stays that company", () => {
    expect(text(compileAgentFlow(input("en", { agent: agent({ companyName: "ABC HMS HOSPITAL" }) })), "agent")).toContain("**ABC HMS Hospital**");
    expect(text(compileAgentFlow(input("en", { agent: agent({ companyName: "bright it solutions" }) })), "agent")).toContain("**Bright IT Solutions**");
    expect(text(compileAgentFlow(input("ta", { agent: agent({ companyName: "ஸ்ரீ லக்ஷ்மி டெக்ஸ்டைல்ஸ்" }) })), "agent")).toContain("**ஸ்ரீ லக்ஷ்மி டெக்ஸ்டைல்ஸ்**");
    expect(text(compileAgentFlow(input("en", { agent: agent({ companyName: "ACME ROBOTICS" }) })), "company_facts")).toContain("(Acme Robotics)");
  });
});

describe("Tamil: no 'the team will confirm' (approved 2026-11-26): Tamil only", () => {
  const OLD_DETAIL =
    "Say honestly that you don't have that detail and that it needs confirmation from the Kagzso Technology Services team. " +
    "That is a statement about the detail, not a promise that anyone will contact them.";
  const OLD_PRICE =
    "Otherwise say honestly that it depends on their requirements and that the team needs to confirm it. Never estimate.\n";
  const text = (language: AiCallLanguage, id: string) =>
    (compileAgentFlow(input(language)).blocks.find((b) => b.id === id) as CallFlowTextBlock).text;

  it("a Tamil agent says it doesn't have the detail or the exact price, and never that the team will confirm it", () => {
    const business = text("ta", "customer_business");
    const situations = text("ta", "objections");
    expect(business).toContain(
      "Say honestly that you don't have that detail right now. Never say that the team, the company or anyone else will confirm it, " +
        "explain it or get back to them.",
    );
    expect(situations).toContain(
      "Otherwise say honestly that it depends on their requirements and that you don't have the exact price. Never estimate, " +
        "and never say that the team or anyone else will confirm it.\n",
    );
    for (const t of [business, situations]) {
      expect(t).not.toContain("needs confirmation from");
      expect(t).not.toContain("the team needs to confirm");
    }
  });

  it.each(["en", "hi", "kn"] as const)("%s keeps both sentences exactly as before (the fixture test checks the whole flow)", (language) => {
    expect(text(language, "customer_business")).toContain(OLD_DETAIL);
    expect(text(language, "objections")).toContain(OLD_PRICE);
    expect(text(language, "customer_business")).not.toContain("right now. Never say that the team");
  });
});

describe("identity opening (2026-11-27): only an agent that switches it on, Tamil only", () => {
  const TAMIL_LINE =
    "Hello. {{time_greeting}}, {{title_to_use}}. நான் Thaara, Kagzso Technology Services-ல இருந்து பேசுறேன். " +
    "Am I speaking with {{customer_name}}, {{title_to_use}}?";
  const withIt = (language: AiCallLanguage, over: Partial<AiAgentConfig> = {}) =>
    compileAgentFlow(input(language, { agent: agent({ identityOpening: true, ...over }) }));

  it("a Tamil agent with it on opens with the line, word for word, and nothing else in its flow changes", () => {
    const before = compileAgentFlow(input("ta"));
    const out = withIt("ta");
    expect(callFlowDefinition.safeParse(out).success).toBe(true);
    expect(out.greeting.text).toBe(TAMIL_LINE);
    expect(out.autonomous).toEqual({ ...before.autonomous, fixed_greeting: true });
    expect({ ...out, greeting: before.greeting, autonomous: before.autonomous }).toEqual(before);
  });

  it("the agent's own executive and company names go into it", () => {
    const out = withIt("ta", { executiveName: "Kayal", companyName: "Kagzso Automation" });
    expect(out.greeting.text).toBe(TAMIL_LINE.replace("Thaara", "Kayal").replace("Kagzso Technology Services", "Kagzso Automation"));
  });

  it("off, or left out, the flow is exactly as before (so are other agents)", () => {
    expect(compileAgentFlow(input("ta", { agent: agent({ identityOpening: false }) }))).toEqual(compileAgentFlow(input("ta")));
    expect(compileAgentFlow(input("ta")).autonomous).not.toHaveProperty("fixed_greeting");
  });

  it.each(["en", "hi", "kn"] as const)("%s has no identity opening: switching it on changes nothing", (language) => {
    expect(withIt(language)).toEqual(compileAgentFlow(input(language)));
  });
});

describe("speak only Tamil (2026-11-27): one agent's own switch, Tamil only", () => {
  it("on: the flow gets the voice backend's pure language style, and nothing else changes", () => {
    const before = compileAgentFlow(input("ta"));
    const out = compileAgentFlow(input("ta", { agent: agent({ pureLanguage: true }) }));
    expect(callFlowDefinition.safeParse(out).success).toBe(true);
    expect(out.language_style).toBe("pure");
    const { language_style: _style, ...rest } = out;
    expect(rest).toEqual(before);
  });

  it("off or left out: no language style, exactly as before", () => {
    expect(compileAgentFlow(input("ta")).language_style).toBeUndefined();
    expect(compileAgentFlow(input("ta", { agent: agent({ pureLanguage: false }) }))).toEqual(compileAgentFlow(input("ta")));
  });

  it.each(["en", "hi", "kn"] as const)("%s: switching it on changes nothing", (language) => {
    expect(compileAgentFlow(input(language, { agent: agent({ pureLanguage: true }) }))).toEqual(compileAgentFlow(input(language)));
  });

  it("works together with the identity opening", () => {
    const out = compileAgentFlow(input("ta", { agent: agent({ pureLanguage: true, identityOpening: true }) }));
    expect(out.language_style).toBe("pure");
    expect(out.autonomous?.fixed_greeting).toBe(true);
    expect(out.greeting.text.startsWith("Hello. {{time_greeting}}")).toBe(true);
  });
});
