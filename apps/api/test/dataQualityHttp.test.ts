import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
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
const tables: Record<"dataQualityJob" | "dataQualityRecord" | "dataQualityExportLog", Row[]> = { dataQualityJob: [], dataQualityRecord: [], dataQualityExportLog: [] };
const writes: string[] = [];
let seq = 0;
let liveRun = false;

const clone = <T,>(v: T): T => structuredClone(v);
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return (v.in as unknown[]).includes(row[k]);
      if ("gt" in v) return row[k] > v.gt;
      return false;
    }
    return row[k] === v;
  });
}
/** Prisma's select: only the fields set to true (so a test sees exactly what the code asked for). */
const pickFields = (row: Row | null, select?: Row) =>
  row && select ? Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, row[k]])) : row;
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
  dataQualityRecord: () => ({ aiState: "NONE", aiScore: null, aiNotes: null, review: "PENDING", raw: null }),
  dataQualityExportLog: () => ({}),
};
function stagingModel(name: keyof typeof tables) {
  const all = () => tables[name];
  const fresh = (data: Row) => ({ id: `${name}-${++seq}`, createdAt: new Date(Date.now() + seq), updatedAt: new Date(), ...DEFAULTS[name](), ...data });
  return {
    create: async ({ data }: { data: Row }) => (writes.push(`${name}.create`), all().push(fresh(data)), clone(all().at(-1)!)),
    createMany: async ({ data }: { data: Row[] }) => (writes.push(`${name}.createMany`), all().push(...data.map(fresh)), { count: data.length }),
    findUnique: async ({ where }: { where: Row }) => clone(all().find((r) => matches(r, where)) ?? null),
    findFirst: async ({ where, orderBy, select }: { where?: Row; orderBy?: Row; select?: Row }) =>
      clone(pickFields(sortRows(all().filter((r) => matches(r, where)), orderBy)[0] ?? null, select)),
    findMany: async ({ where, orderBy, take, select }: { where?: Row; orderBy?: Row; take?: number; select?: Row } = {}) =>
      clone(sortRows(all().filter((r) => matches(r, where)), orderBy).slice(0, take ?? Infinity).map((r) => pickFields(r, select))),
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
  dataQualityExportLog: stagingModel("dataQualityExportLog"),
  aiCallRun:{ findFirst: async () => (liveRun ? { id: "run-live" } : null) },
  aiCallLog: readOnly(callLogs),
  aiCallCustomer: readOnly(customers),
  whatsAppContact: readOnly([{ phone: DQ_IN_WHATSAPP.slice(1) }]),
  contact: readOnly([{ email: "mohan@mohanpharmacy.in" }]),
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
let denyAccess = false; // every generation answers 403 (a blocked key / project)
let generations = 0;
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
      generations++;
      if (denyAccess) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: "Your project has been denied access. Please contact support." }));
      }
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
  tables.dataQualityExportLog = [];
  writes.length = 0;
  enqueued.length = 0;
  prompts.length = 0;
  outbound = [];
  ollamaUp = true;
  liveRun = false;
  rateLimitNext = false;
  denyAccess = false;
  generations = 0;
});
afterEach(() => {
  // The rule for every test: the server talked to nothing but the local Ollama.
  for (const line of outbound) expect(line.split(" ")[1]!.startsWith(`${ollamaBase}/api/`)).toBe(true);
});

