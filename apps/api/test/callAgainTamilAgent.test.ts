import { beforeEach, describe, expect, it, vi } from "vitest";

// Tamil "call again" from an AI Agent's call (2026-11-28): the follow-up calls with that agent's published version
// only. An agent that can't call now (unpublished, removed, switched to Guided) FAILS the follow-up with a clear
// reason; another Tamil flow - the contact's last one ("ABC Hospital - Thaara") or the newest published - is never used
// in its place. Every other follow-up (manual, Guided, ordinary Call Flow) and every other language: as before.
// The real worker and callFlows.ts run against an in-memory stand-in for Prisma; nothing is dialled.

type Row = Record<string, any>;
const t: Record<string, Row[]> = {};
const T = (name: string) => (t[name] ??= []);
const db = {
  aiCallFollowup: {
    findUnique: async ({ where }: Row) => {
      const f = T("followups").find((x) => x.id === where.id);
      return f ? { ...f, customer: T("customers").find((c) => c.id === f.customerId) } : null;
    },
    update: async ({ where, data }: Row) => Object.assign(T("followups").find((x) => x.id === where.id)!, data),
  },
  aiCallLog: {
    findUnique: async ({ where }: Row) => T("logs").find((l) => l.id === where.id) ?? null,
    findMany: async ({ where }: Row) =>
      T("logs").filter((l) => where.id.in.includes(l.id)).sort((a, b) => b.createdAt - a.createdAt),
  },
  aiCallCustomerCall: { findMany: async ({ where }: Row) => T("links").filter((l) => l.customerId === where.customerId) },
  aiAgent: {
    findFirst: async ({ where }: Row) =>
      T("agents").find(
        (a) =>
          a.callFlowId === where.callFlowId &&
          a.language === where.language &&
          (where.mode === undefined || a.mode === where.mode) &&
          (!("archivedAt" in where) || a.archivedAt === where.archivedAt),
      ) ?? null,
  },
  callFlow: { findUnique: async ({ where }: Row) => T("flows").find((f) => f.id === where.id) ?? null },
  callFlowVersion: {
    findFirst: async ({ where }: Row) =>
      T("versions").filter((v) => v.flowId === where.flowId && v.status === "PUBLISHED").sort((a, b) => b.version - a.version)[0] ?? null,
    findMany: async ({ where }: Row) =>
      T("versions")
        .filter((v) => v.status === "PUBLISHED" && T("flows").some((f) => f.id === v.flowId && f.language === where.flow.language && !f.archivedAt))
        .sort((a, b) => b.publishedAt - a.publishedAt),
  },
  aiCallRun: {
    create: async ({ data }: Row) => {
      const run = { id: `run-${T("runs").length + 1}`, flowVersionId: data.flow?.create.flowVersionId ?? null, logs: [{ id: "log-new" }] };
      T("runs").push(run);
      return run;
    },
  },
};
vi.mock("../src/prisma.js", () => ({ prisma: db }));

const ext = vi.hoisted(() => ({ addCustomerEvent: vi.fn(), linkCustomersToRun: vi.fn(), enqueueAiCallRun: vi.fn() }));
vi.mock("../src/domain/aiCalls.js", async (orig) => ({
  ...(await orig<typeof import("../src/domain/aiCalls.js")>()),
  loadDoNotCallPhones: async () => new Set<string>(),
  callsCountedTowardDailyCap: async () => 0,
}));
vi.mock("../src/domain/aiCallLanguages.js", async (orig) => ({
  ...(await orig<typeof import("../src/domain/aiCallLanguages.js")>()),
  aiCallLanguageBlockedReason: async () => null,
  runInProgressReason: async () => null,
}));
vi.mock("../src/domain/aiCallFollowups.js", () => ({ addCustomerEvent: ext.addCustomerEvent }));
vi.mock("../src/domain/aiCallCustomerSync.js", () => ({ linkCustomersToRun: ext.linkCustomersToRun }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAiCallRun: ext.enqueueAiCallRun }));
vi.mock("../src/config/hardStop.js", () => ({ isHardStopEnabled: () => false }));
vi.mock("../src/config/aiCalls.js", async (orig) => {
  const real = await orig<typeof import("../src/config/aiCalls.js")>();
  return { ...real, aiCallsConfig: { ...real.aiCallsConfig, enabled: true, dailyCap: 1000, minGapSec: 0, defaultCountryCode: "91" } };
});

const { processAiCallFollowup } = await import("../src/queue/aiCallFollowup.js");
const { agentCallAgainTarget } = await import("../src/domain/callFlows.js");

const AGENT_FLOW = "flow-kayal";
const ABC_FLOW = "flow-abc-thaara";

