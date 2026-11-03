import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callFlowDefinition, materializeUnlockedBlocks, type CallFlowDefinition } from "@dispatch/shared";
import { analyzeImport } from "../src/domain/callFlowImport.js";
import { CALL_START, correctionFromTurn, parseTranscript, scrubPersonalData, transcriptTurns, withExample } from "../src/domain/callFlowTraining.js";

// Training tab: the definition's `training`, corrections from a call transcript (personal details
// removed), the admin-only endpoints, and that versioning / restore / import carry training while a
// flow without it behaves exactly as before. Fake voice backend, in-memory Prisma: no real database,
// no real provider, no phone number sent anywhere.

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");
const BUILTIN = "kagzso-voice-backend-english/app/flows/builtin/";
const LOCKED: Record<string, string> = JSON.parse(read(BUILTIN + "locked_blocks.json"));
const nila = (): CallFlowDefinition => JSON.parse(read(BUILTIN + "nila.json"));

const TRAINING = {
  enabled: true,
  token_cap: 900,
  persona: { status: "active", role: "Nila, a calm AI calling assistant" },
  phrases: [{ id: "ack1", status: "active", situation: "acknowledge", text: "Okay {{title_to_use}}." }],
  knowledge: [{ id: "f1", status: "active", kind: "fact", topic: "company", always: true, text: "Kexo builds AI automation." }],
  examples: [],
};
const trained = (): CallFlowDefinition => callFlowDefinition.parse({ ...nila(), training: TRAINING });

const TRANSCRIPT = [
  "Agent: Hi Ragul sir, Good morning.",
  "Customer: Yes, this is Ragul Kumar. Call me on 98765 43210 or ragul.k@example.com",
  "Agent: Thank you Ragul sir! We can book a free demo for you tomorrow.",
  "Customer: my name is Priya, I handle the quotation for 20 laptops",
  "Agent: Great Priya, I will send details to www.example.org",
].join("\n");

/* ------------------------------------------------------------------ domain */

describe("training in the flow definition", () => {
  it("is optional: a flow without it parses and hashes exactly as before", async () => {
    const { definitionHash } = await import("../src/domain/callFlows.js");
    const plain = nila();
    const parsed = callFlowDefinition.parse(plain);
    expect("training" in parsed).toBe(false);
    expect(definitionHash(parsed)).toBe(definitionHash(callFlowDefinition.parse(nila())));
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(callFlowDefinition.parse(JSON.parse(JSON.stringify(plain)))));
  });

  it("fills defaults and rejects unknown keys, bad statuses and over-long text", () => {
    const t = trained().training!;
    expect(t.phrases[0]).toMatchObject({ style: "english", reviewed: false, when: "" });
    expect(t.persona).toMatchObject({ formality: 3, pace: "steady", title_use: "sometimes" });
    const bad = (training: unknown) => callFlowDefinition.safeParse({ ...nila(), training }).success;
    expect(bad({ ...TRAINING, extra: 1 })).toBe(false);
    expect(bad({ ...TRAINING, phrases: [{ ...TRAINING.phrases[0], status: "live" }] })).toBe(false);
    expect(bad({ ...TRAINING, phrases: [{ ...TRAINING.phrases[0], text: "x".repeat(121) }] })).toBe(false);
    expect(bad({ ...TRAINING, phrases: [{ ...TRAINING.phrases[0], text: "two\nlines" }] })).toBe(false);
    expect(bad({ ...TRAINING, token_cap: 5000 })).toBe(false);
  });

  it("Import full prompt keeps the training (only blocks change)", () => {
    const def = materializeUnlockedBlocks(trained(), LOCKED);
    const { next } = analyzeImport({ prompt: "# PERSONA\n\nYou are Nila, a new persona text." }, def, LOCKED);
    expect(next.training).toEqual(def.training);
  });
});

