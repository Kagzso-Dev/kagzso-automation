import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readAiCallSheet } from "../src/domain/aiCallImport.js";
import { planAiCallRun } from "../src/domain/aiCalls.js";

// scripts/sample-ai-calls.xlsx is the file the README tells people to test with.
describe("scripts/sample-ai-calls.xlsx", () => {
  it("parses, auto-maps and plans all 5 rows", async () => {
    const buf = readFileSync(fileURLToPath(new URL("../../../scripts/sample-ai-calls.xlsx", import.meta.url)));
    const sheet = await readAiCallSheet(buf, "xlsx");
    expect(sheet.mapping).toEqual({
      customer_name: "customer_name",
      gender: "gender",
      follow_up_detail: "follow_up_detail",
      phone: "phone",
    });
    const rows = sheet.rows.map((r) => ({
      customerName: r.customer_name,
      gender: r.gender,
      followUpDetail: r.follow_up_detail,
      phone: r.phone,
    }));
    expect(rows).toHaveLength(5);
    const plan = planAiCallRun(
      { rows, mode: "all", randomCount: 1, selectedIndexes: [], maxCalls: 10 },
      { doNotCall: new Set(), hardCap: 10 },
    );
    expect(plan.targets.map((t) => t.phone)).toEqual([
      "+919000000001", "+919000000002", "+919000000003", "+919000000004", "+919000000005",
    ]);
    expect(plan.targets.map((t) => t.gender)).toEqual(["male", "female", "male", "female", "male"]); // no gender = Male
  });
});
