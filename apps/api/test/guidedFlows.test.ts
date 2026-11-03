import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUIDED_ISSUE_CODES, callFlowDefinition, guidedFlowDefinition, guidedFlowIssues } from "@dispatch/shared";

// Guided flows (schema_version 2): the SAME cases as the voice backend's validator
// (kagzso-voice-backend-english/tests/test_guided_flow_schema.py), so both sides give the same verdict.
const backend = (path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../kagzso-voice-backend-english/${path}`, import.meta.url)), "utf8"));
const EXAMPLE = backend("app/flows/guided_examples/business_executive.en.json");
const CASES: { name: string; ops: Op[]; codes: string[] }[] = backend("tests/fixtures/guided/validation_cases.json").cases;
type Op = { op: "set" | "delete" | "append" | "insert"; path: string; value?: unknown; index?: number };

/** The fixture's edit operations (the Python test has the same few lines). */
function applyOps(definition: unknown, ops: Op[]): unknown {
  const out = structuredClone(definition) as Record<string, unknown>;
  for (const op of ops) {
    const parts = op.path.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    const last = parts.pop()!;
    let target: any = out;
    for (const p of parts) target = target[p];
    if (op.op === "set") target[last] = structuredClone(op.value);
    else if (op.op === "delete") Array.isArray(target) ? target.splice(Number(last), 1) : delete target[last];
    else if (op.op === "append") target[last].push(structuredClone(op.value));
    else target[last].splice(op.index!, 0, structuredClone(op.value));
  }
  return out;
}

describe("guided flow validation (same cases as the voice backend)", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const issues = guidedFlowIssues(applyOps(EXAMPLE, c.ops));
    expect([...new Set(issues.map((i) => i.code))].sort(), JSON.stringify(issues)).toEqual([...c.codes].sort());
  });

  it("the cases cover every issue code", () => {
    expect(new Set(CASES.flatMap((c) => c.codes))).toEqual(new Set(GUIDED_ISSUE_CODES));
  });

  it("a guided flow is not a version-1 flow, and the other way round", () => {
    expect(guidedFlowDefinition.safeParse(EXAMPLE).success).toBe(true);
    expect(callFlowDefinition.safeParse(EXAMPLE).success).toBe(false); // Dispatch still saves version 1 only
    expect(guidedFlowIssues({ ...EXAMPLE, schema_version: 1 }).map((i) => i.code)).toEqual(["schema"]);
  });
});
