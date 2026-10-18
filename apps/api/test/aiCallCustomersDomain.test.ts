import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// AI Call Customers end to end against an in-memory stand-in for Prisma (no
// MySQL): manual create, bulk import, soft delete, the call webhook setting the
// stage, do-not-call blocking calls, follow-ups created as Pending approval,
// and nothing handed to a sender before an admin approves.

process.env.ENABLE_AI_CALLS = "true";
process.env.VOICE_BACKEND_URL = "http://voice.test";
process.env.VOICE_BACKEND_API_KEY = "k";
process.env.AI_CALL_FOLLOWUP_MAX_RETRIES = "2";

type Row = Record<string, any>;
let seq = 0;
const tables: Record<string, Row[]> = {};
const T = (name: string) => (tables[name] ??= []);

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Row[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return cond.not === null ? v != null : v !== cond.not;
      if ("contains" in cond) return String(v ?? "").toLowerCase().includes(String(cond.contains).toLowerCase());
      if ("gte" in cond) return v != null && v >= cond.gte;
      if ("isNot" in cond) return v != null;
      return true;
    }
    return (v ?? null) === cond;
  });
}

const DEFAULTS: Record<string, Row> = {
  aiCallCustomer: { stage: "NOT_CALLED", gender: "unknown", whatsappOptIn: false, needsReview: false, doNotCall: false, deletedAt: null, lastCallLogId: null },
  aiCallFollowup: { status: "PENDING_APPROVAL", attempt: 1, whatsappTemplateId: null, whatsappBatchId: null, aiCallRunId: null, sourceCallLogId: null, decidedAt: null },
};

function model(name: string) {
  const rows = () => T(name);
  // Copies, like Prisma: a returned row must not change when the table does.
  const withIncludes = (r: Row | undefined, args: Row) =>
    r && args?.include?.customer ? { ...r, customer: { ...T("aiCallCustomer").find((c) => c.id === r.customerId) } } : r && { ...r };
  return {
    create: async ({ data }: Row) => {
      if (name === "aiCallCustomer" && data.activePhone && rows().some((r) => r.activePhone === data.activePhone)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      }
      const row = { id: `${name}-${++seq}`, createdAt: new Date(Date.now() + seq), ...DEFAULTS[name], ...data };
      rows().push(row);
      return { ...row };
    },
    createMany: async ({ data }: Row) => {
      for (const d of data) rows().push({ id: `${name}-${++seq}`, createdAt: new Date(Date.now() + seq), ...d });
      return { count: data.length };
    },
    findUnique: async (args: Row) => withIncludes(rows().find((r) => matches(r, args.where)), args),
    findUniqueOrThrow: async (args: Row) => ({ ...rows().find((r) => matches(r, args.where))! }),
    findFirst: async (args: Row) => {
      const hits = rows().filter((r) => matches(r, args?.where));
      if (args?.orderBy?.createdAt === "desc") hits.sort((a, b) => b.createdAt - a.createdAt);
      return hits[0] ? { ...hits[0] } : null;
    },
    findMany: async (args: Row = {}) => rows().filter((r) => matches(r, args.where)).map((r) => withIncludes(r, args)),
    count: async (args: Row = {}) => rows().filter((r) => matches(r, args.where)).length,
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
  };
}

const db = new Proxy({} as Row, { get: (_t, p: string) => model(p) });
vi.mock("../src/prisma.js", () => ({ prisma: db }));

const createWhatsAppSendBatch = vi.fn(async () => "wa-batch-1");
vi.mock("../src/domain/whatsappSend.js", () => ({ createWhatsAppSendBatch }));
vi.mock("../src/domain/whatsappCredentials.js", () => ({
  getWhatsAppCredentialsView: async () => ({ configured: true }),
}));
const enqueueAiCallFollowup = vi.fn(async () => "job-1");
const enqueueAiCallRun = vi.fn(async () => "job-2");
vi.mock("../src/queue/queues.js", () => ({ enqueueAiCallFollowup, enqueueAiCallRun }));

const customers = await import("../src/domain/aiCallCustomers.js");
const followups = await import("../src/domain/aiCallFollowups.js");
const sync = await import("../src/domain/aiCallCustomerSync.js");
const { loadDoNotCallPhones, planAiCallRun, applyVoiceUpdate } = await import("../src/domain/aiCalls.js");

const ADMIN = "admin@test";
const input = (over: Row = {}) => ({
  customerName: "Asha Raman",
  gender: "female",
  phone: "98765 43210",
  businessName: "Raman Textiles",
  followUpDetail: "Wants the price list",
  email: null,
  whatsappOptIn: false,
  ...over,
});

