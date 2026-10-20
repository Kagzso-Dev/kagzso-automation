import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// /api/ai-calls/.../recording against a fake voice backend and an in-memory Prisma: ADMIN only,
// the voice call id always comes from our log row (never the request), Range is passed through
// for seeking, and every access is logged without phone numbers. No database, no real calls.

const AUDIO = Buffer.from("RIFF" + "x".repeat(996)); // 1000 bytes of "WAV"
const logs: Record<string, { voiceCallId: string | null; phone: string }> = {
  log_ok: { voiceCallId: "call_ok", phone: "+919876543210" },
  log_proc: { voiceCallId: "call_proc", phone: "+919876543211" },
  log_none: { voiceCallId: null, phone: "+919876543212" },
};
const voiceRequests: { method: string; url: string; range?: string; key?: string }[] = [];
let deleted = false;

vi.mock("../src/prisma.js", () => ({
  prisma: {
    aiCallLog: {
      findUnique: async ({ where }: { where: { id: string } }) => (logs[where.id] ? { voiceCallId: logs[where.id]!.voiceCallId } : null),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => logs[id]?.voiceCallId).map((id) => ({ id, voiceCallId: logs[id]!.voiceCallId })),
    },
  },
}));

let server: Server;
let voice: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  voice = createServer((req, res) => {
    voiceRequests.push({ method: req.method!, url: req.url!, range: req.headers.range, key: req.headers["x-api-key"] as string });
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/api/recordings") {
      return json(200, { enabled: true, items: [{ call_id: "call_ok", status: "completed" }, { call_id: "call_proc", status: "processing" }] });
    }
    if (url.pathname === "/api/recordings/call_ok" && req.method === "GET") {
      return json(200, { enabled: true, recording: { call_id: "call_ok", status: deleted ? "deleted" : "completed", duration_ms: 5000, size_bytes: 1000 } });
    }
    if (url.pathname === "/api/recordings/call_ok" && req.method === "DELETE") {
      deleted = true;
      return json(200, { ok: true, recording: { call_id: "call_ok", status: "deleted" } });
    }
    if (url.pathname === "/api/recordings/call_ok/audio") {
      if (deleted) return json(404, { detail: "Recording is deleted" });
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Accept-Ranges", "bytes");
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (m) {
        const [s, e] = [Number(m[1]), Number(m[2])];
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${s}-${e}/${AUDIO.length}`);
        return res.end(AUDIO.subarray(s, e + 1));
      }
      return res.end(AUDIO);
    }
    if (url.pathname === "/api/recordings/call_proc/audio") return json(409, { detail: "Recording is processing" });
    return json(404, { detail: "No recording for this call" });
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
  voiceRequests.length = 0;
  deleted = false;
});

const call = (path: string, init: { role?: "ADMIN" | "EDITOR"; method?: string; range?: string } = {}) =>
  fetch(base + path, {
    method: init.method ?? "GET",
    headers: {
      ...(init.role ? { Authorization: `Bearer ${token(init.role)}` } : {}),
      ...(init.range ? { Range: init.range } : {}),
    },
  });

describe("AI call recordings", () => {
  it("admins can play the recording; the voice call id comes from our log row", async () => {
    const res = await call("/api/ai-calls/logs/log_ok/recording/audio", { role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(AUDIO);
    expect(voiceRequests[0]).toMatchObject({ url: "/api/recordings/call_ok/audio", key: "voice-key-0123456789" });
  });

  it("passes HTTP Range through for seeking", async () => {
    const res = await call("/api/ai-calls/logs/log_ok/recording/audio", { role: "ADMIN", range: "bytes=100-199" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(AUDIO.subarray(100, 200));
    expect(voiceRequests[0]!.range).toBe("bytes=100-199");
  });

  it("downloads as an attachment", async () => {
    const res = await call("/api/ai-calls/logs/log_ok/recording/audio?download=1", { role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="call-log_ok.wav"');
  });

  it("refuses editors (403) and anonymous requests (401) without reaching the voice backend", async () => {
    for (const path of ["/api/ai-calls/logs/log_ok/recording/audio", "/api/ai-calls/logs/log_ok/recording", "/api/ai-calls/recordings/status?logIds=log_ok"]) {
      expect((await call(path, { role: "EDITOR" })).status).toBe(403);
      expect((await call(path)).status).toBe(401);
    }
    expect((await call("/api/ai-calls/logs/log_ok/recording", { role: "EDITOR", method: "DELETE" })).status).toBe(403);
    expect(voiceRequests).toEqual([]);
  });

  it("rejects bad ids, unknown logs and logs without a voice call - no path ever reaches the voice backend", async () => {
    expect((await call("/api/ai-calls/logs/..%2F..%2Fetc/recording/audio", { role: "ADMIN" })).status).toBe(400);
    expect((await call("/api/ai-calls/logs/nope/recording/audio", { role: "ADMIN" })).status).toBe(404);
    expect((await call("/api/ai-calls/logs/log_none/recording/audio", { role: "ADMIN" })).status).toBe(404);
    expect(voiceRequests).toEqual([]);
  });

  it("reports processing (409) and missing recordings (404)", async () => {
    const proc = await call("/api/ai-calls/logs/log_proc/recording/audio", { role: "ADMIN" });
    expect(proc.status).toBe(409);
    expect(((await proc.json()) as { error: string }).error).toMatch(/still being saved/);
  });

  it("metadata, delete, and no access afterwards", async () => {
    const meta = await (await call("/api/ai-calls/logs/log_ok/recording", { role: "ADMIN" })).json();
    expect(meta).toMatchObject({ enabled: true, recording: { status: "completed" } });
    const del = await call("/api/ai-calls/logs/log_ok/recording", { role: "ADMIN", method: "DELETE" });
    expect(del.status).toBe(200);
    expect(voiceRequests.some((r) => r.method === "DELETE" && r.url === "/api/recordings/call_ok")).toBe(true);
    expect((await call("/api/ai-calls/logs/log_ok/recording/audio", { role: "ADMIN" })).status).toBe(404);
  });

  it("returns recording status per log id for the call list", async () => {
    const res = await call("/api/ai-calls/recordings/status?logIds=log_ok,log_proc,log_none,nope", { role: "ADMIN" });
    expect(await res.json()).toEqual({ enabled: true, items: { log_ok: "completed", log_proc: "processing" } });
    expect(voiceRequests[0]!.url).toBe("/api/recordings?call_ids=call_ok,call_proc");
  });

  it("logs who did what, without phone numbers", async () => {
    const { logger } = await import("../src/logger.js");
    const spy = vi.spyOn(logger, "info");
    await call("/api/ai-calls/logs/log_ok/recording/audio", { role: "ADMIN" });
    const entry = spy.mock.calls.find((c) => c[1] === "call recording access");
    expect(entry?.[0]).toMatchObject({ adminId: "u-ADMIN", logId: "log_ok", voiceCallId: "call_ok", action: "play", result: "200" });
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/98765432/);
    spy.mockRestore();
  });
});
