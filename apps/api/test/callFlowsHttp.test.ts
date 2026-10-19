import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// HTTP gates of /api/call-flows with both flags on. A tiny fake voice backend
// answers /api/flows/*; nothing here reaches the database.

let server: Server;
let voice: Server;
let base = "";
const voiceRequests: { path: string; body: unknown; key: string | undefined }[] = [];
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  voice = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      voiceRequests.push({ path: req.url!, body: raw ? JSON.parse(raw) : null, key: req.headers["x-api-key"] as string });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/flows/preview") {
        res.end(JSON.stringify({ valid: true, errors: [], greeting: "Hi, is this Priya?", system_prompt: "…" }));
      } else if (req.url === "/api/flows/builtin") {
        res.end(JSON.stringify({ flows: {}, locked_blocks: {}, variables: ["name"], groups: [], limits: {} }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  }).listen(0);
  process.env.ENABLE_AI_CALLS = "true";
  process.env.ENABLE_CALL_FLOW_EDITOR = "true";
  process.env.AI_CALL_FLOW_TEST_NUMBERS = "+919876543210";
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

const call = (path: string, init: RequestInit & { role?: "ADMIN" | "EDITOR" } = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.role ? { Authorization: `Bearer ${token(init.role)}` } : {}),
    },
  });

describe("/api/call-flows", () => {
  it("requires sign-in; admins and editors get in", async () => {
    expect((await call("/api/call-flows")).status).toBe(401);
    expect((await call("/api/call-flows/preview", { method: "POST", role: "EDITOR", body: "{}" })).status).not.toBe(403);
  });

  it("reports the editor flag and masked test numbers in /api/ai-calls/config", async () => {
    const admin = await (await call("/api/ai-calls/config", { role: "ADMIN" })).json();
    expect(admin).toMatchObject({ flowEditor: true, testCallNumbers: ["+91******3210"] });
    const editor = (await (await call("/api/ai-calls/config", { role: "EDITOR" })).json()) as { testCallNumbers: string[] };
    expect(editor.testCallNumbers).toEqual(["+91******3210"]);
  });

  it("previews through the voice backend with the API key", async () => {
    const res = await call("/api/call-flows/preview", {
      method: "POST",
      role: "ADMIN",
      body: JSON.stringify({ definition: { name: "x" }, sample: { customer_name: "Priya", gender: "female" } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { greeting: string }).greeting).toBe("Hi, is this Priya?");
    const sent = voiceRequests.find((r) => r.path === "/api/flows/preview")!;
    expect(sent.key).toBe("voice-key-0123456789");
    expect(sent.body).toEqual({ flow: { name: "x" }, sample: { customer_name: "Priya", gender: "female" } });
  });

  it("rejects unknown fields before anything else", async () => {
    const preview = await call("/api/call-flows/preview", {
      method: "POST",
      role: "ADMIN",
      body: JSON.stringify({ definition: {}, sample: { phone_number: "+919876543210" } }),
    });
    expect(preview.status).toBe(400);
    const create = await call("/api/call-flows", { method: "POST", role: "ADMIN", body: JSON.stringify({ name: "A", base: "nila", x: 1 }) });
    expect(create.status).toBe(400);
    const draft = await call("/api/call-flows/f1/draft", { method: "PUT", role: "ADMIN", body: JSON.stringify({ definition: { name: "A" } }) });
    expect(draft.status).toBe(400);
  });

  it("test calls only go to allow-listed numbers, picked by id", async () => {
    const free = await call("/api/call-flows/f1/test-call", {
      method: "POST",
      role: "ADMIN",
      body: JSON.stringify({ version: 1, phone: "9812345678" }),
    });
    expect(free.status).toBe(400);
    const res = await call("/api/call-flows/f1/test-call", {
      method: "POST",
      role: "ADMIN",
      body: JSON.stringify({ version: 1, numberId: "+919812345678" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/saved trial number/);
  });

  it("editors can't change call flows (admin-only), but keep the reads they need", async () => {
    const writes: [string, string, unknown][] = [
      ["POST", "/api/call-flows", { name: "A", base: "nila" }],
      ["PUT", "/api/call-flows/f1/draft", { definition: { name: "A" } }],
      ["DELETE", "/api/call-flows/f1/draft", undefined],
      ["POST", "/api/call-flows/f1/publish", {}],
      ["POST", "/api/call-flows/f1/versions/1/restore", {}],
      ["POST", "/api/call-flows/f1/archive", {}],
      ["DELETE", "/api/call-flows/f1", undefined],
      ["POST", "/api/call-flows/test-numbers", { phone: "+919812345678" }],
      ["DELETE", "/api/call-flows/test-numbers/x1", undefined],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(path, { method, role: "EDITOR", ...(body ? { body: JSON.stringify(body) } : {}) });
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
    // Reads stay open to editors: the catalog / flow picker, the preview, and the send pickers.
    expect((await call("/api/call-flows/builtin", { role: "EDITOR" })).status).toBe(200);
    for (const path of ["/api/call-flows", "/api/templates", "/api/whatsapp/templates", "/api/whatsapp/templates/verify"]) {
      const res = await call(path, { role: "EDITOR" });
      expect([path, [401, 403].includes(res.status)]).toEqual([path, false]);
    }
  });

  it("serves the built-in catalog", async () => {
    const res = await call("/api/call-flows/builtin", { role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { variables: string[] }).variables).toEqual(["name"]);
  });
});
