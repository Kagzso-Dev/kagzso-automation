import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Imported after the env below is set: the voice backend addresses are read when the module loads.
let stripProviderSecrets: <T>(value: T) => T;

// /api/ai-providers (Settings → AI providers): ADMIN only. A tiny fake voice backend answers the
// /api/admin/ai-providers endpoints; nothing reaches a provider or the database.

let server: Server;
let voice: Server;
let base = "";
type Seen = { method: string; path: string; body: Record<string, unknown> | null; key?: string; actor?: string };
const seen: Seen[] = [];
const SAVED_KEY = "gsk_saved_key_never_returned";
const VIEW = {
  language: "en", live: false, secrets_ready: true, env_llm: "sarvam:sarvam-105b-conversations",
  llm_order: ["groq_llm", "sarvam_llm", "anthropic_llm"], usable_llm: ["sarvam_llm"], stt_providers: ["sarvam_stt"],
  warnings: [],
  providers: [{ id: "groq_llm", kind: "llm", label: "Groq", enabled: true, key_configured: true, key_source: "saved",
    api_key: SAVED_KEY, nested: { encrypted_key: "v1:abcd:zzz" } }],
};
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  voice = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : null,
        key: req.headers["x-api-key"] as string, actor: req.headers["x-actor"] as string | undefined });
      res.setHeader("Content-Type", "application/json");
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/api/admin/ai-providers/selection" && body.live && !body.confirm) {
        res.statusCode = 409;
        res.end(JSON.stringify({ detail: { message: "No LLM provider is enabled with a key", code: "no_usable_llm" } }));
        return;
      }
      if (body.model === "saaras:v4") {
        res.statusCode = 422;
        res.end(JSON.stringify({ detail: { message: "saaras:v4 is not verified for production calls yet", code: "unverified_model" } }));
        return;
      }
      res.end(JSON.stringify(req.url?.endsWith("/test") ? { ...VIEW, test: { provider: "groq_llm", status: "ok", message: "Connected", latency_ms: 5 } } : VIEW));
    });
  }).listen(0);
  process.env.VOICE_BACKEND_URL = `http://127.0.0.1:${(voice.address() as AddressInfo).port}`;
  process.env.VOICE_BACKEND_API_KEY = "voice-key-0123456789";
  const { createApp } = await import("../src/http/app.js");
  ({ stripProviderSecrets } = await import("../src/services/voiceBackend.js"));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => voice.close(() => r()));
});

const call = (method: string, path: string, body?: unknown, role?: "ADMIN" | "EDITOR") =>
  fetch(`${base}/api/ai-providers${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(role ? { Authorization: `Bearer ${token(role)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const ENDPOINTS: [string, string, unknown][] = [
  ["GET", "/en", undefined],
  ["PUT", "/en/providers/groq_llm", { enabled: true }],
  ["PUT", "/en/selection", { live: false }],
  ["POST", "/en/providers/groq_llm/test", undefined],
  ["POST", "/en/reencrypt", undefined],
];

describe("AI provider settings: admins only", () => {
  it.each(ENDPOINTS)("%s %s needs sign-in and the ADMIN role", async (method, path, body) => {
    const before = seen.length;
    expect((await call(method, path, body)).status).toBe(401);
    expect((await call(method, path, body, "EDITOR")).status).toBe(403);
    expect(seen.length).toBe(before); // the voice backend was never asked
  });

  it.each(ENDPOINTS)("%s %s works for an admin, never returns a key and is never cached", async (method, path, body) => {
    const res = await call(method, path, body, "ADMIN");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(SAVED_KEY);
    expect(text).not.toContain("encrypted_key");
    expect(JSON.parse(text).providers[0].key_configured).toBe(true);
    const sent = seen.at(-1)!;
    expect(sent.key).toBe("voice-key-0123456789");
    if (method !== "GET") expect(sent.actor).toBe("admin@test"); // for the voice backend's audit log
  });
});

describe("AI provider settings: keys and validation", () => {
  it("sends a new key to the voice backend only, and an empty field never erases the saved one", async () => {
    await call("PUT", "/en/providers/anthropic_llm", { api_key: "  sk-ant-new-key-0123456789 ", enabled: true }, "ADMIN");
    expect(seen.at(-1)).toMatchObject({ method: "PUT", path: "/api/admin/ai-providers/providers/anthropic_llm",
      body: { api_key: "sk-ant-new-key-0123456789", enabled: true } });
    await call("PUT", "/en/providers/anthropic_llm", { api_key: "", model: "claude-opus-5-5" }, "ADMIN");
    expect(seen.at(-1)!.body).toEqual({ model: "claude-opus-5-5" });
    await call("PUT", "/en/providers/anthropic_llm", { remove_key: true }, "ADMIN");
    expect(seen.at(-1)!.body).toEqual({ remove_key: true });
  });

  it("refuses unknown providers, fields and languages before reaching the voice backend", async () => {
    const before = seen.length;
    expect((await call("PUT", "/en/providers/groq_stt", { enabled: true }, "ADMIN")).status).toBe(400);
    expect((await call("PUT", "/en/providers/groq_llm", { password: "x" }, "ADMIN")).status).toBe(400);
    expect((await call("PUT", "/en/selection", { llm_order: ["groq_llm"] }, "ADMIN")).status).toBe(400);
    expect((await call("GET", "/ta", undefined, "ADMIN")).status).toBe(404); // no Tamil backend set up here
    expect((await call("GET", "/xx", undefined, "ADMIN")).status).toBe(404);
    expect(seen.length).toBe(before);
  });

  it("passes the voice backend's confirmations and checks through with their codes", async () => {
    const live = await call("PUT", "/en/selection", { live: true }, "ADMIN");
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ code: "no_usable_llm", error: "No LLM provider is enabled with a key" });
    expect((await call("PUT", "/en/selection", { live: true, confirm: true }, "ADMIN")).status).toBe(200);
    const v4 = await call("PUT", "/en/providers/sarvam_stt", { model: "saaras:v4" }, "ADMIN");
    expect(v4.status).toBe(400);
    expect(await v4.json()).toMatchObject({ code: "unverified_model" });
  });

  it("strips key-like fields at any depth", () => {
    expect(stripProviderSecrets({ a: 1, api_key: "x", list: [{ apiKey: "y", secret: "z", key_configured: true }] }))
      .toEqual({ a: 1, list: [{ key_configured: true }] });
  });
});
