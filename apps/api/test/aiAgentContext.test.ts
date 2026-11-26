import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aiCallCustomerInput,
  checkAiCallCustomerRow,
  isContactGender,
  listAiCallCustomersQuery,
  normalizeAiCallGender,
  normalizeContactGender,
} from "@dispatch/shared";

// AI Agent call context (2026-11-26), with Prisma replaced by an in-memory stand-in (no MySQL):
//   A  the customer history sent with an AI Agent's call - only for an agent whose instructions lead, only this
//      contact's own completed calls in this language, at most 2, plus the follow-up the call is for
//   D  English "call again" with the agent whose call created the follow-up; everything else as before
//   E  a callback the customer asked for, kept from the call's insights (never a date, never for a declined call)
//   B  a contact's gender: Not specified instead of a silent Male

type Row = Record<string, any>;
const t: Record<string, Row[]> = {};
const T = (name: string) => (t[name] ??= []);
const db = {
  aiCallCustomerCall: { findMany: async ({ where }: Row) => T("links").filter((l) => l.customerId === where.customerId) },
  aiCallLog: {
    findMany: async ({ where, take }: Row) =>
      T("logs")
        .filter((l) => where.id.in.includes(l.id) && l.status === where.status && l.endedAt != null && l.phone === where.phone)
        .sort((a, b) => b.endedAt - a.endedAt)
        .slice(0, take),
    findUnique: async ({ where }: Row) => T("logs").find((l) => l.id === where.id) ?? null,
  },
  aiCallFollowup: {
    findFirst: async ({ where }: Row) =>
      T("followups").find((f) => f.aiCallRunId === where.aiCallRunId && f.customerId === where.customerId && f.channel === where.channel) ?? null,
  },
  aiAgent: {
    findFirst: async ({ where }: Row) =>
      T("agents").find((a) => a.callFlowId === where.callFlowId && a.mode === where.mode && a.archivedAt === null && a.language === where.language) ?? null,
  },
  callFlow: { findUnique: async ({ where }: Row) => T("flows").find((f) => f.id === where.id) ?? null },
  callFlowVersion: {
    findFirst: async ({ where }: Row) =>
      T("versions").filter((v) => v.flowId === where.flowId && v.status === "PUBLISHED").sort((a, b) => b.version - a.version)[0] ?? null,
  },
};
vi.mock("../src/prisma.js", () => ({ prisma: { ...db, $transaction: (fn: (tx: typeof db) => unknown) => fn(db) } }));

const customer = { id: "cust-1", phone: "+919876543210", language: "ta", deletedAt: null };
const customerOfCall = vi.fn(async () => customer as Row | null);
vi.mock("../src/domain/aiCallCustomerSync.js", () => ({
  customerOfCall,
  businessForCall: vi.fn(async () => null),
  saveLearnedBusiness: vi.fn(async () => undefined),
  syncCustomerFromLog: vi.fn(async () => undefined),
  markCustomerCalling: vi.fn(async () => undefined),
}));

const { historyForCall, instructionsLeadFlow, HISTORY_CALLS } = await import("../src/domain/aiAgentHistory.js");
const { agentVersionForCallAgain } = await import("../src/domain/callFlows.js");
const { parseCallInsights, insightsLine } = await import("../src/domain/aiCallInsights.js");

const LEAD = { autonomous: { target_duration_sec: 60, dnc_enforce: true, natural_lines: true, instructions_lead: true } };
const OLDER_AGENT = { autonomous: { target_duration_sec: 60, dnc_enforce: true, natural_lines: true } };
const run = (language: string | null) => ({ flow: language ? { flowVersion: { flow: { language } } } : null });
const log = (id: string, endedAt: number, over: Row = {}): Row => ({
  id,
  phone: customer.phone,
  status: "COMPLETED",
  endedAt: new Date(endedAt),
  outcome: "interested",
  summary: `Summary of ${id}.`,
  insights: { interest: "interested", requirement: "appointment reminders", automationNeed: "WhatsApp reminders", objections: [] },
  run: run("ta"),
  ...over,
});
const call = (over: Row = {}) => ({ logId: "now", runId: "run-now", phone: customer.phone, language: "ta" as const, flowDefinition: LEAD, ...over });

beforeEach(() => {
  for (const k of Object.keys(t)) delete t[k];
  customerOfCall.mockClear();
  customerOfCall.mockResolvedValue(customer);
});

function seedCalls(...logs: Row[]) {
  for (const l of logs) {
    T("logs").push(l);
    T("links").push({ customerId: customer.id, logId: l.id });
  }
}