/** A customer that has been called once: linked call log in a final state. */
async function calledCustomer(over: Row = {}, log: Row = {}) {
  const c = await customers.createCustomer(input(over) as any, ADMIN);
  const l = await db.aiCallLog.create({ data: { runId: "run-1", position: 0, phone: c.phone, status: "IN_PROGRESS", outcome: null, startedAt: new Date(), ...log } });
  await sync.linkCustomersToRun("run-1", [{ logId: l.id, customerId: c.id }], ADMIN);
  await sync.markCustomerCalling(l.id);
  return { c, log: l };
}
const cust = (id: string) => T("aiCallCustomer").find((r) => r.id === id)!;
const pending = (customerId: string) =>
  T("aiCallFollowup").filter((f) => f.customerId === customerId && f.status === "PENDING_APPROVAL");

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  vi.clearAllMocks();
});

describe("manual create", () => {
  it("stores the number as E.164 and logs a timeline event", async () => {
    const c = await customers.createCustomer(input() as any, ADMIN);
    expect(c).toMatchObject({ phone: "+919876543210", activePhone: "+919876543210", gender: "female", stage: "NOT_CALLED" });
    expect(T("aiCallCustomerEvent").map((e) => e.type)).toEqual(["created"]);
  });

  it("rejects an invalid phone and a duplicate number (in any format)", async () => {
    await expect(customers.createCustomer(input({ phone: "12345" }) as any, ADMIN)).rejects.toMatchObject({ status: 400 });
    await customers.createCustomer(input() as any, ADMIN);
    await expect(customers.createCustomer(input({ phone: "+91 98765 43210" }) as any, ADMIN)).rejects.toMatchObject({ status: 409 });
  });

  it("a number already on the do-not-call list is saved as Do not call", async () => {
    T("contact").push({ phone: "9876543210", status: "UNSUBSCRIBED" });
    const c = await customers.createCustomer(input() as any, ADMIN);
    expect(c).toMatchObject({ stage: "DO_NOT_CALL", doNotCall: true });
  });
});

describe("bulk import", () => {
  it("imports only valid rows and reports skipped / duplicates", async () => {
    await customers.createCustomer(input({ phone: "9000000001" }) as any, ADMIN);
    const res = await customers.importCustomers(
      [
        { customerName: "A", gender: "m", phone: "9876543210", whatsappOptIn: "yes" },
        { customerName: "B", gender: "female", phone: "+91 98765 43210" }, // duplicate in file
        { customerName: "C", gender: "x?", phone: "9123456789" }, // unknown gender
        { customerName: "D", phone: "" }, // missing phone
        { customerName: "E", phone: "12" }, // invalid phone
        { customerName: "F", phone: "09000000001" }, // already saved
        { customerName: "G", phone: "8123456789", email: "g@example.com" },
      ],
      ADMIN,
    );
    expect(res).toMatchObject({ imported: 2, skipped: 3, duplicates: 2 });
    expect(res.problems.map((p) => p.row).sort()).toEqual([2, 3, 4, 5, 6]);
    const a = T("aiCallCustomer").find((c) => c.customerName === "A")!;
    expect(a).toMatchObject({ phone: "+919876543210", gender: "male", whatsappOptIn: true });
  });
});

describe("soft delete", () => {
  it("hides the customer, frees the number, keeps the row and cancels pending follow-ups", async () => {
    const c = await customers.createCustomer(input() as any, ADMIN);
    await followups.createManualFollowup(c.id, { channel: "CALL" }, ADMIN);
    expect(await customers.softDeleteCustomers([c.id], ADMIN)).toBe(1);
    expect(cust(c.id)).toMatchObject({ activePhone: null, phone: "+919876543210" });
    expect(cust(c.id).deletedAt).toBeInstanceOf(Date);
    expect(pending(c.id)).toHaveLength(0);
    expect((await customers.listCustomers({ page: 1, pageSize: 25 })).items).toHaveLength(0);
    // The same number can be added again.
    await expect(customers.createCustomer(input() as any, ADMIN)).resolves.toBeTruthy();
    // Deleting twice is a no-op.
    expect(await customers.softDeleteCustomers([c.id], ADMIN)).toBe(0);
  });
});

