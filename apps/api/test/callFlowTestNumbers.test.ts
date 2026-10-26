import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Trial numbers for the Call Flows test call (/api/call-flows/test-numbers) and
// the test-call allowlist, with Prisma replaced by an in-memory table, the queue
// and the do-not-call lookup stubbed, and a tiny fake voice backend. No MySQL,
// no Redis, no real call.

type Row = { id: string; phone: string; label: string | null; createdBy: string; createdAt: Date; deletedAt: Date | null };
let rows: Row[] = [];
let seq = 0;
let missing = false; // simulate "migration 0023 not applied yet"
const runs: { data: { skipped: { greetingDelaySec?: number }; logs: { create: { phone: string } } } }[] = [];
const dnc = new Set<string>();

const missingErr = () => new Prisma.PrismaClientKnownRequestError("table does not exist", { code: "P2021", clientVersion: "test" });
const guard = () => {
  if (missing) throw missingErr();
};
const byWhere = (where: { id?: string; phone?: string }) => rows.find((r) => (where.id ? r.id === where.id : r.phone === where.phone)) ?? null;

const db = {
  aiCallTestNumber: {
    findMany: async () => (guard(), rows.filter((r) => !r.deletedAt)),
    findUnique: async ({ where }: { where: { id?: string; phone?: string } }) => (guard(), byWhere(where)),
    count: async () => (guard(), rows.filter((r) => !r.deletedAt).length),
    create: async ({ data }: { data: Pick<Row, "phone" | "label" | "createdBy"> }) => {
      guard();
      if (rows.some((r) => r.phone === data.phone)) throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
      const row = { ...data, id: `n${++seq}`, createdAt: new Date(2026, 0, seq), deletedAt: null };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      guard();
      const row = byWhere(where)!;
      Object.assign(row, data);
      return row;
    },
  },
  callFlow: { findUnique: async () => ({ id: "f1", archivedAt: null }) },
  callFlowVersion: {
    findUnique: async () => ({ id: "ver1", version: 1, status: "DRAFT", definition: nila }),
  },
  aiCallRun: {
    findFirst: async () => null,
    create: async (args: (typeof runs)[number]) => {
      runs.push(args);
      return { id: `run${runs.length}` };
    },
  },
};
vi.mock("../src/prisma.js", () => ({ prisma: db }));
const enqueued: string[] = [];
vi.mock("../src/queue/queues.js", async (orig) => ({
  ...(await orig<typeof import("../src/queue/queues.js")>()),
  enqueueAiCallRun: async (job: { runId: string }) => void enqueued.push(job.runId),
}));
vi.mock("../src/domain/aiCalls.js", async (orig) => ({
  ...(await orig<typeof import("../src/domain/aiCalls.js")>()),
  loadDoNotCallPhones: async () => dnc,
  callsCountedTowardDailyCap: async () => 0,
}));

const BUILTIN = new URL("../../../kagzso-voice-backend-english/app/flows/builtin/", import.meta.url);
const nila = JSON.parse(readFileSync(fileURLToPath(new URL("nila.json", BUILTIN)), "utf8"));

const ENV_NUMBER = "+919876543210";
let server: Server;
let voice: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR", sub = `u-${role}`) =>
  jwt.sign({ sub, email: `${sub}@test`, role }, process.env.JWT_ACCESS_SECRET!);

// The voice backend's /ready answer (null: like an older voice backend, it answers the preview body).
let readyBody: Record<string, unknown> | null = null;

beforeAll(async () => {
  voice = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/ready" && readyBody) {
        res.statusCode = readyBody.status === "ready" ? 200 : 503;
        return res.end(JSON.stringify(readyBody));
      }
      res.end(JSON.stringify({ valid: true, errors: [], greeting: "Hi", system_prompt: "…" }));
    });
  }).listen(0);
  process.env.ENABLE_AI_CALLS = "true";
  process.env.ENABLE_CALL_FLOW_EDITOR = "true";
  process.env.AI_CALL_FLOW_TEST_NUMBERS = ENV_NUMBER;
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
  rows = [];
  seq = 0;
  missing = false;
  dnc.clear();
  readyBody = null;
});

