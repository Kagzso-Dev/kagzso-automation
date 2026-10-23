import { describe, expect, it } from "vitest";
import {
  checkAiCallCustomerRow,
  detectAiCallCustomerColumns,
  followupsForStage,
  formatPhoneDisplay,
  normalizePhoneE164,
  parseOptIn,
  stageForCallResult,
} from "@dispatch/shared";

// Pure rules behind AI Call Customers: +91 normalisation / display, row checks,
// column detection, outcome → stage and which follow-ups a stage creates.

describe("+91 phone normalisation (one shared normaliser)", () => {
  it.each([
    ["9876543210", "+919876543210"], // 10 digits → +91
    ["919876543210", "+919876543210"], // 91XXXXXXXXXX
    ["09876543210", "+919876543210"], // 0XXXXXXXXXX
    ["+91 98765 43210", "+919876543210"], // +91 XXXXX XXXXX
    ["98765-43210", "+919876543210"],
    ["(+91) 98765 43210", "+919876543210"],
  ])("%s → %s", (raw, want) => {
    expect(normalizePhoneE164(raw)).toBe(want);
  });

  it("keeps a number with another explicit country code", () => {
    expect(normalizePhoneE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhoneE164("+1 (415) 555-0100")).toBe("+14155550100");
    expect(normalizePhoneE164("0044 20 7946 0958")).toBe("+442079460958");
  });

  it("rejects numbers that aren't dialable", () => {
    for (const bad of ["12345", "98765432", "+91 12345", "0000000000", "", "abc"]) {
      expect(normalizePhoneE164(bad)).toBeNull();
    }
  });

  it("displays Indian numbers as +91 XXXXX XXXXX", () => {
    expect(formatPhoneDisplay("+919876543210")).toBe("+91 98765 43210");
    expect(formatPhoneDisplay("9876543210")).toBe("+91 98765 43210");
    expect(formatPhoneDisplay("+442079460958")).toBe("+442079460958");
    expect(formatPhoneDisplay("not a phone")).toBe("not a phone");
    expect(formatPhoneDisplay(null)).toBe("");
  });

  it("dedupes on the normalised number", () => {
    const set = new Set(["9876543210", "+91 98765 43210", "09876543210", "919876543210"].map((p) => normalizePhoneE164(p)));
    expect(set.size).toBe(1);
  });
});

describe("checkAiCallCustomerRow", () => {
  it("accepts a full row", () => {
    const c = checkAiCallCustomerRow({ customerName: "Asha", gender: "F", phone: "98765 43210", email: "Asha@Example.com" });
    expect(c).toMatchObject({ phone: "+919876543210", gender: "female", email: "asha@example.com", errors: [] });
  });

  it("flags missing / invalid phone, unknown gender and invalid email", () => {
    expect(checkAiCallCustomerRow({ phone: "" }).errors).toContain("Missing phone");
    expect(checkAiCallCustomerRow({ phone: "123" }).errors).toContain("Invalid phone");
    expect(checkAiCallCustomerRow({ phone: "9876543210", gender: "xyz" }).errors[0]).toMatch(/Unknown gender/);
    expect(checkAiCallCustomerRow({ phone: "9876543210", email: "nope" }).errors).toContain("Invalid email");
  });

  it("blank gender is allowed (neutral greeting)", () => {
    const c = checkAiCallCustomerRow({ phone: "9876543210", gender: "" });
    expect(c.errors).toEqual([]);
    expect(c.gender).toBe("unknown");
    expect(c.warnings.join()).toMatch(/neutral greeting/);
  });
});

describe("detectAiCallCustomerColumns", () => {
  it("maps common header spellings", () => {
    const m = detectAiCallCustomerColumns(["Name", "Sex", "Mobile No", "Company", "Notes", "E-mail", "WhatsApp opt-in"]);
    expect(m).toEqual({
      customer_name: "Name",
      gender: "Sex",
      phone: "Mobile No",
      business_name: "Company",
      follow_up_detail: "Notes",
      email: "E-mail",
      whatsapp_opt_in: "WhatsApp opt-in",
    });
  });

  it("parses opt-in values", () => {
    expect(["yes", "Y", "true", "1", "opted in"].every(parseOptIn)).toBe(true);
    expect(["no", "", "0", "maybe"].some(parseOptIn)).toBe(false);
  });
});

