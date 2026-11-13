import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCallInsights } from "@dispatch/shared";

// Call insights after an Autonomous AI Agent's call (domain/aiCallInsights.ts), against an in-memory stand-in for Prisma
// (no MySQL): sentiment and interest are checked again and kept apart, a declined call is never "interested", no
// private detail stays in their text, they reach the call log and (once) the saved customer's timeline, and they never
// change the stage or a follow-up. FAQ counts get the customers' sentiment and interest. Whether a real model reads a
// call right is the voice backend's LLM: scripts/customer_questions_check.py checks that with real transcripts.

type Row = Record<string, any>;
let seq = 0;
const tables: Record<string, Row[]> = {};
const T = (name: string) => (tables[name] ??= []);

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return cond.not === null ? v != null : v != null; // { not: Prisma.AnyNull }: has a value
      return true; // a relation filter (run → flow): every row here belongs to the agent
    }
    return (v ?? null) === cond;
  });
}

function model(name: string) {
  const rows = () => T(name);
  const sorted = (list: Row[], orderBy?: Row) =>
    orderBy?.createdAt === "desc" ? [...list].sort((a, b) => b.createdAt - a.createdAt) : list;
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
    findMany: async ({ where, orderBy, take }: Row = {}) =>
      sorted(rows().filter((x) => matches(x, where)), orderBy).slice(0, take ?? undefined).map((r) => ({ ...r })),
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
    count: async ({ where }: Row = {}) => rows().filter((x) => matches(x, where)).length,
  };
}

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
const syncCustomerFromLog = vi.fn(async () => undefined);
vi.mock("../src/domain/aiCallCustomerSync.js", () => ({
  businessForCall,
  saveLearnedBusiness: vi.fn(async () => undefined),
  syncCustomerFromLog,
  markCustomerCalling: vi.fn(async () => undefined),
}));

const ins = await import("../src/domain/aiCallInsights.js");
const { applyVoiceUpdate } = await import("../src/domain/aiCalls.js");
const { listCustomers } = await import("../src/domain/aiCallCustomers.js");

/** What the voice backend sends (customer_questions.py parse_insights). */
const voice = (over: Row = {}): Row => ({
  sentiment: "positive",
  sentiment_start: "neutral",
  sentiment_end: "positive",
  interest: "interested",
  objections: [{ type: "pricing", text: "worried it may be costly" }],
  not_interested_reason: null,
  requirement: "payment reminders for patients",
  automation_need: "WhatsApp reminders",
  ...over,
});
const TERMS = ["Ragul", "Kumar", "Lakshmi Textiles"];

