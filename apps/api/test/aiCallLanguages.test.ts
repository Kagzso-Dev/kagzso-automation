import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiCallLanguagePath, splitAiCallLanguagePath } from "@dispatch/shared";

// One voice backend per language. Two fake voice backends (English, Tamil) and an in-memory
// Prisma: each language's requests reach only its own backend, English requests are unchanged,
// a backend speaking the wrong language is refused, and an admin can switch Tamil off and on.

type Hit = { lang: string; method: string; path: string; body: Record<string, unknown> | null };
const hits: Hit[] = [];
let tamilSays = "ta"; // what the "Tamil" backend reports as its language

function fakeBackend(lang: "en" | "ta"): Server {
  return createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      hits.push({ lang, method: req.method!, path: req.url!, body });
      const says = lang === "ta" ? tamilSays : "en";
      const json = (status: number, b: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(b));
      };
      if (req.url === "/api/voices/preview") {
        res.setHeader("Content-Type", "audio/wav");
        return res.end(Buffer.from(`RIFF-${lang}`));
      }
      if (req.url === "/health") return json(200, { status: "ok" }); // running: switch-on / Run start nothing
      if (req.url === "/api/flows/builtin") return json(200, { language: says, flows: {}, locked_blocks: {}, variables: [], limits: {} });
      if (req.url === "/ready") return json(200, { status: "ready", mysql: "ok", providers: { public_base_url: "configured" }, language: says });
      if (req.url === "/api/calls/outbound") return json(200, { success: true, call_id: `call-${lang}`, provider_call_id: null });
      return json(404, { detail: "Not Found" });
    });
  }).listen(0);
}

// In-memory Prisma: the Setting table, call flow lists and runs.
const settings = new Map<string, unknown>();
const flowListWheres: unknown[] = [];
const db = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
    upsert: async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
      settings.set(where.key, create.value);
      return {};
    },
  },
  callFlow: {
    findMany: async ({ where }: { where: unknown }) => {
      flowListWheres.push(where);
      return [];
    },
  },
  aiCallRun: { findFirst: async () => null, findMany: async () => [] },
};
vi.mock("../src/prisma.js", () => ({ prisma: db }));

let en: Server;
let ta: Server;
let server: Server;
let base = "";
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const call = (path: string, role: "ADMIN" | "EDITOR", init: { method?: string; body?: unknown } = {}) =>
  fetch(base + path, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(role)}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

beforeAll(async () => {
  en = fakeBackend("en");
  ta = fakeBackend("ta");
  process.env.ENABLE_AI_CALLS = "true";
  process.env.ENABLE_CALL_FLOW_EDITOR = "true";
  process.env.VOICE_BACKEND_URL = `http://127.0.0.1:${(en.address() as AddressInfo).port}`;
  process.env.VOICE_BACKEND_API_KEY = "voice-key-0123456789";
  process.env.VOICE_BACKEND_URL_TA = `http://127.0.0.1:${(ta.address() as AddressInfo).port}`; // key: the English one
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of [server, en, ta]) await new Promise<void>((r) => s.close(() => r()));
  delete process.env.VOICE_BACKEND_URL_TA;
});
beforeEach(() => {
  hits.length = 0;
  flowListWheres.length = 0;
  settings.clear();
  tamilSays = "ta";
});

describe("language addresses", () => {
  it("English keeps its pages; other languages get a prefix", () => {
    expect(aiCallLanguagePath("en", "/call-flows")).toBe("/call-flows");
    expect(aiCallLanguagePath("ta", "/call-flows")).toBe("/ta/call-flows");
    expect(splitAiCallLanguagePath("/hi/ai-call-customers")).toEqual({ language: "hi", path: "/ai-call-customers" });
    expect(splitAiCallLanguagePath("/call-flows")).toEqual({ language: "en", path: "/call-flows" });
    expect(splitAiCallLanguagePath("/lists/ab")).toEqual({ language: "en", path: "/lists/ab" });
  });
});