describe("corrections from a call transcript", () => {
  it("parses Customer / Agent lines", () => {
    expect(parseTranscript(TRANSCRIPT).map((l) => l.speaker)).toEqual(["agent", "customer", "agent", "customer", "agent"]);
    expect(parseTranscript("Agent: one\ncontinued")).toEqual([{ speaker: "agent", text: "one continued" }]);
  });

  it("strips names, phone numbers, emails, links and the follow-up detail", () => {
    const turns = transcriptTurns(TRANSCRIPT, { name: "Ragul Kumar", detail: "the quotation for 20 laptops" });
    const all = JSON.stringify(turns);
    for (const pii of ["Ragul", "Kumar", "98765", "43210", "example.com", "Priya", "laptops", "example.org"]) expect(all).not.toContain(pii);
    expect(turns[0]).toEqual({ turn: 0, customer: CALL_START, agent: "Hi (name) sir, Good morning." });
    expect(turns[1]!.customer).toBe("Yes, this is (name) (name). Call me on (number) or (email)");
    expect(turns[2]!.customer).toBe("my name is (name), I handle (detail)");
    expect(turns[2]!.agent).toContain("(link)");
  });

  it("keeps ordinary words that look like an introduction", () => {
    expect(scrubPersonalData("I am busy right now, this is not a good time")).toBe("I am busy right now, this is not a good time");
    expect(scrubPersonalData("Our site is kagzso.com, call 2 or 3 times")).toBe("Our site is kagzso.com, call 2 or 3 times");
    expect(scrubPersonalData("என் பெயர் ரகுல்")).toBe("என் பெயர் (name)");
  });

  it("becomes a Draft bad example added to the training (switched off when the flow had none)", () => {
    const [, turn] = transcriptTurns(TRANSCRIPT, { name: "Ragul Kumar" });
    const ex = correctionFromTurn(turn!, " Thanks sir, our team can share details if you like. ", "");
    expect(ex).toMatchObject({ status: "draft", kind: "bad", source: "call", reason: "Corrected from a call", better: "Thanks sir, our team can share details if you like." });
    const next = withExample(nila(), ex);
    expect(next.training).toMatchObject({ enabled: false, examples: [ex] });
    expect(callFlowDefinition.safeParse(next).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ HTTP */

type Row = { id: string; flowId: string; version: number; status: "DRAFT" | "PUBLISHED"; definition: unknown; definitionHash: string; publishedAt: Date | null };
let rows: Row[] = [];
let seq = 0;
const flows = new Map<string, { id: string; name: string; archivedAt: Date | null; base: string; language: string; description?: string | null }>();
const byFlow = (flowId: string) => rows.filter((r) => r.flowId === flowId).sort((a, b) => b.version - a.version);
const logs = new Map<string, unknown>();

const db = {
  callFlow: {
    findUnique: async ({ where, include }: { where: { id: string }; include?: unknown }) => {
      const f = flows.get(where.id);
      return f && include ? { ...f, versions: byFlow(f.id) } : (f ?? null);
    },
    update: async ({ where }: { where: { id: string } }) => flows.get(where.id),
    findMany: async () =>
      [...flows.values()].map((f) => ({
        ...f,
        versions: byFlow(f.id).map(({ id, version, status, publishedAt }) => ({ id, version, status, publishedAt })),
      })),
    create: async ({ data }: { data: { name: string; base: string; language: string; description?: string | null; versions: { create: Omit<Row, "id" | "flowId" | "publishedAt"> } } }) => {
      const id = `f${++seq}`;
      flows.set(id, { id, name: data.name, archivedAt: null, base: data.base, language: data.language, description: data.description ?? null });
      rows.push({ ...data.versions.create, id: `v${++seq}`, flowId: id, publishedAt: null } as Row);
      return flows.get(id);
    },
  },
  callFlowVersion: {
    findFirst: async ({ where }: { where: { flowId: string; status?: string } }) =>
      byFlow(where.flowId).find((r) => !where.status || r.status === where.status) ?? null,
    findUnique: async ({ where }: { where: { flowId_version: { flowId: string; version: number } } }) =>
      rows.find((r) => r.flowId === where.flowId_version.flowId && r.version === where.flowId_version.version) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id)!,
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      rows.filter((r) => where.id.in.includes(r.id)).map((r) => ({ id: r.id, definition: r.definition })),
    aggregate: async ({ where }: { where: { flowId: string } }) => ({ _max: { version: byFlow(where.flowId)[0]?.version ?? null } }),
    updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<Row> }) => {
      const r = rows.find((x) => x.id === where.id && x.status === where.status);
      if (r) Object.assign(r, data);
      return { count: r ? 1 : 0 };
    },
    create: async ({ data }: { data: Omit<Row, "id" | "publishedAt"> }) => {
      const r = { ...data, id: `v${++seq}`, publishedAt: null } as Row;
      rows.push(r);
      return r;
    },
  },
  aiCallLog: { findUnique: async ({ where }: { where: { id: string } }) => logs.get(where.id) ?? null },
};
vi.mock("../src/prisma.js", () => ({ prisma: { ...db, $transaction: (fn: (t: typeof db) => unknown) => fn(db) } }));

let server: Server;
let voice: Server;
let base = "";
const voiceRequests: { path: string; body: Record<string, unknown> }[] = [];
const token = (role: "ADMIN" | "EDITOR") =>
  jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
const call = (path: string, body: unknown, role: "ADMIN" | "EDITOR" = "ADMIN", method = "POST") =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(role)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  voice = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      voiceRequests.push({ path: req.url!, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/flows/preview") {
        // Stands in for the voice backend's content rules: a phone number in a phrase is refused.
        const bad = JSON.stringify(body.flow?.training ?? {}).includes("98765");
        res.end(JSON.stringify(bad ? { valid: false, errors: ["training.phrases.1.text: Value error, contains a phone number or long number (personal data)"] } : { valid: true, errors: [] }));
      } else if (req.url === "/api/flows/training-test") {
        if (body.provider_id === "off_llm") {
          res.statusCode = 400;
          res.end(JSON.stringify({ detail: { message: "Pick an LLM provider that is switched on and has a key", code: "not_enabled" } }));
          return;
        }
        const real = body.mode === "real";
        res.end(
          JSON.stringify({
            mode: body.mode,
            provider_id: real ? body.provider_id : "mock",
            model: real ? "m" : "mock",
            without: { reply: real ? "A" : "(mock) A", prompt_tokens: 100 },
            with: { reply: real ? "B" : "(mock) B", prompt_tokens: 180 },
            selected: ["- line"],
            dropped: [],
          }),
        );
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
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => voice.close(() => r()));
});

beforeEach(() => {
  seq = 10;
  voiceRequests.length = 0;
  flows.clear();
  flows.set("live", { id: "live", name: "Nila copy", archivedAt: null, base: "nila", language: "en" });
  rows = [
    { id: "p1", flowId: "live", version: 1, status: "PUBLISHED", definition: nila(), definitionHash: "h1", publishedAt: new Date() },
    { id: "p2", flowId: "live", version: 2, status: "PUBLISHED", definition: trained(), definitionHash: "h2", publishedAt: new Date() },
  ];
  logs.clear();
  const used = { version: 2, flowId: "live", flow: flows.get("live") };
  logs.set("log1", { transcript: TRANSCRIPT, customerName: "Ragul Kumar", followUpDetail: null, run: { flow: { flowVersion: used } } });
  logs.set("noflow", { transcript: TRANSCRIPT, customerName: null, followUpDetail: null, run: { flow: null } });
});

describe("training endpoints", () => {
  it("are admin only: editors get 403", async () => {
    expect((await call("/api/call-flows/training/calls/log1", undefined, "EDITOR", "GET")).status).toBe(403);
    expect((await call("/api/call-flows/training/calls/log1", { turn: 2, better: "x" }, "EDITOR")).status).toBe(403);
    expect((await call("/api/call-flows/live/training/test", { definition: trained(), providerId: "groq_llm", message: "hi" }, "EDITOR")).status).toBe(403);
    expect((await call("/api/call-flows/live/draft", { definition: trained() }, "EDITOR", "PUT")).status).toBe(403);
    expect(voiceRequests).toHaveLength(0);
  });

  it("lists a call's turns with personal details removed", async () => {
    const res = await call("/api/call-flows/training/calls/log1", undefined, "ADMIN", "GET");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ flowId: "live", flowName: "Nila copy", version: 2 });
    expect(JSON.stringify(body)).not.toMatch(/Ragul|98765|example\.com|Priya/);
    expect((await call("/api/call-flows/training/calls/noflow", undefined, "ADMIN", "GET")).status).toBe(400);
  });

  it("saves a correction as a Draft in a new draft version; published versions stay as they were", async () => {
    const before = JSON.stringify(rows.filter((r) => r.status === "PUBLISHED"));
    const res = await call("/api/call-flows/training/calls/log1", { turn: 2, better: "Thanks sir, our team can share the details.", reason: "promised a demo" });
    expect(res.status).toBe(201);
    expect(JSON.stringify(rows.filter((r) => r.status === "PUBLISHED"))).toBe(before);
    const draft = byFlow("live")[0]!;
    expect(draft).toMatchObject({ version: 3, status: "DRAFT" });
    const def = draft.definition as CallFlowDefinition;
    expect(def.training!.phrases).toEqual(trained().training!.phrases); // the existing training is kept
    const ex = def.training!.examples.at(-1)!;
    expect(ex).toMatchObject({ status: "draft", kind: "bad", source: "call", reason: "promised a demo" });
    expect(JSON.stringify(ex)).not.toMatch(/Ragul|98765|example\.com/);
    // Checked by the voice backend before saving.
    expect(voiceRequests.some((r) => r.path === "/api/flows/preview")).toBe(true);
    expect((await call("/api/call-flows/training/calls/log1", { turn: 1, better: "x" })).status).toBe(400); // a Customer line
  });

  it("checks training with the voice backend on save and names the entry; a flow without training saves as before", async () => {
    const bad = trained();
    bad.training!.phrases.push({ ...bad.training!.phrases[0]!, id: "p2", text: "Call 98765 43210" });
    const refused = await call("/api/call-flows/live/draft", { definition: bad }, "ADMIN", "PUT");
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("training.phrases.1.text");
    expect(rows).toHaveLength(2);

    voiceRequests.length = 0;
    const plain = await call("/api/call-flows/live/draft", { definition: nila() }, "ADMIN", "PUT");
    expect(plain.status).toBe(200);
    expect(voiceRequests).toHaveLength(0); // no extra check without training
    expect("training" in (byFlow("live")[0]!.definition as object)).toBe(false);
  });

  it("restore copies the old version's training into the draft", async () => {
    expect((await call("/api/call-flows/live/versions/2/restore", {})).status).toBe(200);
    expect((byFlow("live")[0]!.definition as CallFlowDefinition).training).toEqual(trained().training);
    expect((await call("/api/call-flows/live/versions/1/restore", {})).status).toBe(200);
    expect("training" in (byFlow("live")[0]!.definition as object)).toBe(false);
  });

  it("real test replies go through the flow's voice backend with the provider id and never a phone number", async () => {
    const real = { definition: trained(), mode: "real", providerId: "groq_llm", confirmCost: true, message: "How much does it cost?" };
    const res = await call("/api/call-flows/live/training/test", real);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "real", without: { reply: "A" }, with: { reply: "B" } });
    const sent = voiceRequests.find((r) => r.path === "/api/flows/training-test")!;
    expect(sent.body).toMatchObject({ mode: "real", provider_id: "groq_llm", message: "How much does it cost?" });
    expect(Object.keys(sent.body).sort()).toEqual(["flow", "message", "mode", "provider_id"]);
    const off = await call("/api/call-flows/live/training/test", { ...real, providerId: "off_llm", message: "hi" });
    expect(off.status).toBe(400);
    expect(((await off.json()) as { error: string }).error).toMatch(/switched on/);
  });
});

