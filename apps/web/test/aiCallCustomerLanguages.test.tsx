import { describe, expect, it } from "vitest";
import type { AiCallLanguageInfo } from "@dispatch/shared";
import { openLanguages } from "../src/lib/aiCallCustomers";

// Voicecall Contact → "Also add to these languages" / "Copy to other languages": which lists are offered.

const LANGS: AiCallLanguageInfo[] = [
  { code: "en", name: "English", configured: true, enabled: true },
  { code: "ta", name: "Tamil", configured: true, enabled: true },
  { code: "hi", name: "Hindi", configured: true, enabled: false }, // switched off in Settings
  { code: "kn", name: "Kannada", configured: false, enabled: true }, // its list exists before its backend
];

describe("language lists offered", () => {
  it("only languages switched on in Settings, this page's list first", () => {
    expect(openLanguages(LANGS, "ta")).toEqual(["ta", "en", "kn"]);
    expect(openLanguages(LANGS, "en")).toEqual(["en", "ta", "kn"]);
  });

  it("an older API without the language list offers only this page's list (no checkboxes)", () => {
    expect(openLanguages(undefined, "en")).toEqual(["en"]);
  });
});