const token = (role: "ADMIN" | "EDITOR", sub = `u-${role}`) => jwt.sign({ sub, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const call = (
  path: string,
  { method = "GET", role = "ADMIN" as "ADMIN" | "EDITOR", json, body, sub }: { method?: string; role?: "ADMIN" | "EDITOR"; json?: unknown; body?: FormData; sub?: string } = {},
) =>
  realFetch(apiBase + path, {
    method,
    headers: { Authorization: `Bearer ${token(role, sub)}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
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
    expect(lines[1]).toMatch(/^2,Ravi Kumar,\+919876500001,Ravi Traders,ravi@ravitraders\.in,/);
    const all = await (await call(`/api/data-quality/jobs/${created.id}/export?rows=valid`)).text();
    expect(all.trim().split("\r\n")).toHaveLength(1 + DQ_EXPECTED.valid);
    expect(all).not.toContain("Dinesh");
  });

  it("review by score waits for the AI scores, then approves >= the minimum and rejects below it, never overriding a hand review", async () => {
    const { job: created } = (await (await uploadFixture()).json()) as { job: Row };
    const byScore = (json: unknown) => call(`/api/data-quality/jobs/${created.id}/review-by-score`, { method: "POST", json });
    expect((await byScore({ minScore: 80, review: "APPROVED" })).status).toBe(409); // AI scores still to come

    const ravi = records().find((r) => r.rowIndex === 0)!;
    await call(`/api/data-quality/jobs/${created.id}/review`, { method: "POST", json: { ids: [ravi.id], review: "REJECTED" } });
    expect(await drain(enqueued[0]!)).toEqual({ done: true });

    // AI 80 everywhere: rules 100 → 90, 85 → 83, 90 → 85, 75 → 78 (row 5), 70 → 75 (row 6).
    expect(await (await byScore({ minScore: 80, review: "APPROVED" })).json()).toEqual({ updated: 11 }); // 12 at 80+, minus Ravi
    expect(await (await byScore({ minScore: 80, review: "REJECTED" })).json()).toEqual({ updated: 2 });
    expect(await (await byScore({ minScore: 80, review: "APPROVED" })).json()).toEqual({ updated: 0 });

    const reviewOf = (n: number) => records().find((r) => r.rowIndex === n - 2)!.review; // spreadsheet row number
    expect([reviewOf(2), reviewOf(4), reviewOf(5), reviewOf(6), reviewOf(13)]).toEqual(["REJECTED", "APPROVED", "REJECTED", "REJECTED", "APPROVED"]);
    for (const r of records().filter((x) => x.status !== "VALID")) expect(r.review).toBe("PENDING");

    for (const bad of [{ minScore: 101, review: "APPROVED" }, { minScore: 70, review: "PENDING" }, { minScore: 70 }]) {
      expect((await byScore(bad)).status).toBe(400);
    }
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

  it("a refused key (403) stops after one try, not five, and says why", async () => {
    await uploadFixture();
    denyAccess = true;
    expect(await drain(enqueued[0]!)).toEqual({ stopped: "ai access denied" });
    expect(generations).toBe(1);
    expect(job()).toMatchObject({ status: "DONE", aiStatus: "unavailable", aiFailures: 0 });
    expect(job().note).toMatch(/^Ollama refused the key: Ollama 403: Your project has been denied access/);
    expect(records().filter((r) => r.aiState === "PENDING")).toHaveLength(0);
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

/* ---------------------------------------------------------------- filtered export */

// A file with more columns than the four Data Quality checks: kept whole (raw) since 0028.
const EXPORT_CSV =
  [
    "client_id,business_name,contact_name,email,phone,city,industry,source,first_seen",
    "000123,Sri Murugan Bakery,Ravi Kumar,ravi@murugan.in,9876500101,Chennai,Restaurants & Food Service,Google Places,2026-10-20", // row 2 valid 100
    "000124,முருகன் ஸ்டோர்ஸ்,,,9876500102,Chennai,Retail,Google Places,2026-10-20", //             row 3 valid, no name: 70
    '000125,"=HYPERLINK(""http://x.example"")",Meena,,9876500103,Coimbatore,Retail,Crustdata,2026-10-21', // row 4 valid 100
    "000126,Deepa Bakery,Deepa,info@deepabakery.in,,Chennai,Restaurants & Food Service,Google Places,2026-10-21", // row 5 INVALID: email, no phone
    "000127,Chennai Dental Care,Arun Kumar,,044 2345 6789,Chennai,Healthcare,Google Places,2026-10-21", // row 6 valid landline: 80
    "000128,Dinesh Hardware,Dinesh,,9876500009,Chennai,Retail,Google Places,2026-10-21", //          row 7 EXCLUDED do not call
    "000129,Bala Bakes,Bala,bala@balabakes.in,9876500107,Bengaluru,Restaurants & Food Service,Google Places,2026-10-22", // row 8 valid 100
    "000130,Kavya Cafe,,,9876500108,Bengaluru,Restaurants & Food Service,Google Places,2026-10-22", // row 9 valid, no name: 70
  ].join("\n") + "\n";

const DQ_ALL_COMPUTED = [
  "dq:phone", "dq:phone_extension", "dq:phone_type", "dq:check_status", "dq:excluded_reason", "dq:score", "dq:rule_score", "dq:ai_score",
  "dq:score_breakdown", "dq:tier", "dq:notes", "dq:ai_notes", "dq:review", "dq:file_name", "dq:row", "dq:upload_date",
];

// Uploads (10 a minute) and exports (20 a minute) are rate-limited per user: each call below is made
// as its own admin user so this file's many calls stay under the limits the earlier tests already use.
let callers = 0;
const freshAdmin = () => `u-ADMIN-${++callers}`;

async function uploadFile(content: string | Buffer, filename: string): Promise<Row> {
  const fd = new FormData();
  fd.append("file", new Blob([content]), filename);
  const res = await call("/api/data-quality/jobs", { method: "POST", body: fd, sub: freshAdmin() });
  expect(res.status).toBe(201);
  return ((await res.json()) as { job: Row }).job;
}
const uploadExportFixture = async () => {
  ollamaUp = false; // standard checks only, so every score below is fixed
  return (await uploadFile(EXPORT_CSV, "client-research (1).csv")).id as string;
};
const shownFor = async (id: string, filters: Row) =>
  ((await (await call(`/api/data-quality/jobs/${id}?filters=${encodeURIComponent(JSON.stringify(filters))}`)).json()) as { records: Row[] }).records;
const exportFor = (id: string, body: Row) => call(`/api/data-quality/jobs/${id}/export-filtered`, { method: "POST", json: body, sub: freshAdmin() });
const csvRows = async (res: Response) => parseCsv(await res.text(), { bom: true, columns: true }) as Record<string, string>[];
async function xlsxRows(res: Response): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
  const out: unknown[][] = [];
  wb.worksheets[0]!.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
  return out;
}

describe("filtered export", () => {
  it("exports exactly the rows the table shows, for each filter and combination", async () => {
    const id = await uploadExportFixture();
    const cases: [string, Row, number][] = [
      ["business name word", { business: "bakery" }, 2],
      ["city", { city: "Chennai" }, 4], // 5 shown, one of them excluded
      ["score 70+", { scoreMin: 70 }, 6],
      ["has email, no phone", { hasEmail: true, hasPhone: false }, 1],
      ["city + category + score", { city: "Chennai", category: "Restaurants & Food Service", scoreMin: 70 }, 1],
      ["likely landline", { status: ["LANDLINE"] }, 1],
      ["high priority tier", { tier: ["HIGH_PRIORITY"] }, 3],
      ["phone contains", { phone: "500108" }, 1],
      ["source + date added", { source: "Google Places", dateAdded: "2026-10-22" }, 2],
    ];
    for (const [what, filters, expected] of cases) {
      const shown = (await shownFor(id, filters)).filter((r) => r.status !== "EXCLUDED");
      const res = await exportFor(id, { filters, columns: ["dq:row", "dq:name", "dq:phone"], format: "csv" });
      const rows = await csvRows(res);
      expect([what, shown.length, Number(res.headers.get("x-row-count")), rows.length]).toEqual([what, expected, expected, expected]);
      expect(rows.map((r) => r.row)).toEqual(shown.map((r) => String(r.rowIndex + 2)));
    }
    // The table's own controls travel with the export too: Valid tab + "Only show rows scoring 80+".
    const all = await shownFor(id, {});
    const onScreen = all.filter((r) => r.status === "VALID" && r.score >= 80).map((r) => String(r.rowIndex + 2));
    const viewRows = await csvRows(await exportFor(id, { view: { status: "VALID", minScore: 80 }, columns: ["dq:row"], format: "csv" }));
    expect(viewRows.map((r) => r.row)).toEqual(onScreen);
    expect(onScreen).toEqual(["2", "4", "6", "8"]);
  });

  it("Tamil text, leading zeros and formula-looking cells come out right (CSV with BOM, XLSX as text)", async () => {
    const id = await uploadExportFixture();
    const columns = ["col:client_id", "col:business_name", "col:city", "dq:phone", "dq:score", "dq:tier", "dq:check_status"];

    const csv = await exportFor(id, { columns, format: "csv" });
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="dataquality_client-research-1_all_\d{8}-\d{4}\.csv"$/);
    const bytes = Buffer.from(await csv.arrayBuffer()); // res.text() would drop the BOM while decoding
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM: Excel then reads Tamil correctly
    const rows = parseCsv(bytes.toString("utf8"), { bom: true, columns: true }) as Record<string, string>[];
    const byId = (cid: string) => rows.find((r) => r.client_id === cid)!;
    expect(byId("000123")).toEqual({
      client_id: "000123",
      business_name: "Sri Murugan Bakery",
      city: "Chennai",
      phone_normalised: "+919876500101", // a phone keeps its +: it can't run as a formula
      score: "100",
      tier: "HIGH PRIORITY",
      check_status: "VALID",
    });
    expect(byId("000124").business_name).toBe("முருகன் ஸ்டோர்ஸ்");
    expect(byId("000125").business_name).toBe(`'=HYPERLINK("http://x.example")`);
    expect(rows).toHaveLength(7); // 8 rows, the do-not-call one left out

    const xlsx = await exportFor(id, { columns, format: "xlsx" });
    expect(xlsx.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const sheet = await xlsxRows(xlsx);
    expect(sheet[0]).toEqual(["client_id", "business_name", "city", "phone_normalised", "score", "tier", "check_status"]);
    expect(sheet.find((r) => r[0] === "000123")).toEqual(["000123", "Sri Murugan Bakery", "Chennai", "+919876500101", 100, "HIGH PRIORITY", "VALID"]);
    expect(sheet.find((r) => r[0] === "000124")![1]).toBe("முருகன் ஸ்டோர்ஸ்");
    expect(sheet.find((r) => r[0] === "000125")![1]).toBe(`'=HYPERLINK("http://x.example")`);
    expect(sheet).toHaveLength(1 + 7);
  });

  it("excluded rows are left out unless asked for, and are then labelled EXCLUDED", async () => {
    const id = await uploadExportFixture();
    const body = { filters: { city: "Chennai" }, columns: ["dq:row", "dq:check_status", "dq:excluded_reason"], format: "csv" };
    const without = await csvRows(await exportFor(id, body));
    expect(without.map((r) => r.row)).toEqual(["2", "3", "5", "6"]);
    expect(without.map((r) => r.check_status)).not.toContain("EXCLUDED");
    const withExcluded = await csvRows(await exportFor(id, { ...body, includeExcluded: true }));
    expect(withExcluded.map((r) => r.row)).toEqual(["2", "3", "5", "6", "7"]);
    expect(withExcluded.at(-1)).toEqual({ row: "7", check_status: "EXCLUDED", excluded_reason: "Do not call" });
    expect(tables.dataQualityExportLog.map((l) => l.includeExcluded)).toEqual([false, true]);
  });

  it("only reads: no row, job or contact changes, one audit row with no contact data, nothing sent", async () => {
    const id = await uploadExportFixture();
    const before = JSON.stringify([tables.dataQualityJob, tables.dataQualityRecord]);
    writes.length = 0;
    outbound = [];
    const columns = ["dq:name", "dq:phone", "dq:email"];
    const res = await exportFor(id, { filters: { business: "bakery", phone: "98765", city: "Chennai" }, view: { status: "VALID" }, columns, format: "xlsx" });
    expect(res.status).toBe(200);
    expect(await xlsxRows(res)).toEqual([["name", "phone_normalised", "email"], ["Ravi Kumar", "+919876500101", "ravi@murugan.in"]]);

    expect(JSON.stringify([tables.dataQualityJob, tables.dataQualityRecord])).toBe(before);
    expect(writes).toEqual(["dataQualityExportLog.create"]); // other tables have no write methods at all
    expect(outbound).toEqual([]);
    const log = tables.dataQualityExportLog[0]!;
    expect(log).toMatchObject({ jobId: id, filename: "client-research (1).csv", byEmail: "admin@test", format: "xlsx", columns, includeExcluded: false, rowCount: 1 });
    expect(log.filters).toEqual({ business: "[search]", phone: "[search]", city: "Chennai", view: { status: "VALID" } });
    expect(JSON.stringify(log)).not.toMatch(/bakery|98765|murugan|Ravi/i);
  });

  it("caps one export, and waits when memory is low while a file is being scored", async () => {
    await uploadFile(dqCsv(), "leads.csv"); // Ollama up: this job is RUNNING (AI scoring)
    const id = await uploadExportFixture();
    const body = { columns: ["dq:row"], format: "csv" };

    process.env.DATA_QUALITY_EXPORT_MAX_ROWS = "2";
    try {
      const res = await exportFor(id, body);
      expect(res.status).toBe(413);
      expect(((await res.json()) as Row).error).toBe("These filters match 7 rows; one export can hold at most 2. Narrow the filters and try again.");
    } finally {
      delete process.env.DATA_QUALITY_EXPORT_MAX_ROWS;
    }

    process.env.DATA_QUALITY_EXPORT_MIN_FREE_MB = "100000000"; // "less free memory than this" is always true
    try {
      const busy = await exportFor(id, body);
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({ code: "try_again", error: expect.stringMatching(/Try again shortly/) });
      tables.dataQualityJob.find((j) => j.status === "RUNNING")!.status = "PAUSED"; // nothing scoring any more
      expect((await exportFor(id, body)).status).toBe(200);
    } finally {
      delete process.env.DATA_QUALITY_EXPORT_MIN_FREE_MB;
    }
    expect(tables.dataQualityExportLog).toHaveLength(1); // refused exports are not logged as exports
  });

  it("keeps the whole original row for new files; the table never receives it; dropdown values come from the file", async () => {
    const id = await uploadExportFixture();
    expect(tables.dataQualityJob[0]!.headers).toEqual(["client_id", "business_name", "contact_name", "email", "phone", "city", "industry", "source", "first_seen"]);
    expect(records()[0]!.raw).toMatchObject({ client_id: "000123", city: "Chennai", industry: "Restaurants & Food Service" });

    const detail = (await (await call(`/api/data-quality/jobs/${id}`)).json()) as { records: Row[] };
    expect(detail.records).toHaveLength(8);
    expect(detail.records.every((r) => !("raw" in r))).toBe(true);
    expect((await shownFor(id, { city: "Chennai" })).every((r) => !("raw" in r))).toBe(true);

    const facets = (await (await call(`/api/data-quality/jobs/${id}/facets`)).json()) as Row;
    expect(facets.columns).toEqual({ city: "city", state: null, district: null, pincode: null, category: "industry", source: "source", dateAdded: "first_seen" });
    expect(facets.values.city).toEqual([
      { value: "Chennai", count: 5 },
      { value: "Bengaluru", count: 2 },
      { value: "Coimbatore", count: 1 },
    ]);
  });

  it("files uploaded before this update: the checked values export, file columns can't be asked for", async () => {
    const id = await uploadExportFixture();
    tables.dataQualityJob[0]!.headers = null;
    for (const r of records()) r.raw = null;

    expect(await (await call(`/api/data-quality/jobs/${id}/facets`)).json()).toMatchObject({ headers: null, values: {} });
    expect(await shownFor(id, { city: "Chennai" })).toEqual([]); // nothing to match: never guessed
    const rows = await csvRows(await exportFor(id, { columns: ["dq:row", "dq:name", "dq:phone_raw", "dq:phone_type", "dq:score_breakdown"], format: "csv" }));
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.row === "6")).toEqual({
      row: "6",
      name: "Arun Kumar",
      phone_as_written: "044 2345 6789",
      phone_type: "Landline",
      score_breakdown: "rules 80 (Not a mobile (landline: no WhatsApp) -20)",
    });
    expect((await exportFor(id, { columns: ["col:city"], format: "csv" })).status).toBe(400);
  });

  it("admins only, and bad input is refused", async () => {
    const id = await uploadExportFixture();
    expect((await call(`/api/data-quality/jobs/${id}/facets`, { role: "EDITOR" })).status).toBe(403);
    expect((await call(`/api/data-quality/jobs/${id}/export-filtered`, { method: "POST", role: "EDITOR", json: { columns: ["dq:row"], format: "csv" } })).status).toBe(403);
    expect((await exportFor(id, { columns: ["dq:password"], format: "csv" })).status).toBe(400);
    expect((await exportFor(id, { columns: ["dq:row"], format: "pdf" })).status).toBe(400);
    expect((await call(`/api/data-quality/jobs/${id}?filters=not-json`)).status).toBe(400);
    expect(tables.dataQualityExportLog).toHaveLength(0);
  });
});