describe("call result → stage (webhook / poll)", () => {
  it("Queued → Calling → suggested stage, with a follow-up draft pending approval", async () => {
    const { c, log } = await calledCustomer();
    expect(cust(c.id).stage).toBe("CALLING");
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "interested", summary: "Wants a demo" });
    expect(cust(c.id)).toMatchObject({ stage: "INTERESTED", needsReview: true });
    const drafts = pending(c.id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ channel: "CALL", status: "PENDING_APPROVAL", sourceCallLogId: log.id });
    // Nothing was handed to any sender.
    expect(createWhatsAppSendBatch).not.toHaveBeenCalled();
    expect(enqueueAiCallFollowup).not.toHaveBeenCalled();
    expect(enqueueAiCallRun).not.toHaveBeenCalled();
  });

  it("a later, refined outcome for the same call replaces the drafts; repeats are no-ops", async () => {
    const { c, log } = await calledCustomer();
    await applyVoiceUpdate(log.id, { status: "completed" }); // outcome not classified yet
    expect(cust(c.id).stage).toBe("FOLLOW_UP_NEEDED");
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "not_interested" });
    expect(cust(c.id).stage).toBe("NOT_INTERESTED");
    expect(pending(c.id)).toHaveLength(0);
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "not_interested" });
    expect(T("aiCallCustomerEvent").filter((e) => e.type === "call_result")).toHaveLength(2);
  });

  it("an admin's review is not overwritten by a late callback", async () => {
    const { c, log } = await calledCustomer();
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "interested" });
    await customers.setCustomerStage(c.id, "REJECTED", ADMIN);
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "callback_requested" });
    expect(cust(c.id).stage).toBe("REJECTED");
  });

  it("WhatsApp draft when the customer opted in", async () => {
    const { c, log } = await calledCustomer({ whatsappOptIn: true });
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "interested" });
    expect(pending(c.id).map((f) => f.channel)).toEqual(["WHATSAPP"]);
  });

  it("No answer: limited call-again retries; Failed / Not interested: none", async () => {
    const { c, log } = await calledCustomer();
    await applyVoiceUpdate(log.id, { status: "no_answer" });
    expect(cust(c.id)).toMatchObject({ stage: "NO_ANSWER", needsReview: false });
    expect(pending(c.id)).toHaveLength(1);
    // Two retries used → no third draft.
    T("aiCallFollowup").push({ id: "f-old", customerId: c.id, channel: "CALL", reason: "No answer", status: "APPROVED", createdAt: new Date() });
    for (const f of pending(c.id)) f.status = "REJECTED";
    const l2 = await db.aiCallLog.create({ data: { runId: "run-2", position: 0, phone: c.phone, status: "IN_PROGRESS", startedAt: new Date() } });
    await sync.linkCustomersToRun("run-2", [{ logId: l2.id, customerId: c.id }], ADMIN);
    await applyVoiceUpdate(l2.id, { status: "busy" });
    expect(pending(c.id)).toHaveLength(0);

    const failed = await calledCustomer({ phone: "9123456780" });
    await applyVoiceUpdate(failed.log.id, { status: "failed" });
    expect(cust(failed.c.id).stage).toBe("FAILED");
    expect(pending(failed.c.id)).toHaveLength(0);
  });

  it("calls started from an uploaded file (no saved customer) are untouched", async () => {
    const l = await db.aiCallLog.create({ data: { runId: "run-x", position: 0, phone: "+919000000000", status: "IN_PROGRESS" } });
    await applyVoiceUpdate(l.id, { status: "completed", outcome: "interested" });
    expect(T("aiCallCustomerEvent")).toHaveLength(0);
  });
});

