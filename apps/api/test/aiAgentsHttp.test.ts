import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// AI Agents over HTTP: roles, language scoping, knowledge upload / review, isolation between agents,
// compile + publish through the (fake) voice backend, and calling through the normal AI call run (stubbed:
// no queue, no Redis, no phone call). In-memory Prisma: no database.

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");
const EXECUTIVE = JSON.parse(read("kagzso-voice-backend-english/app/flows/builtin/executive.json"));

/* ------------------------------------------------------------------ in-memory Prisma */
type Row = Record<string, unknown> & { id: string };
const tables: Record<string, Row[]> = {};
let seq = 0;
const T = (name: string) => (tables[name] ??= []);

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
      if (c.in) return c.in.includes(v);
      if (c.notIn) return !c.notIn.includes(v);
      if ("not" in c) return v !== c.not;
      return true;
    }
    return v === cond;
  });
}

function model(name: string, defaults: () => Record<string, unknown> = () => ({})) {
  const rows = () => T(name);
  const create = ({ data }: { data: Record<string, unknown> }) => {
    const r = { id: `${name}_${++seq}`, createdAt: new Date(Date.now() + seq), updatedAt: new Date(), ...defaults(), ...data } as Row;
    rows().push(r);
    return r;
  };
  return {
    create: async (a: { data: Record<string, unknown> }) => create(a),
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      data.forEach((d) => create({ data: d }));
      return { count: data.length };
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) => rows().find((r) => matches(r, where)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => rows().find((r) => matches(r, where))!,
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const found = rows().filter((r) => matches(r, where));
      return found.sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0))[0] ?? null;
    },
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => rows().filter((r) => matches(r, where)),
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => rows().filter((r) => matches(r, where)).length,
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = rows().find((x) => matches(x, where))!;
      Object.assign(r, data, { updatedAt: new Date() });
      return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows().filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }: { where: Record<string, unknown> }) => {
      const i = rows().findIndex((r) => matches(r, where));
      return rows().splice(i, 1)[0];
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const keep = rows().filter((r) => !matches(r, where));
      const count = rows().length - keep.length;
      tables[name] = keep;
      return { count };
    },
    aggregate: async ({ where }: { where: Record<string, unknown> }) => ({
      _max: { version: Math.max(0, ...rows().filter((r) => matches(r, where)).map((r) => Number(r.version))) || null },
    }),
    groupBy: async ({ where }: { where: Record<string, unknown> }) => {
      const counts = new Map<unknown, number>();
      rows().filter((r) => matches(r, where)).forEach((r) => counts.set(r.status, (counts.get(r.status) ?? 0) + 1));
      return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
  };
}

const callFlow = model("callFlow", () => ({ archivedAt: null }));
const callFlowVersion = model("callFlowVersion", () => ({ publishedAt: null }));
const db = {
  aiAgent: model("aiAgent", () => ({ archivedAt: null, callFlowId: null, publishedHash: null })),
  aiAgentKnowledgeFile: model("aiAgentKnowledgeFile"),
  aiAgentKnowledgeItem: model("aiAgentKnowledgeItem", () => ({ status: "DRAFT", always: false, decidedAt: null, decidedByEmail: null })),
  aiIndustry: model("aiIndustry", () => ({ archivedAt: null })),
  aiBusinessCategory: {
    ...model("aiBusinessCategory", () => ({ archivedAt: null })),
    findMany: async () => T("aiBusinessCategory").map((c) => ({ ...c, industries: T("aiIndustry").filter((i) => i.categoryId === c.id) })),
  },
  callFlow: {
    ...callFlow,
    // The agent's first publish creates the flow with its draft v1 (nested create).
    create: async ({ data }: { data: Record<string, unknown> & { versions: { create: Record<string, unknown> } } }) => {
      const { versions, ...flow } = data;
      const f = await callFlow.create({ data: flow });
      const v = await callFlowVersion.create({ data: { ...versions.create, flowId: f.id } });
      return { ...f, versions: [v] };
    },
  },
  callFlowVersion,
};
vi.mock("../src/prisma.js", () => ({
  prisma: {
    ...db,
    $transaction: (arg: unknown) => (typeof arg === "function" ? (arg as (t: typeof db) => unknown)(db) : Promise.all(arg as Promise<unknown>[])),
  },
}));

// The normal AI call run is stubbed: the test checks what the agent asks it for.
const runCalls: unknown[][] = [];
vi.mock("../src/http/routes/aiCalls.js", async (orig) => ({
  ...(await orig<typeof import("../src/http/routes/aiCalls.js")>()),
  planAndStartAiCallRun: vi.fn(async (...args: unknown[]) => {
    runCalls.push(args);
    return { status: 200, json: { dryRun: true, toCall: 1, skipped: {}, invalidRows: [] } };
  }),
}));

