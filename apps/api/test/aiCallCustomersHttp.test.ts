import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// HTTP gates of /api/ai-call-customers and /api/ai-call-followups: sign-in and
// ADMIN are required. Every request here is rejected before any database
// access, so no MySQL is needed.

let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);

beforeAll(async () => {
  process.env.ENABLE_AI_CALLS = "true";
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (path: string, init: RequestInit & { role?: "ADMIN" | "EDITOR" } = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.role ? { Authorization: `Bearer ${token(init.role)}` } : {}),
    },
  });

const ENDPOINTS: [string, string][] = [
  ["GET", "/api/ai-call-customers"],
  ["GET", "/api/ai-call-customers/callable"],
  ["GET", "/api/ai-call-customers/sample"],
  ["POST", "/api/ai-call-customers"],
  ["POST", "/api/ai-call-customers/import"],
  ["POST", "/api/ai-call-customers/delete"],
  ["POST", "/api/ai-call-customers/call"],
  ["GET", "/api/ai-call-customers/abc"],
  ["PUT", "/api/ai-call-customers/abc"],
  ["POST", "/api/ai-call-customers/abc/stage"],
  ["POST", "/api/ai-call-customers/abc/followups"],
  ["POST", "/api/ai-call-customers/add-to-languages"],
  ["POST", "/api/ai-call-customers/copy-to-languages"],
  ["POST", "/api/ai-call-customers/import-to-languages"],
  ["GET", "/api/ai-call-followups"],
  ["PATCH", "/api/ai-call-followups/abc"],
  ["POST", "/api/ai-call-followups/abc/approve"],
  ["POST", "/api/ai-call-followups/abc/reject"],
];

describe("AI Call Customers / follow-ups access", () => {
  it.each(ENDPOINTS)("%s %s requires sign-in", async (method, path) => {
    expect((await call(path, { method, body: method === "GET" ? undefined : "{}" })).status).toBe(401);
  });

  it("lets editors through the role gate", async () => {
    const res = await call("/api/ai-call-customers/delete", { method: "POST", role: "EDITOR", body: JSON.stringify({ ids: [] }) });
    expect(res.status).toBe(400);
  });

  it.each(["add-to-languages", "copy-to-languages", "import-to-languages"])("several language lists: %s is for admins only (editors get 403)", async (path) => {
    const res = await call(`/api/ai-call-customers/${path}`, { method: "POST", role: "EDITOR", body: "{}" });
    expect(res.status).toBe(403);
    // An admin gets past the role gate to input validation (refused before any database access).
    expect((await call(`/api/ai-call-customers/${path}`, { method: "POST", role: "ADMIN", body: "{}" })).status).toBe(400);
  });

  it("several language lists: a language that doesn't exist is refused", async () => {
    const res = await call("/api/ai-call-customers/copy-to-languages", { method: "POST", role: "ADMIN", body: JSON.stringify({ ids: ["a"], targets: ["xx"] }) });
    expect(res.status).toBe(400);
  });

  it("validates input before touching the database", async () => {
    const res = await call("/api/ai-call-customers/delete", { method: "POST", role: "ADMIN", body: JSON.stringify({ ids: [] }) });
    expect(res.status).toBe(400);
    const stage = await call("/api/ai-call-customers/abc/stage", { method: "POST", role: "ADMIN", body: JSON.stringify({ stage: "CALLING" }) });
    expect(stage.status).toBe(400);
  });
});