/* ------------------------------------------------------------------ Training Studio, phase 1 */

const PROFILE = { agent_name: "Thaara", company: "Kagzso AI and Automation", objective: "Introduce our AI automation services" };
const withProfile = (status: "active" | "draft" = "active", enabled = true): CallFlowDefinition =>
  callFlowDefinition.parse({ ...nila(), training: { ...TRAINING, enabled, persona: { ...TRAINING.persona, ...PROFILE, status } } });

describe("agent profile, situations and example metadata in the definition", () => {
  it("profile fields default to empty and are single lines with limits", () => {
    expect(trained().training!.persona).toMatchObject({ agent_name: "", company: "", objective: "", intro: "" });
    expect(withProfile().training!.persona).toMatchObject(PROFILE);
    const ok = (persona: Record<string, unknown>) =>
      callFlowDefinition.safeParse({ ...nila(), training: { ...TRAINING, persona: { ...TRAINING.persona, ...persona } } }).success;
    expect(ok({ agent_name: "தாரா" })).toBe(true);
    expect(ok({ agent_name: "Agent 007" })).toBe(false);
    expect(ok({ objective: "x".repeat(301) })).toBe(false);
    expect(ok({ intro: "two\nlines" })).toBe(false);
  });

  it("accepts the new situations and optional example metadata; an example without them is unchanged", () => {
    const phrase = { id: "d1", status: "active", situation: "disclosure", text: "I am an AI assistant." };
    const example = { id: "e1", status: "active", kind: "good", customer: "Who is this?", agent: "This is Thaara from Kexo.", situation: "identity", topic: "identity", style: "english" };
    const def = callFlowDefinition.parse({ ...nila(), training: { ...TRAINING, phrases: [phrase], examples: [example] } });
    expect(def.training!.examples[0]).toMatchObject({ situation: "identity", topic: "identity", style: "english" });
    const { situation: _s, topic: _t, style: _st, ...bare } = example;
    const plain = callFlowDefinition.parse({ ...nila(), training: { ...TRAINING, examples: [bare] } });
    expect(Object.keys(plain.training!.examples[0]!)).not.toContain("topic");
    expect(callFlowDefinition.safeParse({ ...nila(), training: { ...TRAINING, phrases: [{ ...phrase, situation: "upsell" }] } }).success).toBe(false);
  });

  it("the executive base keeps the nila locked blocks, and its built-in script parses", async () => {
    const { CALL_FLOW_BASES, CALL_FLOW_LOCKED_KEYS } = await import("@dispatch/shared");
    expect(CALL_FLOW_BASES).toContain("executive");
    expect(CALL_FLOW_LOCKED_KEYS.executive).toEqual(CALL_FLOW_LOCKED_KEYS.nila);
    const exe = JSON.parse(read(BUILTIN + "executive.json"));
    expect(callFlowDefinition.safeParse(exe).success).toBe(true);
  });

  it("a correction keeps the situation, topic and style the admin picked", () => {
    const [, turn] = transcriptTurns(TRANSCRIPT, { name: "Ragul Kumar" });
    const ex = correctionFromTurn(turn!, "Our team shares exact pricing after understanding your needs.", "", { situation: "price", topic: " price ", style: "english" });
    expect(ex).toMatchObject({ situation: "price", topic: "price", style: "english", status: "draft" });
    expect(Object.keys(correctionFromTurn(turn!, "x", ""))).not.toContain("situation");
  });
});

