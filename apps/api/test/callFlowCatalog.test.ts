import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callFlowDefinition, type AiCallLanguage } from "@dispatch/shared";
import { withoutNullOptionalSettings } from "../src/http/routes/callFlows.js";
import { schemaIssues } from "../src/domain/callFlows.js";

// The built-in flows exactly as each language's voice backend serves them (GET /api/flows/builtin), written by the
// voice backend's tests/test_flow_catalog_contract.py. A voice backend sends unset optional settings as null
// (language_style, autonomous); Dispatch's schema treats them as absent - builtins() reads them without the nulls.

const LANGUAGES: AiCallLanguage[] = ["en", "ta", "hi", "kn"];
const BASES = ["executive", "nila", "followup"] as const;
const catalog = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../../kagzso-voice-backend-english/tests/fixtures/catalog/${lang}.json`, import.meta.url), "utf8")) as {
    language: string;
    flows: Record<string, Record<string, unknown>>;
  };

describe.each(LANGUAGES)("built-in flows served by the %s voice backend", (lang) => {
  const served = catalog(lang);

  it("are that language's, with every base", () => {
    expect(served.language).toBe(lang);
    expect(Object.keys(served.flows).sort()).toEqual([...BASES].sort());
  });

  it.each(BASES)("%s: valid for Dispatch once unset settings are left out (as served, null is refused)", (base) => {
    const flow = served.flows[base]!;
    const raw = callFlowDefinition.safeParse({ ...flow, language: lang });
    expect(raw.success).toBe(false); // what broke AI Agents Preview / Publish and "New flow"
    const fixed = callFlowDefinition.safeParse({ ...withoutNullOptionalSettings(flow), language: lang });
    expect(fixed.success, fixed.success ? "" : schemaIssues(fixed.error)).toBe(true);
    expect(fixed.data?.language).toBe(lang);
  });
});

describe("withoutNullOptionalSettings", () => {
  it("leaves out only unset optional settings and keeps every real value", () => {
    const identity = { question: "{{customer_name}}?", reask: null };
    const flow = { name: "x", voice_id: null, language_style: null, autonomous: null, pauses: null, recording_notice: null, identity: null, training: null };
    expect(withoutNullOptionalSettings(flow)).toEqual({ name: "x", voice_id: null });
    const set = { language_style: "pure", autonomous: { target_duration_sec: 60, dnc_enforce: true }, identity };
    expect(withoutNullOptionalSettings(set)).toEqual(set);
    expect(flow.language_style).toBeNull(); // the input is not changed
  });
});

describe("schemaIssues", () => {
  it("names the failing fields (at most three, then a count)", () => {
    const r = callFlowDefinition.safeParse({ ...catalog("ta").flows.executive, language: "ta" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(schemaIssues(r.error)).toBe(
      "language_style: Expected 'mixed' | 'pure', received null; autonomous: Expected object, received null",
    );
    const many = { issues: [1, 2, 3, 4, 5].map((n) => ({ path: [`f${n}`], message: "bad" })) };
    expect(schemaIssues(many)).toBe("f1: bad; f2: bad; f3: bad; and 2 more");
    expect(schemaIssues({ issues: [{ path: [], message: "bad" }] })).toBe("flow: bad");
  });
});
