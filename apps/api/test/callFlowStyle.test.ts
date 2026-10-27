import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CALL_FLOW_MIXED_STARTERS,
  callFlowDefinition,
  languageStyleLabel,
  languageStyleOf,
  type CallFlowDefinition,
} from "@dispatch/shared";

// Call Flows "Language style" in the shared flow schema: absent = mixed (every flow saved before the
// setting), "pure" is accepted for another language, English has no style, and the mixed starter lines
// are valid flow text (variables allowed, identity lines name the customer).

const BUILTIN = new URL("../../../kagzso-voice-backend-english/app/flows/builtin/", import.meta.url);
const nila = JSON.parse(readFileSync(fileURLToPath(new URL("nila.json", BUILTIN)), "utf8")) as CallFlowDefinition;
const tamil = (extra: Record<string, unknown> = {}) => ({ ...nila, language: "ta", ...extra });

describe("language style", () => {
  it("a flow saved before the setting is mixed; pure and mixed are accepted for Tamil", () => {
    const old = callFlowDefinition.parse(tamil());
    expect(old.language_style).toBeUndefined();
    expect(languageStyleOf(old)).toBe("mixed");
    expect(callFlowDefinition.parse(tamil({ language_style: "pure" })).language_style).toBe("pure");
    expect(callFlowDefinition.safeParse(tamil({ language_style: "loud" })).success).toBe(false);
  });

  it("an English flow has no language style (English stays as it is)", () => {
    expect(callFlowDefinition.safeParse({ ...nila, language: "en" }).success).toBe(true);
    const styled = callFlowDefinition.safeParse({ ...nila, language: "en", language_style: "mixed" });
    expect(styled.success).toBe(false);
    expect(JSON.stringify(styled.error?.issues)).toContain("An English flow has no language style");
  });

  it("names per language", () => {
    expect(languageStyleLabel("ta", "mixed")).toBe("Tanglish (Tamil + everyday English)");
    expect(languageStyleLabel("hi", "mixed")).toBe("Hinglish (Hindi + everyday English)");
    expect(languageStyleLabel("kn", "mixed")).toBe("Kanglish (Kannada + everyday English)");
    expect(languageStyleLabel("kn", "pure")).toBe("Pure Kannada");
  });

  it.each(["ta", "hi", "kn"])("the %s mixed starter lines are valid flow text", (language) => {
    const s = CALL_FLOW_MIXED_STARTERS[language]!;
    const flow = callFlowDefinition.safeParse({ ...nila, language, language_style: "mixed", identity: s.identity, silence: s.silence });
    expect(flow.success, JSON.stringify(flow.error?.issues)).toBe(true);
  });
});
