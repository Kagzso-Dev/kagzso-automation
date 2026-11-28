import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hardStopStatusText } from "@dispatch/shared";
import { hs } from "./fakePrismaHardStop.js";

// Hard stop (ENABLE_HARD_STOP). The rule: everything except work already in progress is stopped. A call dialing /
// ringing / connected, a WhatsApp message being sent and an email being sent finish normally (results, outcome and
// follow-up drafts saved); everything not started becomes CANCELLED with "Hard stop by <user> at <time>". The real
// worker code runs against an in-memory database (fakePrismaHardStop.ts) whose conditional writes behave like MySQL's;
// only the outside world is mocked (the email provider, Meta, the voice backend).

vi.mock("../src/prisma.js", async () => ({ prisma: (await import("./fakePrismaHardStop.js")).hs.db }));

const ext = vi.hoisted(() => ({
  deliverEmail: vi.fn(),
  sendTemplateMessage: vi.fn(),
  getVoiceCall: vi.fn(),
  placeVoiceCall: vi.fn(),
  applyVoiceUpdate: vi.fn(),
  syncCustomerFromLog: vi.fn(),
  markCustomerCalling: vi.fn(),
  linkCustomersToRun: vi.fn(),
  addCustomerEvent: vi.fn(),
}));

vi.mock("../src/domain/delivery.js", () => ({ deliverEmail: ext.deliverEmail }));
vi.mock("../src/queue/dailyCap.js", () => ({ dailyCapReached: async () => false, msUntilNextWindow: () => 60_000 }));
vi.mock("../src/services/whatsapp.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/whatsapp.js")>()),
  sendTemplateMessage: ext.sendTemplateMessage,
}));
vi.mock("../src/domain/whatsappTemplateHeader.js", () => ({ headerComponentForTemplate: async () => null }));
vi.mock("../src/domain/whatsappCooldown.js", () => ({ marketingCooldownUntil: async () => null }));
vi.mock("../src/services/voiceBackend.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/voiceBackend.js")>()),
  getVoiceCall: ext.getVoiceCall,
  placeVoiceCall: ext.placeVoiceCall,
}));
vi.mock("../src/domain/aiCalls.js", async (orig) => ({
  ...(await orig<typeof import("../src/domain/aiCalls.js")>()),
  applyVoiceUpdate: ext.applyVoiceUpdate,
  loadDoNotCallPhones: async () => new Set<string>(),
  callsCountedTowardDailyCap: async () => 0,
}));
vi.mock("../src/domain/callFlows.js", () => ({
  pinnedFlowForRun: async () => null,
  flowVersionForCallAgain: async () => null,
  agentVersionForCallAgain: async () => null,
  agentCallAgainTarget: async () => null,
}));
vi.mock("../src/domain/aiCallVoiceTuning.js", () => ({ voiceTuningForCall: async () => null }));
vi.mock("../src/domain/aiAgentQuestions.js", () => ({ knownQuestionsForFlow: async () => null }));
vi.mock("../src/domain/aiCallCustomerSync.js", () => ({
  syncCustomerFromLog: ext.syncCustomerFromLog,
  markCustomerCalling: ext.markCustomerCalling,
  businessForCall: async () => null,
  linkCustomersToRun: ext.linkCustomersToRun,
}));
vi.mock("../src/domain/aiCallFollowups.js", () => ({ addCustomerEvent: ext.addCustomerEvent }));
vi.mock("../src/domain/aiCallLanguages.js", async (orig) => ({
  ...(await orig<typeof import("../src/domain/aiCallLanguages.js")>()),
  languageOfRun: async () => "en",
  disabledAiCallLanguages: async () => new Set(),
  aiCallLanguageBlockedReason: async () => null,
  runInProgressReason: async () => null,
}));
vi.mock("../src/config/aiCalls.js", async (orig) => {
  const real = await orig<typeof import("../src/config/aiCalls.js")>();
  return { ...real, aiCallsConfig: { ...real.aiCallsConfig, enabled: true, dailyCap: 1000, minGapSec: 0, callTimeoutSec: 900, defaultCountryCode: "91" } };
});

const { processManualBulkSend } = await import("../src/queue/manualBulkSend.js");
const { processWhatsAppBulkSend, purgeConfirmedRecipient } = await import("../src/queue/whatsappBulkSend.js");
const { processAiCallRun } = await import("../src/queue/aiCallRun.js");
const { processAiCallFollowup } = await import("../src/queue/aiCallFollowup.js");
const { fanOutCampaign } = await import("../src/queue/dispatch.js");
const { DeferJobError } = await import("../src/queue/engine.js");
const { finalizeHardStop } = await import("../src/queue/hardStopFinalizer.js");
const hardStop = await import("../src/domain/hardStop.js");
const { pressHardStop, getHardStopView, stopCoveringEmailJob, cancelEmailJobAtCheckPoint, hardStopCsv, HardStopError } = hardStop;

const originalFlag = process.env.ENABLE_HARD_STOP;
const flag = (on: boolean) => {
  process.env.ENABLE_HARD_STOP = on ? "true" : "false";
};
afterAll(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_HARD_STOP;
  else process.env.ENABLE_HARD_STOP = originalFlag;
});

const ADMIN = { id: "u-admin", email: "admin@test" };
const REASON = /^Hard stop by admin@test at \d{4}-\d\d-\d\d \d\d:\d\d UTC$/;