function seed() {
  T("aiAgent").push({ id: "agent-1", callFlowId: "flow-1", archivedAt: null, mode: "AUTONOMOUS" });
  T("aiCallRunFlow").push({ runId: "run-1", flowVersion: { flowId: "flow-1", flow: { language: "ta" } } });
  T("aiCallLog").push({ id: "log-1", runId: "run-1", phone: "+919876543210", customerName: "Ragul Kumar", status: "COMPLETED", outcome: "interested", sentiment: null, insights: null, createdAt: new Date(1000) });
  T("aiCallCustomer").push({ id: "cust-1", stage: "INTERESTED", needsReview: true, doNotCall: false, phone: "+919876543210", language: "ta", deletedAt: null, lastCallLogId: "log-1", createdAt: new Date(1) });
  T("aiCallCustomerCall").push({ customerId: "cust-1", logId: "log-1" });
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ checking */
describe("checking what the voice backend sent", () => {
  it("reads every field, sentiment and interest kept apart", () => {
    expect(ins.parseCallInsights(voice())).toEqual({
      sentiment: "positive",
      sentimentStart: "neutral",
      sentimentEnd: "positive",
      interest: "interested",
      objections: [{ type: "pricing", text: "worried it may be costly" }],
      notInterestedReason: null,
      requirement: "payment reminders for patients",
      automationNeed: "WhatsApp reminders",
    });
    // A friendly customer who declines stays friendly and not interested: neither is made from the other.
    const declined = ins.parseCallInsights(voice({ interest: "not_interested", not_interested_reason: { type: "existing_system", text: "has billing software" } }));
    expect(declined).toMatchObject({ sentiment: "positive", interest: "not_interested", notInterestedReason: { type: "existing_system", text: "has billing software" } });
  });

  it("a call whose outcome is not interested (or do not call) is never kept as interested", () => {
    expect(ins.parseCallInsights(voice({ interest: "highly_interested" }), [], "not_interested")!.interest).toBe("not_interested");
    expect(ins.parseCallInsights(voice({ interest: "interested" }), [], "do_not_call")!.interest).toBe("not_interested");
    expect(ins.parseCallInsights(voice({ interest: "interested" }), [], "interested")!.interest).toBe("interested");
  });

  it("a reason is kept only for a customer who wasn't interested", () => {
    expect(ins.parseCallInsights(voice({ interest: "exploring", not_interested_reason: { type: "timing", text: "busy" } }))!.notInterestedReason).toBeNull();
  });

  it("anything outside the fixed lists is unclear / null / other, never a reason to drop the call's insights", () => {
    const out = ins.parseCallInsights(voice({ sentiment: "happy", sentiment_end: "glad", interest: "maybe", objections: [{ type: "price", text: "costly" }] }))!;
    expect(out).toMatchObject({ sentiment: null, sentimentEnd: null, interest: "unclear", objections: [{ type: "other", text: "costly" }] });
  });

  it.each([
    ["a phone number", "call him on 98765 43210"],
    ["an email address", "send it to ragul@example.com"],
    ["the customer's name", "Ragul wants reminders"],
    ["the customer's business", "reminders for Lakshmi Textiles"],
    ["too long", "x".repeat(200)],
  ])("no private detail stays in their text: %s", (_why, text) => {
    const out = ins.parseCallInsights(voice({ requirement: text, automation_need: text, objections: [{ type: "trust", text }] }), TERMS)!;
    expect(out.requirement).toBeNull();
    expect(out.automationNeed).toBeNull();
    expect(out.objections).toEqual([{ type: "trust", text: "" }]); // the kind of concern still counts
  });

  it.each([null, undefined, "text", [1, 2], 42])("nothing readable: no insights (%s)", (value) => {
    expect(ins.parseCallInsights(value)).toBeNull();
  });

  it("one timeline line says how the call went", () => {
    expect(ins.insightsLine(ins.parseCallInsights(voice())!)).toBe(
      "Sentiment: Neutral → Positive · Interest: Interested · Objection: Pricing (worried it may be costly) · " +
        "Needs: payment reminders for patients · Wants automated: WhatsApp reminders",
    );
    expect(ins.insightsLine(ins.parseCallInsights(voice({ sentiment_start: "positive", objections: [], requirement: null, automation_need: null, interest: "exploring" }))!))
      .toBe("Sentiment: Positive · Interest: Exploring");
  });
});

/* ------------------------------------------------------------------ the call's status update */
describe("from the call's status update", () => {
  it("kept on the call log and once on the customer's timeline, delivered by webhook and poll", async () => {
    seed();
    await applyVoiceUpdate("log-1", { status: "completed", callInsights: voice() }); // webhook
    await applyVoiceUpdate("log-1", { status: "completed", callInsights: voice() }); // poll
    expect(T("aiCallLog")[0]).toMatchObject({ sentiment: "positive", insights: { interest: "interested", sentimentStart: "neutral" } });
    const events = T("aiCallCustomerEvent").filter((e) => e.type === "call_insights");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ customerId: "cust-1", refId: "log-1", stage: null });
    expect(events[0]!.detail).toContain("Interest: Interested");
  });

  it("never changes the stage or a follow-up", async () => {
    seed();
    const before = { ...T("aiCallCustomer")[0] };
    await ins.saveCallInsights("log-1", voice({ interest: "not_interested", not_interested_reason: { type: "no_need", text: "no need now" } }));
    expect(T("aiCallCustomer")[0]).toEqual(before);
    expect(T("aiCallFollowup")).toEqual([]);
    expect(syncCustomerFromLog).not.toHaveBeenCalled();
  });

  it("a call from an uploaded file (no saved customer): on the log only", async () => {
    seed();
    T("aiCallCustomerCall").length = 0;
    expect(await ins.saveCallInsights("log-1", voice())).toMatchObject({ interest: "interested" });
    expect(T("aiCallLog")[0]!.sentiment).toBe("positive");
    expect(T("aiCallCustomerEvent")).toEqual([]);
  });

  it("the customer's name and business on file never stay in the text", async () => {
    seed();
    await ins.saveCallInsights("log-1", voice({ requirement: "billing for Lakshmi Textiles" }));
    expect(T("aiCallLog")[0]!.insights.requirement).toBeNull();
  });

  it("never breaks the status update: a bad value is no insights", async () => {
    seed();
    await expect(applyVoiceUpdate("log-1", { status: "completed", outcome: "interested", callInsights: "bad" })).resolves.toBeTruthy();
    expect(T("aiCallLog")[0]).toMatchObject({ outcome: "interested", sentiment: null, insights: null });
  });

  it("FAQ counts: the sentiment and interest of the call it was asked on", async () => {
    seed();
    T("aiAgentKnowledgeItem").push({ id: "a1", agentId: "agent-1", kind: "qa", status: "APPROVED", source: "row 2", topic: "Services", text: "We automate billing.", questions: ["What services do you offer?"], createdAt: new Date(1) });
    const questions = [{ question: "What services do you offer?", topic: "Services", asked: "", known_id: "a1", answered: true, answer: null, answer_from: [] }];
    await applyVoiceUpdate("log-1", { status: "completed", customerQuestions: questions, callInsights: voice({ interest: "highly_interested" }) });
    const stats = T("setting").find((s) => s.key === "aiAgentQuestions:agent-1")!.value.items.a1;
    expect(stats).toMatchObject({ asked: 1, sentiments: { positive: 1 }, interests: { highly_interested: 1 } });
    // Without insights (an older voice backend) the counts are as before.
    T("aiCallLog").push({ id: "log-2", runId: "run-1", phone: "+919876543210", customerName: null, status: "COMPLETED", outcome: null, createdAt: new Date(2000) });
    await applyVoiceUpdate("log-2", { status: "completed", customerQuestions: questions });
    const after = T("setting").find((s) => s.key === "aiAgentQuestions:agent-1")!.value.items.a1;
    expect(after).toMatchObject({ asked: 2, sentiments: { positive: 1 }, interests: { highly_interested: 1 } });
  });
});

