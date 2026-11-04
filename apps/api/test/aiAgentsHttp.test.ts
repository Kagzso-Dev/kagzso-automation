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
// The built-in flows exactly as each language's voice backend serves them (unset optional settings as null),
// from the voice backend's contract test (tests/test_flow_catalog_contract.py).
const CATALOGS: Record<string, { language: string; flows: Record<string, Record<string, unknown>> }> = Object.fromEntries(
  ["en", "ta", "hi", "kn"].map((l) => [l, JSON.parse(read(`kagzso-voice-backend-english/tests/fixtures/catalog/${l}.json`))]),
);

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
    // The Voice Call Flows list includes each flow's versions.
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
      T("callFlow")
        .filter((r) => matches(r, where))
        .map((f) => ({ ...f, versions: T("callFlowVersion").filter((v) => v.flowId === f.id) })),
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
// The rate limits are per user: tests that make many requests act as an admin of their own (adminSub).
let adminSub = "u-ADMIN";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: role === "ADMIN" ? adminSub : `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const req = (method: string, path: string, body?: unknown, role: "ADMIN" | "EDITOR" = "ADMIN") =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(role)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const upload = (agentId: string, files: { name: string; text: string | Uint8Array }[], extra: Record<string, string> = {}) => {
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
      // One fake backend for every language: Tamil / Hindi / Kannada are served under /ta, /hi, /kn.
      const [, lang = "en", path = r.url] = r.url!.match(/^\/(ta|hi|kn)(\/.*)$/) ?? [];
      if (path === "/api/flows/builtin") {
        res.end(JSON.stringify({ ...CATALOGS[lang], locked_blocks: {}, variables: [], groups: [] }));
      } else if (path === "/api/flows/preview") {
        const body = JSON.parse(raw);
        previews.push({ ...body, backend: lang });
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
  for (const l of ["ta", "hi", "kn"]) process.env[`VOICE_BACKEND_URL_${l.toUpperCase()}`] = `${process.env.VOICE_BACKEND_URL}/${l}`;
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

  it("only admins change anything or read the knowledge; editors are stopped at the role gate", async () => {
    const a = await createAgent();
    await upload(a.id, [{ name: "k.csv", text: CSV }]);
    const item = T("aiAgentKnowledgeItem")[0]!.id;
    const file = T("aiAgentKnowledgeFile")[0]!.id;
    const before = JSON.stringify(tables);
    const editorCalls: [string, string, unknown?][] = [
      ["GET", `/api/ai-agents/${a.id}/knowledge`],
      ["PUT", `/api/ai-agents/${a.id}`, { agent: AGENT }],
      ["DELETE", `/api/ai-agents/${a.id}`],
      ["DELETE", `/api/ai-agents/${a.id}/knowledge/files/${file}`],
      ["POST", `/api/ai-agents/${a.id}/knowledge/items`, { kind: "fact", topic: "X", text: "Y", questions: [], always: false }],
      ["PATCH", `/api/ai-agents/${a.id}/knowledge/items/${item}`, { text: "changed" }],
      ["DELETE", `/api/ai-agents/${a.id}/knowledge/items/${item}`],
      ["POST", `/api/ai-agents/${a.id}/knowledge/decide`, { ids: [item], status: "approved" }],
      ["POST", `/api/ai-agents/${a.id}/preview`, {}],
      ["POST", `/api/ai-agents/${a.id}/knowledge-test`, { message: "hi" }],
      ["POST", `/api/ai-agents/${a.id}/publish`, {}],
      ["POST", "/api/ai-agents/library/categories", { name: "X" }],
    ];
    for (const [method, path, body] of editorCalls) {
      expect((await req(method, path, body, "EDITOR")).status, `${method} ${path}`).toBe(403);
    }
    expect(JSON.stringify(tables)).toBe(before);
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

  it("a scanned (image-only) PDF is refused with a clear message, and never replaces good knowledge", async () => {
    const scanned = new Uint8Array(readFileSync(new URL("./fixtures/knowledge/scanned.pdf", import.meta.url)));
    const a = await createAgent();
    await upload(a.id, [{ name: "k.csv", text: CSV }]);
    const fileId = T("aiAgentKnowledgeFile")[0]!.id;
    const itemId = T("aiAgentKnowledgeItem")[0]!.id;
    await req("POST", `/api/ai-agents/${a.id}/knowledge/decide`, { ids: [itemId], status: "approved" });
    const r = await upload(a.id, [{ name: "letter.pdf", text: scanned }], { replacesFileId: fileId });
    const saved = ((await r.json()) as { files: { status: string; error: string; itemCount: number }[] }).files[0]!;
    expect(saved.status).toBe("failed");
    expect(saved.error).toMatch(/no selectable text.*scanned or image-only.*not supported/);
    expect(saved.itemCount).toBe(0);
    const k = (await (await req("GET", `/api/ai-agents/${a.id}/knowledge`)).json()) as { files: { id: string; status: string }[]; items: { id: string; status: string }[] };
    expect(k.files.find((f) => f.id === fileId)?.status).toBe("extracted"); // the old file stays
    expect(k.items.find((i) => i.id === itemId)?.status).toBe("approved"); // and its approved items
  });

  it("upload limits answer with a readable 400 (not a server error)", async () => {
    const a = await createAgent();
    const big = await upload(a.id, [{ name: "big.txt", text: new Uint8Array(10 * 1024 * 1024 + 1) }]);
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toBe("Each file must be 10 MB or smaller");
    const many = await upload(a.id, Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, text: "Billing: Kagzso automates billing." })));
    expect(many.status).toBe(400);
    expect(((await many.json()) as { error: string }).error).toMatch(/At most 10 files per upload/);
    expect(T("aiAgentKnowledgeFile")).toEqual([]);
  });

  it("a real text PDF upload becomes draft items with page sources", async () => {
    const pdf = new Uint8Array(readFileSync(new URL("./fixtures/knowledge/multipage.pdf", import.meta.url)));
    const a = await createAgent();
    const saved = ((await (await upload(a.id, [{ name: "guide.pdf", text: pdf }])).json()) as { files: { status: string; itemCount: number }[] }).files[0]!;
    expect(saved).toMatchObject({ status: "extracted", itemCount: 3 });
    const k = (await (await req("GET", `/api/ai-agents/${a.id}/knowledge`)).json()) as { items: { topic: string; status: string; source: string }[] };
    expect(k.items.map((i) => [i.topic, i.source, i.status])).toEqual([
      ["Section 1", "page 1", "draft"], ["Section 2", "page 2", "draft"], ["Section 3", "page 3", "draft"],
    ]);
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

describe("the generated Call Flow is managed by its agent", () => {
  async function published() {
    const a = await createAgent();
    const r = await req("POST", `/api/ai-agents/${a.id}/publish`);
    expect(r.status).toBe(200);
    const { flowId } = (await r.json()) as { flowId: string };
    return { a, flowId };
  }
  const snapshot = () => JSON.stringify([T("callFlow"), T("callFlowVersion")]);

  it("Voice Call Flows can't change it: every write is refused with the reason, nothing changes", async () => {
    const { a, flowId } = await published();
    const definition = T("callFlowVersion").find((v) => v.flowId === flowId)!.definition;
    const before = snapshot();
    const writes: [string, string, unknown?][] = [
      ["PUT", `/api/call-flows/${flowId}/draft`, { definition }],
      ["DELETE", `/api/call-flows/${flowId}/draft`],
      ["POST", `/api/call-flows/${flowId}/publish`],
      ["POST", `/api/call-flows/${flowId}/versions/1/restore`],
      ["DELETE", `/api/call-flows/${flowId}/versions/1`],
      ["POST", `/api/call-flows/${flowId}/archive`],
      ["DELETE", `/api/call-flows/${flowId}`, { confirm: "DELETE" }],
    ];
    for (const [method, path, body] of writes) {
      const r = await req(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(409);
      expect(((await r.json()) as { error: string }).error).toMatch(/generated by the AI Agent "ABC Hospital - Thaara".*Copy this flow/);
    }
    expect(snapshot()).toBe(before);
    // Viewing works and says who manages it (the list too).
    const detail = (await (await req("GET", `/api/call-flows/${flowId}`)).json()) as { managedBy: unknown };
    expect(detail.managedBy).toEqual({ agentId: a.id, agentName: "ABC Hospital - Thaara" });
    const list = (await (await req("GET", "/api/call-flows")).json()) as { items: { id: string; managedBy: unknown }[] };
    expect(list.items.find((f) => f.id === flowId)?.managedBy).toEqual({ agentId: a.id, agentName: "ABC Hospital - Thaara" });
  });

  it("an ordinary flow is not managed; an archived agent's flow becomes an ordinary flow again", async () => {
    const { a, flowId } = await published();
    T("callFlow").push({ id: "plain", name: "Plain", base: "executive", language: "en", archivedAt: null, updatedAt: new Date() });
    expect(((await (await req("GET", "/api/call-flows/plain")).json()) as { managedBy: unknown }).managedBy).toBeNull();
    expect((await req("DELETE", `/api/ai-agents/${a.id}`)).status).toBeLessThan(300);
    expect(((await (await req("GET", `/api/call-flows/${flowId}`)).json()) as { managedBy: unknown }).managedBy).toBeNull();
    expect((await req("POST", `/api/call-flows/${flowId}/archive`)).status).toBe(200);
  });

  it("publishing never silently replaces a draft left on the flow: it asks, then replaces only when confirmed", async () => {
    const { a, flowId } = await published();
    const live = T("callFlowVersion").find((v) => v.flowId === flowId)!;
    // A hand edit saved before generated flows were read-only.
    T("callFlowVersion").push({ ...live, id: "hand", version: 2, status: "DRAFT", publishedAt: null, createdByEmail: "ops@test", definition: { hand: true } });
    const before = snapshot();
    const r = await req("POST", `/api/ai-agents/${a.id}/publish`, {});
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; code: string; details: { draftConflict: { version: number; by: string } } };
    expect(body.code).toBe("draft_conflict");
    expect(body.details.draftConflict).toMatchObject({ version: 2, by: "ops@test" });
    expect(body.error).toMatch(/unpublished draft \(v2, saved by ops@test\).*Copy the flow/);
    expect(snapshot()).toBe(before); // nothing replaced
    const ok = await req("POST", `/api/ai-agents/${a.id}/publish`, { replaceDraft: true });
    expect(ok.status).toBe(200);
    expect(T("callFlowVersion").find((v) => v.id === "hand")!.definition).not.toEqual({ hand: true });
  });

  it("the agent's own publishes never ask (no draft is left behind)", async () => {
    const { a } = await published();
    expect((await req("POST", `/api/ai-agents/${a.id}/publish`, {})).status).toBe(200);
    expect((await req("POST", `/api/ai-agents/${a.id}/publish`)).status).toBe(200);
  });
});

describe("Kannada Autonomous AI calls are paused (until native-speaker review)", () => {
  /** An agent of `language` whose own flow already has a live autonomous version (as after a publish). */
  async function liveAgent(language: string, agent: Record<string, unknown> = AGENT) {
    const a = await createAgent(language, agent);
    const flowId = `flow_${a.id}`;
    T("callFlow").push({ id: flowId, name: "Agent flow", base: "executive", language, archivedAt: null });
    T("callFlowVersion").push({
      id: `v_${a.id}`, flowId, version: 1, status: "PUBLISHED", definition: { language, autonomous: { target_duration_sec: 60, dnc_enforce: true } },
    });
    T("aiAgent").find((r) => r.id === a.id)!.callFlowId = flowId;
    return a;
  }

  it("a Kannada autonomous agent can't call (check or real), with the reason; nothing is planned", async () => {
    const a = await liveAgent("kn");
    for (const body of [{ dryRun: true }, {}]) {
      const r = await req("POST", `/api/ai-agents/${a.id}/call`, body);
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toMatch(/^Kannada Autonomous AI calls are paused until a native speaker/);
    }
    expect(runCalls).toEqual([]);
  });

  it("Kannada agents can still be created, edited and given knowledge", async () => {
    const a = await createAgent("kn");
    expect((await req("PUT", `/api/ai-agents/${a.id}`, { agent: { ...AGENT, name: "Kannada - edited" } })).status).toBe(200);
    const up = await upload(a.id, [{ name: "k.csv", text: CSV }]);
    expect(up.status).toBe(201);
    expect(T("aiAgentKnowledgeItem").filter((i) => i.agentId === a.id).length).toBeGreaterThan(0);
    const k = await req("POST", `/api/ai-agents/${a.id}/knowledge/decide`, { ids: [T("aiAgentKnowledgeItem")[0]!.id], status: "approved" });
    expect(k.status).toBe(200);
  });

  it("English, Tamil and Hindi autonomous agents and Kannada GUIDED agents call as before", async () => {
    for (const language of ["en", "ta", "hi"]) {
      const a = await liveAgent(language);
      expect((await req("POST", `/api/ai-agents/${a.id}/call`, { dryRun: true })).status, language).toBe(200);
    }
    T("callFlow").push({ id: "kn_nila", name: "Kannada Nila", base: "nila", language: "kn", archivedAt: null });
    T("callFlowVersion").push({ id: "v_kn1", flowId: "kn_nila", version: 1, status: "PUBLISHED", definition: { language: "kn" } });
    const g = await createAgent("kn", { name: "Guided kn", mode: "guided", guidedFlowId: "kn_nila", contactPhone: "+919876543210" });
    expect((await req("POST", `/api/ai-agents/${g.id}/call`, { dryRun: true })).status).toBe(200);
    expect(runCalls).toHaveLength(4);
    expect(runCalls[3]![0]).toMatchObject({ flowId: "kn_nila" });
  });
});

describe("Preview and Publish with the built-in flows a real voice backend serves (unset settings as null)", () => {
  let n = 0;
  beforeEach(() => void (adminSub = `u-admin-catalog-${++n}`));
  afterAll(() => void (adminSub = "u-ADMIN"));
  const GREETING = { en: "This is Thaara calling from", ta: "நான் Thaara", hi: "मेरा नाम Thaara", kn: "ನಾನು Thaara" } as const;

  it.each(["en", "ta", "hi", "kn"] as const)("%s: Raagul, male, one approved item - preview and publish succeed", async (lang) => {
    expect(JSON.stringify(CATALOGS[lang]!.flows.executive)).toMatch(/"language_style":null.*"autonomous":null|"autonomous":null.*"language_style":null/);
    const a = await createAgent(lang, { ...AGENT, name: `Thaara ${lang}`, contactName: "Raagul", contactGender: "male" });
    await upload(a.id, [{ name: "k.csv", text: "Topic,Answer,Question\nIntegration,It works alongside your software.,Will it replace our software?\n" }]);
    const item = T("aiAgentKnowledgeItem").find((i) => i.agentId === a.id)!;
    expect((await req("POST", `/api/ai-agents/${a.id}/knowledge/decide`, { ids: [item.id], status: "approved" })).status).toBe(200);

    const preview = await req("POST", `/api/ai-agents/${a.id}/preview`, { customerName: "Raagul", gender: "male" });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const sent = previews.at(-1)! as { backend: string; sample: unknown; flow: Record<string, unknown> & { training: { knowledge: { status: string; topic: string; text: string }[] } } };
    expect(sent.backend).toBe(lang); // asked the agent's own language's voice backend
    expect(sent.sample).toEqual({ customer_name: "Raagul", gender: "male" });
    expect(sent.flow.language).toBe(lang);
    expect(sent.flow).not.toHaveProperty("language_style");
    expect(sent.flow.autonomous).toEqual({ target_duration_sec: 60, dnc_enforce: true });
    expect(String((sent.flow.greeting as { text: string }).text)).toContain(GREETING[lang]);
    expect(sent.flow.training.knowledge.map((k) => [k.status, k.topic, k.text])).toEqual([
      ["active", "Integration", "It works alongside your software."],
    ]);

    const pub = await req("POST", `/api/ai-agents/${a.id}/publish`, {});
    expect(pub.status, await pub.clone().text()).toBe(200);
    const { flowId, version } = (await pub.json()) as { flowId: string; version: number };
    expect(version).toBe(1);
    const live = T("callFlowVersion").find((v) => v.flowId === flowId && v.status === "PUBLISHED")!;
    const def = live.definition as Record<string, unknown> & { training: { knowledge: { topic: string }[] } };
    expect(def.language).toBe(lang);
    expect(def.training.knowledge.map((k) => k.topic)).toEqual(["Integration"]);
    expect(T("callFlow").find((f) => f.id === flowId)!.language).toBe(lang);
  });

  it("a built-in that is really invalid is named in the error (field: message)", async () => {
    const { compileAgent } = await import("../src/domain/aiAgents.js");
    const a = await createAgent("ta");
    const row = T("aiAgent").find((r) => r.id === a.id)!;
    const broken = { ...CATALOGS.ta!.flows.executive, language_style: null, autonomous: null, greeting: null };
    await expect(compileAgent(row as never, broken)).rejects.toThrow(
      /^The voice backend's built-in Business executive flow failed validation \(greeting: .+; language_style: .+; autonomous: .+\)$/,
    );
  });
});

describe("Voice Call Flows: New flow from a built-in (unset settings as null)", () => {
  let n = 0;
  beforeEach(() => void (adminSub = `u-admin-newflow-${++n}`));
  afterAll(() => void (adminSub = "u-ADMIN"));
  it.each(["en", "ta", "hi", "kn"] as const)("%s: every base can be copied into a new draft", async (lang) => {
    for (const b of ["executive", "nila", "followup"] as const) {
      const r = await req("POST", "/api/call-flows", { name: `My ${b} (${lang})`, base: b, language: lang });
      expect(r.status, `${lang} ${b}: ${await r.clone().text()}`).toBe(201);
      const { id } = (await r.json()) as { id: string };
      const draft = T("callFlowVersion").find((v) => v.flowId === id)!;
      expect(draft).toMatchObject({ version: 1, status: "DRAFT" });
      const def = draft.definition as Record<string, unknown>;
      expect(def).toMatchObject({ base: b, language: lang, name: `My ${b} (${lang})` });
      expect(def).not.toHaveProperty("language_style");
      expect(def).not.toHaveProperty("autonomous");
      // The draft is the served built-in with only the unset settings left out (plus its new name).
      const { language_style: _ls, autonomous: _au, ...rest } = CATALOGS[lang]!.flows[b]!;
      expect(def).toEqual({ ...rest, name: `My ${b} (${lang})`, language: lang });
    }
  });
});
