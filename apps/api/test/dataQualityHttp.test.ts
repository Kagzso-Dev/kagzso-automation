import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DQ_DO_NOT_CALL,
  DQ_EXPECTED,
  DQ_IN_VOICECALL,
  DQ_IN_WHATSAPP,
  DQ_NOT_INTERESTED,
  DQ_WRONG_PERSON,
  dqCsv,
} from "./dataQualityFixture.js";

// Data Quality end to end: upload the 20-row file over HTTP, run the background AI scoring
// against a fake LOCAL Ollama, and record every outbound request the server makes. Prisma is an
// in-memory store that only allows writes to the two staging tables; existing tables are read-only.

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const tables: Record<"dataQualityJob" | "dataQualityRecord", Row[]> = { dataQualityJob: [], dataQualityRecord: [] };
const writes: string[] = [];
let seq = 0;
let liveRun = false;

const clone = <T,>(v: T): T => structuredClone(v);
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) return "in" in v ? (v.in as unknown[]).includes(row[k]) : false;
    return row[k] === v;
  });
}
function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === "object" && "increment" in v ? row[k] + v.increment : v;
  row.updatedAt = new Date();
}
function sortRows(rows: Row[], orderBy?: Row) {
  const [[key, dir] = []] = Object.entries(orderBy ?? {});
  return key ? [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (dir === "desc" ? -1 : 1)) : rows;
}
const DEFAULTS = {
  dataQualityJob: () => ({ status: "RUNNING", aiStatus: "pending", aiDone: 0, aiFailures: 0, note: null, waitingReason: null, runToken: null, finishedAt: null }),
  dataQualityRecord: () => ({ aiState: "NONE", aiScore: null, aiNotes: null, review: "PENDING" }),
};
function stagingModel(name: keyof typeof tables) {
  const all = () => tables[name];
  const fresh = (data: Row) => ({ id: `${name}-${++seq}`, createdAt: new Date(Date.now() + seq), updatedAt: new Date(), ...DEFAULTS[name](), ...data });
  return {
    create: async ({ data }: { data: Row }) => (writes.push(`${name}.create`), all().push(fresh(data)), clone(all().at(-1)!)),
    createMany: async ({ data }: { data: Row[] }) => (writes.push(`${name}.createMany`), all().push(...data.map(fresh)), { count: data.length }),
    findUnique: async ({ where }: { where: Row }) => clone(all().find((r) => matches(r, where)) ?? null),
    findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Row }) => clone(sortRows(all().filter((r) => matches(r, where)), orderBy)[0] ?? null),
    findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number } = {}) =>
      clone(sortRows(all().filter((r) => matches(r, where)), orderBy).slice(0, take ?? Infinity)),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.update`);
      const r = all().find((x) => matches(x, where))!;
      apply(r, data);
      return clone(r);
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.updateMany`);
      const hit = all().filter((r) => matches(r, where));
      hit.forEach((r) => apply(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }: { where: Row }) => {
      writes.push(`${name}.delete`);
      const r = all().find((x) => matches(x, where))!;
      tables[name] = all().filter((x) => x !== r);
      if (name === "dataQualityJob") tables.dataQualityRecord = tables.dataQualityRecord.filter((x) => x.jobId !== r.id); // cascade
      return r;
    },
  };
}

// Existing tables: read-only (no create / update / delete methods exist, so a write would throw).
const callLogs = [
  { phone: DQ_NOT_INTERESTED, outcome: "not_interested" },
  { phone: DQ_WRONG_PERSON, outcome: "wrong_person" },
];
const customers = [{ phone: DQ_IN_VOICECALL, activePhone: DQ_IN_VOICECALL, stage: "NOT_CALLED" }];
const readOnly = (rows: Row[]) => ({ findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)) });
const db = {
  dataQualityJob: stagingModel("dataQualityJob"),
  dataQualityRecord: stagingModel("dataQualityRecord"),
  aiCallRun: { findFirst: async () => (liveRun ? { id: "run-live" } : null) },
  aiCallLog: readOnly(callLogs),
  aiCallCustomer: readOnly(customers),
  whatsAppContact: readOnly([{ phone: DQ_IN_WHATSAPP.slice(1) }]),
  contact: readOnly([{ email: "mohan@example.com" }]),
};
vi.mock("../src/prisma.js", () => ({ prisma: db }));
vi.mock("../src/domain/aiCalls.js", async (orig) => ({
  ...(await orig<typeof import("../src/domain/aiCalls.js")>()),
  loadDoNotCallPhones: async () => new Set([DQ_DO_NOT_CALL]),
}));
const enqueued: { jobId: string; runToken: string }[] = [];
vi.mock("../src/queue/queues.js", async (orig) => ({
  ...(await orig<typeof import("../src/queue/queues.js")>()),
  enqueueDataQuality: async (job: { jobId: string; runToken: string }) => void enqueued.push(job),
}));