/* ------------------------------------------------------------------ where admins see them */
describe("where admins see them", () => {
  it("the customer list shows the newest call that has insights (a later call nobody answered changes nothing)", async () => {
    seed();
    T("aiCallLog")[0]!.insights = ins.parseCallInsights(voice({ interest: "exploring", sentiment: "neutral" }));
    T("aiCallLog")[0]!.sentiment = "neutral";
    T("aiCallLog").push({ id: "log-2", runId: "run-1", phone: "+919876543210", status: "COMPLETED", outcome: "interested", sentiment: "positive", insights: ins.parseCallInsights(voice()), createdAt: new Date(2000) });
    T("aiCallLog").push({ id: "log-3", runId: "run-1", phone: "+919876543210", status: "NO_ANSWER", outcome: null, sentiment: null, insights: null, createdAt: new Date(3000) });
    T("aiCallCustomerCall").push({ customerId: "cust-1", logId: "log-2" }, { customerId: "cust-1", logId: "log-3" });
    const { items } = await listCustomers({ language: "ta", page: 1, pageSize: 50 });
    expect(items[0]!.lastInsight).toEqual({ sentiment: "positive", interest: "interested", at: new Date(2000).toISOString() });
    expect(items[0]!.stage).toBe("INTERESTED"); // the stage is its own
  });

  it("an agent's summary: sentiment, interest, how the mood changed, and the most common concerns", () => {
    const list = [
      ins.parseCallInsights(voice()),
      ins.parseCallInsights(voice({ sentiment: "negative", sentiment_start: "neutral", sentiment_end: "negative", interest: "not_interested", objections: [], not_interested_reason: { type: "pricing", text: "too costly" } })),
      ins.parseCallInsights(voice({ sentiment: "neutral", sentiment_start: "neutral", sentiment_end: "neutral", interest: "exploring", objections: [{ type: "existing_system", text: "uses Tally" }] })),
      null,
    ];
    expect(ins.summarizeInsights(list)).toEqual({
      calls: 3,
      sentiment: { positive: 1, negative: 1, neutral: 1 },
      interest: { interested: 1, not_interested: 1, exploring: 1 },
      change: { better: 1, same: 1, worse: 1 },
      concerns: [
        { type: "pricing", count: 2, examples: ["worried it may be costly", "too costly"] },
        { type: "existing_system", count: 1, examples: ["uses Tally"] },
      ],
    });
  });

  it("an agent's summary from its calls; none yet is null", async () => {
    seed();
    expect(await ins.agentCallInsights("agent-1")).toBeNull(); // no call has insights yet
    await ins.saveCallInsights("log-1", voice());
    expect(await ins.agentCallInsights("agent-1")).toMatchObject({ calls: 1, interest: { interested: 1 } });
    expect(await ins.agentCallInsights("no-such-agent")).toBeNull();
  });

  it("stored insights read back safely", () => {
    expect(ins.storedInsights(null)).toBeNull();
    expect(ins.storedInsights([1] as never)).toBeNull();
    expect(ins.storedInsights({ interest: "exploring" } as never)).toEqual({ interest: "exploring" } as unknown as AiCallInsights);
  });
});
