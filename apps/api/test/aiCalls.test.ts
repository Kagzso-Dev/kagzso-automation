import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  checkAiCallRow,
  detectAiCallColumns,
  maskPhone,
  normalizeAiCallGender,
  normalizePhoneE164,
  startAiCallsInput,
} from "@dispatch/shared";
import { readAiCallSheet } from "../src/domain/aiCallImport.js";
import {
  fisherYatesShuffle,
  isValidAiCallSignature,
  mapVoiceStatus,
  nextAiCallStatus,
  parseUtc,
  pickRandom,
  planAiCallRun,
  signAiCallWebhook,
} from "../src/domain/aiCalls.js";

/* ------------------------------------------------------------------ E.164 */

describe("normalizePhoneE164 (default India)", () => {
  it("adds +91 to a bare 10-digit number", () => {
    expect(normalizePhoneE164("9876543210")).toBe("+919876543210");
    expect(normalizePhoneE164("98765 43210")).toBe("+919876543210");
    expect(normalizePhoneE164("(987) 654-3210")).toBe("+919876543210");
  });

  it("handles a trunk 0, a 91 prefix, +91 and 0091", () => {
    expect(normalizePhoneE164("09876543210")).toBe("+919876543210");
    expect(normalizePhoneE164("919876543210")).toBe("+919876543210");
    expect(normalizePhoneE164("+91 98765-43210")).toBe("+919876543210");
    expect(normalizePhoneE164("0091 9876543210")).toBe("+919876543210");
  });

  it("keeps a 10-digit mobile that itself starts with 91", () => {
    expect(normalizePhoneE164("9123456789")).toBe("+919123456789");
  });

  it("accepts spreadsheet numbers in scientific notation", () => {
    expect(normalizePhoneE164("9.87654321E9")).toBe("+919876543210");
    expect(normalizePhoneE164(9876543210)).toBe("+919876543210");
  });

  it("keeps other countries when written internationally", () => {
    expect(normalizePhoneE164("+1 (415) 555-2671")).toBe("+14155552671");
    expect(normalizePhoneE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("uses another default country code when configured", () => {
    expect(normalizePhoneE164("(415) 555-2671", "1")).toBe("+14155552671");
  });

  it("rejects malformed numbers", () => {
    expect(normalizePhoneE164("")).toBe(null);
    expect(normalizePhoneE164(null)).toBe(null);
    expect(normalizePhoneE164("abc")).toBe(null);
    expect(normalizePhoneE164("98765")).toBe(null); // too short
    expect(normalizePhoneE164("98765432101234")).toBe(null); // bare, too long
    expect(normalizePhoneE164("+91 98765")).toBe(null); // +91 needs 10 digits
    expect(normalizePhoneE164("+91 0876543210")).toBe(null); // national part can't start with 0
  });
});

describe("gender / masking / row checks", () => {
  it("accepts m / male and f / female in any case; anything else is Male", () => {
    expect(normalizeAiCallGender("M")).toBe("male");
    expect(normalizeAiCallGender("MALE")).toBe("male");
    expect(normalizeAiCallGender(" Female ")).toBe("female");
    expect(normalizeAiCallGender("f")).toBe("female");
    for (const other of ["", null, undefined, "unknown", "other", "Mrs.", "x"]) expect(normalizeAiCallGender(other)).toBe("male");
  });

  it("masks all but the country code and last 4 digits", () => {
    expect(maskPhone("+919876543210")).toBe("+91******3210");
    expect(maskPhone("9876543210")).toBe("98****3210");
    expect(maskPhone(null)).toBe("");
  });

  it("flags missing / invalid phone as errors; a missing gender only defaults to Male", () => {
    expect(checkAiCallRow({ phone: "" }).errors).toEqual(["Missing phone"]);
    expect(checkAiCallRow({ phone: "12345" }).errors).toEqual(["Invalid phone"]);
    const ok = checkAiCallRow({ customerName: "Ragul", gender: "x", phone: "9876543210" });
    expect(ok.errors).toEqual([]);
    expect(ok.phone).toBe("+919876543210");
    expect(ok.gender).toBe("male");
    expect(ok.genderDefaulted).toBe(true);
    expect(ok.warnings[0]).toMatch(/No gender — Male/);
    expect(checkAiCallRow({ gender: "F", phone: "9876543210" })).toMatchObject({ gender: "female", genderDefaulted: false });
  });
});

/* ------------------------------------------------------------------ parsing */

describe("detectAiCallColumns", () => {
  it("maps the canonical headers", () => {
    expect(detectAiCallColumns(["customer_name", "gender", "follow_up_detail", "phone"])).toEqual({
      customer_name: "customer_name",
      gender: "gender",
      follow_up_detail: "follow_up_detail",
      phone: "phone",
    });
  });

  it("accepts the common variants, case-insensitively", () => {
    expect(detectAiCallColumns(["Full Name", "Sex", "Notes", "Mobile"])).toEqual({
      customer_name: "Full Name",
      gender: "Sex",
      follow_up_detail: "Notes",
      phone: "Mobile",
    });
    expect(detectAiCallColumns(["Name", "Follow Up", "Phone Number"])).toMatchObject({
      customer_name: "Name",
      follow_up_detail: "Follow Up",
      phone: "Phone Number",
      gender: null,
    });
  });
});

describe("readAiCallSheet", () => {
  it("reads a csv with a BOM and detects columns", async () => {
    const csv = "﻿name,sex,notes,mobile\nRagul,M,Invoice follow-up,98765 43210\n,,,\nPriya,F,Demo,+919812345678\n";
    const sheet = await readAiCallSheet(Buffer.from(csv), "csv");
    expect(sheet.headers).toEqual(["name", "sex", "notes", "mobile"]);
    expect(sheet.rows).toHaveLength(2); // blank row dropped
    expect(sheet.rows[0]).toEqual({ name: "Ragul", sex: "M", notes: "Invoice follow-up", mobile: "98765 43210" });
    expect(sheet.mapping).toEqual({ customer_name: "name", gender: "sex", follow_up_detail: "notes", phone: "mobile" });
    expect(sheet.truncated).toBe(false);
  });

  it("reads an xlsx and keeps numeric phones as plain digits", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["customer_name", "gender", "follow_up_detail", "phone"]);
    ws.addRow(["Ragul", "male", "Pending quotation", 9876543210]);
    ws.addRow(["Anita", "", "", "+91 98123 45678"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheet = await readAiCallSheet(buf, "xlsx");
    expect(sheet.rows).toEqual([
      { customer_name: "Ragul", gender: "male", follow_up_detail: "Pending quotation", phone: "9876543210" },
      { customer_name: "Anita", gender: "", follow_up_detail: "", phone: "+91 98123 45678" },
    ]);
    expect(sheet.mapping.phone).toBe("phone");
  });
});

/* ------------------------------------------------------------------ random selection */

describe("fisherYatesShuffle / pickRandom", () => {
  it("is a permutation and does not modify the input of pickRandom", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const picked = pickRandom(input, 8);
    expect([...picked].sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("follows the Fisher–Yates swap sequence for a given RNG", () => {
    // rand always returns 0: i=3 swaps with 0, i=2 with 0, i=1 with 0.
    expect(fisherYatesShuffle(["a", "b", "c", "d"], () => 0)).toEqual(["b", "c", "d", "a"]);
  });

  it("is roughly uniform", () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 8000; i++) counts[pickRandom([0, 1, 2, 3], 1)[0]!]++;
    for (const c of counts) expect(c).toBeGreaterThan(1700); // expected 2000 each
  });
});

/* ------------------------------------------------------------------ planning */

const rows = [
  { customerName: "A", gender: "m", followUpDetail: "x", phone: "9876543210" },
  { customerName: "B", gender: "f", followUpDetail: "y", phone: "+91 98765 43210" }, // dup of A
  { customerName: "C", gender: "", followUpDetail: "", phone: "12" }, // invalid
  { customerName: "D", gender: "f", followUpDetail: "", phone: "9812345678" },
  { customerName: "E", gender: "m", followUpDetail: "", phone: "9822222222" }, // do-not-call
  { customerName: "F", gender: "m", followUpDetail: "", phone: "9833333333" },
  { customerName: "G", gender: "", followUpDetail: "", phone: "" }, // missing
];
const base = { rows, randomCount: 1, selectedIndexes: [] as number[], maxCalls: 10 };
const opts = { doNotCall: new Set(["+919822222222"]), hardCap: 10 };

describe("planAiCallRun", () => {
  it("all: drops invalid, duplicate and do-not-call rows, keeps file order", () => {
    const plan = planAiCallRun({ ...base, mode: "all" }, opts);
    expect(plan.targets.map((t) => t.customerName)).toEqual(["A", "D", "F"]);
    expect(plan.targets[0]).toMatchObject({ phone: "+919876543210", gender: "male", rowIndex: 0 });
    expect(plan.skipped).toEqual({ invalid: 2, duplicates: 1, doNotCall: 1, capped: 0 });
    expect(plan.invalidRows.map((r) => r.rowIndex)).toEqual([2, 6]);
  });

  it("selected: only the checked rows", () => {
    const plan = planAiCallRun({ ...base, mode: "selected", selectedIndexes: [1, 4, 5] }, opts);
    // B is only a duplicate of A when A is in the run — here it isn't.
    expect(plan.targets.map((t) => t.customerName)).toEqual(["B", "F"]);
    expect(plan.skipped.doNotCall).toBe(1);
  });

  it("random: picks N distinct numbers and never the same number twice", () => {
    for (let i = 0; i < 200; i++) {
      const plan = planAiCallRun({ ...base, mode: "random", randomCount: 3 }, opts);
      const phones = plan.targets.map((t) => t.phone);
      expect(phones).toHaveLength(3);
      expect(new Set(phones).size).toBe(3);
      expect(phones).not.toContain("+919822222222");
    }
  });

  it("random: asking for more than exist returns every eligible row once", () => {
    const plan = planAiCallRun({ ...base, mode: "random", randomCount: 50 }, opts);
    expect(plan.targets).toHaveLength(3);
    expect(plan.skipped.capped).toBe(0);
  });

  it("applies the per-run cap and the hard cap", () => {
    expect(planAiCallRun({ ...base, mode: "all", maxCalls: 2 }, opts).targets).toHaveLength(2);
    const hard = planAiCallRun({ ...base, mode: "all", maxCalls: 10 }, { ...opts, hardCap: 1 });
    expect(hard.targets).toHaveLength(1);
    expect(hard.skipped.capped).toBe(2);
    const rnd = planAiCallRun({ ...base, mode: "random", randomCount: 3 }, { ...opts, hardCap: 2 });
    expect(rnd.targets).toHaveLength(2);
    expect(rnd.skipped.capped).toBe(1);
  });
});

describe("startAiCallsInput", () => {
  it("applies defaults", () => {
    const v = startAiCallsInput.parse({ rows: [{ phone: "9876543210" }], mode: "random" });
    expect(v).toMatchObject({ randomCount: 1, gapSeconds: 30, maxCalls: 10, dryRun: false });
  });

  it("requires a selection in selected mode and at least one row", () => {
    expect(startAiCallsInput.safeParse({ rows: [{ phone: "1" }], mode: "selected" }).success).toBe(false);
    expect(startAiCallsInput.safeParse({ rows: [], mode: "all" }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ status + callbacks */

describe("voice status mapping", () => {
  it("maps voice-backend statuses", () => {
    expect(mapVoiceStatus("initiating")).toBe("DIALING");
    expect(mapVoiceStatus("ringing")).toBe("RINGING");
    expect(mapVoiceStatus("speaking")).toBe("IN_PROGRESS");
    expect(mapVoiceStatus("no_answer")).toBe("NO_ANSWER");
    expect(mapVoiceStatus("no-answer")).toBe("NO_ANSWER");
    expect(mapVoiceStatus("cancelled")).toBe("FAILED");
    expect(mapVoiceStatus("weird")).toBe(null);
  });

  it("never regresses and never leaves a final state", () => {
    expect(nextAiCallStatus("IN_PROGRESS", "RINGING")).toBe("IN_PROGRESS");
    expect(nextAiCallStatus("RINGING", "IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(nextAiCallStatus("DIALING", "NO_ANSWER")).toBe("NO_ANSWER");
    expect(nextAiCallStatus("COMPLETED", "FAILED")).toBe("COMPLETED");
    expect(nextAiCallStatus("RINGING", null)).toBe("RINGING");
  });

  it("parses naive UTC timestamps from the voice backend", () => {
    expect(parseUtc("2026-10-10T09:15:00")?.toISOString()).toBe("2026-10-10T09:15:00.000Z");
    expect(parseUtc("2026-10-10T09:15:00+05:30")?.toISOString()).toBe("2026-10-10T03:45:00.000Z");
    expect(parseUtc("nope")).toBe(null);
  });
});

describe("callback signature", () => {
  const secret = "test-webhook-secret";
  const raw = Buffer.from('{"log_id":"abc","status":"ringing"}');
  const now = 1_790_000_000;
  const ts = String(now);
  const sig = `sha256=${signAiCallWebhook(secret, ts, raw)}`;

  it("accepts a fresh, correctly signed body", () => {
    expect(isValidAiCallSignature(raw, ts, sig, secret, now)).toBe(true);
  });

  it("rejects tampering, a wrong secret, missing headers and stale timestamps", () => {
    expect(isValidAiCallSignature(Buffer.from('{"log_id":"abc","status":"completed"}'), ts, sig, secret, now)).toBe(false);
    expect(isValidAiCallSignature(raw, ts, sig, "other-secret", now)).toBe(false);
    expect(isValidAiCallSignature(raw, undefined, sig, secret, now)).toBe(false);
    expect(isValidAiCallSignature(raw, ts, undefined, secret, now)).toBe(false);
    expect(isValidAiCallSignature(raw, ts, sig, secret, now + 301)).toBe(false);
  });
});

describe("AI greeting delay (Start AI Calls)", () => {
  it("defaults to 2 seconds and allows 0 to 10 in whole or half seconds", async () => {
    const { startAiCallsInput, callAiCallCustomersInput } = await import("@dispatch/shared");
    const base = { rows: [{ phone: "+919876543210" }], mode: "all" };
    expect(startAiCallsInput.parse(base).greetingDelaySec).toBe(2);
    for (const ok of [0, 0.5, 2, 10]) expect(startAiCallsInput.parse({ ...base, greetingDelaySec: ok }).greetingDelaySec).toBe(ok);
    for (const bad of [-1, 10.5, 1.25, "x"]) expect(startAiCallsInput.safeParse({ ...base, greetingDelaySec: bad }).success).toBe(false);
    const saved = { customerIds: ["c1"], mode: "all" };
    expect(callAiCallCustomersInput.parse(saved).greetingDelaySec).toBe(2);
    expect(callAiCallCustomersInput.safeParse({ ...saved, greetingDelaySec: 11 }).success).toBe(false);
    expect(startAiCallsInput.parse({ ...base, gapSeconds: 45, greetingDelaySec: 3 })).toMatchObject({ gapSeconds: 45, greetingDelaySec: 3 });
  });
});