type Opts = { method?: string; body?: unknown; role?: "ADMIN" | "EDITOR"; sub?: string };
const call = (path: string, { method = "GET", body, role = "ADMIN", sub }: Opts = {}) =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(role, sub)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
type Item = { id: string; masked: string; label: string | null; source: "saved" | "env" };
const list = async () => (await (await call("/api/call-flows/test-numbers")).json()) as { items: Item[]; max: number; tableMissing: boolean };
const add = (phone: string, label?: string) => call("/api/call-flows/test-numbers", { method: "POST", body: { phone, label } });
const testCall = (numberId: string, sub: string) =>
  call("/api/call-flows/f1/test-call", { method: "POST", sub, body: { version: 1, numberId } });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("trial numbers: access", () => {
  it("editors can list trial numbers", async () => {
    expect((await call("/api/call-flows/test-numbers", { role: "EDITOR" })).status).toBe(200);
  });
});

describe("trial numbers: add / list / remove", () => {
  it("adds a number, normalising every +91 format to E.164", async () => {
    const res = await add("98765 43211", "My phone");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ masked: "+91 98XXX XXX11", label: "My phone", source: "saved" });
    expect((await add("098765 43212")).status).toBe(201);
    expect((await add("919876543213")).status).toBe(201);
    expect((await add("+91 98765 43214")).status).toBe(201);
    expect(rows.map((r) => r.phone)).toEqual(["+919876543211", "+919876543212", "+919876543213", "+919876543214"]);
    expect(rows[0]!.createdBy).toBe("u-ADMIN@test");
  });

  it("lists saved numbers plus AI_CALL_FLOW_TEST_NUMBERS, masked only", async () => {
    await add("9876543211", "My phone");
    const res = await call("/api/call-flows/test-numbers");
    const text = await res.text();
    expect(text).not.toContain("9876543211");
    expect(text).not.toContain("9876543210");
    const body = JSON.parse(text) as { items: Item[]; max: number; tableMissing: boolean };
    expect(body.max).toBe(5);
    expect(body.tableMissing).toBe(false);
    expect(body.items.map((i) => [i.masked, i.source])).toEqual([
      ["+91 98XXX XXX11", "saved"],
      ["+91 98XXX XXX10", "env"],
    ]);
  });

  it("rejects invalid numbers", async () => {
    for (const bad of ["12345", "0123456789", "abc", ""]) {
      expect((await add(bad)).status).toBe(400);
    }
    expect(rows).toEqual([]);
  });

  it("rejects duplicates in any format, including an env number", async () => {
    await add("9876543211");
    const dup = await add("+91 98765 43211");
    expect(dup.status).toBe(409);
    expect(await errorOf(dup)).toMatch(/already a trial number/);
    expect((await add("09876543210")).status).toBe(409); // already in AI_CALL_FLOW_TEST_NUMBERS
    expect(rows).toHaveLength(1);
  });

  it("allows at most 5 saved numbers", async () => {
    for (let i = 1; i <= 5; i++) expect((await add(`987654322${i}`)).status).toBe(201);
    const sixth = await add("9876543229");
    expect(sixth.status).toBe(400);
    expect(await errorOf(sixth)).toMatch(/up to 5/);
    expect(rows).toHaveLength(5);
  });

  it("removes a number (soft delete) and can add it back", async () => {
    const { id } = (await (await add("9876543211")).json()) as Item;
    const del = await call(`/api/call-flows/test-numbers/${encodeURIComponent(id)}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(rows[0]!.deletedAt).toBeInstanceOf(Date);
    expect((await list()).items.map((i) => i.source)).toEqual(["env"]);
    expect((await call(`/api/call-flows/test-numbers/${encodeURIComponent(id)}`, { method: "DELETE" })).status).toBe(404);

    expect((await add("9876543211", "Again")).status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deletedAt: null, label: "Again" });
  });

  it("won't remove an env number or an unknown id", async () => {
    const envItem = (await list()).items.find((i) => i.source === "env")!;
    const res = await call(`/api/call-flows/test-numbers/${encodeURIComponent(envItem.id)}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/AI_CALL_FLOW_TEST_NUMBERS/);
    expect((await call("/api/call-flows/test-numbers/nope", { method: "DELETE" })).status).toBe(404);
  });
});

