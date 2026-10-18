import { beforeEach, describe, expect, it, vi } from "vitest";

// Characterization tests for one iteration of the email drip batch
// (queue/manualBulkSend.ts): stop conditions, the daily-cap gate, per-item
// outcomes, cancel mid-send, pacing between items and the lead-gen purge.
// Prisma, deliverEmail and the daily-cap helpers are mocked.

const db = vi.hoisted(() => ({
  manualSendBatch: { findUnique: vi.fn(), update: vi.fn() },
  manualSendBatchItem: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  emailLog: { findUnique: vi.fn(), deleteMany: vi.fn() },
  contact: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));
const deliverEmail = vi.hoisted(() => vi.fn());
const cap = vi.hoisted(() => ({ dailyCapReached: vi.fn(), msUntilNextWindow: vi.fn() }));

vi.mock("../src/prisma.js", () => ({ prisma: db }));
vi.mock("../src/domain/delivery.js", () => ({ deliverEmail }));
vi.mock("../src/queue/dailyCap.js", () => cap);

const { processManualBulkSend } = await import("../src/queue/manualBulkSend.js");
const { DeferJobError } = await import("../src/queue/engine.js");
const { manualKey } = await import("../src/domain/idempotency.js");

const batch = { id: "b1", status: "RUNNING", templateId: "t1", minDelaySec: 10, maxDelaySec: 10, purgeAfter: false };
const item = { id: "i1", contactId: "c1" };

beforeEach(() => {
  vi.clearAllMocks();
  db.manualSendBatch.findUnique.mockResolvedValue(batch);
  db.manualSendBatch.update.mockResolvedValue({});
  db.manualSendBatchItem.findFirst.mockResolvedValue(item);
  db.manualSendBatchItem.update.mockResolvedValue({});
  db.manualSendBatchItem.count.mockResolvedValue(3);
  db.manualSendBatchItem.groupBy.mockResolvedValue([{ status: "SENT", _count: { _all: 4 } }]);
  cap.dailyCapReached.mockResolvedValue(false);
  deliverEmail.mockResolvedValue({ result: "sent", emailLogId: "log1", providerMessageId: "pm1" });
});

describe("processManualBulkSend (characterization)", () => {
  it("batch gone / not RUNNING", async () => {
    db.manualSendBatch.findUnique.mockResolvedValueOnce(null);
    await expect(processManualBulkSend({ batchId: "b1" })).resolves.toEqual({ skipped: "batch gone" });
    db.manualSendBatch.findUnique.mockResolvedValueOnce({ ...batch, status: "CANCELLED" });
    await expect(processManualBulkSend({ batchId: "b1" })).resolves.toEqual({ skipped: "batch CANCELLED" });
    expect(deliverEmail).not.toHaveBeenCalled();
  });

  it("no PENDING items: batch DONE with counts", async () => {
    db.manualSendBatchItem.findFirst.mockResolvedValueOnce(null);
    await expect(processManualBulkSend({ batchId: "b1" })).resolves.toEqual({ done: true, SENT: 4 });
    expect(db.manualSendBatch.update).toHaveBeenCalledWith({ where: { id: "b1" }, data: { status: "DONE", nextItemAt: null } });
    // An item left SENDING by a worker restart is marked FAILED once — never left pending or re-queued.
    expect(db.manualSendBatchItem.updateMany).toHaveBeenCalledWith({
      where: { batchId: "b1", status: "SENDING" },
      data: { status: "FAILED", error: expect.stringMatching(/Interrupted/) },
    });
    expect(db.contact.deleteMany).not.toHaveBeenCalled(); // no purge without purgeAfter
  });

  it("daily cap reached: parks the batch until the next window, nothing sent", async () => {
    cap.dailyCapReached.mockResolvedValueOnce(true);
    cap.msUntilNextWindow.mockReturnValueOnce(60_000);
    const err = (await processManualBulkSend({ batchId: "b1" }).catch((e) => e)) as InstanceType<typeof DeferJobError>;
    expect(err).toBeInstanceOf(DeferJobError);
    expect(db.manualSendBatch.update).toHaveBeenCalledWith({ where: { id: "b1" }, data: { nextItemAt: err.runAt } });
    expect(deliverEmail).not.toHaveBeenCalled();
  });

  it("sends the next item with the manual idempotency key, marks it SENT, defers by the delay", async () => {
    const before = Date.now();
    const err = (await processManualBulkSend({ batchId: "b1" }).catch((e) => e)) as InstanceType<typeof DeferJobError>;
    expect(deliverEmail).toHaveBeenCalledWith({
      idempotencyKey: manualKey("t1", "c1"),
      contactId: "c1",
      source: { type: "manual", templateId: "t1" },
    });
    expect(db.manualSendBatchItem.update).toHaveBeenNthCalledWith(1, { where: { id: "i1" }, data: { status: "SENDING" } });
    expect(db.manualSendBatchItem.update).toHaveBeenNthCalledWith(2, {
      where: { id: "i1" },
      data: { status: "SENT", sentAt: expect.any(Date), error: null, emailLogId: "log1" },
    });
    expect(err).toBeInstanceOf(DeferJobError);
    const wait = err.runAt.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(10_000);
    expect(wait).toBeLessThan(11_000);
    expect(db.manualSendBatch.update).toHaveBeenLastCalledWith({ where: { id: "b1" }, data: { nextItemAt: err.runAt } });
  });

  it("skipped send: item SKIPPED with the reason", async () => {
    deliverEmail.mockResolvedValueOnce({ result: "skipped", emailLogId: "log1", reason: "suppressed" });
    await processManualBulkSend({ batchId: "b1" }).catch(() => {});
    expect(db.manualSendBatchItem.update).toHaveBeenNthCalledWith(2, {
      where: { id: "i1" },
      data: { status: "SKIPPED", error: "suppressed", emailLogId: "log1" },
    });
  });

  it("send throws: item FAILED, linked to the ledger row, batch continues", async () => {
    deliverEmail.mockRejectedValueOnce(new Error("smtp down"));
    db.emailLog.findUnique.mockResolvedValueOnce({ id: "log9" });
    const err = (await processManualBulkSend({ batchId: "b1" }).catch((e) => e)) as InstanceType<typeof DeferJobError>;
    expect(db.manualSendBatchItem.update).toHaveBeenNthCalledWith(2, {
      where: { id: "i1" },
      data: { status: "FAILED", error: "smtp down", emailLogId: "log9" },
    });
    expect(err).toBeInstanceOf(DeferJobError);
  });

  it("cancelled mid-send: clears nextItemAt and stops", async () => {
    db.manualSendBatch.findUnique.mockResolvedValueOnce(batch).mockResolvedValueOnce({ status: "CANCELLED" });
    await expect(processManualBulkSend({ batchId: "b1" })).resolves.toEqual({ stopped: "CANCELLED" });
    expect(db.manualSendBatch.update).toHaveBeenLastCalledWith({ where: { id: "b1" }, data: { nextItemAt: null } });
  });

  it("last item sent: DONE; purgeAfter deletes only the contacts emailed successfully, never failed / skipped", async () => {
    db.manualSendBatch.findUnique.mockResolvedValue({ ...batch, purgeAfter: true });
    db.manualSendBatchItem.count.mockResolvedValueOnce(0);
    db.manualSendBatchItem.findMany.mockResolvedValueOnce([{ contactId: "c1" }, { contactId: "c2" }, { contactId: "c1" }]);
    db.emailLog.deleteMany.mockReturnValueOnce("del-logs");
    db.contact.deleteMany.mockReturnValueOnce("del-contacts");
    await expect(processManualBulkSend({ batchId: "b1" })).resolves.toEqual({ done: true, SENT: 4 });
    expect(db.manualSendBatchItem.findMany).toHaveBeenCalledWith({ where: { batchId: "b1", status: "SENT" }, select: { contactId: true } });
  });

  it("purgeAfter with only failed / skipped items deletes nothing", async () => {
    db.manualSendBatch.findUnique.mockResolvedValue({ ...batch, purgeAfter: true });
    db.manualSendBatchItem.findFirst.mockResolvedValueOnce(null);
    db.manualSendBatchItem.findMany.mockResolvedValueOnce([]); // no SENT items
    await expect(processManualBulkSend({ batchId: "b1" })).resolves.toMatchObject({ done: true });
    expect(db.contact.deleteMany).not.toHaveBeenCalled();
    expect(db.emailLog.deleteMany).not.toHaveBeenCalled();
  });

  it("purgeAfter deletes the SENT contacts and their email logs", async () => {
    db.manualSendBatch.findUnique.mockResolvedValue({ ...batch, purgeAfter: true });
    db.manualSendBatchItem.count.mockResolvedValueOnce(0);
    db.manualSendBatchItem.findMany.mockResolvedValueOnce([{ contactId: "c1" }, { contactId: "c2" }, { contactId: "c1" }]);
    db.emailLog.deleteMany.mockReturnValueOnce("del-logs");
    db.contact.deleteMany.mockReturnValueOnce("del-contacts");
    await expect(processManualBulkSend({ batchId: "b1" })).resolves.toEqual({ done: true, SENT: 4 });
    expect(db.emailLog.deleteMany).toHaveBeenCalledWith({ where: { contactId: { in: ["c1", "c2"] } } });
    expect(db.contact.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["c1", "c2"] } } });
    expect(db.$transaction).toHaveBeenCalledWith(["del-logs", "del-contacts"]);
  });
});