/* ------------------------------------------------------------------ fake voice backend + app */
let server: Server;
let voice: Server;
let base = "";
const previews: Record<string, unknown>[] = [];
const token = (role: "ADMIN" | "EDITOR") => jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const req = (method: string, path: string, body?: unknown, role: "ADMIN" | "EDITOR" = "ADMIN") =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(role)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const upload = (agentId: string, files: { name: string; text: string }[], extra: Record<string, string> = {}) => {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([f.text]), f.name);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return fetch(`${base}/api/ai-agents/${agentId}/knowledge/files`, { method: "POST", headers: { Authorization: `Bearer ${token("ADMIN")}` }, body: form });
};

beforeAll(async () => {
  voice = createServer((r, res) => {
    let raw = "";
    r.on("data", (c) => (raw += c));
    r.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (r.url === "/api/flows/builtin") {
        res.end(JSON.stringify({ flows: { executive: EXECUTIVE }, locked_blocks: {}, variables: [], groups: [], language: "en" }));
      } else if (r.url === "/api/flows/preview") {
        const body = JSON.parse(raw);
        previews.push(body);
        const bad = JSON.stringify(body.flow).includes("REJECT-ME");
        res.end(JSON.stringify(bad ? { valid: false, errors: ["training.knowledge.0.text: Value error, not allowed"] } : { valid: true, errors: [], greeting: "Hello" }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  }).listen(0);
  process.env.ENABLE_AI_CALLS = "true";
  process.env.ENABLE_CALL_FLOW_EDITOR = "true";
  process.env.VOICE_BACKEND_URL = `http://127.0.0.1:${(voice.address() as AddressInfo).port}`;
  process.env.VOICE_BACKEND_API_KEY = "voice-key-0123456789";
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => voice.close(() => r()));
});

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  previews.length = 0;
  runCalls.length = 0;
  T("aiBusinessCategory").push({ id: "cat_h", name: "Healthcare", archivedAt: null });
  T("aiIndustry").push({ id: "ind_h", categoryId: "cat_h", name: "Hospital", discoveryTopics: "Billing\nAppointments", archivedAt: null });
});

const AGENT = {
  name: "ABC Hospital - Thaara",
  categoryId: "cat_h",
  industryId: "ind_h",
  businessName: "ABC Hospital",
  objective: "Introduce AI and automation for hospitals.",
  contactName: "Ragul",
  contactGender: "male",
  contactPhone: "+919876543210",
  instructions: "Do not talk about pricing.",
};
async function createAgent(language = "en", agent: Record<string, unknown> = AGENT) {
  const r = await req("POST", "/api/ai-agents", { language, agent });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; [k: string]: unknown };
}
const CSV = "Topic,Answer,Question\nBilling,Kagzso automates billing follow-ups.,\nIntegration,It works alongside your software.,Will it replace our software?\nPricing,It costs Rs 25000 per month.,\n";

/* ------------------------------------------------------------------ tests */
describe("agents", () => {
  it("admins create with the defaults; editors can read but not create", async () => {
    const a = await createAgent();
    expect(a).toMatchObject({ language: "en", mode: "autonomous", executiveName: "Thaara", companyName: "Kagzso Technology Services", targetDurationSec: 60, maxDurationSec: 105, unpublishedChanges: true });
    expect((await req("POST", "/api/ai-agents", { language: "en", agent: AGENT }, "EDITOR")).status).toBe(403);
    expect((await req("GET", `/api/ai-agents/${a.id}`, undefined, "EDITOR")).status).toBe(200);
  });

  it("each language section lists only its own agents (one shared industry library)", async () => {
    const en = await createAgent("en");
    const ta = await createAgent("ta", { ...AGENT, name: "Tamil agent" });
    const list = async (l: string) => ((await (await req("GET", `/api/ai-agents?language=${l}`)).json()) as { id: string }[]).map((x) => x.id);
    expect(await list("en")).toEqual([en.id]);
    expect(await list("ta")).toEqual([ta.id]);
    const lib = (await (await req("GET", "/api/ai-agents/library")).json()) as { name: string; industries: { name: string }[] }[];
    expect(lib[0]).toMatchObject({ name: "Healthcare", industries: [{ name: "Hospital" }] });
  });

  it("validates: an industry of another category, a guided agent without a flow, an unknown language", async () => {
    T("aiBusinessCategory").push({ id: "cat_x", name: "Other", archivedAt: null });
    expect((await req("POST", "/api/ai-agents", { language: "en", agent: { ...AGENT, categoryId: "cat_x" } })).status).toBe(400);
    expect((await req("POST", "/api/ai-agents", { language: "en", agent: { name: "g", mode: "guided" } })).status).toBe(400);
    expect((await req("POST", "/api/ai-agents", { language: "xx", agent: AGENT })).status).toBe(400);
  });
});