beforeEach(() => {
  hs.reset();
  vi.clearAllMocks();
  flag(true);
  ext.deliverEmail.mockImplementation(async (job: { contactId: string }) => ({ result: "sent", emailLogId: `log-${job.contactId}`, providerMessageId: "pm" }));
  ext.sendTemplateMessage.mockImplementation(async () => ({ providerMessageId: `wamid.${Math.random()}` }));
  ext.placeVoiceCall.mockImplementation(async (args: { logId: string }) => ({ callId: `v-${args.logId}`, providerCallId: null }));
});

/** Run a drip / run job the way the queue does: again after each DeferJobError, until it returns. */
async function drain(fn: () => Promise<unknown>, max = 20): Promise<unknown> {
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DeferJobError) continue;
      throw err;
    }
  }
  return "still deferring";
}

const status = (model: string) => Object.fromEntries(hs.T(model).map((r) => [r.id, r.status]));

/* ------------------------------------------------------------------ seeds */

function emailBatch(n = 3, extra: Record<string, unknown> = {}) {
  hs.seed("template", { id: "t1", name: "Welcome" });
  const b = hs.seed("manualSendBatch", { status: "RUNNING", templateId: "t1", minDelaySec: 0, maxDelaySec: 0, purgeAfter: false, total: n, ...extra });
  for (let i = 1; i <= n; i++) {
    hs.seed("contact", { id: `c${i}`, email: `c${i}@x.test`, firstName: `First${i}`, lastName: `Last${i}`, phone: null, businessName: `Biz ${i}` });
    hs.seed("manualSendBatchItem", { id: `i${i}`, batchId: b.id, contactId: `c${i}`, email: `c${i}@x.test`, name: `First${i} Last${i}`, status: "PENDING" });
  }
  return b;
}

function waBatch(n = 3, extra: Record<string, unknown> = {}) {
  hs.seed("whatsAppTemplate", { id: "wt1", name: "Offer", providerTemplateName: "offer_v1", languageCode: "en" });
  const b = hs.seed("whatsAppSendBatch", { status: "RUNNING", templateId: "wt1", minDelaySec: 0, maxDelaySec: 0, purgeAfter: false, purgeTable: null, purgeIds: null, total: n, ...extra });
  for (let i = 1; i <= n; i++) {
    hs.seed("whatsAppContact", { id: `wc${i}`, phone: `9198765000${i}`, firstName: `Wa${i}`, lastName: null });
    hs.seed("whatsAppSend", { id: `w${i}`, batchId: b.id, whatsappContactId: `wc${i}`, phone: `9198765000${i}`, name: `Wa${i}`, businessName: null, body: "hi", contentVariables: {}, status: "QUEUED" });
  }
  return b;
}

function callRun(queued = 3, extra: Record<string, unknown> = {}) {
  const r = hs.seed("aiCallRun", { id: "run1", mode: "SELECTED", status: "RUNNING", gapSeconds: 0, maxCalls: queued, total: queued, skipped: null, ...extra });
  for (let i = 1; i <= queued; i++) {
    hs.seed("aiCallLog", { id: `l${i}`, runId: r.id, position: i, customerName: `Cust ${i}`, gender: "female", followUpDetail: `detail ${i}`, phone: `+9190000000${i}`, status: "QUEUED" });
  }
  return r;
}

/* ------------------------------------------------------------------ in progress finishes, the rest is cancelled */

describe("Email (Send Queue → Email)", () => {
  it("the email being sent at the stop is sent and counted; nothing after it is sent; the rest is CANCELLED with the reason", async () => {
    const b = emailBatch(3);
    ext.deliverEmail.mockImplementationOnce(async (job: { contactId: string }) => {
      await pressHardStop("EMAIL_BATCH", b.id, ADMIN); // pressed while this email is with the provider
      return { result: "sent", emailLogId: `log-${job.contactId}`, providerMessageId: "pm" };
    });

    expect(await drain(() => processManualBulkSend({ batchId: b.id }))).toEqual({ stopped: "CANCELLED" });
    expect(await drain(() => processManualBulkSend({ batchId: b.id }))).toEqual({ skipped: "batch CANCELLED" });

    expect(ext.deliverEmail).toHaveBeenCalledTimes(1);
    expect(status("manualSendBatchItem")).toEqual({ i1: "SENT", i2: "CANCELLED", i3: "CANCELLED" });
    for (const id of ["i2", "i3"]) expect(hs.T("manualSendBatchItem").find((i) => i.id === id)!.error).toMatch(REASON);
    expect(hs.T("manualSendBatchItem").find((i) => i.id === "i1")!.error).toBeNull(); // in progress: never relabeled

    const stop = hs.T("hardStop")[0]!;
    expect(stop).toMatchObject({ scope: "EMAIL_BATCH", targetId: b.id, byEmail: "admin@test", inProgressAtStop: 1, cancelledItems: 2 });
    expect(await finalizeHardStop(stop.id)).toBe(true);
    const view = (await getHardStopView(stop.id))!;
    expect(view).toMatchObject({ status: "STOPPED", inProgress: 0, completed: 1, cancelled: 2, followupsCancelled: 0 });
    expect(hardStopStatusText(view)).toBe("Stopped: 1 completed (including those in progress), 2 cancelled, and 0 follow-ups/retries cancelled");
  });

  it("status shows 'Stopping... (1 in progress)' until the email in progress ends", async () => {
    const b = emailBatch(2);
    hs.T("manualSendBatchItem")[0]!.status = "SENDING"; // being sent right now
    const { stopId } = await pressHardStop("EMAIL_BATCH", b.id, ADMIN);
    expect(await finalizeHardStop(stopId)).toBe(false);
    expect(hardStopStatusText((await getHardStopView(stopId))!)).toBe("Stopping... (1 in progress)");
    hs.T("manualSendBatchItem")[0]!.status = "SENT"; // the send finished normally
    expect(await finalizeHardStop(stopId)).toBe(true);
    expect((await getHardStopView(stopId))!.status).toBe("STOPPED");
  });

  it("a lead-gen batch still deletes the contacts it emailed (SENT) after the stop; cancelled contacts are never deleted", async () => {
    const b = emailBatch(3, { purgeAfter: true });
    ext.deliverEmail.mockImplementationOnce(async (job: { contactId: string }) => {
      await pressHardStop("EMAIL_BATCH", b.id, ADMIN);
      return { result: "sent", emailLogId: `log-${job.contactId}`, providerMessageId: "pm" };
    });
    await drain(() => processManualBulkSend({ batchId: b.id }));
    await finalizeHardStop(hs.T("hardStop")[0]!.id);
    expect(hs.T("contact").map((c) => c.id)).toEqual(["c2", "c3"]);
  });
});

