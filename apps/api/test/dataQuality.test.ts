import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aiPrompt,
  checkRows,
  detectDataQualityColumns,
  overallScore,
  parseAiAnswer,
  type DqLookups,
} from "../src/domain/dataQuality.js";
import { isLoopbackHost, readOllamaSettings } from "../src/config/dataQuality.js";
import { OLLAMA_PATHS, ollamaUrl } from "../src/services/ollama.js";
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

// Data Quality: the standard checks on the 20-row test file, the Ollama-only guard, the prompt
// (no phone / email), and the export. No DB, no network.

const lookups = (): DqLookups => ({
  doNotCall: new Set([DQ_DO_NOT_CALL]),
  notInterested: new Set([DQ_NOT_INTERESTED]),
  wrongPerson: new Set([DQ_WRONG_PERSON]),
  inVoicecall: new Set([DQ_IN_VOICECALL]),
  inWhatsapp: new Set([DQ_IN_WHATSAPP]),
  emailContacts: new Set(["mohan@example.com"]),
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

  it("a do-not-call number listed twice stays EXCLUDED both times (never a duplicate to approve)", () => {
    const twice = checkRows([{ Phone: "9876500009" }, { Phone: "9876500009" }], { name: null, phone: "Phone", business: null, email: null }, lookups());
    expect(twice.records.map((r) => r.status)).toEqual(["EXCLUDED", "EXCLUDED"]);
  });
});

describe("Ollama only", () => {
  const local = readOllamaSettings({ OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama3.2" });

  it("accepts only this machine", () => {
    expect(local).toMatchObject({ origin: "http://127.0.0.1:11434", model: "llama3.2", problem: null });
    expect(readOllamaSettings({ OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: "m" }).problem).toBeNull();
    for (const url of ["https://api.openai.com", "http://10.0.0.5:11434", "http://ollama.example.com:11434", "http://169.254.169.254"]) {
      expect(readOllamaSettings({ OLLAMA_BASE_URL: url, OLLAMA_MODEL: "m" })).toMatchObject({ origin: null, problem: expect.stringMatching(/this server/) });
    }
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
  });

  it("not configured = AI off, never a crash", () => {
    expect(readOllamaSettings({}).problem).toBe("OLLAMA_BASE_URL is not set");
    expect(readOllamaSettings({ OLLAMA_BASE_URL: "http://127.0.0.1:11434" }).problem).toBe("OLLAMA_MODEL is not set");
    expect(() => ollamaUrl("/api/tags", readOllamaSettings({}))).toThrow(/not set/);
  });

  it("builds URLs only for the configured origin and the two Ollama paths", () => {
    expect(OLLAMA_PATHS).toEqual(["/api/tags", "/api/generate"]);
    expect(ollamaUrl("/api/generate", local)).toBe("http://127.0.0.1:11434/api/generate");
    for (const path of ["/api/pull", "/api/chat", "//evil.com/api/generate", "https://evil.com/api/generate", "/api/generate?x=1"]) {
      expect(() => ollamaUrl(path, local)).toThrow();
    }
  });

  it("the prompt carries only the name and business name — never the phone or email", () => {
    const p = aiPrompt({ name: "Ravi Kumar", businessName: "Ravi Traders" });
    expect(p).toContain('"name":"Ravi Kumar"');
    expect(p).toContain('"business_name":"Ravi Traders"');
    expect(p).not.toMatch(/9876|@|phone|email/i);
  });

  it("reads the model's answer defensively", () => {
    expect(parseAiAnswer({ score: 87.6, issues: ["name ok", "  "] })).toEqual({ score: 88, notes: "name ok" });
    expect(parseAiAnswer({ score: "140" })).toEqual({ score: 100, notes: null });
    expect(() => parseAiAnswer({ issues: [] })).toThrow();
    expect(overallScore(80, null)).toBe(80);
    expect(overallScore(80, 61)).toBe(71);
    expect(overallScore(null, 90)).toBeNull();
  });

  it("source guard: only services/ollama.ts opens a network request, and no module reaches another service", () => {
    const files = ["config/dataQuality.ts", "services/ollama.ts", "domain/dataQuality.ts", "queue/dataQuality.ts", "http/routes/dataQuality.ts"];
    const forbidden = /voiceBackend|services\/whatsapp|provider\/|smtp|nodemailer|twilio|plivo|sarvam|openai|anthropic|gemini|googleapis|axios|node:https?['"]|undici/i;
    for (const f of files) {
      const src = readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect([f, imports.filter((i) => forbidden.test(i))]).toEqual([f, []]);
      expect([f, /\bfetch\(/.test(src)]).toEqual([f, f === "services/ollama.ts"]);
    }
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