describe("test call allowlist", () => {
  it("rejects a number that isn't allowed, a typed-in number and a removed one", async () => {
    expect((await testCall("db:does-not-exist", "u-a1")).status).toBe(400);
    expect((await testCall("+919812345678", "u-a1")).status).toBe(400);
    const free = await call("/api/call-flows/f1/test-call", { method: "POST", sub: "u-a2", body: { version: 1, phone: "9812345678" } });
    expect(free.status).toBe(400);
    const { id } = (await (await add("9876543211")).json()) as Item;
    await call(`/api/call-flows/test-numbers/${encodeURIComponent(id)}`, { method: "DELETE" });
    expect((await testCall(id, "u-a2")).status).toBe(400);
    expect(runs).toHaveLength(0);
  });

  it("calls a saved trial number", async () => {
    const { id } = (await (await add("9876543211")).json()) as Item;
    const before = runs.length;
    const res = await testCall(id, "u-a3");
    expect(res.status).toBe(201);
    expect(runs[before]!.data.logs.create.phone).toBe("+919876543211");
    // Same greeting delay a real run starts with by default.
    expect(runs[before]!.data.skipped.greetingDelaySec).toBe(2);
    expect(enqueued).toContain(((await res.json()) as { runId: string }).runId);
  });

  it("keeps the do-not-call check", async () => {
    const { id } = (await (await add("9876543211")).json()) as Item;
    dnc.add("+919876543211");
    const res = await testCall(id, "u-a4");
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatch(/do-not-call/);
  });

  it("env fallback: AI_CALL_FLOW_TEST_NUMBERS still works, even without the new table", async () => {
    missing = true;
    const body = await list();
    expect(body.tableMissing).toBe(true);
    expect(body.items).toEqual([expect.objectContaining({ masked: "+91 98XXX XXX10", source: "env" })]);
    const addRes = await add("9876543211");
    expect(addRes.status).toBe(503);
    expect(await errorOf(addRes)).toMatch(/prisma:deploy/);
    expect((await call("/api/call-flows/test-numbers/db:n1", { method: "DELETE" })).status).toBe(503);

    const before = runs.length;
    expect((await testCall(body.items[0]!.id, "u-a5")).status).toBe(201);
    expect(runs[before]!.data.logs.create.phone).toBe(ENV_NUMBER);
  });

  it("allows 3 test calls per hour per admin", async () => {
    const envId = (await list()).items[0]!.id;
    for (let i = 0; i < 3; i++) expect((await testCall(envId, "u-rate")).status).toBe(201);
    const fourth = await testCall(envId, "u-rate");
    expect(fourth.status).toBe(429);
    expect(await errorOf(fourth)).toMatch(/3 test calls per hour/);
    // Per admin: another admin is unaffected.
    expect((await testCall(envId, "u-other")).status).toBe(201);
  });
});

describe("test call when Plivo can't reach the voice backend", () => {
  const ready = (publicUrl: "configured" | "unreachable", reason: string | null = null) => ({
    status: publicUrl === "configured" ? "ready" : "not_ready",
    mysql: "ok",
    providers: { telephony: "configured", public_base_url: publicUrl, sarvam: "configured", tts: "configured", llm: "configured" },
    public_base_url_check: { url: "https://steersman.ngrok-free.dev", reachable: publicUrl === "configured", reason },
    telephony_provider: "plivo",
  });

  it("is refused with the reason (no run, no call), and goes ahead once the URL is reachable again", async () => {
    const envId = (await list()).items.find((i) => i.source === "env")!.id;
    const before = { runs: runs.length, enqueued: enqueued.length };

    readyBody = ready("unreachable", "ngrok tunnel offline");
    const refused = await testCall(envId, "u-ngrok");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      code: "voice_unreachable",
      error:
        "Calls can't connect: Plivo can't reach the voice backend at https://steersman.ngrok-free.dev (ngrok tunnel offline). " +
        "Start ngrok, or fix PUBLIC_BASE_URL in the voice backend's .env and restart it, then try again.",
    });
    expect({ runs: runs.length, enqueued: enqueued.length }).toEqual(before);

    readyBody = ready("configured");
    expect((await testCall(envId, "u-ngrok")).status).toBe(201);
    expect(runs).toHaveLength(before.runs + 1);
  });

  it("other /ready answers never block a call (not ready for another reason, an older voice backend)", async () => {
    const envId = (await list()).items.find((i) => i.source === "env")!.id;
    readyBody = { ...ready("configured"), status: "not_ready", providers: { ...ready("configured").providers, llm: "missing" } };
    expect((await testCall(envId, "u-other-ready")).status).toBe(201);
    readyBody = null; // the older voice backend: no /ready check at all
    expect((await testCall(envId, "u-other-ready")).status).toBe(201);
  });
});