describe("WhatsApp (Send Queue → WhatsApp)", () => {
  it("the message handed to Meta at the stop counts as sent; nothing after it is sent; the rest is CANCELLED", async () => {
    const b = waBatch(3);
    ext.sendTemplateMessage.mockImplementationOnce(async () => {
      await pressHardStop("WHATSAPP_BATCH", b.id, ADMIN); // pressed while Meta has the message
      return { providerMessageId: "wamid.1" };
    });
    expect(await drain(() => processWhatsAppBulkSend({ batchId: b.id }))).toEqual({ stopped: "CANCELLED" });
    expect(await drain(() => processWhatsAppBulkSend({ batchId: b.id }))).toEqual({ skipped: "batch CANCELLED" });
    expect(ext.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(status("whatsAppSend")).toEqual({ w1: "SENT", w2: "CANCELLED", w3: "CANCELLED" });
    expect(hs.T("whatsAppSend").find((s) => s.id === "w1")!.providerMessageId).toBe("wamid.1");
    const stopId = hs.T("hardStop")[0]!.id;
    expect(await finalizeHardStop(stopId)).toBe(true);
    expect(await getHardStopView(stopId)).toMatchObject({ completed: 1, cancelled: 2, csvRows: { whatsapp: 2, email: 0, calls: 0 } });
  });

  it("lead-gen: only recipients Meta confirmed (DELIVERED / READ) are deleted, also when the confirmation comes after the stop", async () => {
    const b = waBatch(3, { purgeAfter: true, purgeTable: "whatsapp", purgeIds: ["wc1", "wc2", "wc3"] });
    ext.sendTemplateMessage.mockImplementationOnce(async () => {
      await pressHardStop("WHATSAPP_BATCH", b.id, ADMIN);
      return { providerMessageId: "wamid.1" };
    });
    await drain(() => processWhatsAppBulkSend({ batchId: b.id }));
    await finalizeHardStop(hs.T("hardStop")[0]!.id);
    expect(hs.T("whatsAppContact").map((c) => c.id)).toEqual(["wc1", "wc2", "wc3"]); // w1 only SENT: kept
    hs.T("whatsAppSend").find((s) => s.id === "w1")!.status = "DELIVERED"; // Meta's webhook, later
    await purgeConfirmedRecipient("w1");
    expect(hs.T("whatsAppContact").map((c) => c.id)).toEqual(["wc2", "wc3"]); // cancelled ones are never deleted
  });
});

describe("AI calls (English and Tamil use the same run worker)", () => {
  it("a connected call at the stop runs to its natural end: log, outcome and follow-up draft saved; no new call starts; no hang-up", async () => {
    const r = callRun(2);
    const live = hs.seed("aiCallLog", { id: "l0", runId: r.id, position: 0, customerName: "Live", gender: "male", phone: "+919000000000", status: "IN_PROGRESS", voiceCallId: "v-l0", startedAt: new Date() });
    hs.seed("aiCallCustomer", { id: "cust1", customerName: "Live", gender: "male", phone: "+919000000000", businessName: null, followUpDetail: null, language: "en" });
    // An approved call-again follow-up from an earlier call, waiting for its time, with its delayed job.
    const waiting = hs.seed("aiCallFollowup", { channel: "CALL", status: "APPROVED", customerId: "cust1", sourceCallLogId: "l0", aiCallRunId: null, scheduledAt: new Date(Date.now() + 3600_000), attempt: 1 });
    hs.seed("job", { queue: "ai-call-followup", payload: { followupId: waiting.id }, dedupeKey: `ai-call-followup:${waiting.id}`, runAt: new Date(Date.now() + 3600_000) });

    const { stopId } = await pressHardStop("AI_CALL_RUN", r.id, ADMIN);
    expect(status("aiCallLog")).toEqual({ l1: "CANCELLED", l2: "CANCELLED", l0: "IN_PROGRESS" });
    expect(hs.T("aiCallFollowup")[0]).toMatchObject({ status: "CANCELLED", error: expect.stringMatching(REASON) });
    expect(hs.T("job")).toEqual([]); // its timer is cleared
    expect(await getHardStopView(stopId)).toMatchObject({ status: "STOPPING", inProgress: 1, cancelled: 2, followupsCancelled: 1 });

    // The voice backend still reports the call connected: the run keeps polling it, dials no one.
    ext.getVoiceCall.mockResolvedValue({ status: "in_progress" });
    expect(await processAiCallRun({ runId: r.id }).catch((e) => e)).toBeInstanceOf(DeferJobError);
    // It ends normally: outcome saved, the customer's follow-up draft created (waiting for approval).
    ext.getVoiceCall.mockResolvedValue({ status: "completed", outcome: "callback_requested" });
    ext.applyVoiceUpdate.mockImplementation(async (logId: string, u: { status: string; outcome: string }) => {
      const log = hs.T("aiCallLog").find((l) => l.id === logId)!;
      if (u.status === "completed") Object.assign(log, { status: "COMPLETED", outcome: u.outcome, endedAt: new Date() });
      hs.seed("aiCallFollowup", { channel: "CALL", status: "PENDING_APPROVAL", customerId: "cust1", sourceCallLogId: logId, aiCallRunId: null });
    });
    expect(await drain(() => processAiCallRun({ runId: r.id }))).toEqual({ stopped: "CANCELLED" });

    expect(ext.placeVoiceCall).not.toHaveBeenCalled();
    expect(live.id).toBe("l0");
    expect(hs.T("aiCallLog").find((l) => l.id === "l0")).toMatchObject({ status: "COMPLETED", outcome: "callback_requested", error: null });
    expect(hs.T("aiCallFollowup").find((f) => f.status === "PENDING_APPROVAL")).toBeTruthy(); // the draft is kept
    expect(hs.T("aiCallRun")[0]!.status).toBe("CANCELLED");
    expect(await finalizeHardStop(stopId)).toBe(true);
    expect(await getHardStopView(stopId)).toMatchObject({ status: "STOPPED", completed: 1, cancelled: 2, followupsCancelled: 1 });
    // The drafts waiting for approval are still there after the stop finished.
    expect(hs.T("aiCallFollowup").filter((f) => f.status === "PENDING_APPROVAL")).toHaveLength(1);
  });

  it("the cancelled follow-up never fires: its job, run late, creates no call run", async () => {
    hs.seed("aiCallCustomer", { id: "cust1", customerName: "A", gender: "male", phone: "+919000000001", language: "en", doNotCall: false, deletedAt: null });
    const f = hs.seed("aiCallFollowup", { channel: "CALL", status: "APPROVED", customerId: "cust1", aiCallRunId: null, attempt: 1, decidedByEmail: "admin@test" });
    await pressHardStop("ALL", null, ADMIN);
    expect(await processAiCallFollowup({ followupId: f.id })).toEqual({ skipped: true });
    expect(hs.T("aiCallRun")).toEqual([]);
  });

  it("no hang-up or end-call request exists in any hard-stop code path", () => {
    const files = ["../src/domain/hardStop.ts", "../src/http/routes/hardStop.ts", "../src/queue/hardStopFinalizer.ts"];
    for (const f of files) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(src).not.toMatch(/services\/voiceBackend/); // never talks to a voice backend
      expect(src).not.toMatch(/hang_?up\(|endCall\(|end_call|\/hangup/i);
    }
  });
});

/* ------------------------------------------------------------------ retries, fan-out, campaigns, triggers */

describe("email retries, campaign fan-out and Stop all", () => {
  function campaign(id: string, status: string) {
    return hs.seed("campaign", { id, name: `Campaign ${id}`, status, scheduleType: "ONCE", listId: `list-${id}`, templateId: "t1", lastRunAt: new Date(Date.now() - 600_000) });
  }
  const sendJob = (campaignId: string, contactId: string, extra: Record<string, unknown> = {}) =>
    hs.seed("job", {
      queue: "send-email",
      payload: { idempotencyKey: `campaign:${campaignId}:${contactId}:2026-11-18`, contactId, source: { type: "campaign", campaignId, runDate: "2026-11-18" } },
      dedupeKey: `campaign_${campaignId}_${contactId}_2026-11-18`,
      maxAttempts: 3,
      ...extra,
    });

  it("a campaign stop cancels its queued emails and queued retries (a failed earlier attempt's ledger is closed); in-progress emails are left", async () => {
    campaign("k1", "SENDING");
    hs.seed("contact", { id: "c1", email: "c1@x.test" });
    hs.seed("contact", { id: "c2", email: "c2@x.test" });
    hs.seed("contact", { id: "c3", email: "c3@x.test" });
    sendJob("k1", "c1"); //                               queued
    sendJob("k1", "c2", { attempts: 1 }); //               queued retry
    const active = sendJob("k1", "c3", { status: "ACTIVE", attempts: 1 }); // being sent
    hs.seed("emailLog", { idempotencyKey: "campaign:k1:c2:2026-11-18", status: "QUEUED", contactId: "c2" });

    const { stopId } = await pressHardStop("CAMPAIGN", "k1", ADMIN);
    expect(hs.T("campaign")[0]!.status).toBe("PAUSED");
    expect(hs.T("job").map((j) => j.id)).toEqual([active.id]);
    expect(hs.T("emailLog")[0]).toMatchObject({ status: "FAILED", errorMessage: expect.stringMatching(/^Retry cancelled — Hard stop by/) });
    expect(await getHardStopView(stopId)).toMatchObject({ inProgress: 1, cancelled: 1, followupsCancelled: 1 });
  });

  it("a retry an in-progress email schedules after the stop never fires: the check point cancels it, and so does the final sweep", async () => {
    campaign("k1", "SENDING");
    hs.seed("contact", { id: "c1", email: "c1@x.test" });
    const job = sendJob("k1", "c1", { status: "ACTIVE", attempts: 1 });
    const { stopId } = await pressHardStop("CAMPAIGN", "k1", ADMIN);
    // The attempt in progress fails after the stop; the queue schedules a retry.
    Object.assign(job, { status: "PENDING", attempts: 1 });
    Object.assign(hs.T("job")[0]!, { status: "PENDING" });
    // Check point at the retry: covered → not sent.
    const stop = await stopCoveringEmailJob(job.id, job.payload);
    expect(stop?.id).toBe(stopId);
    expect(await cancelEmailJobAtCheckPoint(stop!, { id: job.id, attempts: 2 }, job.payload)).toMatchObject({ cancelled: expect.stringMatching(REASON) });
    // The finalizer's sweep also removes it (nothing is in progress any more).
    expect(await finalizeHardStop(stopId)).toBe(true);
    expect(hs.T("job")).toEqual([]);
    expect(await getHardStopView(stopId)).toMatchObject({ status: "STOPPED", followupsCancelled: 1 });
  });

  it("an email dispatched after the stop is not covered (a stop covers what existed when it was pressed)", async () => {
    campaign("k1", "SENDING");
    await pressHardStop("CAMPAIGN", "k1", ADMIN);
    const later = sendJob("k1", "c9", {});
    later.payload.dispatchedAt = new Date(Date.now() + 5000).toISOString();
    expect(await stopCoveringEmailJob(later.id, later.payload)).toBeNull();
  });

  it("a fan-out part way stops at its next chunk and never overwrites PAUSED", async () => {
    const c = campaign("k1", "SCHEDULED");
    for (let i = 0; i < 501; i++) hs.seed("listMembership", { listId: c.listId, contactId: `m${String(i).padStart(4, "0")}` });
    // Press the stop as the first chunk's last email is queued.
    let queued = 0;
    const upsert = hs.model("job").upsert;
    const real = upsert.getMockImplementation()!;
    upsert.mockImplementation(async (args) => {
      if (++queued === 500) await pressHardStop("CAMPAIGN", "k1", ADMIN);
      return real(args);
    });
    expect(await fanOutCampaign("k1", "2026-11-18")).toBe(500); // the second chunk never starts
    upsert.mockImplementation(real);
    expect(hs.T("campaign")[0]!.status).toBe("PAUSED");
    const stopId = hs.T("hardStop")[0]!.id;
    expect(hs.T("hardStopItem").filter((i) => i.kind === "cancelled")).toHaveLength(499); // queued before the press
    // The 500th was queued while the stop was being pressed. It carries its fan-out's start time, so the stop
    // covers it: its check point would not send it, and the final sweep removes it.
    const late = hs.T("job").filter((x) => x.queue === "send-email");
    expect(late).toHaveLength(1);
    expect(late[0]!.payload.dispatchedAt).toBeTruthy();
    expect((await stopCoveringEmailJob(late[0]!.id, late[0]!.payload))?.id).toBe(stopId);
    expect(await finalizeHardStop(stopId)).toBe(true);
    expect(hs.T("job").filter((x) => x.queue === "send-email")).toEqual([]);
    expect(await getHardStopView(stopId)).toMatchObject({ status: "STOPPED", cancelled: 500 });
  });

  it("a campaign whose fan-out finished (SENT) but whose emails were still queued is paused; one with nothing left to cancel stays SENT", async () => {
    campaign("k1", "SENT");
    campaign("k2", "SENT");
    hs.seed("contact", { id: "c1", email: "c1@x.test" });
    sendJob("k1", "c1");
    sendJob("k2", "c1", { status: "ACTIVE" }); // its last email is being sent: nothing to cancel
    const { stopId } = await pressHardStop("ALL", null, ADMIN);
    expect(status("campaign")).toEqual({ k1: "PAUSED", k2: "SENT" });
    expect((await getHardStopView(stopId))!.paused.campaigns).toEqual([{ id: "k1", name: "Campaign k1" }]);
  });

  it("a single campaign's Hard stop touches no other campaign and no trigger", async () => {
    campaign("k1", "SENDING");
    campaign("k2", "SCHEDULED");
    hs.seed("trigger", { id: "tr1", name: "Signup", active: true });
    const other = sendJob("k2", "c1");
    await pressHardStop("CAMPAIGN", "k1", ADMIN);
    expect(status("campaign")).toEqual({ k1: "PAUSED", k2: "SCHEDULED" });
    expect(hs.T("trigger")[0]!.active).toBe(true);
    expect(hs.T("job").map((j) => j.id)).toEqual([other.id]);
  });

  it("Stop all pauses scheduled / sending campaigns, switches active triggers off, cancels trigger emails, and lists what it paused", async () => {
    campaign("k1", "SENDING");
    campaign("k2", "SCHEDULED");
    campaign("k3", "DRAFT");
    hs.seed("trigger", { id: "tr1", name: "Signup", active: true });
    hs.seed("trigger", { id: "tr2", name: "Old", active: false });
    hs.seed("contact", { id: "c1", email: "c1@x.test" });
    hs.seed("job", { queue: "send-email", payload: { idempotencyKey: "trigger:tr1:c1:abc", contactId: "c1", source: { type: "trigger", triggerId: "tr1", payload: {} } }, dedupeKey: "trigger_tr1_c1_abc" });
    const { stopId } = await pressHardStop("ALL", null, ADMIN);
    expect(status("campaign")).toEqual({ k1: "PAUSED", k2: "PAUSED", k3: "DRAFT" });
    expect(hs.T("trigger").map((t) => t.active)).toEqual([false, false]);
    expect(hs.T("job")).toEqual([]);
    const view = (await getHardStopView(stopId))!;
    expect(view.paused).toEqual({
      campaigns: [
        { id: "k1", name: "Campaign k1" },
        { id: "k2", name: "Campaign k2" },
      ],
      triggers: [{ id: "tr1", name: "Signup" }],
    });
    expect(view.cancelled).toBe(1);
  });
});

/* ------------------------------------------------------------------ a section's own button */

describe("a section's Hard stop (Email, WhatsApp, the calls of one language) stops only that section", () => {
  /** One running send of every kind, English and Tamil calls, and follow-ups in both languages. */
  function everything() {
    const email = emailBatch(2);
    const wa = waBatch(2);
    hs.seed("aiCallRun", { id: "runEn", mode: "SELECTED", status: "RUNNING", gapSeconds: 0, maxCalls: 1, total: 1 });
    hs.seed("aiCallLog", { id: "en1", runId: "runEn", position: 0, phone: "+919000000101", status: "QUEUED" });
    hs.seed("callFlow", { id: "flowTa", language: "ta" });
    hs.seed("callFlowVersion", { id: "fvTa", flowId: "flowTa" });
    hs.seed("aiCallRun", { id: "runTa", mode: "SELECTED", status: "RUNNING", gapSeconds: 0, maxCalls: 1, total: 1 });
    hs.seed("aiCallRunFlow", { runId: "runTa", flowVersionId: "fvTa" });
    hs.seed("aiCallLog", { id: "ta1", runId: "runTa", position: 0, phone: "+919000000102", status: "QUEUED" });
    hs.seed("aiCallCustomer", { id: "custEn", customerName: "E", gender: "male", phone: "+919000000201", language: "en" });
    hs.seed("aiCallCustomer", { id: "custTa", customerName: "T", gender: "male", phone: "+919000000202", language: "ta" });
    hs.seed("aiCallFollowup", { id: "fuEn", channel: "CALL", status: "APPROVED", customerId: "custEn", aiCallRunId: null });
    hs.seed("aiCallFollowup", { id: "fuTa", channel: "CALL", status: "APPROVED", customerId: "custTa", aiCallRunId: null });
    hs.seed("campaign", { id: "k1", name: "K", status: "SCHEDULED", scheduleType: "ONCE", listId: "L", templateId: "t1" });
    hs.seed("trigger", { id: "tr1", name: "Signup", active: true });
    return { email, wa };
  }
  const state = () => ({
    email: hs.T("manualSendBatch")[0]!.status,
    wa: hs.T("whatsAppSendBatch")[0]!.status,
    runEn: hs.T("aiCallRun").find((r) => r.id === "runEn")!.status,
    runTa: hs.T("aiCallRun").find((r) => r.id === "runTa")!.status,
    fuEn: hs.T("aiCallFollowup").find((f) => f.id === "fuEn")!.status,
    fuTa: hs.T("aiCallFollowup").find((f) => f.id === "fuTa")!.status,
    campaign: hs.T("campaign")[0]!.status,
    trigger: hs.T("trigger")[0]!.active,
  });
  const untouched = { email: "RUNNING", wa: "RUNNING", runEn: "RUNNING", runTa: "RUNNING", fuEn: "APPROVED", fuTa: "APPROVED", campaign: "SCHEDULED", trigger: true };

  it("WhatsApp: only WhatsApp sends", async () => {
    everything();
    const { stopId } = await pressHardStop("WHATSAPP", null, ADMIN);
    expect(state()).toEqual({ ...untouched, wa: "CANCELLED" });
    expect(status("whatsAppSend")).toEqual({ w1: "CANCELLED", w2: "CANCELLED" });
    expect(await getHardStopView(stopId)).toMatchObject({ scope: "WHATSAPP", cancelled: 2 });
  });

  it("Email: email drips, campaigns (paused), triggers (switched off) and queued emails; nothing else", async () => {
    everything();
    hs.seed("job", { queue: "send-email", payload: { idempotencyKey: "trigger:tr1:c1:x", contactId: "c1", source: { type: "trigger", triggerId: "tr1", payload: {} } }, dedupeKey: "trigger_tr1_c1_x" });
    const { stopId } = await pressHardStop("EMAIL", null, ADMIN);
    expect(state()).toEqual({ ...untouched, email: "CANCELLED", campaign: "PAUSED", trigger: false });
    expect(hs.T("job").filter((j) => j.queue === "send-email")).toEqual([]);
    // Its check points cover email: a retry or a late fan-out chunk dispatched before it is not sent.
    const late = { idempotencyKey: "campaign:k1:c2:d", contactId: "c2", source: { type: "campaign", campaignId: "k1" }, dispatchedAt: new Date(Date.now() - 1000).toISOString() };
    expect((await stopCoveringEmailJob("any", late))?.id).toBe(stopId);
  });

  it("Calls · Tamil: only Tamil runs and Tamil follow-ups; English calls continue", async () => {
    everything();
    const { stopId } = await pressHardStop("CALLS", "ta", ADMIN);
    expect(state()).toEqual({ ...untouched, runTa: "CANCELLED", fuTa: "CANCELLED" });
    expect(status("aiCallLog")).toEqual({ en1: "QUEUED", ta1: "CANCELLED" });
    expect(await getHardStopView(stopId)).toMatchObject({ scope: "CALLS", targetId: "ta", cancelled: 1, followupsCancelled: 1 });
  });

  it("Calls · English: only English runs (those without a flow too) and English follow-ups", async () => {
    everything();
    await pressHardStop("CALLS", "en", ADMIN);
    expect(state()).toEqual({ ...untouched, runEn: "CANCELLED", fuEn: "CANCELLED" });
  });

  it("each language has its own open stop; an unknown language is refused", async () => {
    everything();
    const ta = await pressHardStop("CALLS", "ta", ADMIN);
    const en = await pressHardStop("CALLS", "en", ADMIN);
    expect(en.stopId).not.toBe(ta.stopId);
    expect((await pressHardStop("CALLS", "ta", ADMIN)).stopId).toBe(ta.stopId); // same open stop again
    await expect(pressHardStop("CALLS", "xx", ADMIN)).rejects.toMatchObject({ status: 404 });
  });
});

/* ------------------------------------------------------------------ idempotency, audit, CSV */

describe("idempotency, audit and the cancelled-rows CSV", () => {
  it("a second press returns the same stop; a finished send answers 409", async () => {
    const b = emailBatch(2);
    const first = await pressHardStop("EMAIL_BATCH", b.id, ADMIN);
    const second = await pressHardStop("EMAIL_BATCH", b.id, { id: "u2", email: "other@test" });
    expect(second).toEqual({ stopId: first.stopId, created: false });
    expect(hs.T("hardStop")).toHaveLength(1);
    expect(hs.T("hardStopItem").filter((i) => i.kind === "cancelled")).toHaveLength(2); // nothing recorded twice
    await finalizeHardStop(first.stopId);
    await expect(pressHardStop("EMAIL_BATCH", b.id, ADMIN)).rejects.toMatchObject({ status: 409 });
    await expect(pressHardStop("EMAIL_BATCH", "nope", ADMIN)).rejects.toBeInstanceOf(HardStopError);
  });

  it("CSV: one file per channel, with the columns that channel's import reads", async () => {
    const b = emailBatch(2);
    const { stopId } = await pressHardStop("EMAIL_BATCH", b.id, ADMIN);
    const file = (await hardStopCsv(stopId, "email"))!;
    const [head, ...rows] = file.body.trim().split("\r\n");
    expect(head).toBe("email,first_name,last_name,phone,business,cancelled_from,reason");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^c1@x\.test,First1,Last1,,Biz 1,"?Email batch ""Welcome"""?,Hard stop by admin@test at /);
    expect((await hardStopCsv(stopId, "calls"))!.body.trim()).toBe("customer_name,gender,phone,business_name,follow_up_detail,cancelled_from,reason");
  });
});

/* ------------------------------------------------------------------ two workers racing with a stop */

describe("two workers racing with a stop (the stop pressed before every database call in turn)", () => {
  type Kind = "email" | "whatsapp" | "calls";
  const setups: Record<Kind, { seed: () => string; work: (id: string) => Promise<unknown>; scope: "EMAIL_BATCH" | "WHATSAPP_BATCH" | "AI_CALL_RUN"; model: string; started: (r: Record<string, any>) => boolean; claim: string }> = {
    email: { seed: () => emailBatch(4).id, work: (id) => processManualBulkSend({ batchId: id }), scope: "EMAIL_BATCH", model: "manualSendBatchItem", started: (r) => r.status !== "PENDING" && r.status !== "CANCELLED", claim: '"status":"SENDING"' },
    whatsapp: { seed: () => waBatch(4).id, work: (id) => processWhatsAppBulkSend({ batchId: id }), scope: "WHATSAPP_BATCH", model: "whatsAppSend", started: (r) => r.status !== "QUEUED" && r.status !== "CANCELLED", claim: '"status":"SENDING"' },
    calls: { seed: () => callRun(4).id, work: (id) => processAiCallRun({ runId: id }), scope: "AI_CALL_RUN", model: "aiCallLog", started: (r) => r.status !== "QUEUED" && r.status !== "CANCELLED", claim: '"status":"DIALING"' },
  };
  const sent = (kind: Kind): string[] =>
    kind === "email"
      ? ext.deliverEmail.mock.calls.map((c) => (c[0] as { contactId: string }).contactId.replace("c", "i"))
      : kind === "whatsapp"
        ? ext.sendTemplateMessage.mock.calls.map((c) => `w${String((c[0] as { to: string }).to).slice(-1)}`)
        : ext.placeVoiceCall.mock.calls.map((c) => (c[0] as { logId: string }).logId);

  for (const kind of ["email", "whatsapp", "calls"] as Kind[]) {
    it(`${kind}: nothing starts after the stop is confirmed, nothing in progress is aborted, nothing is sent twice`, async () => {
      let checked = 0;
      for (let k = 1; k <= 90; k++) {
        hs.reset();
        vi.clearAllMocks();
        const s = setups[kind];
        // Calls end as soon as they are polled, so the run moves on.
        ext.getVoiceCall.mockResolvedValue({ status: "completed" });
        ext.applyVoiceUpdate.mockImplementation(async (logId: string) => {
          Object.assign(hs.T("aiCallLog").find((l) => l.id === logId)!, { status: "COMPLETED", endedAt: new Date() });
        });
        const id = s.seed();
        let confirmedAt = Infinity;
        let pressed = false;
        hs.before(k, async () => {
          try {
            await pressHardStop(s.scope, id, ADMIN);
            pressed = true;
          } catch (err) {
            if (!(err instanceof HardStopError)) throw err; // 409: the send had already finished
          }
          confirmedAt = hs.ops;
        });
        await Promise.all([drain(() => s.work(id), 30), drain(() => s.work(id), 30)]);
        if (!pressed) continue;
        checked++;
        // Run both workers again: still nothing new.
        const before = sent(kind).length;
        await Promise.all([drain(() => s.work(id), 5), drain(() => s.work(id), 5)]);
        expect(sent(kind).length, `k=${k}: sent after the stop`).toBe(before);

        const rows = hs.T(s.model);
        const ids = sent(kind);
        expect(new Set(ids).size, `k=${k}: an item sent twice`).toBe(ids.length);
        for (const r of rows) {
          if (r.status === "CANCELLED") {
            expect(ids, `k=${k}: cancelled item ${r.id} was sent`).not.toContain(r.id);
            expect(r.error).toMatch(REASON);
          }
          if (ids.includes(r.id)) expect(s.started(r), `k=${k}: item ${r.id} in progress was relabeled ${r.status}`).toBe(true);
        }
        const claims = hs.events.filter((e) => e.what.includes(s.claim));
        for (const c of claims) expect(c.op, `k=${k}: item ${c.id} started after the stop was confirmed`).toBeLessThan(confirmedAt);
        const stop = hs.T("hardStop")[0]!;
        await finalizeHardStop(stop.id);
        const v = (await getHardStopView(stop.id))!;
        expect(v.status, `k=${k}`).toBe("STOPPED");
        expect(v.completed + v.cancelled, `k=${k}: every item is either finished or cancelled`).toBe(rows.length);
      }
      expect(checked).toBeGreaterThan(10); // the stop landed mid-run at many different points
    });
  }

  it("follow-ups: a stop at any point either cancels it (no call run is created) or finds its call run already started", async () => {
    let checked = 0;
    let startedFirst = 0;
    for (let k = 1; k <= 40; k++) {
      hs.reset();
      vi.clearAllMocks();
      hs.seed("aiCallCustomer", { id: "cust1", customerName: "A", gender: "male", phone: "+919000000001", language: "en", doNotCall: false, deletedAt: null });
      const f = hs.seed("aiCallFollowup", { channel: "CALL", status: "APPROVED", customerId: "cust1", aiCallRunId: null, attempt: 1, decidedByEmail: "admin@test" });
      hs.before(k, async () => {
        await pressHardStop("ALL", null, ADMIN);
      });
      await processAiCallFollowup({ followupId: f.id });
      const row = hs.T("aiCallFollowup")[0]!;
      const runs = hs.T("aiCallRun");
      if (row.status === "CANCELLED") {
        checked++;
        expect(runs, `k=${k}: a cancelled follow-up created a run`).toEqual([]);
        expect(hs.T("job").filter((j) => j.queue === "ai-call-run"), `k=${k}`).toEqual([]);
      } else {
        expect(row.aiCallRunId, `k=${k}`).toBe(runs[0]?.id); // started first: in progress, untouched
        if (hs.T("hardStop").length) startedFirst++;
      }
    }
    // The stop landed before the claim (cancelled, no run) and after it (the run is in progress and kept).
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(startedFirst).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ flag off: exactly as before */

describe("flag off: every worker runs exactly its earlier code", () => {
  beforeEach(() => flag(false));
  const hardStopTouched = () =>
    ["hardStop", "hardStopItem"].some((m) => Object.values(hs.model(m)).some((fn) => (fn as { mock: { calls: unknown[] } }).mock.calls.length > 0));

  it("email: the item is marked SENDING with the plain update, as before; no hard-stop table is read", async () => {
    const b = emailBatch(1);
    await drain(() => processManualBulkSend({ batchId: b.id }));
    expect(hs.model("manualSendBatchItem").update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "SENDING" } });
    expect(hs.model("manualSendBatch").update).toHaveBeenCalledWith({ where: { id: b.id }, data: { status: "DONE", nextItemAt: null } });
    expect(hardStopTouched()).toBe(false);
  });

  it("WhatsApp: same", async () => {
    const b = waBatch(1);
    await drain(() => processWhatsAppBulkSend({ batchId: b.id }));
    expect(hs.model("whatsAppSend").update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { status: "SENDING" } });
    expect(hardStopTouched()).toBe(false);
  });

  it("calls: DIALING with the plain update, as before", async () => {
    const r = callRun(1);
    ext.getVoiceCall.mockResolvedValue({ status: "completed" });
    await processAiCallRun({ runId: r.id }).catch(() => undefined);
    expect(hs.model("aiCallLog").update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { status: "DIALING", startedAt: expect.any(Date) } });
    expect(hardStopTouched()).toBe(false);
  });

  it("follow-ups: the run is created and linked as before (no transaction)", async () => {
    hs.seed("aiCallCustomer", { id: "cust1", customerName: "A", gender: "male", phone: "+919000000001", language: "en", doNotCall: false, deletedAt: null });
    const f = hs.seed("aiCallFollowup", { channel: "CALL", status: "APPROVED", customerId: "cust1", aiCallRunId: null, attempt: 1, decidedByEmail: "admin@test" });
    const out = (await processAiCallFollowup({ followupId: f.id })) as { runId: string };
    expect(hs.model("aiCallFollowup").update).toHaveBeenCalledWith({ where: { id: f.id }, data: { aiCallRunId: out.runId } });
    expect(hs.model("aiCallFollowup").updateMany).not.toHaveBeenCalled();
    expect(hardStopTouched()).toBe(false);
  });

  it("campaign fan-out: same writes and payloads as before (no dispatchedAt)", async () => {
    hs.seed("campaign", { id: "k1", name: "K", status: "SCHEDULED", scheduleType: "ONCE", listId: "L", templateId: "t1" });
    hs.seed("listMembership", { listId: "L", contactId: "m1" });
    expect(await fanOutCampaign("k1", "2026-11-18")).toBe(1);
    expect(hs.model("campaign").update).toHaveBeenLastCalledWith({ where: { id: "k1" }, data: { status: "SENT" } });
    expect(hs.T("job")[0]!.payload).not.toHaveProperty("dispatchedAt");
    expect(hardStopTouched()).toBe(false);
  });
});
