import { describe, expect, it } from "vitest";
import { classifyButtonReply, normalizeReplyText } from "@dispatch/shared";

// Display-only Inbox badge for tapped quick-reply buttons (English and Tamil).

const tap = (text: string, buttonLabels?: string[]) => classifyButtonReply({ messageType: "button", text, payload: text, buttonLabels });

describe("button reply badge", () => {
  it.each([
    ["Yes, interested", "interested"],
    ["Interested", "interested"],
    ["Yes 👍", "interested"],
    ["Not now", "not_now"],
    ["Not Interested", "not_now"],
    ["No, thanks!", "not_now"],
  ])("English %s → %s", (text, intent) => {
    expect(tap(text)).toBe(intent);
  });

  it.each([
    ["ஆர்வம் உள்ளது", "interested"],
    ["ஆம்", "interested"],
    ["இப்போது வேண்டாம்", "not_now"],
    ["ஆர்வம் இல்லை", "not_now"],
  ])("Tamil %s → %s", (text, intent) => {
    expect(tap(text)).toBe(intent);
  });

  it("'not interested' is never read as interested", () => {
    expect(tap("not interested")).toBe("not_now");
    expect(tap("ஆர்வம் இல்லை")).toBe("not_now");
  });

  it("unknown wording: the button's position on the template decides (any language)", () => {
    const labels = ["சரி, சொல்லுங்கள்", "அப்புறம் பேசலாம்", "Call me"];
    expect(tap("சரி, சொல்லுங்கள்", labels)).toBe("interested");
    expect(tap("அப்புறம் பேசலாம்", labels)).toBe("not_now");
    expect(tap("Call me", labels)).toBeNull(); // third button: no badge
  });

  it("a known phrase wins over position (a template whose first button is Not now)", () => {
    expect(tap("Not now", ["Not now", "Interested"])).toBe("not_now");
  });

  it("no badge for typed text, unknown taps or empty replies", () => {
    expect(classifyButtonReply({ messageType: "text", text: "Interested" })).toBeNull();
    expect(tap("Call me tomorrow")).toBeNull();
    expect(tap("")).toBeNull();
    expect(classifyButtonReply({ messageType: "interactive", text: null, payload: "Yes, interested" })).toBe("interested");
  });

  it("normalising keeps Tamil vowel signs and drops punctuation / emoji", () => {
    expect(normalizeReplyText("  ஆர்வம் உள்ளது! 🙏 ")).toBe("ஆர்வம் உள்ளது");
    expect(normalizeReplyText("Yes,  INTERESTED.")).toBe("yes interested");
  });
});
