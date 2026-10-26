import { describe, expect, it } from "vitest";
import {
  detectExtraColumns,
  exportFileName,
  exportHeaders,
  filtersForLog,
  phoneExtension,
  phoneType,
  rowMatches,
  safeText,
  scoreBreakdown,
  tierFor,
  type DqRow,
} from "../src/domain/dataQualityExport.js";

// Data Quality filtered export: the pure parts (no DB). The HTTP flow is in dataQualityHttp.test.ts.

const row = (over: Partial<DqRow> = {}): DqRow => ({
  id: "r1",
  rowIndex: 0,
  name: "Ravi Kumar",
  phoneRaw: "9876500101",
  phone: "+919876500101",
  businessName: "Sri Murugan Bakery",
  email: null,
  status: "VALID",
  excludedReason: null,
  issues: [],
  flags: [],
  ruleScore: 100,
  aiState: "NONE",
  aiScore: null,
  aiNotes: null,
  review: "PENDING",
  raw: { city: "Chennai", industry: "Restaurants & Food Service" },
  ...over,
});
const cols = detectExtraColumns(["client_id", "business_name", "city", "industry", "source", "first_seen"]);

describe("derived values", () => {
  it("phone type comes from the stored numbers", () => {
    expect(phoneType("+919876500101", "98765 00101")).toBe("mobile");
    expect(phoneType("+914423456789", "044 2345 6789")).toBe("landline");
    expect(phoneType("+911800123456", "1800 123 456")).toBe("tollfree");
    expect(phoneType(null, "1800 123 4567")).toBe("tollfree"); // 11 digits: not dialable here, still toll-free
    expect(phoneType("+447700900123", "+44 7700 900123")).toBe("international");
    expect(phoneType(null, "12345")).toBe("unusable");
    expect(phoneType(null, null)).toBe("none");
    expect(phoneType(null, "")).toBe("none");
  });

  it("extension only when the number has one", () => {
    expect(phoneExtension("+91 44 2345 6789 ext 12")).toBe("12");
    expect(phoneExtension("044-23456789 x204")).toBe("204");
    expect(phoneExtension("9876500101")).toBeNull();
  });

  it("tiers: 85+ high priority, 70-84 good, 50-69 review, below 50 reject, none without a score", () => {
    expect([100, 85, 84, 70, 69, 50, 49, 0].map(tierFor)).toEqual(["HIGH_PRIORITY", "HIGH_PRIORITY", "GOOD", "GOOD", "REVIEW", "REVIEW", "REJECT", "REJECT"]);
    expect(tierFor(null)).toBeNull();
  });

  it("score breakdown lists what cost points", () => {
    expect(scoreBreakdown({ ruleScore: 55, aiScore: 80, issues: ["missing_name", "missing_business"] })).toBe(
      "rules 55 (No name -30, No business name -15) · AI 80 → 68",
    );
    expect(scoreBreakdown({ ruleScore: 100, aiScore: null, issues: [] })).toBe("rules 100");
    expect(scoreBreakdown({ ruleScore: null, aiScore: null, issues: ["bad_phone"] })).toBe("");
  });
});

describe("columns of the file", () => {
  it("finds city, category, source and date added by header; leaves missing ones null", () => {
    expect(cols).toEqual({ city: "city", state: null, district: null, pincode: null, category: "industry", source: "source", dateAdded: "first_seen" });
    expect(detectExtraColumns(["Pin Code", "District", "State"])).toMatchObject({ pincode: "Pin Code", district: "District", state: "State" });
    expect(detectExtraColumns(null)).toEqual({ city: null, state: null, district: null, pincode: null, category: null, source: null, dateAdded: null });
  });

  it("a Data Quality column that clashes with a file column gets dq_", () => {
    expect(exportHeaders(["col:email", "dq:email", "dq:phone", "col:phone"])).toEqual(["email", "dq_email", "phone_normalised", "phone"]);
  });
});

