import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_KNOWLEDGE_FROM_CALLS } from "@dispatch/shared";
import type { LearnedQuestion, QuestionStore } from "../src/domain/aiAgentQuestions.js";

// Customer questions learned on Autonomous AI Agent calls (domain/aiAgentQuestions.ts), against an in-memory stand-in
// for Prisma (no MySQL): what a call's questions count, which become Draft suggestions, what is never kept (private
// details, a customer's words as an answer, approved knowledge changed without an admin), and that a call delivered
// by both the webhook and the poll is counted once. Whether a real model groups differently worded questions is the
// voice backend's LLM: that needs a real-model check, not this file.

type Row = Record<string, any>;
let seq = 0;
const tables: Record<string, Row[]> = {};
const T = (name: string) => (tables[name] ??= []);

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return cond.not === null ? v != null : v !== cond.not;
      return true;
    }
    return (v ?? null) === cond;
  });
}

function model(name: string) {
  const rows = () => T(name);
  return {
    create: async ({ data }: Row) => {
      const row = { id: `${name}-${++seq}`, createdAt: new Date(Date.now() + seq), status: "DRAFT", ...data };
      rows().push(row);
      return { ...row };
    },
    findUnique: async ({ where }: Row) => {
      const r = rows().find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    findFirst: async ({ where }: Row = {}) => {
      const r = rows().find((x) => matches(x, where));
      return r ? { ...r } : null;
    },
    findMany: async ({ where }: Row = {}) => rows().filter((x) => matches(x, where)).map((r) => ({ ...r })),
    update: async ({ where, data }: Row) => {
      const r = rows().find((x) => matches(x, where))!;
      Object.assign(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: Row) => {
      const hits = rows().filter((x) => matches(x, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    },
    groupBy: async () => [],
    count: async ({ where }: Row = {}) => rows().filter((x) => matches(x, where)).length,
  };
}

// The Settings row lock (INSERT IGNORE, then SELECT ... FOR UPDATE) as MySQL would answer it.
const raw = {
  $executeRaw: async (_sql: TemplateStringsArray, key: string, value: string) => {
    if (!T("setting").some((s) => s.key === key)) T("setting").push({ key, value: JSON.parse(value) });
    return 1;
  },
  $queryRaw: async (_sql: TemplateStringsArray, key: string) => T("setting").filter((s) => s.key === key).map((s) => ({ value: s.value })),
};
const db: Row = new Proxy({} as Row, {
  get: (_t, p: string) => {
    if (p === "$transaction") return async (fn: (tx: Row) => Promise<unknown>) => fn(db);
    if (p in raw) return raw[p as keyof typeof raw];
    return model(p);
  },
});
vi.mock("../src/prisma.js", () => ({ prisma: db }));

const businessForCall = vi.fn(async () => "Lakshmi Textiles");
vi.mock("../src/domain/aiCallCustomerSync.js", () => ({
  businessForCall,
  saveLearnedBusiness: vi.fn(async () => undefined),
  syncCustomerFromLog: vi.fn(async () => undefined),
  markCustomerCalling: vi.fn(async () => undefined),
}));

const q = await import("../src/domain/aiAgentQuestions.js");
const { applyVoiceUpdate } = await import("../src/domain/aiCalls.js");
const { listKnowledge } = await import("../src/domain/aiAgents.js");

const NOW = new Date("2026-11-12T10:00:00Z");
const TERMS = q.privateTerms("Ragul Kumar", "Lakshmi Textiles");

function learned(over: Partial<LearnedQuestion> = {}): LearnedQuestion {
  return { question: "Which languages does it support?", topic: "Languages", asked: "Tamil-la pesuma?", known_id: null, answered: true, answer: null, answer_from: [], ...over };
}
function qa(id: string, over: Row = {}): Row {
  return { id, status: "APPROVED", source: "row 2", topic: "Services", text: "We automate billing.", questions: ["What services do you offer?"], ...over };
}
const plan = (store: QuestionStore, items: Row[], questions: LearnedQuestion[], logId = "log-1", language = "ta") =>
  q.planQuestions(store, items as never, logId, questions, { language, now: NOW, terms: TERMS });
const empty = (): QuestionStore => ({ v: 1, calls: [], items: {} });

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ what one call changes */
describe("a call's questions", () => {
  it("a question matching an approved Q&A is counted on it, and its new wording is kept beside it, never written in", () => {
    const store = empty();
    const out = plan(store, [qa("a1")], [learned({ known_id: "a1", asked: "நீங்க என்ன service பண்றீங்க?", answered: false })]);
    expect(out).toEqual({ creates: [], updates: [], skipped: 0 });
    expect(store.items.a1).toEqual({
      asked: 1,
      unanswered: 1,
      lastAskedAt: NOW.toISOString(),
      languages: { ta: 1 },
      ways: ["நீங்க என்ன service பண்றீங்க?"],
      draftedFrom: [],
    });
  });

  it("a new question becomes a Draft suggestion with the answer drafted from approved knowledge", () => {
    const store = empty();
    const out = plan(store, [qa("a1")], [learned({ answer: "It speaks English and Tamil.", answer_from: ["Languages"] })])!;
    expect(out.creates).toEqual([
      { key: "new:0", topic: "Languages", text: "It speaks English and Tamil.", questions: ["Which languages does it support?", "Tamil-la pesuma?"] },
    ]);
    expect(store.items["new:0"]).toMatchObject({ asked: 1, unanswered: 0, draftedFrom: ["Languages"], ways: [] });
  });

  it("an answer with nothing approved behind it is never used: the suggestion waits for the admin's answer", () => {
    const out = plan(empty(), [], [learned({ answer: "Yes, all of them.", answer_from: [] })])!;
    expect(out.creates[0]!.text).toBe("");
  });

  it("the same question again fills an open suggestion: another wording, and an answer where it had none", () => {
    const store = empty();
    const items = [qa("s1", { status: "DRAFT", source: AI_KNOWLEDGE_FROM_CALLS, text: "", questions: ["Which languages does it support?"] })];
    const out = plan(store, items, [learned({ known_id: "s1", asked: "क्या यह हिंदी बोलता है?", answer: "Hindi too.", answer_from: ["Languages"] })], "log-2", "hi")!;
    expect(out.updates).toEqual([{ id: "s1", text: "Hindi too.", questions: ["Which languages does it support?", "क्या यह हिंदी बोलता है?"] }]);
    expect(store.items.s1).toMatchObject({ asked: 1, languages: { hi: 1 }, draftedFrom: ["Languages"] });
  });

  it("a rejected suggestion keeps absorbing its question, so it is not suggested again", () => {
    const store = empty();
    const items = [qa("r1", { status: "REJECTED", source: AI_KNOWLEDGE_FROM_CALLS, questions: ["Do you sell hardware?"] })];
    const out = plan(store, items, [learned({ question: "Do you sell hardware?", known_id: "r1" })])!;
    expect(out.creates).toEqual([]);
    expect(out.updates).toEqual([]);
    expect(store.items.r1!.asked).toBe(1);
  });

  it("a question written word for word on an item is found even without the backend's match", () => {
    const store = empty();
    const out = plan(store, [qa("a1")], [learned({ question: "what services do you OFFER", known_id: null })])!;
    expect(out.creates).toEqual([]);
    expect(store.items.a1!.asked).toBe(1);
  });

  it("is counted once per call, however often it came up, and a call is never counted twice", () => {
    const store = empty();
    plan(store, [qa("a1")], [learned({ known_id: "a1", answered: false }), learned({ known_id: "a1", question: "What do you do?" })]);
    expect(store.items.a1).toMatchObject({ asked: 1, unanswered: 1 });
    expect(plan(store, [qa("a1")], [learned({ known_id: "a1" })])).toBeNull(); // the same call again (webhook + poll)
    plan(store, [qa("a1")], [learned({ known_id: "a1" })], "log-2", "en");
    expect(store.items.a1).toMatchObject({ asked: 2, unanswered: 1, languages: { ta: 1, en: 1 } });
  });

  it.each([
    ["the customer's name", "Can Ragul get a discount?"],
    ["their business", "Will it work for Lakshmi Textiles?"],
    ["a phone number", "Can you call 98765 43210 about it?"],
    ["an email address", "Send it to ragul@example.com?"],
  ])("a question with %s is never kept", (_what, question) => {
    const store = empty();
    expect(plan(store, [], [learned({ question })])).toEqual({ creates: [], updates: [], skipped: 0 });
    expect(store.items).toEqual({});
  });

  it("private details in the customer's wording drop that wording only", () => {
    const out = plan(empty(), [], [learned({ asked: "Lakshmi Textiles-ku idhu work aagumaa?" })])!;
    expect(out.creates[0]!.questions).toEqual(["Which languages does it support?"]);
  });

  it("at most 50 open suggestions: past that, new questions wait", () => {
    const open = Array.from({ length: q.MAX_OPEN_SUGGESTIONS }, (_, n) =>
      qa(`s${n}`, { status: "DRAFT", source: AI_KNOWLEDGE_FROM_CALLS, questions: [`Question ${n}?`] }),
    );
    const out = plan(empty(), open, [learned({ question: "Something brand new?" })])!;
    expect(out).toMatchObject({ creates: [], skipped: 1 });
  });

  it("an unreadable list is nothing", () => {
    for (const bad of [null, "x", {}, [{ nope: 1 }], [{ question: 5 }]]) expect(q.parseLearnedQuestions(bad)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the request to the voice backend */
describe("the request to the voice backend", () => {
  const BASE = { customerName: "Ragul", gender: "male", followUpDetail: null, phone: "+919876543210", runId: "r1", logId: "l1" };
  const KNOWN_LIST = [{ id: "a1", question: "What services do you offer?" }];
  const refused = (field: string) => [422, { detail: [{ loc: ["body", field], msg: "Extra inputs are not permitted" }] }] as const;
  const ok = [200, { success: true, call_id: "c1", provider_call_id: null }] as const;

  async function place(extra: Record<string, unknown>, responses: (readonly [number, unknown])[]) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const [status, body] = responses.shift()!;
      return new Response(JSON.stringify(body), { status });
    });
    process.env.ENABLE_AI_CALLS = "true";
    process.env.VOICE_BACKEND_URL = "http://voice.test";
    process.env.VOICE_BACKEND_API_KEY = "voice-key-0123456789";
    vi.resetModules();
    const { placeVoiceCall } = await import("../src/services/voiceBackend.js");
    try {
      return { result: await placeVoiceCall({ ...BASE, ...extra } as never), bodies };
    } catch (err) {
      return { err: err as Error, bodies };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("carries the agent's questions only when given", async () => {
    expect((await place({}, [ok])).bodies[0]).not.toHaveProperty("known_questions");
    expect((await place({ knownQuestions: [] }, [ok])).bodies[0]!.known_questions).toEqual([]);
    expect((await place({ knownQuestions: KNOWN_LIST }, [ok])).bodies[0]!.known_questions).toEqual(KNOWN_LIST);
  });

  it("a voice backend from before this still places the call, without them", async () => {
    const { result, bodies } = await place({ knownQuestions: KNOWN_LIST }, [refused("known_questions"), ok]);
    expect(result).toEqual({ callId: "c1", providerCallId: null });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("known_questions");
  });

  it("any other refusal is not retried", async () => {
    const { err, bodies } = await place({ knownQuestions: KNOWN_LIST }, [refused("phone_number"), ok]);
    expect(err?.message).toContain("phone_number");
    expect(bodies).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ the database path */
const AGENT = { id: "agent-1", callFlowId: "flow-1", archivedAt: null, mode: "AUTONOMOUS", language: "ta" };

function seed() {
  T("aiAgent").push({ ...AGENT });
  T("aiCallLog").push({ id: "log-1", runId: "run-1", phone: "+919876543210", customerName: "Ragul", status: "COMPLETED", outcome: "interested" });
  T("aiCallRunFlow").push({ runId: "run-1", flowVersion: { flowId: "flow-1", flow: { language: "ta" } } });
  T("aiAgentKnowledgeItem").push(
    { id: "a1", agentId: "agent-1", kind: "qa", status: "APPROVED", source: "row 2", topic: "Services", text: "We automate billing.", questions: ["What services do you offer?"], createdAt: new Date(1) },
    { id: "f1", agentId: "agent-1", kind: "fact", status: "APPROVED", source: "page 1", topic: "About", text: "Kagzso is in Chennai.", questions: [], createdAt: new Date(2) },
    { id: "x1", agentId: "agent-1", kind: "qa", status: "REJECTED", source: "row 9", topic: "Old", text: "Old.", questions: ["An old question?"], createdAt: new Date(3) },
  );
}

const CALL_QUESTIONS = [
  { question: "What services do you offer?", topic: "Services", asked: "Neenga enna service pannreenga?", known_id: "a1", answered: true, answer: null, answer_from: [] },
  { question: "Does it work with Tally?", topic: "Integration", asked: "Tally-oda work aagumaa?", known_id: null, answered: false, answer: null, answer_from: [] },
];

describe("from the call's status update to the Knowledge tab", () => {
  it("only an Autonomous AI Agent's flow sends questions: approved first, a rejected file item left out", async () => {
    seed();
    expect(await q.knownQuestionsForFlow("flow-1")).toEqual([{ id: "a1", question: "What services do you offer?" }]);
    expect(await q.knownQuestionsForFlow("another-flow")).toBeNull();
    expect(await q.knownQuestionsForFlow(null)).toBeNull();
    T("aiAgent")[0]!.archivedAt = new Date();
    expect(await q.knownQuestionsForFlow("flow-1")).toBeNull();
  });

  it("webhook and poll deliver the same call: counted once, one Draft suggestion, shown with its counts", async () => {
    seed();
    await applyVoiceUpdate("log-1", { status: "completed", customerQuestions: CALL_QUESTIONS }); // webhook
    await applyVoiceUpdate("log-1", { status: "completed", customerQuestions: CALL_QUESTIONS }); // poll
    const drafts = T("aiAgentKnowledgeItem").filter((i) => i.source === AI_KNOWLEDGE_FROM_CALLS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      agentId: "agent-1",
      kind: "qa",
      status: "DRAFT",
      topic: "Integration",
      text: "",
      questions: ["Does it work with Tally?", "Tally-oda work aagumaa?"],
    });
    expect(drafts[0]!.issues).toContain("missing answer"); // can't be approved until an admin writes it
    expect(T("aiAgentKnowledgeItem").find((i) => i.id === "a1")).toMatchObject({ questions: ["What services do you offer?"], status: "APPROVED" });

    const { items } = await listKnowledge("agent-1");
    expect(items.find((i) => i.id === "a1")!.calls).toMatchObject({ asked: 1, unanswered: 0, languages: { ta: 1 }, ways: ["Neenga enna service pannreenga?"] });
    expect(items.find((i) => i.id === drafts[0]!.id)!.calls).toMatchObject({ asked: 1, unanswered: 1 });
    expect(items.find((i) => i.id === "f1")!.calls).toBeUndefined(); // never asked: the view is as before

    // The suggestion is now among the questions the next call is sent.
    expect((await q.knownQuestionsForFlow("flow-1"))!.map((k) => k.id)).toEqual(["a1", drafts[0]!.id]);
  });

  it("a list it can't read never breaks the call's status update", async () => {
    seed();
    await expect(applyVoiceUpdate("log-1", { status: "completed", outcome: "interested", customerQuestions: { bad: true } })).resolves.toBeTruthy();
    expect(T("aiCallLog")[0]).toMatchObject({ outcome: "interested" });
    expect(T("setting")).toHaveLength(0);
  });

  it("nothing is learned for a call that isn't an agent's", async () => {
    seed();
    T("aiCallRunFlow")[0]!.flowVersion.flowId = "ordinary-flow";
    await applyVoiceUpdate("log-1", { status: "completed", customerQuestions: CALL_QUESTIONS });
    expect(T("aiAgentKnowledgeItem").filter((i) => i.source === AI_KNOWLEDGE_FROM_CALLS)).toHaveLength(0);
    expect(T("setting")).toHaveLength(0);
  });

  it("counts of a deleted suggestion go with it, so the question may be suggested again", async () => {
    seed();
    await applyVoiceUpdate("log-1", { status: "completed", customerQuestions: CALL_QUESTIONS });
    const draft = T("aiAgentKnowledgeItem").find((i) => i.source === AI_KNOWLEDGE_FROM_CALLS)!;
    tables.aiAgentKnowledgeItem = T("aiAgentKnowledgeItem").filter((i) => i.id !== draft.id);
    T("aiCallLog").push({ id: "log-2", runId: "run-1", phone: "+919876543211", customerName: "Asha", status: "COMPLETED" });
    await applyVoiceUpdate("log-2", { status: "completed", customerQuestions: [CALL_QUESTIONS[1]] });
    const store = T("setting")[0]!.value as QuestionStore;
    expect(store.items[draft.id]).toBeUndefined();
    expect(store.calls).toEqual(["log-1", "log-2"]);
    expect(T("aiAgentKnowledgeItem").filter((i) => i.source === AI_KNOWLEDGE_FROM_CALLS)).toHaveLength(1);
  });
});