describe("each language reaches only its own voice backend", () => {
  it("config lists English, Tamil, Hindi and Kannada (pages exist before a backend is set up)", async () => {
    const body = (await (await call("/api/ai-calls/config", "EDITOR")).json()) as {
      languages: { code: string; enabled: boolean; configured: boolean }[];
    };
    expect(body.languages.map((l) => [l.code, l.enabled, l.configured])).toEqual([
      ["en", true, true],
      ["ta", true, true],
      ["hi", true, false], // no VOICE_BACKEND_URL_HI: its pages show, it can't call
      ["kn", true, false],
    ]);
  });

  it("a language without a backend can't call: its runs are refused with the setting to add", async () => {
    const rows = [{ customerName: "Arun", gender: "male", phone: "9876543210" }];
    const res = await call("/api/ai-calls/start", "EDITOR", { method: "POST", body: { rows, mode: "all", language: "hi", flowId: "f1" } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/Hindi voice backend is not configured — set VOICE_BACKEND_URL_HI/);
    const catalog = await call("/api/call-flows/builtin?language=hi", "EDITOR");
    expect(catalog.status).toBe(503);
  });

  it("voice previews: Tamil to the Tamil backend; English exactly as before", async () => {
    const tamil = await call("/api/voices/preview", "ADMIN", { method: "POST", body: { voice_id: "roopa", text: "வணக்கம்", language: "ta" } });
    expect(Buffer.from(await tamil.arrayBuffer()).toString()).toBe("RIFF-ta");
    const english = await call("/api/voices/preview", "ADMIN", { method: "POST", body: { voice_id: "roopa", text: "Hello" } });
    expect(Buffer.from(await english.arrayBuffer()).toString()).toBe("RIFF-en");
    expect(hits.map((h) => [h.lang, h.body])).toEqual([
      ["ta", { voice_id: "roopa", text: "வணக்கம்" }], // the language picks the backend; the body is unchanged
      ["en", { voice_id: "roopa", text: "Hello" }],
    ]);
  });

  it("call flow lists and built-ins are per language", async () => {
    expect((await call("/api/call-flows?language=ta", "EDITOR")).status).toBe(200);
    expect((await call("/api/call-flows", "EDITOR")).status).toBe(200);
    expect(flowListWheres).toEqual([
      { archivedAt: null, language: "ta" },
      { archivedAt: null, language: "en" },
    ]);
    const catalog = (await (await call("/api/call-flows/builtin?language=ta", "EDITOR")).json()) as { language: string };
    expect(catalog.language).toBe("ta");
    expect(hits.filter((h) => h.path === "/api/flows/builtin").map((h) => h.lang)).toEqual(["ta"]);
  });

  it("a Tamil backend that calls in English is refused (calls would speak the wrong language)", async () => {
    tamilSays = "en";
    const langs = (await (await call("/api/ai-calls/languages", "ADMIN")).json()) as {
      items: { code: string; status: { problem: string | null } | null }[];
    };
    expect(langs.items.find((l) => l.code === "ta")!.status!.problem).toMatch(/calls in English \(CALL_LANGUAGE=en\)/);
    expect(langs.items.find((l) => l.code === "en")!.status!.problem).toBeNull();
  });
});

describe("Settings → AI call languages", () => {
  it("only admins can switch a language; English can't be switched off", async () => {
    expect((await call("/api/ai-calls/languages/ta", "EDITOR", { method: "PUT", body: { enabled: false } })).status).toBe(403);
    expect((await call("/api/ai-calls/languages", "EDITOR")).status).toBe(403);
    expect((await call("/api/ai-calls/languages/en", "ADMIN", { method: "PUT", body: { enabled: false } })).status).toBe(400);
    expect((await call("/api/ai-calls/languages/te", "ADMIN", { method: "PUT", body: { enabled: false } })).status).toBe(404); // no pages
    // Hindi has pages before its backend exists, so it can be switched too.
    expect((await call("/api/ai-calls/languages/hi", "ADMIN", { method: "PUT", body: { enabled: false } })).status).toBe(200);
    expect(settings.get("aiCallLanguagesDisabled")).toEqual(["hi"]);
  });

  it("Disable hides Tamil and refuses its runs; Enable brings it back", async () => {
    const off = await call("/api/ai-calls/languages/ta", "ADMIN", { method: "PUT", body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(settings.get("aiCallLanguagesDisabled")).toEqual(["ta"]);
    const config = (await (await call("/api/ai-calls/config", "EDITOR")).json()) as { languages: { code: string }[] };
    expect(config.languages.map((l) => l.code)).toEqual(["en", "hi", "kn"]);

    const rows = [{ customerName: "Arun", gender: "male", phone: "9876543210" }];
    const refused = await call("/api/ai-calls/start", "EDITOR", { method: "POST", body: { rows, mode: "all", language: "ta", flowId: "f1" } });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Tamil AI calls are switched off/);

    const on = (await (await call("/api/ai-calls/languages/ta", "ADMIN", { method: "PUT", body: { enabled: true } })).json()) as {
      backend: { started: boolean; running: boolean; error: string | null } | null;
    };
    expect(settings.get("aiCallLanguagesDisabled")).toEqual([]);
    // Switching on makes sure its voice backend runs: already up here, so nothing was started.
    expect(on.backend).toEqual({ started: false, running: true, error: null });
  });

  it("Run: admins only; a running backend isn't started again; no backend says what to set", async () => {
    expect((await call("/api/ai-calls/languages/ta/run", "EDITOR", { method: "POST" })).status).toBe(403);
    const ran = await call("/api/ai-calls/languages/ta/run", "ADMIN", { method: "POST" });
    expect(ran.status).toBe(200);
    expect(await ran.json()).toEqual({ started: false, running: true, error: null });
    const none = await call("/api/ai-calls/languages/hi/run", "ADMIN", { method: "POST" });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toMatch(/set VOICE_BACKEND_URL_HI \(npm run voice:lang:init -- hi\)/);
    // Switching on a language without a backend just switches it on (nothing to start).
    const hi = (await (await call("/api/ai-calls/languages/hi", "ADMIN", { method: "PUT", body: { enabled: true } })).json()) as { backend: unknown };
    expect(hi.backend).toBeNull();
  });

  it("a Tamil run always uses a Tamil flow (no default agent)", async () => {
    const rows = [{ customerName: "Arun", gender: "male", phone: "9876543210" }];
    const res = await call("/api/ai-calls/start", "EDITOR", { method: "POST", body: { rows, mode: "all", language: "ta" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Pick a Tamil call flow/);
  });
});

describe("placing a call", () => {
  it("a Tamil call goes to the Tamil backend by agent name; English is sent as before", async () => {
    const { placeVoiceCall } = await import("../src/services/voiceBackend.js");
    const input = { customerName: "Arun", gender: "male", followUpDetail: null, phone: "+919876543210", runId: "r1", logId: "l1" };
    expect(await placeVoiceCall({ ...input, language: "ta" })).toEqual({ callId: "call-ta", providerCallId: null });
    expect(await placeVoiceCall(input)).toEqual({ callId: "call-en", providerCallId: null });
    const [tamil, english] = hits.filter((h) => h.path === "/api/calls/outbound");
    expect(tamil!.lang).toBe("ta");
    expect(tamil!.body).not.toHaveProperty("agent_id"); // the English backend's row id means nothing there
    expect(tamil!.body).not.toHaveProperty("language");
    expect(english!.lang).toBe("en");
  });
});