/* ---------------------------------------------------------------- fake local Ollama */

let ollamaUp = true;
let rateLimitNext = false; // the next generation answers 429 "too many requests"
const prompts: string[] = [];
let ollama: Server;
let ollamaBase = "";

/* ---------------------------------------------------------------- outbound request log */

const realFetch = globalThis.fetch;
let outbound: string[] = [];
let apiBase = "";

let server: Server;
let processDataQuality: (p: Record<string, unknown>) => Promise<unknown>;
let DeferJobError: typeof import("../src/queue/engine.js").DeferJobError;

beforeAll(async () => {
  ollama = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (!ollamaUp) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: "server is starting" }));
      }
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
      if (rateLimitNext) {
        rateLimitNext = false;
        res.statusCode = 429;
        res.setHeader("retry-after", "20");
        return res.end(JSON.stringify({ error: "too many requests" }));
      }
      const { prompt } = JSON.parse(body) as { prompt: string };
      prompts.push(prompt);
      res.end(JSON.stringify({ response: JSON.stringify({ score: 80, issues: ["looks real"] }) }));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => ollama.once("listening", r));
  ollamaBase = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
  process.env.OLLAMA_BASE_URL = ollamaBase;
  process.env.OLLAMA_MODEL = "llama3.2";
  process.env.DATA_QUALITY_AI_TIMEOUT_SEC = "10";

  ({ processDataQuality } = await import("../src/queue/dataQuality.js"));
  ({ DeferJobError } = await import("../src/queue/engine.js"));
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Every fetch in this process is logged; the test's own calls to the API are left out below.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(apiBase)) outbound.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => ollama.close(() => r()));
});
beforeEach(() => {
  tables.dataQualityJob = [];
  tables.dataQualityRecord = [];
  writes.length = 0;
  enqueued.length = 0;
  prompts.length = 0;
  outbound = [];
  ollamaUp = true;
  liveRun = false;
  rateLimitNext = false;
});
afterEach(() => {
  // The rule for every test: the server talked to nothing but the local Ollama.
  for (const line of outbound) expect(line.split(" ")[1]!.startsWith(`${ollamaBase}/api/`)).toBe(true);
});