describe("filters", () => {
  it("all filters must match; inside a group any one will do", () => {
    const r = row();
    expect(rowMatches(r, { business: "  BAKERY " }, {}, cols)).toBe(true);
    expect(rowMatches(r, { business: "bakery", city: "Chennai", category: "Restaurants & Food Service", scoreMin: 70 }, {}, cols)).toBe(true);
    expect(rowMatches(r, { business: "bakery", city: "Madurai" }, {}, cols)).toBe(false);
    expect(rowMatches(r, { status: ["INVALID", "VALID"] }, {}, cols)).toBe(true);
    expect(rowMatches(r, { status: ["LANDLINE"] }, {}, cols)).toBe(false);
    expect(rowMatches(row({ phone: "+914423456789" }), { status: ["LANDLINE"] }, {}, cols)).toBe(true);
    expect(rowMatches(r, { phone: "98765 001" }, {}, cols)).toBe(true);
    expect(rowMatches(r, { phone: "abc" }, {}, cols)).toBe(false); // no digits: matches nothing
    expect(rowMatches(r, { hasEmail: false, hasPhone: true }, {}, cols)).toBe(true);
    expect(rowMatches(r, { scoreMax: 90 }, {}, cols)).toBe(false);
    expect(rowMatches(row({ ruleScore: null, status: "INVALID" }), { scoreMin: 0 }, {}, cols)).toBe(false); // no score: no match
    expect(rowMatches(r, { tier: ["GOOD"] }, {}, cols)).toBe(false);
    expect(rowMatches(r, { review: ["APPROVED", "PENDING"] }, {}, cols)).toBe(true);
  });

  it("the table's tab and 'score N+' apply too", () => {
    expect(rowMatches(row(), {}, { status: "VALID", minScore: 100 }, cols)).toBe(true);
    expect(rowMatches(row(), {}, { status: "INVALID" }, cols)).toBe(false);
    expect(rowMatches(row({ ruleScore: 70 }), {}, { minScore: 80 }, cols)).toBe(false);
  });

  it("a file without its original columns never matches a city / category filter (nothing is guessed)", () => {
    expect(rowMatches(row({ raw: null }), { city: "Chennai" }, {}, detectExtraColumns(null))).toBe(false);
  });

  it("the audit log never holds search text", () => {
    expect(filtersForLog({ business: "bakery", phone: "98765", email: "ravi@", name: "Ravi", city: "Chennai", scoreMin: 70 }, { status: "VALID" })).toEqual({
      business: "[search]",
      phone: "[search]",
      email: "[search]",
      name: "[search]",
      city: "Chennai",
      scoreMin: 70,
      view: { status: "VALID" },
    });
  });
});

describe("export cells and file name", () => {
  it("anything a spreadsheet would run gets a leading '; phone numbers and plain numbers stay", () => {
    expect(safeText("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(safeText("@cmd")).toBe("'@cmd");
    expect(safeText("+1+cmd|' /C calc'!A0")).toBe("'+1+cmd|' /C calc'!A0");
    expect(safeText("-2+3")).toBe("'-2+3");
    expect(safeText("\tx")).toBe("'\tx");
    expect(safeText("+919876543210")).toBe("+919876543210");
    expect(safeText("+91 (44) 2345-6789")).toBe("+91 (44) 2345-6789");
    expect(safeText("-12.5")).toBe("-12.5");
    expect(safeText("முருகன் ஸ்டோர்ஸ்")).toBe("முருகன் ஸ்டோர்ஸ்");
    expect(safeText("000123")).toBe("000123");
  });

  it("dataquality_<file>_<filters>_<YYYYMMDD-HHMM>, in the server's time zone, no search text", () => {
    const at = new Date("2026-10-26T13:00:00Z");
    expect(exportFileName("client-research (1).xlsx", { city: "Chennai", business: "bakery", scoreMin: 70 }, { status: "VALID" }, "csv", at, "Asia/Kolkata")).toBe(
      "dataquality_client-research-1_city-chennai_search_valid_score70-100_20261026-1830.csv",
    );
    expect(exportFileName("leads.csv", {}, {}, "xlsx", at, "UTC")).toBe("dataquality_leads_all_20261026-1300.xlsx");
    expect(exportFileName("முருகன்.xlsx", { tier: ["HIGH_PRIORITY"], hasEmail: true, hasPhone: false }, {}, "xlsx", at, "UTC")).toBe(
      "dataquality_file_email-yes_phone-no_tier-high-priority_20261026-1300.xlsx",
    );
  });
});