describe("Training Studio endpoints", () => {
  it("the training test is a free mock unless a real test is asked for and its cost confirmed", async () => {
    const mock = await call("/api/call-flows/live/training/test", { definition: trained(), message: "How much does it cost?" });
    expect(mock.status).toBe(200);
    expect(await mock.json()).toMatchObject({ mode: "mock", provider_id: "mock", selected: ["- line"] });
    const sent = voiceRequests.find((r) => r.path === "/api/flows/training-test")!;
    expect(sent.body).toMatchObject({ mode: "mock" });
    expect("provider_id" in sent.body).toBe(false);

    voiceRequests.length = 0;
    const unconfirmed = await call("/api/call-flows/live/training/test", { definition: trained(), mode: "real", providerId: "groq_llm", message: "hi" });
    expect(unconfirmed.status).toBe(400);
    const noProvider = await call("/api/call-flows/live/training/test", { definition: trained(), mode: "real", confirmCost: true, message: "hi" });
    expect(noProvider.status).toBe(400);
    expect(voiceRequests).toHaveLength(0); // refused before anything reaches a provider
  });

  it("editors never see training: stripped from the flow, its preview refused, the tab actions 403", async () => {
    rows.push({ id: "d3", flowId: "live", version: 3, status: "DRAFT", definition: withProfile(), definitionHash: "h3", publishedAt: null });
    type Detail = { versions: { version: number; definition: CallFlowDefinition }[] };
    const asEditor = (await (await call("/api/call-flows/live", undefined, "EDITOR", "GET")).json()) as Detail;
    expect(asEditor.versions.every((v) => !("training" in v.definition))).toBe(true);
    expect(asEditor.versions.find((v) => v.version === 1)!.definition.blocks).toEqual(nila().blocks);
    const asAdmin = (await (await call("/api/call-flows/live", undefined, "ADMIN", "GET")).json()) as Detail;
    expect(asAdmin.versions.find((v) => v.version === 3)!.definition.training!.persona!.agent_name).toBe("Thaara");

    expect((await call("/api/call-flows/preview", { definition: trained(), trainingMessage: "price?" }, "EDITOR")).status).toBe(403);
    voiceRequests.length = 0;
    expect((await call("/api/call-flows/preview", { definition: trained() }, "EDITOR")).status).toBe(200);
    expect("training" in (voiceRequests[0]!.body.flow as object)).toBe(false); // an editor's preview compiles no training
    expect((await call("/api/call-flows/live/copy", { name: "Mine" }, "EDITOR")).status).toBe(403);
    expect((await call("/api/call-flows/live/training/test", { definition: trained(), message: "hi" }, "EDITOR")).status).toBe(403);
  });

  it("the list shows the live version's agent profile, never the rest of the training", async () => {
    rows.push({ id: "p3", flowId: "live", version: 3, status: "PUBLISHED", definition: withProfile(), definitionHash: "h3", publishedAt: new Date() });
    const items = ((await (await call("/api/call-flows", undefined, "EDITOR", "GET")).json()) as { items: { agent: unknown }[] }).items;
    expect(items[0]!.agent).toEqual({ agentName: "Thaara", role: TRAINING.persona.role, company: PROFILE.company, objective: PROFILE.objective, trainingOn: true });
    expect(JSON.stringify(items)).not.toMatch(/Kexo builds|Okay \{\{title_to_use\}\}/); // facts and phrases stay private
  });

  it("copies a flow as a new Draft v1, with or without its training; the source is unchanged", async () => {
    rows.push({ id: "d3", flowId: "live", version: 3, status: "DRAFT", definition: withProfile("draft", false), definitionHash: "h3", publishedAt: null });
    const before = JSON.stringify(rows.filter((r) => r.flowId === "live"));
    const res = await call("/api/call-flows/live/copy", { name: "Executive test" });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(flows.get(id)).toMatchObject({ name: "Executive test", base: "nila", language: "en" });
    const copy = byFlow(id);
    expect(copy).toHaveLength(1);
    expect(copy[0]).toMatchObject({ version: 1, status: "DRAFT" });
    const def = copy[0]!.definition as CallFlowDefinition;
    expect(def.name).toBe("Executive test");
    expect(def.training).toEqual(withProfile("draft", false).training); // from the newest version (the draft)
    expect(JSON.stringify(rows.filter((r) => r.flowId === "live"))).toBe(before);
    expect(voiceRequests.some((r) => r.path === "/api/flows/preview")).toBe(true); // checked by the voice backend

    const bare = await call("/api/call-flows/live/copy", { name: "No training", includeTraining: false });
    const bareId = ((await bare.json()) as { id: string }).id;
    expect("training" in (byFlow(bareId)[0]!.definition as object)).toBe(false);
    expect((await call("/api/call-flows/live/copy", { name: "" })).status).toBe(400);
    expect((await call("/api/call-flows/nope/copy", { name: "x" })).status).toBe(404);
  });

  it("a correction saved from a call carries its situation, topic and style", async () => {
    const res = await call("/api/call-flows/training/calls/log1", { turn: 2, better: "Thanks sir, our team can share the details.", situation: "objection", topic: "demo", style: "english" });
    expect(res.status).toBe(201);
    const ex = (byFlow("live")[0]!.definition as CallFlowDefinition).training!.examples.at(-1)!;
    expect(ex).toMatchObject({ situation: "objection", topic: "demo", style: "english", status: "draft" });
  });
});