const token = (role: "ADMIN" | "EDITOR") => jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const call = (path: string, { method = "GET", role = "ADMIN" as "ADMIN" | "EDITOR", json, body }: { method?: string; role?: "ADMIN" | "EDITOR"; json?: unknown; body?: FormData } = {}) =>
  realFetch(apiBase + path, {
    method,
    headers: { Authorization: `Bearer ${token(role)}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body ?? (json !== undefined ? JSON.stringify(json) : undefined),
  });
const uploadFixture = async (role: "ADMIN" | "EDITOR" = "ADMIN") => {
  const fd = new FormData();
  fd.append("file", new Blob([dqCsv()], { type: "text/csv" }), "leads.csv");
  return call("/api/data-quality/jobs", { method: "POST", role, body: fd });
};
/** Run the background job until it finishes, or until it waits longer than a normal step. */
async function drain(payload: { jobId: string; runToken: string }): Promise<unknown> {
  for (let i = 0; i < 200; i++) {
    try {
      return await processDataQuality(payload);
    } catch (err) {
      if (!(err instanceof DeferJobError)) throw err;
      if (err.runAt.getTime() - Date.now() > 5000) return "waiting";
    }
  }
  throw new Error("job never finished");
}
const records = () => tables.dataQualityRecord;
const job = () => tables.dataQualityJob[0]!;

describe("access", () => {
  it("admins only: editors get 403, nobody signed in gets 401", async () => {
    for (const path of ["/api/data-quality/status", "/api/data-quality/jobs"]) {
      expect((await call(path, { role: "EDITOR" })).status).toBe(403);
      expect((await realFetch(apiBase + path)).status).toBe(401);
    }
    expect((await uploadFixture("EDITOR")).status).toBe(403);
    expect(tables.dataQualityJob).toHaveLength(0);
  });
});

describe("the 20-row file with Ollama running", () => {
  it("checks, stages, AI-scores the valid rows and calls nothing but the local Ollama", async () => {
    const res = await uploadFixture();
    expect(res.status).toBe(201);
    const { job: created } = (await res.json()) as { job: Row };
    expect(created).toMatchObject({ ...DQ_EXPECTED, status: "RUNNING", aiStatus: "pending", aiModel: "llama3.2 (Ollama)" });
    expect(enqueued).toEqual([{ jobId: created.id, runToken: created.runToken }]);

    expect(await drain(enqueued[0]!)).toEqual({ done: true });
    expect(job()).toMatchObject({ status: "DONE", aiStatus: "done", aiDone: 14, aiFailures: 0 });
    const valid = records().filter((r) => r.status === "VALID");
    expect(valid.every((r) => r.aiState === "DONE" && r.aiScore === 80)).toBe(true);
    // Excluded, invalid and duplicate rows were never scored or sent.
    for (const r of records().filter((x) => x.status !== "VALID")) expect([r.ruleScore, r.aiScore, r.aiState]).toEqual([null, null, "NONE"]);
    expect(prompts).toHaveLength(14);
    expect(prompts.some((p) => /9876|@/.test(p))).toBe(false); // no phone number or email left the API process
    expect(prompts.some((p) => p.includes("Dinesh"))).toBe(false); // the do-not-call row

    // The network call list: 1 health check on upload, then a health check + one generation per valid row.
    const list = outbound.map((l) => l.replace(ollamaBase, "<ollama>"));
    console.info(`Outbound requests (${list.length}):\n  ${[...new Set(list)].map((l) => `${l} ×${list.filter((x) => x === l).length}`).join("\n  ")}`);
    expect(new Set(list)).toEqual(new Set(["GET <ollama>/api/tags", "POST <ollama>/api/generate"]));
    expect(list.filter((l) => l.endsWith("/api/generate"))).toHaveLength(14);

    // Only the two staging tables were written.
    expect(new Set(writes.map((w) => w.split(".")[0]))).toEqual(new Set(["dataQualityJob", "dataQualityRecord"]));

    const detail = (await (await call(`/api/data-quality/jobs/${created.id}`)).json()) as { records: Row[] };
    expect(detail.records.find((r) => r.rowIndex === 0)).toMatchObject({ ruleScore: 100, aiScore: 80, score: 90 });
    expect(detail.records.find((r) => r.phone === DQ_DO_NOT_CALL)).toMatchObject({ status: "EXCLUDED", excludedReason: "do_not_call", score: null });
  });

  it("review approves only VALID rows; the export holds only the approved ones", async () => {
    const { job: created } = (await (await uploadFixture()).json()) as { job: Row };
    const ravi = records().find((r) => r.rowIndex === 0)!;
    const excluded = records().find((r) => r.status === "EXCLUDED")!;
    const dup = records().find((r) => r.status === "DUPLICATE")!;
    const res = await call(`/api/data-quality/jobs/${created.id}/review`, { method: "POST", json: { ids: [ravi.id, excluded.id, dup.id], review: "APPROVED" } });
    expect(await res.json()).toEqual({ updated: 1 });
    expect([excluded.review, dup.review]).toEqual(["PENDING", "PENDING"]);

    const csv = await (await call(`/api/data-quality/jobs/${created.id}/export?rows=approved`)).text();
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^2,Ravi Kumar,\+919876500001,Ravi Traders,ravi@example.com,/);
    const all = await (await call(`/api/data-quality/jobs/${created.id}/export?rows=valid`)).text();
    expect(all.trim().split("\r\n")).toHaveLength(1 + DQ_EXPECTED.valid);
    expect(all).not.toContain("Dinesh");
  });
});

describe("Ollama not available", () => {
  it("runs only the standard checks and says so", async () => {
    ollamaUp = false;
    const status = (await (await call("/api/data-quality/status")).json()) as { ai: Row };
    expect(status.ai).toMatchObject({ provider: "ollama", configured: true, available: false });
    const { job: created } = (await (await uploadFixture()).json()) as { job: Row };
    expect(created).toMatchObject({ ...DQ_EXPECTED, status: "DONE", aiStatus: "unavailable" });
    expect(created.note).toMatch(/^Ollama not available: Ollama 503/);
    expect(enqueued).toHaveLength(0);
    const valid = records().filter((r) => r.status === "VALID");
    expect(valid.every((r) => r.aiState === "SKIPPED" && typeof r.ruleScore === "number")).toBe(true);
    expect(outbound.every((l) => l.endsWith("/api/tags"))).toBe(true);
  });

  it("Ollama going down mid-job skips the rest and keeps the checks", async () => {
    await uploadFixture();
    ollamaUp = false;
    expect(await drain(enqueued[0]!)).toEqual({ stopped: "ai unavailable" });
    expect(job()).toMatchObject({ status: "DONE", aiStatus: "unavailable" });
    expect(records().filter((r) => r.aiState === "PENDING")).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });
});

describe("background job controls", () => {
  it("too many requests: waits and tries the same row again, without counting a failure", async () => {
    await uploadFixture();
    rateLimitNext = true;
    expect(await drain(enqueued[0]!)).toBe("waiting"); // deferred ~20s (Retry-After)
    expect(job()).toMatchObject({ status: "RUNNING", aiFailures: 0, aiDone: 0, waitingReason: expect.stringMatching(/rate limit/) });
    expect(records().find((r) => r.rowIndex === 0)!.aiState).toBe("PENDING");
    expect(await drain(enqueued[0]!)).toEqual({ done: true });
    expect(job()).toMatchObject({ status: "DONE", aiDone: 14, aiFailures: 0, waitingReason: null });
  });

  it("waits while live AI calls run, then goes on", async () => {
    await uploadFixture();
    liveRun = true;
    expect(await drain(enqueued[0]!)).toBe("waiting");
    expect(job().waitingReason).toMatch(/live AI calls/);
    expect(prompts).toHaveLength(0);
    liveRun = false;
    expect(await drain(enqueued[0]!)).toEqual({ done: true });
    expect(job().waitingReason).toBeNull();
  });

  it("pause stops it, resume goes on with a new token (the old queued run stops), cancel ends it", async () => {
    const { job: created } = (await (await uploadFixture()).json()) as { job: Row };
    const first = enqueued[0]!;
    expect((await call(`/api/data-quality/jobs/${created.id}/pause`, { method: "POST" })).status).toBe(200);
    expect(await drain(first)).toEqual({ stopped: "PAUSED" });
    expect((await call(`/api/data-quality/jobs/${created.id}/pause`, { method: "POST" })).status).toBe(409);
    expect((await call(`/api/data-quality/jobs/${created.id}`, { method: "DELETE" })).status).toBe(200); // paused → may be removed
    expect(tables.dataQualityJob).toHaveLength(0);
    expect(records()).toHaveLength(0); // its rows went with it

    const { job: again } = (await (await uploadFixture()).json()) as { job: Row };
    await call(`/api/data-quality/jobs/${again.id}/pause`, { method: "POST" });
    expect((await call(`/api/data-quality/jobs/${again.id}/resume`, { method: "POST" })).status).toBe(200);
    const resumed = enqueued.at(-1)!;
    expect(resumed.runToken).not.toBe(enqueued.at(-2)!.runToken);
    expect(await drain(enqueued.at(-2)!)).toEqual({ stopped: "RUNNING" }); // stale copy: wrong token
    expect((await call(`/api/data-quality/jobs/${again.id}`, { method: "DELETE" })).status).toBe(409); // running
    expect((await call(`/api/data-quality/jobs/${again.id}/cancel`, { method: "POST" })).status).toBe(200);
    expect(await drain(resumed)).toEqual({ stopped: "CANCELLED" });
    expect(job()).toMatchObject({ status: "CANCELLED", aiStatus: "cancelled" });
    expect(records().filter((r) => r.aiState === "PENDING")).toHaveLength(0);
    expect((await call(`/api/data-quality/jobs/${again.id}/resume`, { method: "POST" })).status).toBe(409);
  });
});
