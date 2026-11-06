import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AI_AGENT_DEFAULTS,
  AI_AGENT_DURATION_LIMITS,
  AI_AGENT_OPENINGS,
  AI_AGENT_VOICE_SPEED_LIMITS,
  AI_AGENT_VOICE_SPEEDS,
  aiAgentInput,
  callFlowDefinition,
  knowledgeTextIssues,
  matchLibraryName,
  type AiAgentConfig,
  type AiCallLanguage,
  type CallFlowDefinition,
  type CallFlowTextBlock,
} from "@dispatch/shared";
import {
  AgentCompileError,
  compileAgentFlow,
  CONVERSATION_BLOCK,
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
    categoryId: "aicat_healthcare",
    industryId: "aiind_hospital",
    businessName: "ABC Hospital",
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
  categoryName: "Healthcare",
  industry: { name: "Hospital", discoveryTopics: "Hospital administration\nPatient workflows\nBilling\nAppointments" },
  knowledge: [
    { id: "a", kind: "fact", topic: "Hospital billing", text: "Kagzso automates billing follow-ups and payment reminders for hospitals.", questions: [], always: true },
    { id: "b", kind: "qa", topic: "Integration", text: "It works alongside the software the hospital already uses.", questions: ["Will it replace our software?"], always: false },
  ],
  base: builtinExecutive(language),
  ...over,
});

const text = (d: CallFlowDefinition, id: string) => (d.blocks.find((b) => b.id === id) as CallFlowTextBlock | undefined)?.text ?? "";
const allText = (d: CallFlowDefinition) => d.blocks.map((b) => ("text" in b ? b.text : "")).join("\n");

