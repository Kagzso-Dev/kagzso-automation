import { beforeEach, describe, expect, it, vi } from "vitest";

// A failed WhatsApp message never deletes or changes the contact (queue/whatsappBulkSend.ts):
// the lead-gen purge only deletes recipients Meta confirmed DELIVERED / READ (at batch
// end or when the confirmation arrives later), the Meta 131049 cooldown skips instead
// of sending or retrying, and nothing is left SENDING. In-memory Prisma; Meta mocked.

type Row = Record<string, any>;
const t = vi.hoisted(() => ({
  batches: [] as Row[],
  sends: [] as Row[],
  waContacts: [] as Row[],
  contacts: [] as Row[],
  sendCalls: [] as Row[],
  category: "MARKETING" as string | null,
}));

function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return (cond.in as unknown[]).includes(v);
      if ("gte" in cond) return v instanceof Date && v >= cond.gte;
      if ("not" in cond) return v !== cond.not;
    }
    return v === cond;
  });
}
const table = (rows: () => Row[]) => ({
  findUnique: async ({ where }: Row) => rows().find((r) => r.id === where.id) ?? null,
  findFirst: async ({ where, orderBy }: Row) => {
    const hit = rows().filter((r) => match(r, where));
    if (orderBy?.failedAt === "desc") hit.sort((a, b) => b.failedAt - a.failedAt);
    return hit[0] ?? null;
  },
  findMany: async ({ where }: Row) => rows().filter((r) => match(r, where)),
  count: async ({ where }: Row) => rows().filter((r) => match(r, where)).length,
  update: async ({ where, data }: Row) => Object.assign(rows().find((r) => r.id === where.id)!, data),
  updateMany: async ({ where, data }: Row) => {
    const hit = rows().filter((r) => match(r, where));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  },
  deleteMany: async ({ where }: Row) => {
    const keep = rows().filter((r) => !match(r, where));
    const count = rows().length - keep.length;
    rows().splice(0, rows().length, ...keep);
    return { count };
  },
  groupBy: async ({ where }: Row) => {
    const counts: Record<string, number> = {};
    for (const r of rows().filter((x) => match(x, where))) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return Object.entries(counts).map(([status, n]) => ({ status, _count: { _all: n } }));
  },
});