describe("confirmed Interested: no automatic follow-ups", () => {
  it("a suggested Interested (from the call) keeps its pending follow-up", async () => {
    const { c, log } = await calledCustomer();
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "interested" });
    expect(cust(c.id)).toMatchObject({ stage: "INTERESTED", needsReview: true });
    expect(pending(c.id)).toHaveLength(1);
  });

  it("confirming Interested cancels only the pending drafts (kept, reason 'interested'); the customer stays listed", async () => {
    const { c, log } = await calledCustomer();
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "interested" });
    const [draft] = pending(c.id);
    T("aiCallFollowup").push({ id: "f-approved", customerId: c.id, channel: "CALL", status: "APPROVED", createdAt: new Date() });
    const before = { ...cust(c.id) };

    await customers.setCustomerStage(c.id, "INTERESTED", ADMIN);

    expect(pending(c.id)).toHaveLength(0);
    expect(T("aiCallFollowup").find((f) => f.id === draft!.id)).toMatchObject({ status: "CANCELLED", error: "positive_review" });
    expect(T("aiCallFollowup").find((f) => f.id === "f-approved")!.status).toBe("APPROVED"); // already handed over: untouched
    expect(T("aiCallFollowup")).toHaveLength(2); // nothing deleted
    expect(cust(c.id)).toMatchObject({ ...before, stage: "INTERESTED", needsReview: false });
    const listed = (await customers.listCustomers({ page: 1, pageSize: 25 })).items.map((x: Row) => x.id);
    expect(listed).toContain(c.id);
    expect((await customers.callableCustomers()).map((x: Row) => x.id)).toContain(c.id); // still selectable for "Call selected"
  });

  it("no new automatic follow-ups while confirmed Interested", async () => {
    const { c } = await calledCustomer();
    await customers.setCustomerStage(c.id, "INTERESTED", ADMIN);
    expect(await followups.createFollowupDrafts(cust(c.id) as any, "INTERESTED")).toEqual([]);
    expect(pending(c.id)).toHaveLength(0);
  });

  it("back to Follow-up needed: queued again normally; old cancelled drafts are not revived", async () => {
    const { c, log } = await calledCustomer();
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "interested" });
    await customers.setCustomerStage(c.id, "INTERESTED", ADMIN);
    const cancelled = T("aiCallFollowup").filter((f) => f.status === "CANCELLED").map((f) => f.id);

    await customers.setCustomerStage(c.id, "FOLLOW_UP_NEEDED", ADMIN);

    const now = pending(c.id);
    expect(now).toHaveLength(1);
    expect(cancelled).not.toContain(now[0]!.id);
    expect(T("aiCallFollowup").filter((f) => cancelled.includes(f.id)).every((f) => f.status === "CANCELLED")).toBe(true);
  });
});

describe("confirmed Approved: same as confirmed Interested", () => {
  it("Approve on a suggested Interested (e.g. Suganya) cancels its pending draft; the customer stays listed, unchanged otherwise", async () => {
    const { c, log } = await calledCustomer();
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "interested" });
    const [draft] = pending(c.id);
    const before = { ...cust(c.id) };

    await customers.setCustomerStage(c.id, "APPROVED", ADMIN);

    expect(pending(c.id)).toHaveLength(0);
    expect(T("aiCallFollowup").find((f) => f.id === draft!.id)).toMatchObject({ status: "CANCELLED", error: "positive_review" });
    expect(cust(c.id)).toMatchObject({ ...before, stage: "APPROVED", needsReview: false });
    expect((await customers.listCustomers({ page: 1, pageSize: 25 })).items.map((x: Row) => x.id)).toContain(c.id);
    expect((await customers.callableCustomers()).map((x: Row) => x.id)).toContain(c.id);
    expect(await followups.createFollowupDrafts(cust(c.id) as any, "APPROVED")).toEqual([]);
  });

  it("Approved back to Follow-up needed: queued again normally; cancelled drafts stay cancelled", async () => {
    const { c, log } = await calledCustomer();
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "interested" });
    await customers.setCustomerStage(c.id, "APPROVED", ADMIN);
    const cancelled = T("aiCallFollowup").filter((f) => f.status === "CANCELLED").map((f) => f.id);

    await customers.setCustomerStage(c.id, "FOLLOW_UP_NEEDED", ADMIN);

    expect(pending(c.id)).toHaveLength(1);
    expect(cancelled).not.toContain(pending(c.id)[0]!.id);
  });

  it("other stages keep their behaviour: Callback requested still creates a call-again draft", async () => {
    const { c } = await calledCustomer();
    await customers.setCustomerStage(c.id, "CALLBACK_REQUESTED", ADMIN);
    expect(pending(c.id).map((f) => f.channel)).toEqual(["CALL"]);
  });
});