describe.each(["en", "ta", "hi", "kn"] as const)("compiled agent flow (%s)", (language) => {
  const out = compileAgentFlow(input(language));

  it("is a valid executive flow with the agent's limits and autonomous settings", () => {
    expect(callFlowDefinition.safeParse(out).success).toBe(true);
    expect(out.base).toBe("executive");
    expect(out.language).toBe(language);
    expect(out.limits).toEqual({ max_duration_sec: 105 });
    expect(out.autonomous).toEqual({ target_duration_sec: 60, dnc_enforce: true, natural_lines: true, voice_pace: 0.9 });
  });

  it("no fixed opening: the agent greets in its own words, with no time of day and no identity question", () => {
    const opening = text(out, "opening");
    expect(opening).toMatch(/There is no fixed greeting and no set first line/);
    expect(opening).toMatch(/Do not open with a time-of-day greeting/);
    expect(opening).toMatch(/`address_as`/);
    expect(opening).toMatch(/never invent a name or a gender/);
    expect(opening).toMatch(/Greet only once/);
    expect(opening).not.toContain(out.greeting.text.slice(0, 12)); // the unspoken greeting is not handed to the LLM
    expect(allText(out)).not.toContain("time_greeting");
    expect(out.greeting.text).not.toContain("time_greeting");
    // Not even the built-in flow's own identity question comes through.
    if (language !== "en") expect(builtinExecutive(language).identity).toBeDefined();
    expect(out.identity).toBeUndefined();
    expect(allText(out)).not.toMatch(/\{\{\s*title_to_use\s*\}\}/);
  });

  it("no fixed conversation: no numbered sequence, no scripted steps, no quoted line to read out", () => {
    const blocks = out.blocks.map((b) => b.id);
    expect(blocks).not.toContain("conversation_stages");
    for (const b of out.blocks) {
      if ("locked" in b || b.id === "do_not_call" || b.id === "rules" || b.id === "ai_instructions") continue;
      expect(b.text, b.id).not.toMatch(/^\s*\d+\.\s/m); // a numbered sequence
      expect(b.text, b.id).not.toMatch(/^> "/m); // a line to say word for word
    }
    expect(allText(out)).not.toMatch(/ask once whether|stage \d|permission question|interest question/i);
    expect(text(out, "next_step")).toBe(CONVERSATION_BLOCK);
    expect(CONVERSATION_BLOCK).toMatch(/not a script\. There are no steps, no fixed order/);
    expect(CONVERSATION_BLOCK).toMatch(/never ask for something they have already told you/i);
    expect(CONVERSATION_BLOCK).toMatch(/Understand first, explain relevant value second/);
    expect(CONVERSATION_BLOCK).toMatch(/follow them/);
    expect(CONVERSATION_BLOCK).toMatch(/A reply does not need a question/);
    expect(CONVERSATION_BLOCK).toMatch(/ask whether they have a minute or can talk now/);
    expect(CONVERSATION_BLOCK).toMatch(/ask how to reach them or for any contact details/);
    expect(CONVERSATION_BLOCK).toMatch(/the marker is the very last thing you write/);
  });

  it("keeps every locked safety block and the do-not-call / outcome blocks of the built-in flow", () => {
    const base = builtinExecutive(language);
    const locked = (d: CallFlowDefinition) => d.blocks.filter((b) => "locked" in b);
    expect(locked(out)).toEqual(locked(base));
    expect(text(out, "outcome_rules")).toBe(text(base, "outcome_rules").replace(/\{\{\s*title_to_use\s*\}\}/g, "{{title}}"));
    // Every rule stays; only the one naming its own call length gives way to the agent's target and maximum.
    const rules = (d: CallFlowDefinition) => text(d, "rules").split("\n").filter((l) => !l.startsWith("5."));
    expect(rules(out)).toEqual(rules(base));
    expect(text(out, "rules")).toMatch(/^5\. CALL LENGTH says/m);
    // The closings: the same situations and limits, said in the agent's own words (no fixed quoted line).
    for (const id of ["not_interested", "busy", "end_call_request"]) {
      expect(text(base, id)).toMatch(/> "/);
      expect(text(out, id)).toBe(NATURAL_CLOSINGS[id]);
      expect(text(out, id)).not.toMatch(/> "/);
      expect(text(out, id)).toMatch(/in your own words and in the call's language/);
      expect(text(out, id)).toMatch(/Then end the call/);
    }
    expect(text(out, "busy")).toMatch(/never promise a callback/);
    expect(text(out, "busy")).toMatch(/apologise briefly for disturbing them/);
    expect(text(out, "not_interested")).toMatch(/do not re-pitch/);
    // do_not_call: the same block, with the line the backend speaks word for word in the call's language.
    const dnc = AI_AGENT_OPENINGS[language]!.dnc;
    expect(text(out, "do_not_call")).toBe(
      text(base, "do_not_call").replace('"Understood. I respect your request. Thank you."', `"${dnc}"`),
    );
    expect(text(out, "do_not_call")).toContain(`> "${dnc}"`);
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

describe("what the compiled flow tells the AI", () => {
  const out = compileAgentFlow(input("en"));

  it("who calls, for which business and why - and that the entered details are not verified", () => {
    const who = text(out, "agent");
    expect(who).toContain("**Thaara**");
    expect(who).toContain("**Kagzso Technology Services**");
    expect(who).toContain("**ABC Hospital**");
    expect(who).toContain("Introduce AI and automation for hospitals");
    expect(who).toMatch(/NOT verified/);
    expect(who).toMatch(/no script, no fixed order and no fixed list of questions/i);
    expect(who).toMatch(/business customer executive/);
    expect(who).toMatch(/Your name is always written exactly as Thaara, in those letters, in every language/);
  });

  it("industry topics are discovery topics, not product claims; unknown answers are never invented", () => {
    const ind = text(out, "industry_context");
    expect(ind).toContain("* Billing");
    expect(ind).toMatch(/NOT claims/);
    expect(ind).toMatch(/Only describe products and services that the approved/);
    expect(ind).toMatch(/never guess or invent/);
    expect(ind).toContain("+91 98000 12345"); // the callback number, only when asked
    expect(ind).toMatch(/Never promise a callback/);
  });

  it("the admin's instructions: priority order first, variables and the end-call marker removed", () => {
    const ins = text(out, "ai_instructions");
    expect(ins.startsWith(INSTRUCTIONS_HEADER)).toBe(true);
    expect(ins).toMatch(/1\. Safety, do-not-call/);
    expect(ins).toMatch(/5\. The calling objective/);
    expect(ins).toContain("> Do not talk about pricing.");
    expect(ins).not.toContain("{{");
    expect(ins).not.toContain("[[END_CALL]]");
    // After the script, so the voice backend's fixed rules (appended after every block) still come last.
    const ids = out.blocks.map((b) => b.id);
    expect(ids.indexOf("ai_instructions")).toBe(ids.length - 1);
  });

  it("no instructions = no instructions block", () => {
    const plain = compileAgentFlow(input("en", { agent: agent({ instructions: "  " }) }));
    expect(plain.blocks.some((b) => b.id === "ai_instructions")).toBe(false);
  });

  it("voice and delivery: calm, patient, no exclamation marks - after the built-in blocks, before call length", () => {
    const ids = out.blocks.map((b) => b.id);
    expect(ids.indexOf("voice_delivery")).toBe(ids.indexOf("call_length") - 1);
    expect(ids.indexOf("voice_delivery")).toBeGreaterThan(ids.indexOf("rules"));
    const block = out.blocks.find((b) => b.id === "voice_delivery") as CallFlowTextBlock;
    expect(block).toMatchObject({ group: "tone", text: VOICE_DELIVERY_BLOCK });
    expect(block.text).toContain("No exclamation marks");
    expect(block.text).toMatch(/hesitates, goes quiet, interrupts or asks the same thing again, stay patient/);
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
    // A short maximum: the closing never comes before the target.
    expect(text(compileAgentFlow(input("en", { agent: agent({ targetDurationSec: 40, maxDurationSec: 45 }) })), "call_length")).toMatch(/polite closing near 40 seconds/);
  });

  it("training: active profile and only the given (approved) knowledge, all active", () => {
    const t = out.training!;
    expect(t.enabled).toBe(true);
    expect(t.persona).toMatchObject({ status: "active", agent_name: "Thaara", company: "Kagzso Technology Services", business_type: "Hospital" });
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
      aiAgentInput.safeParse({ name: "x", customCategory: "c", customIndustry: "i", businessName: "b", objective: "o", voiceSpeed });
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
      aiAgentInput.safeParse({ name: "x", customCategory: "c", customIndustry: "i", businessName: "b", objective: "o", targetDurationSec, maxDurationSec });
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

  it("no industry / topics / callback number: still valid, no topic list, website instead of a number", () => {
    const bare = compileAgentFlow(input("en", { industry: null, categoryName: null, agent: agent({ callbackNumber: null }) }));
    expect(callFlowDefinition.safeParse(bare).success).toBe(true);
    expect(text(bare, "industry_context")).not.toMatch(/checklist/);
    expect(text(bare, "industry_context")).toMatch(/visit kagzso\.com/);
    expect(text(bare, "industry_context")).toMatch(/Understand what kind of business this is from the conversation/);
    // Another company with no number: nothing invented to point at.
    const other = compileAgentFlow(input("en", { industry: null, categoryName: null, agent: agent({ companyName: "Acme Foods", callbackNumber: null }) }));
    expect(allText(other)).not.toMatch(/visit kagzso\.com/);
  });

  it("verified information only, and nothing promised that no workflow delivers", () => {
    const situations = text(out, "objections");
    expect(situations).toMatch(/give a price only if the approved information states it/);
    expect(situations).toMatch(/you cannot send or book anything on this call/);
    expect(situations).toMatch(/Understand whether any other part of their work still takes a lot of time/);
    expect(situations).toMatch(/say honestly that you are an AI assistant/);
    expect(situations).not.toMatch(/^> "/m);
    expect(text(out, "interested_close")).toMatch(/Never tell the customer that anyone will contact them/);
    expect(text(out, "industry_context")).toMatch(/needs confirmation from the Kagzso Technology Services team/);
    expect(text(out, "industry_context")).toMatch(/not a promise that anyone will contact them/);
    // The flag must not reach the prompt: it would make a promise depend on an environment setting.
    expect(allText(out)).not.toContain("team_follow_up_configured");
    expect(allText(out)).not.toMatch(/Our team will get in touch/);
  });

  it("each language has its own speaking style; none of them is a script", () => {
    expect(text(compileAgentFlow(input("en")), "speaking_style")).toMatch(/clear, simple, professional spoken English/);
    expect(text(compileAgentFlow(input("ta")), "speaking_style")).toMatch(/natural conversational Tamil/);
    expect(text(compileAgentFlow(input("hi")), "speaking_style")).toMatch(/natural conversational Hindi/);
    expect(text(compileAgentFlow(input("kn")), "speaking_style")).toMatch(/natural conversational Kannada/);
    expect(text(compileAgentFlow(input("ta")), "speaking_style")).toMatch(/Never translate English sentences word for word/);
    // A name typed in Latin letters stays in them; a name typed in the language's own script is never told otherwise.
    expect(text(compileAgentFlow(input("ta")), "speaking_style")).toMatch(/Write your own name only in English letters, never in Tamil letters/);
    expect(text(compileAgentFlow(input("hi")), "speaking_style")).toMatch(/never in Hindi letters/);
    expect(text(compileAgentFlow(input("en")), "speaking_style")).not.toMatch(/Write your own name/);
    const tamilName = compileAgentFlow(input("ta", { agent: agent({ executiveName: "தாரா" }) }));
    expect(text(tamilName, "speaking_style")).not.toMatch(/Write your own name/);
    expect(text(tamilName, "agent")).toContain("exactly as தாரா");
  });

  it("refuses a language without reviewed opening lines, and a base that is not executive", () => {
    expect(() => compileAgentFlow({ ...input("en"), language: "te", base: { ...builtinExecutive("en"), language: "te" } })).toThrow(AgentCompileError);
    const nila = callFlowDefinition.parse({ ...JSON.parse(read(BUILTIN + "nila.json")), language: "en" });
    expect(() => compileAgentFlow(input("en", { base: nila }))).toThrow(/Business executive/);
  });

  it("defaults: Thaara, Kagzso Technology Services, 60 s target, 1 min 45 s maximum, Male", () => {
    const min = { name: "x", categoryId: "c", industryId: "i", businessName: "b", objective: "o" };
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

  it("typed industries without discovery topics: open questions instead, and never assumptions from the category", () => {
    const typed = compileAgentFlow(input("en", { categoryName: "Manufacturing", industry: { name: "Textile mill", discoveryTopics: "" } }));
    expect(callFlowDefinition.safeParse(typed).success).toBe(true);
    const ind = text(typed, "industry_context");
    expect(ind).toContain("Expected industry: **Textile mill**");
    expect(ind).toMatch(/Never assume which products or services this business offers/);
    expect(ind).toMatch(/If they run a different kind of business, follow them/);
    expect(ind).toMatch(/one short, open question/);
    expect(ind).not.toMatch(/checklist/);
    expect(text(typed, "agent")).toContain("a business in the **Textile mill** industry, (Manufacturing)");
    expect(typed.training?.persona?.business_type).toBe("Textile mill");
    // Library industries keep their topic list (and get the same no-assumptions line).
    const lib = text(compileAgentFlow(input("en")), "industry_context");
    expect(lib).toMatch(/NOT a checklist of questions/);
    expect(lib).toMatch(/Never assume/);
    expect(lib).not.toMatch(/one short, open question/);
  });
});

describe("Business section validation (library entry or typed by hand)", () => {
  const base = { name: "x", businessName: "b", objective: "o" };
  const issues = (v: Record<string, unknown>) => {
    const r = aiAgentInput.safeParse({ ...base, ...v });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("an autonomous agent needs a category, an industry and a business name", () => {
    expect(issues({})).toEqual(["categoryId: Pick a category", "industryId: Pick an industry"]);
    expect(issues({ categoryId: "c", industryId: "i", businessName: "   " })).toEqual(["businessName: Enter the business name"]);
    expect(issues({ categoryId: "c", industryId: "i" })).toEqual([]);
    // Guided agents call with their Call Flow as it is: no Business section needed.
    expect(aiAgentInput.safeParse({ name: "g", mode: "guided", guidedFlowId: "f" }).success).toBe(true);
  });

  it("typed names: trimmed and spaces collapsed; empty after trimming = still to be entered", () => {
    const d = aiAgentInput.parse({ ...base, customCategory: "  Manufacturing  ", customIndustry: " Textile    mill ", businessName: "  ABC   Mills " });
    expect(d).toMatchObject({ customCategory: "Manufacturing", customIndustry: "Textile mill", businessName: "ABC Mills" });
    expect(issues({ customCategory: "   ", customIndustry: "Textile mill" })).toEqual(["customCategory: Enter the category"]);
    expect(issues({ categoryId: "c", customIndustry: "" })).toEqual(["customIndustry: Enter the industry"]);
    expect(issues({ categoryId: "c", customIndustry: "x".repeat(81) })).toHaveLength(1);
    expect(issues({ categoryId: "c", customIndustry: "Textile\nmill" })).toHaveLength(1);
  });

  it("never both a library entry and a typed name; a typed category needs a typed industry", () => {
    expect(issues({ categoryId: "c", customCategory: "X", industryId: "i" })).toContain("customCategory: Pick a category from the list or enter one, not both");
    expect(issues({ categoryId: "c", industryId: "i", customIndustry: "Y" })).toContain("customIndustry: Pick an industry from the list or enter one, not both");
    expect(issues({ customCategory: "X", industryId: "i" })).toEqual(["industryId: Enter the industry for a category you typed in"]);
    expect(issues({ categoryId: "c", customIndustry: "Y" })).toEqual([]); // typed industry under a library category
    expect(issues({ customCategory: "X", customIndustry: "Y" })).toEqual([]);
  });

  it("names match the library ignoring case, spaces and punctuation; archived entries never match", () => {
    const lib = [
      { id: "1", name: "IT company", archivedAt: null },
      { id: "2", name: "Hotel / Restaurant", archivedAt: null },
      { id: "3", name: "School", archivedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(matchLibraryName("it-Company", lib)?.id).toBe("1");
    expect(matchLibraryName("  hotel restaurant ", lib)?.id).toBe("2");
    expect(matchLibraryName("school", lib)).toBeUndefined();
    expect(matchLibraryName("Software company", lib)).toBeUndefined();
    expect(matchLibraryName("--", lib)).toBeUndefined();
  });
});

describe("knowledge content checks (same rules as the voice backend)", () => {
  const cases: { text: string; policy: boolean; ok: boolean }[] = JSON.parse(read(FIXTURES + "knowledge_cases.json"));
  it.each(cases)("$text → ok=$ok", ({ text: t, policy, ok }) => {
    expect(knowledgeTextIssues(t, { policy }).length === 0).toBe(ok);
  });
});