vi.mock("../src/prisma.js", () => ({
  prisma: {
    whatsAppSendBatch: table(() => t.batches),
    whatsAppSend: table(() => t.sends),
    whatsAppContact: table(() => t.waContacts),
    contact: table(() => t.contacts),
    emailLog: { deleteMany: async () => ({ count: 0 }) },
    whatsAppSendMedia: { upsert: async () => ({}) },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));
vi.mock("../src/services/whatsapp.js", async (orig) => ({
  ...(await orig<object>()),
  sendTemplateMessage: vi.fn(async (input: Row) => {
    t.sendCalls.push(input);
    return { providerMessageId: `wamid.${t.sendCalls.length}` };
  }),
}));
vi.mock("../src/domain/whatsappTemplateHeader.js", () => ({ headerComponentForTemplate: async () => null }));
vi.mock("../src/domain/whatsappTemplateVerify.js", () => ({ metaTemplateCategory: async () => t.category }));

const { processWhatsAppBulkSend, purgeConfirmedRecipient } = await import("../src/queue/whatsappBulkSend.js");
const { DeferJobError } = await import("../src/queue/engine.js");

const template = { id: "tpl", name: "Intro", providerTemplateName: "kagzso_intro", languageCode: "en" };
const send = (id: string, over: Row) => ({ id, batchId: "b1", phone: `9198765400${id.slice(-2)}`, status: "QUEUED", contentVariables: {}, createdAt: new Date(), ...over });

beforeEach(() => {
  for (const k of ["batches", "sends", "waContacts", "contacts", "sendCalls"] as const) t[k].length = 0;
  t.category = "MARKETING";
  t.waContacts.push(...["c1", "c2", "c3", "c4"].map((id) => ({ id, phone: `phone-${id}` })));
});

function leadGenBatch(status = "RUNNING") {
  t.batches.push({ id: "b1", status, template, minDelaySec: 1, maxDelaySec: 1, purgeAfter: true, purgeTable: "whatsapp", purgeIds: ["c1", "c2", "c3", "c4"] });
}

describe("failed WhatsApp sends keep the contact", () => {
  it("batch end deletes only confirmed deliveries — never FAILED (131049), SKIPPED or merely SENT", async () => {
    leadGenBatch();
    t.sends.push(
      send("s01", { whatsappContactId: "c1", status: "DELIVERED" }),
      send("s02", { whatsappContactId: "c2", status: "SENT" }),
      send("s03", { whatsappContactId: "c3", status: "FAILED", errorCode: "131049" }),
      send("s04", { whatsappContactId: "c4", status: "SKIPPED" }),
    );
    await expect(processWhatsAppBulkSend({ batchId: "b1" })).resolves.toMatchObject({ done: true });
    expect(t.waContacts.map((c) => c.id)).toEqual(["c2", "c3", "c4"]);
    expect(t.sends.find((s) => s.id === "s03")).toMatchObject({ status: "FAILED", errorCode: "131049" }); // history kept
  });

  it("a delivery confirmed after the batch ended deletes that one recipient; a failure never does", async () => {
    leadGenBatch("DONE");
    t.sends.push(
      send("s02", { whatsappContactId: "c2", status: "DELIVERED" }),
      send("s03", { whatsappContactId: "c3", status: "FAILED", errorCode: "131049" }),
    );
    await purgeConfirmedRecipient("s03");
    expect(t.waContacts.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
    await purgeConfirmedRecipient("s02");
    expect(t.waContacts.map((c) => c.id)).toEqual(["c1", "c3", "c4"]);
  });

  it("no purge at all without purgeAfter, whatever the results", async () => {
    t.batches.push({ id: "b1", status: "RUNNING", template, minDelaySec: 1, maxDelaySec: 1, purgeAfter: false, purgeTable: null, purgeIds: null });
    t.sends.push(send("s01", { whatsappContactId: "c1", status: "READ" }));
    await processWhatsAppBulkSend({ batchId: "b1" });
    expect(t.waContacts).toHaveLength(4);
  });

  it("an item left SENDING by a restart is marked FAILED once at batch end (not pending, not re-queued)", async () => {
    leadGenBatch();
    t.sends.push(send("s01", { whatsappContactId: "c1", status: "SENDING" }));
    await processWhatsAppBulkSend({ batchId: "b1" });
    expect(t.sends[0]).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Interrupted/) });
    expect(t.waContacts).toHaveLength(4);
  });

  it("131049 cooldown: a marketing template to that number is SKIPPED, not sent and not retried", async () => {
    leadGenBatch();
    const phone = "919876540099";
    t.sends.push(
      send("old", { batchId: "b0", phone, status: "FAILED", errorCode: "131049", failedAt: new Date(Date.now() - 60 * 60_000) }),
      send("s01", { phone, whatsappContactId: "c1" }),
    );
    await expect(processWhatsAppBulkSend({ batchId: "b1" })).resolves.toMatchObject({ done: true });
    expect(t.sendCalls).toHaveLength(0);
    expect(t.sends.find((s) => s.id === "s01")).toMatchObject({ status: "SKIPPED", error: expect.stringMatching(/131049 cooldown/) });
    expect(t.waContacts).toHaveLength(4); // the contact is untouched
  });

  it("the cooldown doesn't apply to utility templates, or once it has passed", async () => {
    t.category = "UTILITY";
    t.batches.push({ id: "b1", status: "RUNNING", template, minDelaySec: 1, maxDelaySec: 1, purgeAfter: false, purgeTable: null, purgeIds: null });
    const phone = "919876540098";
    t.sends.push(
      send("old", { batchId: "b0", phone, status: "FAILED", errorCode: "131049", failedAt: new Date(Date.now() - 60 * 60_000) }),
      send("s01", { phone }),
      send("s02", { phone: "919876540097" }),
    );
    t.sends.push(send("old2", { batchId: "b0", phone: "919876540097", status: "FAILED", errorCode: "131049", failedAt: new Date(Date.now() - 25 * 60 * 60_000) }));
    const err = await processWhatsAppBulkSend({ batchId: "b1" }).catch((e) => e);
    expect(err).toBeInstanceOf(DeferJobError); // paced before the next item
    expect(t.sendCalls.map((c) => c.to)).toEqual([phone]);
    t.category = "MARKETING";
    await processWhatsAppBulkSend({ batchId: "b1" }).catch(() => undefined); // 25 h ago: cooldown over
    expect(t.sendCalls.map((c) => c.to)).toEqual([phone, "919876540097"]);
  });

  it("a send Meta rejects is recorded FAILED once; the contact row is never touched", async () => {
    const wa = await import("../src/services/whatsapp.js");
    vi.mocked(wa.sendTemplateMessage).mockRejectedValueOnce(new wa.WhatsAppSendError("Meta 131026: undeliverable", false, "131026"));
    t.batches.push({ id: "b1", status: "RUNNING", template, minDelaySec: 1, maxDelaySec: 1, purgeAfter: true, purgeTable: "whatsapp", purgeIds: ["c1"] });
    t.sends.push(send("s01", { whatsappContactId: "c1" }));
    const before = JSON.stringify(t.waContacts);
    await processWhatsAppBulkSend({ batchId: "b1" }).catch(() => undefined);
    expect(t.sends[0]).toMatchObject({ status: "FAILED", errorCode: "131026" });
    expect(JSON.stringify(t.waContacts)).toBe(before);
  });
});
