import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aiPrompt,
  checkRows,
  detectDataQualityColumns,
  indianPhoneIssues,
  isPlaceholderEmail,
  overallScore,
  parseAiAnswer,
  type DqLookups,
} from "../src/domain/dataQuality.js";
import { isLoopbackHost, readAiSettings } from "../src/config/dataQuality.js";
import { aiUrl, allowedPaths, generateJson } from "../src/services/dataQualityAi.js";
import { exportCell } from "../src/http/routes/dataQuality.js";
import {
  DQ_DO_NOT_CALL,
  DQ_EXPECTED,
  DQ_HEADERS,
  DQ_IN_VOICECALL,
  DQ_IN_WHATSAPP,
  DQ_NOT_INTERESTED,
  DQ_WRONG_PERSON,
  dqSheetRows,
} from "./dataQualityFixture.js";

// Data Quality: the standard checks on the 20-row test file, the AI service guard (Ollama / Groq /
// Gemini), the prompt (no phone / email), and the export. No DB; fetch is faked where used.

const lookups = (): DqLookups => ({
  doNotCall: new Set([DQ_DO_NOT_CALL]),
  notInterested: new Set([DQ_NOT_INTERESTED]),
  wrongPerson: new Set([DQ_WRONG_PERSON]),
  inVoicecall: new Set([DQ_IN_VOICECALL]),
  inWhatsapp: new Set([DQ_IN_WHATSAPP]),
  emailContacts: new Set(["mohan@mohanpharmacy.in"]),
});

describe("standard checks on the 20-row file", () => {
  const mapping = detectDataQualityColumns([...DQ_HEADERS]);
  const { records, counts } = checkRows(dqSheetRows(), mapping, lookups());
  const row = (n: number) => records[n - 2]!; // spreadsheet row number (header = row 1)

  it("finds the columns by header", () => {
    expect(mapping).toEqual({ name: "Name", phone: "Phone", business: "Business Name", email: "Email" });
  });

  it("counts every row once", () => {
    expect(counts).toEqual(DQ_EXPECTED);
    expect(records).toHaveLength(20);
  });

  it("a bad or missing phone is INVALID", () => {
    expect([row(7).status, row(7).issues]).toEqual(["INVALID", ["bad_phone"]]);
    expect([row(8).status, row(8).issues]).toEqual(["INVALID", ["missing_phone"]]);
  });

  it("the same number again is a DUPLICATE of the first row", () => {
    expect(row(9)).toMatchObject({ status: "DUPLICATE", phone: "+919876500001", issues: ["duplicate_of_row_2"] });
    expect(row(2).status).toBe("VALID");
  });

  it("do not call, not interested and wrong person are EXCLUDED and never scored", () => {
    expect([row(10).status, row(10).excludedReason]).toEqual(["EXCLUDED", "do_not_call"]);
    expect([row(11).status, row(11).excludedReason]).toEqual(["EXCLUDED", "not_interested"]);
    expect([row(12).status, row(12).excludedReason]).toEqual(["EXCLUDED", "wrong_person"]);
    for (const n of [10, 11, 12]) expect([row(n).ruleScore, row(n).aiState]).toEqual([null, "NONE"]);
  });

  it("only VALID rows get a rule score and wait for the AI score", () => {
    for (const r of records) {
      expect(r.aiState).toBe(r.status === "VALID" ? "PENDING" : "NONE");
      expect(r.ruleScore === null).toBe(r.status !== "VALID");
    }
  });

  it("name, business and email problems lower the score", () => {
    expect([row(2).issues, row(2).ruleScore]).toEqual([[], 100]);
    expect([row(4).issues, row(4).ruleScore]).toEqual([["missing_business"], 85]);
    expect([row(5).issues, row(5).ruleScore]).toEqual([["suspicious_name"], 75]);
    expect([row(6).issues, row(6).ruleScore]).toEqual([["missing_name"], 70]);
    expect([row(13).issues, row(13).ruleScore]).toEqual([["bad_email"], 90]);
  });

  it("numbers already saved are noted, not excluded", () => {
    expect([row(14).status, row(14).flags]).toEqual(["VALID", ["in_voicecall"]]);
    expect([row(15).status, row(15).flags]).toEqual(["VALID", ["in_whatsapp"]]);
    expect(row(16).flags).toEqual(["in_email_contacts"]);
  });

  it("placeholder numbers are INVALID; Indian landlines stay VALID but lose 20 points", () => {
    for (const p of ["+919999999999", "+919000000001", "+911234567890", "+919876543210", "+919898989898"]) {
      expect([p, indianPhoneIssues(p)]).toEqual([p, ["fake_phone"]]);
    }
    expect(indianPhoneIssues("+914423456789")).toEqual(["not_mobile"]);
    for (const p of ["+919840012345", "+916380112233", "+447700900123"]) expect([p, indianPhoneIssues(p)]).toEqual([p, []]);

    const phoneOnly = { name: "Name", phone: "Phone", business: "Business", email: null };
    const rows = ["99999 99999", "+91 90000 00005", "1234567890", "044 2345 6789", "98400 12345", "9999999999"].map((Phone) => ({
      Name: "Ravi Kumar",
      Phone,
      Business: "Ravi Traders",
    }));
    const { records: rs, counts: c } = checkRows(rows, phoneOnly, lookups());
    expect(rs.map((r) => [r.status, r.issues, r.ruleScore])).toEqual([
      ["INVALID", ["fake_phone"], null],
      ["INVALID", ["fake_phone"], null],
      ["INVALID", ["fake_phone"], null],
      ["VALID", ["not_mobile"], 80],
      ["VALID", [], 100],
      ["INVALID", ["fake_phone"], null], // a placeholder listed twice is never a duplicate to approve
    ]);
    expect(rs[0]!.phone).toBe("+919999999999");
    expect(c).toMatchObject({ valid: 2, invalid: 4, duplicates: 0 });
  });

  it("placeholder emails are bad emails; the same email on two valid rows is a note, not a penalty", () => {
    for (const e of ["test@gmail.com", "no-email@shop.in", "N.A@gmail.com", "ravi@example.com", "owner@na.com", "ravi@shop.test"]) {
      expect([e, isPlaceholderEmail(e)]).toEqual([e, true]);
    }
    for (const e of ["ravi@ravitraders.in", "info@shop.in", "contact@gmail.com", "testingteam@tcs.com"]) expect([e, isPlaceholderEmail(e)]).toEqual([e, false]);

    const cols = { name: "Name", phone: "Phone", business: "Business", email: "Email" };
    const rows = [
      ["9840012301", "ravi@ravitraders.in"], // row 2
      ["9840012302", "RAVI@ravitraders.in"], // row 3: same address, other case
      ["9840012303", "test@test.com"], // row 4
      ["9840012304", "test@test.com"], // row 5: placeholders are not compared
      ["12345", "shop@shop.in"], // row 6: INVALID, its email is not remembered
      ["9840012306", "shop@shop.in"], // row 7
    ].map(([Phone, Email]) => ({ Name: "Ravi Kumar", Phone: Phone!, Business: "Ravi Traders", Email: Email! }));
    const { records: rs } = checkRows(rows, cols, lookups());
    expect(rs.map((r) => [r.status, r.issues, r.flags, r.ruleScore])).toEqual([
      ["VALID", [], [], 100],
      ["VALID", [], ["same_email_as_row_2"], 100],
      ["VALID", ["bad_email"], [], 90],
      ["VALID", ["bad_email"], [], 90],
      ["INVALID", ["bad_phone"], [], null],
      ["VALID", [], [], 100],
    ]);
  });

  it("a do-not-call number listed twice stays EXCLUDED both times (never a duplicate to approve)", () => {
    const twice = checkRows([{ Phone: "9876500009" }, { Phone: "9876500009" }], { name: null, phone: "Phone", business: null, email: null }, lookups());
    expect(twice.records.map((r) => r.status)).toEqual(["EXCLUDED", "EXCLUDED"]);
  });
});