/* ------------------------------------------------------------------ A: customer history */
describe("A: an AI Agent call's customer history", () => {
  it("only for a flow whose admin's instructions lead (and with natural lines)", async () => {
    seedCalls(log("a", 1000));
    expect(instructionsLeadFlow(LEAD)).toBe(true);
    for (const definition of [OLDER_AGENT, null, {}, { language: "ta" }, { autonomous: { instructions_lead: true } }]) {
      expect(instructionsLeadFlow(definition)).toBe(false);
      expect(await historyForCall(call({ flowDefinition: definition }))).toBeNull();
    }
    expect(customerOfCall).toHaveBeenCalledTimes(0); // nothing is even read for those calls
  });

  it("the newest 2 completed calls of this contact, newest first, with their summary and insights", async () => {
    seedCalls(log("old", 1000), log("mid", 2000, { outcome: "callback_requested" }), log("new", 3000));
    const h = await historyForCall(call());
    expect(HISTORY_CALLS).toBe(2);
    expect(h!.calls.map((c) => c.summary)).toEqual(["Summary of new.", "Summary of mid."]);
    expect(h!.calls[0]).toEqual({
      date: new Date(3000).toISOString().slice(0, 10),
      outcome: "interested",
      summary: "Summary of new.",
      interest: "interested",
      requirement: "appointment reminders",
      automation_need: "WhatsApp reminders",
    });
    expect(JSON.stringify(h)).not.toMatch(/transcript/i);
  });

  it("never another contact's, another phone's, another language's, an unfinished call or the call being placed", async () => {
    seedCalls(
      log("now", 9000), // the call itself
      log("other-phone", 8000, { phone: "+919999999999" }),
      log("english", 7000, { run: run(null) }), // an English run (default agent)
      log("hindi", 6500, { run: run("hi") }),
      log("no-answer", 6000, { status: "NO_ANSWER" }),
      log("ringing", 5500, { endedAt: null }),
      log("ok", 5000),
    );
    T("logs").push(log("stranger", 9500)); // not linked to this contact
    const h = await historyForCall(call());
    expect(h!.calls.map((c) => c.summary)).toEqual(["Summary of ok."]);
  });

  it("a first call, or no contact on file: nothing is sent (the voice backend then says there is no earlier call)", async () => {
    expect(await historyForCall(call())).toBeNull();
    customerOfCall.mockResolvedValue(null);
    seedCalls(log("a", 1000));
    expect(await historyForCall(call())).toBeNull();
    customerOfCall.mockResolvedValue({ ...customer, deletedAt: new Date() });
    expect(await historyForCall(call())).toBeNull();
  });

  it("a 'call again' follow-up: its reason, note and day, even before any completed call", async () => {
    T("followups").push({ aiCallRunId: "run-now", customerId: customer.id, channel: "CALL", reason: "Interested", note: "Asked about pricing for 3 branches", scheduledAt: new Date("2026-11-30T05:00:00Z") });
    expect(await historyForCall(call())).toEqual({
      calls: [],
      call_again: { reason: "Interested", note: "Asked about pricing for 3 branches", scheduled_for: "2026-11-30" },
    });
    // Another run's follow-up (or a WhatsApp one) is never this call's.
    expect(await historyForCall(call({ runId: "run-other" }))).toBeNull();
  });

  it("a callback the customer asked for travels with that call; a broken record never stops the call", async () => {
    seedCalls(log("cb", 1000, { insights: { interest: "exploring", callbackRequest: { type: "explicit", when: "tomorrow morning" } } }));
    expect((await historyForCall(call()))!.calls[0]!.callback_request).toEqual({ type: "explicit", when: "tomorrow morning" });
    customerOfCall.mockRejectedValue(new Error("db down"));
    expect(await historyForCall(call())).toBeNull();
  });
});

/* ------------------------------------------------------------------ D: English call again */
describe("D: English 'call again' with the agent whose call created the follow-up", () => {
  function seedAgentFlow(over: Row = {}) {
    T("logs").push({ id: "src", run: { flow: { flowVersion: { flowId: "flow-agent" } } } });
    T("flows").push({ id: "flow-agent", archivedAt: null, language: "en" });
    T("versions").push({ id: "v1", flowId: "flow-agent", version: 1, status: "PUBLISHED", definition: LEAD });
    T("versions").push({ id: "v2", flowId: "flow-agent", version: 2, status: "PUBLISHED", definition: LEAD });
    T("agents").push({ id: "agent-1", callFlowId: "flow-agent", mode: "AUTONOMOUS", archivedAt: null, language: "en", ...over });
  }

  it("the agent's current published version", async () => {
    seedAgentFlow();
    expect((await agentVersionForCallAgain("src"))?.id).toBe("v2");
  });

  it("anything else calls with the default agent, as before", async () => {
    expect(await agentVersionForCallAgain(null)).toBeNull(); // a manual follow-up
    T("logs").push({ id: "nila", run: { flow: null } }); // a Nila call
    expect(await agentVersionForCallAgain("nila")).toBeNull();
    T("logs").push({ id: "ordinary", run: { flow: { flowVersion: { flowId: "flow-ordinary" } } } }); // a Call Flow, no agent
    T("flows").push({ id: "flow-ordinary", archivedAt: null, language: "en" });
    T("versions").push({ id: "vo", flowId: "flow-ordinary", version: 1, status: "PUBLISHED", definition: {} });
    expect(await agentVersionForCallAgain("ordinary")).toBeNull();
  });

  it("an archived or guided agent, or an unpublished flow: the default agent, as before", async () => {
    seedAgentFlow({ archivedAt: new Date() });
    expect(await agentVersionForCallAgain("src")).toBeNull();
    T("agents")[0]!.archivedAt = null;
    T("agents")[0]!.mode = "GUIDED";
    expect(await agentVersionForCallAgain("src")).toBeNull();
    T("agents")[0]!.mode = "AUTONOMOUS";
    T("versions").length = 0; // unpublished since
    expect(await agentVersionForCallAgain("src")).toBeNull();
  });
});