describe("stageForCallResult", () => {
  it.each([
    ["COMPLETED", "interested", "INTERESTED"],
    ["COMPLETED", "not_interested", "NOT_INTERESTED"],
    ["COMPLETED", "wrong_person", "FOLLOW_UP_NEEDED"], // someone else answered: not a "no"
    ["COMPLETED", "callback_requested", "CALLBACK_REQUESTED"],
    ["COMPLETED", "do_not_call", "DO_NOT_CALL"],
    ["COMPLETED", "voicemail", "NO_ANSWER"],
    ["COMPLETED", "completed", "FOLLOW_UP_NEEDED"],
    ["COMPLETED", null, "FOLLOW_UP_NEEDED"],
    ["NO_ANSWER", "no_answer", "NO_ANSWER"],
    ["BUSY", null, "NO_ANSWER"],
    ["FAILED", "call_failed", "FAILED"],
    ["FAILED", "do_not_call", "DO_NOT_CALL"],
  ])("%s / %s → %s", (status, outcome, stage) => {
    expect(stageForCallResult(status, outcome)).toBe(stage);
  });
});

describe("followupsForStage", () => {
  const base = { whatsappOptIn: false, doNotCall: false, noAnswerRetries: 0, maxRetries: 2 };

  it("Interested / Follow-up needed / Approved: WhatsApp when opted in, else a call-again", () => {
    for (const s of ["INTERESTED", "FOLLOW_UP_NEEDED", "APPROVED"] as const) {
      expect(followupsForStage(s, { ...base, whatsappOptIn: true })).toEqual([{ channel: "WHATSAPP" }]);
      expect(followupsForStage(s, base)).toEqual([{ channel: "CALL", callInHours: 24 }]);
    }
  });

  it("skips Not interested, Do not call, Failed", () => {
    for (const s of ["NOT_INTERESTED", "DO_NOT_CALL", "FAILED", "REJECTED", "NOT_CALLED"] as const) {
      expect(followupsForStage(s, { ...base, whatsappOptIn: true })).toEqual([]);
    }
    expect(followupsForStage("INTERESTED", { ...base, doNotCall: true })).toEqual([]);
  });

  it("No answer: a limited number of call-again retries", () => {
    expect(followupsForStage("NO_ANSWER", base)).toEqual([{ channel: "CALL", callInHours: 4 }]);
    expect(followupsForStage("NO_ANSWER", { ...base, noAnswerRetries: 1 })).toHaveLength(1);
    expect(followupsForStage("NO_ANSWER", { ...base, noAnswerRetries: 2 })).toEqual([]);
    expect(followupsForStage("NO_ANSWER", { ...base, maxRetries: 0 })).toEqual([]);
  });
});

describe("a missing customer name never blocks a call", () => {
  it("add / edit, import and Start AI Calls all accept a customer without a name (phone stays required)", async () => {
    const { aiCallCustomerInput, importAiCallCustomersInput, checkAiCallCustomerRow, checkAiCallRow, startAiCallsInput } =
      await import("@dispatch/shared");
    expect(aiCallCustomerInput.parse({ phone: "+919876543210" }).customerName).toBeNull();
    expect(aiCallCustomerInput.parse({ phone: "+919876543210", customerName: "  " }).customerName).toBeNull();
    expect(aiCallCustomerInput.safeParse({ customerName: "Ragul" }).success).toBe(false); // phone is required
    expect(importAiCallCustomersInput.safeParse({ rows: [{ phone: "9876543210" }] }).success).toBe(true);
    const row = checkAiCallCustomerRow({ phone: "9876543210", customerName: "" });
    expect(row.errors).toEqual([]); // a warning only, never a reason to skip the row
    expect(checkAiCallRow({ phone: "9876543210" }).errors).toEqual([]);
    expect(startAiCallsInput.safeParse({ rows: [{ phone: "+919876543210" }], mode: "all" }).success).toBe(true);
  });
});
