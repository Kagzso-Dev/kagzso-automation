import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Versioning rules and version pinning, with Prisma replaced by an in-memory table.

type Row = {
  id: string;
  flowId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  definition: unknown;
  definitionHash: string;
  publishedAt: Date | null;
};
let rows: Row[] = [];
let flows: Record<string, { archivedAt: Date | null }> = {};
let links: Record<string, string> = {}; // runId -> versionId
let nextId = 1;

const match = (r: Row, where: Partial<Row>) => Object.entries(where).every(([k, v]) => r[k as keyof Row] === v);
const callFlowVersion = {
  findFirst: async ({ where, orderBy }: { where: Partial<Row>; orderBy?: { version: "desc" } }) => {
    const hits = rows.filter((r) => match(r, where));
    if (orderBy) hits.sort((a, b) => b.version - a.version);
    return hits[0] ?? null;
  },
  findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id)!,
  updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
    const hits = rows.filter((r) => match(r, where));
    hits.forEach((r) => Object.assign(r, data));
    return { count: hits.length };
  },
  aggregate: async ({ where }: { where: Partial<Row> }) => ({
    _max: { version: Math.max(0, ...rows.filter((r) => match(r, where)).map((r) => r.version)) || null },
  }),
  create: async ({ data }: { data: Omit<Row, "id" | "publishedAt"> }) => {
    const row = { id: `v${nextId++}`, publishedAt: null, ...data };
    rows.push(row);
    return row;
  },
};
const db = {
  callFlowVersion,
  callFlow: {
    update: async () => ({}),
    findUnique: async ({ where }: { where: { id: string } }) => flows[where.id] ?? null,
  },
  aiCallRunFlow: {
    findUnique: async ({ where }: { where: { runId: string } }) => {
      const v = rows.find((r) => r.id === links[where.runId]);
      return v ? { runId: where.runId, flowVersion: v } : null;
    },
  },
};
vi.mock("../src/prisma.js", () => ({
  prisma: { ...db, $transaction: (fn: (tx: typeof db) => unknown) => fn(db) },
}));

const { saveDraft, publishDraft, versionForNewRun, pinnedFlowForRun, CallFlowError, definitionHash } = await import(
  "../src/domain/callFlows.js"
);

const def = (name: string) => ({ name, marker: name }) as never;

beforeEach(() => {
  rows = [];
  flows = { f1: { archivedAt: null } };
  links = {};
  nextId = 1;
});

describe("drafts and publishing", () => {
  it("saving twice edits the same draft", async () => {
    const a = await saveDraft("f1", def("A"), "admin@test");
    const b = await saveDraft("f1", def("B"), "admin@test");
    expect(rows).toHaveLength(1);
    expect(b.id).toBe(a.id);
    expect(b.definition).toEqual(def("B"));
    expect(b.definitionHash).toBe(definitionHash(def("B")));
  });

  it("editing a published flow creates the next version and never touches the published one", async () => {
    const v1 = await saveDraft("f1", def("A"), null);
    await publishDraft(v1.id);
    const v2 = await saveDraft("f1", def("B"), null);
    expect(v2.version).toBe(2);
    expect(rows.find((r) => r.version === 1)).toMatchObject({ status: "PUBLISHED", definition: def("A") });
    await saveDraft("f1", def("C"), null);
    expect(rows.find((r) => r.version === 1)!.definition).toEqual(def("A"));
  });

  it("a published version can't be published or edited again", async () => {
    const v1 = await saveDraft("f1", def("A"), null);
    await publishDraft(v1.id);
    await expect(publishDraft(v1.id)).rejects.toBeInstanceOf(CallFlowError);
  });
});

describe("version pinning", () => {
  it("a new run pins the latest published version, not the draft", async () => {
    const v1 = await saveDraft("f1", def("A"), null);
    await publishDraft(v1.id);
    const v2 = await saveDraft("f1", def("B"), null);
    await publishDraft(v2.id);
    await saveDraft("f1", def("C (draft)"), null);
    expect((await versionForNewRun("f1")).version).toBe(2);
  });

  it("a run keeps its version after newer ones are published", async () => {
    const v1 = await saveDraft("f1", def("A"), null);
    await publishDraft(v1.id);
    links.run1 = (await versionForNewRun("f1")).id;
    const v2 = await saveDraft("f1", def("B"), null);
    await publishDraft(v2.id);
    // Flows from before languages (and English flows) are English: their runs call the English backend.
    expect(await pinnedFlowForRun("run1")).toEqual({ flowId: "f1", version: 1, draft: false, definition: def("A"), language: "en" });
  });

  it("refuses unpublished or archived flows; a run without a flow uses the default agent", async () => {
    await saveDraft("f1", def("A"), null);
    await expect(versionForNewRun("f1")).rejects.toThrow(/no published version/);
    flows.f1.archivedAt = new Date();
    await expect(versionForNewRun("f1")).rejects.toThrow(/not found/);
    expect(await pinnedFlowForRun("no-link")).toBeNull();
  });
});

describe("placeVoiceCall", () => {
  const sent: Record<string, unknown>[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ success: true, call_id: "c1", provider_call_id: null }), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function client() {
    process.env.VOICE_BACKEND_URL = "http://voice.test";
    process.env.VOICE_BACKEND_API_KEY = "voice-key-0123456789";
    vi.resetModules();
    return import("../src/services/voiceBackend.js");
  }
  const input = { customerName: "Ragul", gender: "male", followUpDetail: null, phone: "+919876543210", runId: "r1", logId: "l1" };

  // The agent field comes from VOICE_AGENT_ID / VOICE_AGENT_NAME (a local .env may set them).
  const withoutAgent = ({ agent_id: _id, agent_name: _name, ...rest }: Record<string, unknown>) => rest;

  it("without a flow sends exactly the old request", async () => {
    await (await client()).placeVoiceCall(input);
    expect(withoutAgent(sent[0])).toEqual({
      phone_number: "+919876543210",
      customer_name: "Ragul",
      gender: "male",
      run_id: "r1",
      log_id: "l1",
    });
    expect(Boolean(sent[0].agent_id ?? sent[0].agent_name)).toBe(true);
  });

  it("with a pinned flow adds flow_id, flow_version, flow_draft and the definition", async () => {
    await (await client()).placeVoiceCall({ ...input, flow: { flowId: "f1", version: 3, draft: false, definition: { a: 1 } } });
    expect(sent[0]).toMatchObject({ flow_id: "f1", flow_version: 3, flow_draft: false, flow: { a: 1 } });
    expect(Boolean(sent[0].agent_id ?? sent[0].agent_name)).toBe(true); // still the fallback agent
  });
});