/* ------------------------------------------------------------------ E: callback request in the insights */
describe("E: a callback the customer asked for", () => {
  const voice = (over: Row = {}): Row => ({ sentiment: "neutral", interest: "exploring", objections: [], requirement: null, automation_need: null, ...over });

  it("explicit and suggested, in the customer's words; on the timeline as one short part", () => {
    const explicit = parseCallInsights(voice({ callback_request: { type: "explicit", when: "tomorrow at 11 am" } }), [], "callback_requested")!;
    expect(explicit.callbackRequest).toEqual({ type: "explicit", when: "tomorrow at 11 am" });
    expect(insightsLine(explicit)).toContain("Callback: asked (tomorrow at 11 am)");
    const suggested = parseCallInsights(voice({ callback_request: { type: "suggested", when: null } }), [])!;
    expect(suggested.callbackRequest).toEqual({ type: "suggested", when: null });
    expect(insightsLine(suggested)).toContain("Callback: maybe");
  });

  it("a declined call, an unknown type or private text is never kept as a callback time", () => {
    expect(parseCallInsights(voice({ callback_request: { type: "explicit", when: "monday" } }), [], "not_interested")!.callbackRequest).toBeNull();
    expect(parseCallInsights(voice({ callback_request: { type: "explicit", when: "monday" } }), [], "do_not_call")!.callbackRequest).toBeNull();
    expect(parseCallInsights(voice({ callback_request: { type: "inferred", when: "monday" } }), [])!.callbackRequest).toBeNull();
    expect(parseCallInsights(voice({ callback_request: { type: "explicit", when: "call 9876543210" } }), [])!.callbackRequest).toEqual({ type: "explicit", when: null });
  });

  it("calls that weren't asked for it keep exactly the insights they had (no new key)", () => {
    const before = parseCallInsights(voice(), [])!;
    expect("callbackRequest" in before).toBe(false);
    expect(insightsLine(before)).not.toContain("Callback");
  });
});

/* ------------------------------------------------------------------ B: contact gender */
describe("B: a contact's gender can be Not specified, never a silent Male", () => {
  it("blank or unrecognised is Not specified, with a warning; Male and Female as before", () => {
    expect(checkAiCallCustomerRow({ phone: "9876543210", gender: "" }).gender).toBe("unspecified");
    expect(checkAiCallCustomerRow({ phone: "9876543210", gender: "" }).warnings).toContain("No gender — saved as Not specified");
    expect(checkAiCallCustomerRow({ phone: "9876543210", gender: "Mrs." }).warnings).toContain('Gender "Mrs." — saved as Not specified');
    expect(checkAiCallCustomerRow({ phone: "9876543210", gender: "M" }).gender).toBe("male");
    expect(checkAiCallCustomerRow({ phone: "9876543210", gender: "Female" }).gender).toBe("female");
    for (const word of ["unspecified", "Not specified", "unknown", "N/A"]) {
      const row = checkAiCallCustomerRow({ phone: "9876543210", gender: word });
      expect([word, row.gender, row.warnings.some((w) => w.includes("Gender"))]).toEqual([word, "unspecified", false]);
      expect(isContactGender(word)).toBe(true);
    }
    expect(normalizeContactGender(undefined)).toBe("unspecified");
  });

  it("the form and the list filter accept it; the upload-file AI Call rows keep their own rule", () => {
    expect(aiCallCustomerInput.parse({ phone: "9876543210", gender: "unspecified" }).gender).toBe("unspecified");
    expect(listAiCallCustomersQuery.parse({ gender: "unspecified" }).gender).toBe("unspecified");
    expect(normalizeAiCallGender("")).toBe("male"); // unchanged for the other callers
  });
});