describe("knowledge", () => {
  it("upload → Draft items with issues; only clean items can be approved", async () => {
    const a = await createAgent();
    const up = await upload(a.id, [{ name: "kagzso.csv", text: CSV }, { name: "notes.doc", text: "x" }]);
    expect(up.status).toBe(201);
    const { files } = (await up.json()) as { files: { fileName: string; itemCount?: number; error?: string }[] };
    expect(files[0]).toMatchObject({ fileName: "kagzso.csv", itemCount: 3 });
    expect(files[1]!.error).toMatch(/Unsupported/);
    const k = (await (await req("GET", `/api/ai-agents/${a.id}/knowledge`)).json()) as { items: { id: string; topic: string; status: string; issues: string[] }[] };
    expect(k.items.map((i) => [i.topic, i.status, i.issues.length > 0])).toEqual([
      ["Billing", "draft", false],
      ["Integration", "draft", false],
      ["Pricing", "draft", true],
    ]);
    const res = await req("POST", `/api/ai-agents/${a.id}/knowledge/decide`, { ids: k.items.map((i) => i.id), status: "approved" });
    const out = (await res.json()) as { updated: number; refused: { reason: string }[] };
    expect(out.updated).toBe(2);
    expect(out.refused[0]!.reason).toMatch(/price/);
  });

  it("editing an approved item puts it back to Draft and re-checks it", async () => {
    const a = await createAgent();
    await upload(a.id, [{ name: "k.csv", text: CSV }]);
    const id = T("aiAgentKnowledgeItem")[0]!.id;
    await req("POST", `/api/ai-agents/${a.id}/knowledge/decide`, { ids: [id], status: "approved" });
    const r = await req("PATCH", `/api/ai-agents/${a.id}/knowledge/items/${id}`, { text: "Call 98765 43210 for details." });
    expect(await r.json()).toMatchObject({ status: "draft", issues: [expect.stringMatching(/phone number/)] });
  });

  it("isolation: one agent's items can't be read, changed or approved through another agent", async () => {
    const a = await createAgent();
    const b = await createAgent("en", { ...AGENT, name: "Other business", businessName: "XYZ School" });
    await upload(a.id, [{ name: "k.csv", text: CSV }]);
    const itemOfA = T("aiAgentKnowledgeItem")[0]!.id;
    expect((await req("PATCH", `/api/ai-agents/${b.id}/knowledge/items/${itemOfA}`, { text: "x" })).status).toBe(404);
    expect((await req("DELETE", `/api/ai-agents/${b.id}/knowledge/items/${itemOfA}`)).status).toBe(404);
    const d = (await (await req("POST", `/api/ai-agents/${b.id}/knowledge/decide`, { ids: [itemOfA], status: "approved" })).json()) as { updated: number };
    expect(d.updated).toBe(0);
    expect(((await (await req("GET", `/api/ai-agents/${b.id}/knowledge`)).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("replacing a file removes its old items (approved ones too) and marks it replaced", async () => {
    const a = await createAgent();
    await upload(a.id, [{ name: "k.csv", text: CSV }]);
    const fileId = T("aiAgentKnowledgeFile")[0]!.id;
    await req("POST", `/api/ai-agents/${a.id}/knowledge/decide`, { ids: [T("aiAgentKnowledgeItem")[0]!.id], status: "approved" });
    await upload(a.id, [{ name: "k2.csv", text: "Topic,Answer\nAppointments,Patients get reminders.\n" }], { replacesFileId: fileId });
    const k = (await (await req("GET", `/api/ai-agents/${a.id}/knowledge`)).json()) as { files: { status: string }[]; items: { topic: string; status: string }[] };
    expect(k.items).toEqual([expect.objectContaining({ topic: "Appointments", status: "draft" })]);
    expect(k.files.map((f) => f.status).sort()).toEqual(["extracted", "replaced"]);
  });
});

describe("publish and call", () => {
  it("publish: compiled with only this agent's APPROVED knowledge, checked by the voice backend, then live", async () => {
    const a = await createAgent();
    const other = await createAgent("en", { ...AGENT, name: "Other", businessName: "XYZ" });
    await upload(a.id, [{ name: "k.csv", text: CSV }]);
    await upload(other.id, [{ name: "o.csv", text: "Topic,Answer\nSecret,Other customer's private note.\n" }]);
    await req("POST", `/api/ai-agents/${other.id}/knowledge/decide`, { ids: T("aiAgentKnowledgeItem").filter((i) => i.agentId === other.id).map((i) => i.id), status: "approved" });
    const billing = T("aiAgentKnowledgeItem").find((i) => i.topic === "Billing")!;
    await req("POST", `/api/ai-agents/${a.id}/knowledge/decide`, { ids: [billing.id], status: "approved" });

    const r = await req("POST", `/api/ai-agents/${a.id}/publish`);
    expect(r.status).toBe(200);
    const out = (await r.json()) as { flowId: string; version: number; agent: { unpublishedChanges: boolean; liveVersion: number } };
    expect(out.version).toBe(1);
    expect(out.agent).toMatchObject({ unpublishedChanges: false, liveVersion: 1 });
    const sent = JSON.stringify(previews.at(-1)!.flow);
    expect(sent).toContain("Kagzso automates billing follow-ups.");
    expect(sent).not.toContain("It works alongside"); // a draft item
    expect(sent).not.toContain("private note"); // another agent's knowledge
    expect(sent).toContain('"autonomous"');
    const flow = T("callFlow").find((f) => f.id === out.flowId)!;
    expect(flow).toMatchObject({ base: "executive", language: "en" });

    // A change to the settings shows as unpublished; publishing again makes v2 of the same flow.
    await req("PUT", `/api/ai-agents/${a.id}`, { agent: { ...AGENT, instructions: "Never discuss competitors." } });
    expect(((await (await req("GET", `/api/ai-agents/${a.id}`)).json()) as { unpublishedChanges: boolean }).unpublishedChanges).toBe(true);
    const again = (await (await req("POST", `/api/ai-agents/${a.id}/publish`)).json()) as { flowId: string; version: number };
    expect(again).toMatchObject({ flowId: out.flowId, version: 2 });
  });

  it("a flow the voice backend rejects is not published", async () => {
    const a = await createAgent("en", { ...AGENT, instructions: "REJECT-ME" });
    const r = await req("POST", `/api/ai-agents/${a.id}/publish`);
    expect(r.status).toBe(400);
    expect(T("callFlowVersion").some((v) => v.status === "PUBLISHED")).toBe(false);
  });

  it("call: needs a published agent; then one row through the normal run, neutral for Not specified", async () => {
    const a = await createAgent("en", { ...AGENT, contactGender: "unspecified" });
    expect((await req("POST", `/api/ai-agents/${a.id}/call`, { dryRun: true }, "EDITOR")).status).toBe(409);
    const { flowId } = (await (await req("POST", `/api/ai-agents/${a.id}/publish`)).json()) as { flowId: string };
    const r = await req("POST", `/api/ai-agents/${a.id}/call`, { dryRun: true }, "EDITOR");
    expect(r.status).toBe(200);
    const [input, user, , opts] = runCalls[0] as [Record<string, unknown>, { email: string }, unknown, { neutralGenderRows: Set<number> }];
    expect(input).toMatchObject({ flowId, language: "en", maxCalls: 1, dryRun: true, rows: [{ phone: "+919876543210", customerName: "Ragul", gender: null }] });
    expect(user.email).toBe("editor@test");
    expect([...opts.neutralGenderRows]).toEqual([0]);
    // Another number and gender for this call only.
    await req("POST", `/api/ai-agents/${a.id}/call`, { phone: "+919811122233", customerName: "Priya", gender: "female", dryRun: true });
    expect(runCalls[1]![0]).toMatchObject({ rows: [{ phone: "+919811122233", customerName: "Priya", gender: "female" }] });
    expect(runCalls[1]![3]).toBeUndefined();
  });

  it("preview: rendered by the voice backend with the agent's contact as the sample", async () => {
    const a = await createAgent("en", { ...AGENT, contactGender: "unspecified" });
    const r = await req("POST", `/api/ai-agents/${a.id}/preview`, {});
    expect(r.status).toBe(200);
    expect(previews.at(-1)!.sample).toEqual({ customer_name: "Ragul", gender: "unknown" });
  });

  it("guided agents call with their picked Call Flow and have nothing to compile", async () => {
    T("callFlow").push({ id: "nila_copy", name: "Nila", base: "nila", language: "en", archivedAt: null });
    T("callFlowVersion").push({ id: "v_n1", flowId: "nila_copy", version: 1, status: "PUBLISHED", definition: {} });
    const g = await createAgent("en", { name: "Guided", mode: "guided", guidedFlowId: "nila_copy", contactPhone: "+919876543210" });
    expect((await req("POST", `/api/ai-agents/${g.id}/publish`)).status).toBe(400);
    await req("POST", `/api/ai-agents/${g.id}/call`, { dryRun: true });
    expect(runCalls[0]![0]).toMatchObject({ flowId: "nila_copy" });
    // A flow of another language can't be picked.
    T("callFlow").push({ id: "ta_flow", name: "Tamil", base: "nila", language: "ta", archivedAt: null });
    expect((await req("POST", "/api/ai-agents", { language: "en", agent: { name: "x", mode: "guided", guidedFlowId: "ta_flow" } })).status).toBe(400);
  });
});