describe("AI service guard (one service, fixed address, name + business only)", () => {
  const local = readAiSettings({ OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama3.2" });
  const groq = readAiSettings({ DATA_QUALITY_AI_PROVIDER: "groq", GROQ_API_KEY: "gsk_test_key", GROQ_MODEL: "llama-3.1-8b-instant" });
  const gemini = readAiSettings({ DATA_QUALITY_AI_PROVIDER: "gemini", GEMINI_API_KEY: "gem_test_key", GEMINI_MODEL: "gemini-2.5-flash" });

  it("Ollama is accepted only on this machine; it is the default service", () => {
    expect(local).toMatchObject({ provider: "ollama", origin: "http://127.0.0.1:11434", model: "llama3.2", problem: null, minGapMs: 250 });
    expect(readAiSettings({ OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: "m" }).problem).toBeNull();
    for (const url of ["https://api.openai.com", "http://10.0.0.5:11434", "http://ollama.example.com:11434", "http://169.254.169.254"]) {
      expect(readAiSettings({ OLLAMA_BASE_URL: url, OLLAMA_MODEL: "m" })).toMatchObject({ origin: null, problem: expect.stringMatching(/this server/) });
    }
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
  });

  it("Groq and Gemini use their own fixed address; the key and model are required", () => {
    expect(groq).toMatchObject({ provider: "groq", origin: "https://api.groq.com", model: "llama-3.1-8b-instant", problem: null, minGapMs: 2500 });
    expect(gemini).toMatchObject({ provider: "gemini", origin: "https://generativelanguage.googleapis.com", problem: null });
    expect(readAiSettings({ DATA_QUALITY_AI_PROVIDER: "groq", GROQ_MODEL: "m" }).problem).toBe("GROQ_API_KEY is not set");
    expect(readAiSettings({ DATA_QUALITY_AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" }).problem).toBe("GEMINI_MODEL is not set");
    expect(readAiSettings({ DATA_QUALITY_AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_MODEL: "../x" }).problem).toMatch(/not a valid model/);
    expect(readAiSettings({ DATA_QUALITY_AI_PROVIDER: "openai" }).problem).toMatch(/must be one of: ollama, groq, gemini/);
  });

  it("not configured = AI off, never a crash", () => {
    expect(readAiSettings({}).problem).toBe("OLLAMA_BASE_URL is not set");
    expect(readAiSettings({ OLLAMA_BASE_URL: "http://127.0.0.1:11434" }).problem).toBe("OLLAMA_MODEL is not set");
    expect(() => aiUrl("/api/tags", readAiSettings({}))).toThrow(/not set/);
  });

  it("builds URLs only for the chosen service and its two paths", () => {
    expect(allowedPaths("ollama", "m")).toEqual(["/api/tags", "/api/generate"]);
    expect(aiUrl("/api/generate", local)).toBe("http://127.0.0.1:11434/api/generate");
    expect(aiUrl("/openai/v1/chat/completions", groq)).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(aiUrl("/v1beta/models/gemini-2.5-flash:generateContent", gemini)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    for (const [s, path] of [
      [local, "/api/pull"], [local, "//evil.com/api/generate"], [local, "/api/generate?x=1"],
      [groq, "/api/generate"], [groq, "/openai/v1/files"], [groq, "https://evil.com/openai/v1/chat/completions"],
      [gemini, "/v1beta/models/other-model:generateContent"], [gemini, "/v1beta/files"],
    ] as const) {
      expect(() => aiUrl(path, s)).toThrow();
    }
  });

  it("Groq and Gemini requests: right address, key in a header (never the URL), prompt without phone / email", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      const answer = JSON.stringify({ score: 92, issues: [] });
      const body = url.includes("groq") ? { choices: [{ message: { content: answer } }] } : { candidates: [{ content: { parts: [{ text: answer }] } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const prompt = aiPrompt({ name: "Deepa", businessName: "Deepa Bakery" });
      expect(await generateJson(prompt, groq)).toEqual({ score: 92, issues: [] });
      expect(await generateJson(prompt, gemini)).toEqual({ score: 92, issues: [] });
    } finally {
      globalThis.fetch = real;
    }
    expect(seen.map((r) => r.url)).toEqual([
      "https://api.groq.com/openai/v1/chat/completions",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    ]);
    expect(seen[0]!.headers.Authorization).toBe("Bearer gsk_test_key");
    expect(seen[1]!.headers["x-goog-api-key"]).toBe("gem_test_key");
    for (const r of seen) {
      expect(r.url).not.toMatch(/key/);
      expect(r.body).toContain("Deepa Bakery");
      expect(r.body).not.toMatch(/9876|@|phone|email/i);
    }
  });

  it("too many requests → wait and retry (not a failure)", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 429, headers: { "retry-after": "12" } })) as typeof fetch;
    try {
      await expect(generateJson("x JSON", groq)).rejects.toMatchObject({ name: "AiError", retryAfterMs: 12_000 });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("the prompt carries only the name and business name — never the phone or email", () => {
    const p = aiPrompt({ name: "Ravi Kumar", businessName: "Ravi Traders" });
    expect(p).toContain('"name":"Ravi Kumar"');
    expect(p).toContain('"business_name":"Ravi Traders"');
    expect(p).not.toMatch(/9876|@|phone|email/i);
  });

  it("reads the model answer defensively", () => {
    expect(parseAiAnswer({ score: 87.6, issues: ["name ok", "  "] })).toEqual({ score: 88, notes: "name ok" });
    expect(parseAiAnswer({ score: "140" })).toEqual({ score: 100, notes: null });
    expect(() => parseAiAnswer({ issues: [] })).toThrow();
    expect(overallScore(80, null)).toBe(80);
    expect(overallScore(80, 61)).toBe(71);
    expect(overallScore(null, 90)).toBeNull();
  });

  it("source guard: only services/dataQualityAi.ts opens a network request, and no module reaches another service", () => {
    const files = ["config/dataQuality.ts", "services/dataQualityAi.ts", "domain/dataQuality.ts", "queue/dataQuality.ts", "http/routes/dataQuality.ts"];
    const forbidden = /voiceBackend|services\/whatsapp|provider\/|smtp|nodemailer|twilio|plivo|sarvam|openai|anthropic|axios|node:https?['"]|undici/i;
    const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
    for (const f of files) {
      const imports = [...read(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect([f, imports.filter((i) => forbidden.test(i))]).toEqual([f, []]);
      expect([f, /\bfetch\(/.test(read(f))]).toEqual([f, f === "services/dataQualityAi.ts"]);
    }
    // The only hosts written anywhere in the module are the two cloud services' fixed addresses.
    const hosts = files.flatMap((f) => [...read(f).matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]));
    expect([...new Set(hosts)].sort()).toEqual(["https://api.groq.com", "https://generativelanguage.googleapis.com"]);
  });
});

describe("export", () => {
  it("keeps phone numbers and blocks spreadsheet formulas", () => {
    expect(exportCell("+919876500001")).toBe("+919876500001");
    expect(exportCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(exportCell("@SUM(1)")).toBe("'@SUM(1)");
    expect(exportCell("-cmd")).toBe("'-cmd");
    expect(exportCell("a, b")).toBe('"a, b"');
    expect(exportCell(null)).toBe("");
  });
});
