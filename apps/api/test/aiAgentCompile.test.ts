import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AI_AGENT_DEFAULTS,
  aiAgentInput,
  callFlowDefinition,
  knowledgeTextIssues,
  type AiAgentConfig,
  type AiCallLanguage,
  type CallFlowDefinition,
  type CallFlowTextBlock,
} from "@dispatch/shared";
import { AgentCompileError, compileAgentFlow, INSTRUCTIONS_HEADER, type CompileInput } from "../src/domain/aiAgentCompile.js";

// AI Agents → Call Flow compiler. The base is the voice backend's own built-in "executive" flow per language
// (builtin/executive.json with builtin/<lang>/executive.json laid over it, as app/flows/loader.load_builtin
// does). The compiled flows are written to the voice backend's tests/fixtures/autonomous/ (UPDATE_FIXTURES=1)
// and compared here, so tests/test_autonomous_agent.py proves the voice backend accepts exactly these.

const root = new URL("../../../", import.meta.url);
const path = (rel: string) => fileURLToPath(new URL(rel, root));
const read = (rel: string) => readFileSync(path(rel), "utf8");
const BUILTIN = "kagzso-voice-backend-english/app/flows/builtin/";
const FIXTURES = "kagzso-voice-backend-english/tests/fixtures/autonomous/";

function builtinExecutive(language: AiCallLanguage): CallFlowDefinition {
  const data = JSON.parse(read(BUILTIN + "executive.json"));
  const own = BUILTIN + `${language}/executive.json`;
  if (language !== "en" && existsSync(path(own))) Object.assign(data, JSON.parse(read(own)));
  return callFlowDefinition.parse({ ...data, language });
}

const agent = (over: Partial<AiAgentConfig> = {}): AiAgentConfig =>
  aiAgentInput.parse({
    name: "ABC Hospital - Thaara",
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
    expect(out.autonomous).toEqual({ target_duration_sec: 60, dnc_enforce: true });
  });

  it("opens with the agent and company, then the identity question; sir / madam only from a given gender", () => {
    expect(out.greeting.text).toContain("Thaara");
    expect(out.greeting.text).toContain("Kagzso Technology Services");
    expect(out.greeting.text).toContain("{{time_greeting}}");
    expect(out.greeting.text).toContain("{{title}}");
    expect(out.greeting.text).not.toContain("customer_name"); // the system asks the identity question after it
    expect(out.identity?.question).toContain("{{customer_name}}");
    expect(allText(out)).not.toMatch(/\{\{\s*title_to_use\s*\}\}/);
  });

  it("keeps every locked safety block and the do-not-call / closing blocks of the built-in flow", () => {
    const base = builtinExecutive(language);
    const locked = (d: CallFlowDefinition) => d.blocks.filter((b) => "locked" in b);
    expect(locked(out)).toEqual(locked(base));
    for (const id of ["do_not_call", "not_interested", "busy", "end_call_request", "outcome_rules", "rules"]) {
      expect(text(out, id)).toBe(text(base, id).replace(/\{\{\s*title_to_use\s*\}\}/g, "{{title}}"));
    }
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
    expect(who).toMatch(/no fixed list of questions/i);
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

  it("call length: target and the hard stop", () => {
    const len = text(out, "call_length");
    expect(len).toContain("about 60 seconds");
    expect(len).toContain("at 105 seconds");
    expect(len).toMatch(/Never interrupt or rush/);
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

  it("personality sets the tone scales", () => {
    const friendly = compileAgentFlow(input("en", { agent: agent({ personality: "friendly" }) }));
    expect(friendly.training!.persona).toMatchObject({ formality: 2, warmth: 5 });
  });

  it("no industry / topics / callback number: still valid, no topic list, website instead of a number", () => {
    const bare = compileAgentFlow(input("en", { industry: null, categoryName: null, agent: agent({ callbackNumber: null }) }));
    expect(callFlowDefinition.safeParse(bare).success).toBe(true);
    expect(text(bare, "industry_context")).not.toMatch(/DISCOVERY/);
    expect(text(bare, "industry_context")).toMatch(/website/);
  });

  it("refuses a language without reviewed opening lines, and a base that is not executive", () => {
    expect(() => compileAgentFlow({ ...input("en"), language: "te", base: { ...builtinExecutive("en"), language: "te" } })).toThrow(AgentCompileError);
    const nila = callFlowDefinition.parse({ ...JSON.parse(read(BUILTIN + "nila.json")), language: "en" });
    expect(() => compileAgentFlow(input("en", { base: nila }))).toThrow(/Business executive/);
  });

  it("defaults: Thaara, Kagzso Technology Services, 60 s target, 1 min 45 s maximum, Male", () => {
    const d = aiAgentInput.parse({ name: "x", businessName: "b", objective: "o" });
    expect(d).toMatchObject({
      executiveName: AI_AGENT_DEFAULTS.executiveName,
      companyName: "Kagzso Technology Services",
      targetDurationSec: 60,
      maxDurationSec: 105,
      contactGender: "male",
      mode: "autonomous",
    });
    expect(aiAgentInput.safeParse({ name: "x", businessName: "b", objective: "o", targetDurationSec: 110 }).success).toBe(false);
    expect(aiAgentInput.safeParse({ name: "x", mode: "guided" }).success).toBe(false); // needs its Call Flow
    expect(aiAgentInput.safeParse({ name: "x", businessName: "b", objective: "o", executiveName: "Thaara2" }).success).toBe(false);
  });
});

describe("knowledge content checks (same rules as the voice backend)", () => {
  const cases: { text: string; policy: boolean; ok: boolean }[] = JSON.parse(read(FIXTURES + "knowledge_cases.json"));
  it.each(cases)("$text → ok=$ok", ({ text: t, policy, ok }) => {
    expect(knowledgeTextIssues(t, { policy }).length === 0).toBe(ok);
  });
});