// The real upload file, end to end (in-memory database): DQ_REAL_FILE=<path to .xlsx> npx vitest run test/dataQualityHttp.test.ts
describe.runIf(!!process.env.DQ_REAL_FILE)("the real file (DQ_REAL_FILE)", () => {
  it("every filter's export holds exactly the rows the table shows; nothing changes", async () => {
    ollamaUp = false;
    const file = process.env.DQ_REAL_FILE!;
    const job = await uploadFile(readFileSync(file), basename(file));
    const columns = [...(job.headers as string[]).map((h) => `col:${h}`), ...DQ_ALL_COMPUTED];
    const before = JSON.stringify([tables.dataQualityJob, tables.dataQualityRecord]);
    const cases: [string, Row][] = [
      ["no filters", {}],
      ["business name contains 'bakery'", { business: "bakery" }],
      ["city Chennai", { city: "Chennai" }],
      ["score 70+", { scoreMin: 70 }],
      ["has email, no phone", { hasEmail: true, hasPhone: false }],
      ["Chennai + Healthcare + score 70+", { city: "Chennai", category: "Healthcare", scoreMin: 70 }],
      ["Bengaluru + Restaurants & Food Service + has email", { city: "Bengaluru", category: "Restaurants & Food Service", hasEmail: true }],
      ["likely landline", { status: ["LANDLINE"] }],
      ["tier HIGH PRIORITY + mobile", { tier: ["HIGH_PRIORITY"], phoneType: ["mobile"] }],
    ];
    const report: string[] = [`${job.filename}: ${job.total} rows (${job.valid} valid, ${job.invalid} invalid, ${job.duplicates} duplicate, ${job.excluded} excluded)`];
    for (const [what, filters] of cases) {
      const shown = (await shownFor(job.id, filters)).filter((r) => r.status !== "EXCLUDED").length;
      const csv = await exportFor(job.id, { filters, columns, format: "csv" });
      const header = Number(csv.headers.get("x-row-count"));
      const csvText = await csv.text();
      const csvCount = (parseCsv(csvText, { bom: true, columns: true }) as unknown[]).length;
      const xlsxCount = (await xlsxRows(await exportFor(job.id, { filters, columns, format: "xlsx" }))).length - 1;
      const tamil = /[஀-௿]/.test(csvText) ? ", Tamil kept" : "";
      report.push(`${what}: table ${shown}, CSV ${csvCount}, XLSX ${xlsxCount}, X-Row-Count ${header}${tamil}`);
      expect([what, csvCount, xlsxCount, header]).toEqual([what, shown, shown, shown]);
    }
    console.info(report.join("\n"));
    expect(JSON.stringify([tables.dataQualityJob, tables.dataQualityRecord])).toBe(before);
    expect(new Set(writes.map((w) => w.split(".")[0]))).toEqual(new Set(["dataQualityJob", "dataQualityRecord", "dataQualityExportLog"]));
  }, 600_000);
});
