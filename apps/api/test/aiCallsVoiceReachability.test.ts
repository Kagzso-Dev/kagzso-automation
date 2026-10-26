import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Starting AI calls while Plivo can't reach the voice backend (its /ready says the public URL is
// "unreachable", e.g. the ngrok tunnel is stopped): refused at the confirm step (dry run) and at
// Start, with the reason, and nothing is created or queued. Prisma, the queue and the do-not-call
// lookups are stubbed; the voice backend is a tiny fake. No MySQL, no real call.

const created: unknown[] = [];
const db = {
  aiCallRun: {
    findFirst: async () => null,
    create: async (args: unknown) => (created.push(args), { id: `run${created.length}` }),
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
  loadDoNotCallPhones: async () => new Set<string>(),
  callsCountedTowardDailyCap: async () => 0,
}));

let readyBody: Record<string, unknown> = {};
let readyStatus = 200;
let server: Server;
let voice: Server;
let base = "";

beforeAll(async () => {
  voice = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = req.url === "/ready" ? readyStatus : 404;
      res.end(JSON.stringify(req.url === "/ready" ? readyBody : { detail: "Not Found" }));
    });
  }).listen(0);
  process.env.ENABLE_AI_CALLS = "true";
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
  created.length = 0;
  enqueued.length = 0;
});

const token = jwt.sign({ sub: "u-admin", email: "admin@test", role: "ADMIN" }, process.env.JWT_ACCESS_SECRET!);
const start = (dryRun: boolean) =>
  fetch(`${base}/api/ai-calls/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rows: [{ customerName: "Ravi", phone: "9876500101" }], mode: "all", dryRun }),
  });
const ready = (publicUrl: "configured" | "unreachable", reason: string | null = null) => {
  readyStatus = publicUrl === "configured" ? 200 : 503;
  readyBody = {
    status: publicUrl === "configured" ? "ready" : "not_ready",
    providers: { telephony: "configured", public_base_url: publicUrl, sarvam: "configured", tts: "configured", llm: "configured" },
    public_base_url_check: { url: "https://steersman.ngrok-free.dev", reachable: publicUrl === "configured", reason },
    telephony_provider: "plivo",
  };
};

describe("starting AI calls when Plivo can't reach the voice backend", () => {
  it("the confirm step and Start are refused with the reason; nothing is created or queued", async () => {
    ready("unreachable", "ngrok tunnel offline");
    for (const dryRun of [true, false]) {
      const res = await start(dryRun);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        code: "voice_unreachable",
        error: expect.stringMatching(/^Calls can't connect: Plivo can't reach the voice backend at https:\/\/steersman\.ngrok-free\.dev \(ngrok tunnel offline\)\. Start ngrok/),
      });
    }
    expect(created).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("a reachable voice backend starts the run as before", async () => {
    ready("configured");
    const dry = await start(true);
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dryRun: true, toCall: 1 });
    expect((await start(false)).status).toBe(201);
    expect(enqueued).toEqual(["run1"]);
  });

  it("a voice backend without the check (404 on /ready) never blocks the start", async () => {
    readyStatus = 404;
    readyBody = { detail: "Not Found" };
    expect((await start(true)).status).toBe(200);
  });
});