describe("do not call", () => {
  it("is applied immediately from the call, permanently, and blocks future calls", async () => {
    const { c, log } = await calledCustomer();
    await followups.createManualFollowup(c.id, { channel: "CALL" }, ADMIN);
    await applyVoiceUpdate(log.id, { status: "completed", outcome: "do_not_call" });
    expect(cust(c.id)).toMatchObject({ stage: "DO_NOT_CALL", doNotCall: true, needsReview: false });
    expect(pending(c.id)).toHaveLength(0);
    await expect(customers.setCustomerStage(c.id, "INTERESTED", ADMIN)).rejects.toMatchObject({ status: 409 });
    await expect(customers.updateCustomer(c.id, input({ phone: "9111111111" }) as any, ADMIN)).rejects.toMatchObject({ status: 409 });

    // Still blocked after a soft delete, and the planner skips the number.
    await customers.softDeleteCustomers([c.id], ADMIN);
    const dnc = await loadDoNotCallPhones("91");
    expect(dnc.has("+919876543210")).toBe(true);
    const plan = planAiCallRun({ rows: [{ phone: "9876543210" }], mode: "all", randomCount: 1, selectedIndexes: [], maxCalls: 5 }, { doNotCall: dnc, hardCap: 10 });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped.doNotCall).toBe(1);
  });

  it("an admin can mark Do not call; it can't be undone", async () => {
    const c = await customers.createCustomer(input() as any, ADMIN);
    await customers.setCustomerStage(c.id, "DO_NOT_CALL", ADMIN);
    expect(cust(c.id).doNotCall).toBe(true);
    await expect(customers.setCustomerStage(c.id, "NOT_CALLED", ADMIN)).rejects.toMatchObject({ status: 409 });
  });
});

describe("follow-up approval (Send Queue)", () => {
  it("nothing is sent until approved; reject sends nothing", async () => {
    const c = await customers.createCustomer(input({ whatsappOptIn: true }) as any, ADMIN);
    const f = await followups.createManualFollowup(c.id, { channel: "WHATSAPP" }, ADMIN);
    expect(f.status).toBe("PENDING_APPROVAL");
    await followups.rejectFollowup(f.id, ADMIN);
    expect(T("aiCallFollowup")[0].status).toBe("REJECTED");
    expect(createWhatsAppSendBatch).not.toHaveBeenCalled();
    await expect(followups.approveFollowup(f.id, ADMIN)).rejects.toMatchObject({ status: 409 });
  });

  it("WhatsApp: needs a template, then hands over to the existing batch sender once", async () => {
    T("whatsAppTemplate").push({ id: "tpl-1", providerTemplateName: "kagzso_follow_up" });
    const c = await customers.createCustomer(input({ whatsappOptIn: true }) as any, ADMIN);
    const f = await followups.createManualFollowup(c.id, { channel: "WHATSAPP" }, ADMIN);
    await expect(followups.approveFollowup(f.id, ADMIN)).rejects.toMatchObject({ status: 400 });
    expect(createWhatsAppSendBatch).not.toHaveBeenCalled();

    await followups.editFollowup(f.id, { whatsappTemplateId: "tpl-1" }, ADMIN);
    const done = await followups.approveFollowup(f.id, ADMIN);
    expect(done).toMatchObject({ status: "APPROVED", whatsappBatchId: "wa-batch-1", decidedByEmail: ADMIN });
    expect(createWhatsAppSendBatch).toHaveBeenCalledTimes(1);
    expect(createWhatsAppSendBatch).toHaveBeenCalledWith({
      templateId: "tpl-1",
      recipients: [{ phone: "+919876543210", firstName: "Asha", lastName: "Raman", businessName: "Raman Textiles" }],
    });
    await expect(followups.approveFollowup(f.id, ADMIN)).rejects.toMatchObject({ status: 409 });
    expect(createWhatsAppSendBatch).toHaveBeenCalledTimes(1);
  });

  it("WhatsApp follow-ups need opt-in", async () => {
    const c = await customers.createCustomer(input({ whatsappOptIn: false }) as any, ADMIN);
    await expect(followups.createManualFollowup(c.id, { channel: "WHATSAPP" }, ADMIN)).rejects.toMatchObject({ status: 400 });
  });

  it("Call again: approval schedules it at the chosen time (no call before that)", async () => {
    const c = await customers.createCustomer(input() as any, ADMIN);
    const when = new Date(Date.now() + 2 * 3600_000);
    const f = await followups.createManualFollowup(c.id, { channel: "CALL", scheduledAt: when }, ADMIN);
    expect(enqueueAiCallFollowup).not.toHaveBeenCalled();
    await followups.approveFollowup(f.id, ADMIN);
    expect(enqueueAiCallFollowup).toHaveBeenCalledWith({ followupId: f.id }, when);
    expect(enqueueAiCallRun).not.toHaveBeenCalled();
  });

  it("can't approve for a do-not-call or deleted customer", async () => {
    const c = await customers.createCustomer(input() as any, ADMIN);
    const f = await followups.createManualFollowup(c.id, { channel: "CALL" }, ADMIN);
    cust(c.id).doNotCall = true;
    await expect(followups.approveFollowup(f.id, ADMIN)).rejects.toMatchObject({ status: 409 });
    expect(enqueueAiCallFollowup).not.toHaveBeenCalled();
  });
});