/** A Tamil contact called twice: by the Kayal agent ("src") and, later, by the ABC Hospital flow ("abc"). */
function seed(language = "ta") {
  T("customers").push({ id: "cust-1", phone: "+919876543210", language, deletedAt: null, doNotCall: false, customerName: "Ragul", gender: "male", followUpDetail: null });
  T("flows").push({ id: AGENT_FLOW, language, archivedAt: null }, { id: ABC_FLOW, language, archivedAt: null });
  T("versions").push(
    { id: "v-kayal-1", flowId: AGENT_FLOW, version: 1, status: "PUBLISHED", publishedAt: new Date(1000), definition: { autonomous: { target_duration_sec: 60 } } },
    { id: "v-kayal-2", flowId: AGENT_FLOW, version: 2, status: "PUBLISHED", publishedAt: new Date(2000), definition: { autonomous: { target_duration_sec: 60 } } },
    { id: "v-abc", flowId: ABC_FLOW, version: 9, status: "PUBLISHED", publishedAt: new Date(9000), definition: {} },
  );
  T("agents").push({ id: "kayal", name: "Kagzso Technology", callFlowId: AGENT_FLOW, mode: "AUTONOMOUS", archivedAt: null, language });
  T("logs").push(
    { id: "src", createdAt: new Date(3000), run: { flow: { flowVersion: { flowId: AGENT_FLOW } } } },
    { id: "abc", createdAt: new Date(5000), run: { flow: { flowVersion: { flowId: ABC_FLOW } } } }, // the contact's LAST call
  );
  T("links").push({ customerId: "cust-1", logId: "src" }, { customerId: "cust-1", logId: "abc" });
  T("followups").push({ id: "fu-1", customerId: "cust-1", status: "APPROVED", channel: "CALL", aiCallRunId: null, attempt: 1, sourceCallLogId: "src", decidedByEmail: "admin@test" });
}

beforeEach(() => {
  for (const k of Object.keys(t)) delete t[k];
  vi.clearAllMocks();
});

const followup = () => T("followups")[0]!;

describe("Tamil: a follow-up from an AI Agent's call uses that agent only", () => {
  it("published: the agent's current version, not the contact's last flow (ABC Hospital - Thaara)", async () => {
    seed();
    expect(await processAiCallFollowup({ followupId: "fu-1" })).toEqual({ runId: "run-1" });
    expect(T("runs")).toEqual([expect.objectContaining({ flowVersionId: "v-kayal-2" })]);
    expect(followup()).toMatchObject({ status: "APPROVED", aiCallRunId: "run-1" });
  });

  const cases: [string, () => void, RegExp][] = [
    ["unpublished", () => void T("versions").splice(0, 2), /has no published version — publish it again, then approve a new follow-up/],
    ["removed", () => void (T("agents")[0]!.archivedAt = new Date()), /was removed/],
    ["switched to Guided", () => void (T("agents")[0]!.mode = "GUIDED"), /is no longer Autonomous/],
  ];
  it.each(cases)("%s: the follow-up FAILS with the reason; no run, no other flow", async (_case, change, reason) => {
    seed();
    change();
    expect(await processAiCallFollowup({ followupId: "fu-1" })).toEqual({ failed: expect.stringMatching(reason) });
    expect(T("runs")).toEqual([]); // nothing is dialled - not the ABC Hospital flow, not the newest Tamil flow
    expect(followup().status).toBe("FAILED");
    expect(followup().error).toMatch(/^The AI agent "Kagzso Technology" whose call created this follow-up /);
    expect(followup().error).toMatch(/No other call flow is used in its place\.$/);
    expect(ext.addCustomerEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "followup_failed", detail: followup().error }));
  });
});

describe("everything else calls again exactly as before", () => {
  it("a follow-up from an ordinary Call Flow's call: the contact's last flow", async () => {
    seed();
    followup().sourceCallLogId = "abc";
    await processAiCallFollowup({ followupId: "fu-1" });
    expect(T("runs")).toEqual([expect.objectContaining({ flowVersionId: "v-abc" })]);
  });

  it("a manual follow-up (no source call): the contact's last flow", async () => {
    seed();
    followup().sourceCallLogId = null;
    await processAiCallFollowup({ followupId: "fu-1" });
    expect(T("runs")).toEqual([expect.objectContaining({ flowVersionId: "v-abc" })]);
  });

  it.each(["hi", "kn"] as const)("%s: the agent rule doesn't apply; the contact's last flow, as before", async (language) => {
    seed(language);
    expect(await agentCallAgainTarget("src", language)).toBeNull();
    T("versions").splice(0, 2); // even with the agent unpublished, nothing fails: as before
    await processAiCallFollowup({ followupId: "fu-1" });
    expect(T("runs")).toEqual([expect.objectContaining({ flowVersionId: "v-abc" })]);
  });
});