/* ------------------------------------------------------------------ Phase 11 quality fixes */

describe("language-aware training cap and the uncertain situation", () => {
  it("a new training starts at 900 in English and 1200 in an Indic flow; a saved cap is kept", async () => {
    const { trainingDefaultTokenCap, TRAINING_MAX_TOKEN_CAP } = await import("@dispatch/shared");
    expect(trainingDefaultTokenCap("en")).toBe(900);
    expect(trainingDefaultTokenCap("ta")).toBe(1200);
    expect(trainingDefaultTokenCap("hi")).toBe(1200);
    expect(trainingDefaultTokenCap("ta")).toBeLessThanOrEqual(TRAINING_MAX_TOKEN_CAP);
    const [, turn] = transcriptTurns(TRANSCRIPT, { name: "Ragul Kumar" });
    const ex = correctionFromTurn(turn!, "Okay, thank you.", "");
    expect(withExample(nila(), ex).training!.token_cap).toBe(900);
    expect(withExample({ ...nila(), language: "ta" }, ex).training!.token_cap).toBe(1200);
    expect(withExample({ ...trained(), language: "ta" }, ex).training!.token_cap).toBe(900); // an existing training keeps its cap
  });

  it("accepts the uncertain situation for phrases, examples and corrections", () => {
    const phrase = { id: "u1", status: "active", situation: "uncertain", text: "Of course, take your time." };
    expect(callFlowDefinition.safeParse({ ...nila(), training: { ...TRAINING, phrases: [phrase] } }).success).toBe(true);
    const [, turn] = transcriptTurns(TRANSCRIPT, { name: "Ragul Kumar" });
    expect(correctionFromTurn(turn!, "Take your time.", "", { situation: "uncertain" }).situation).toBe("uncertain");
  });
});
