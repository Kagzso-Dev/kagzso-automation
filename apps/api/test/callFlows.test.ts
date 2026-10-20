import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CALL_FLOW_LOCKED_KEYS,
  CALL_FLOW_UNLOCKED_KEYS,
  callFlowDefinition,
  isLockedBlock,
  saveCallFlowDraftInput,
  startAiCallsInput,
  unknownCallFlowVariables,
  type CallFlowDefinition,
} from "@dispatch/shared";

// The shared zod mirror must accept exactly what the voice backend ships, so the
// built-in flows are read straight from kagzso-voice-backend-english.
const BUILTIN = new URL("../../../kagzso-voice-backend-english/app/flows/builtin/", import.meta.url);
const readJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, BUILTIN)), "utf8"));
const nila = (): CallFlowDefinition => readJson("nila.json");

const issues = (v: unknown) => {
  const r = callFlowDefinition.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("callFlowDefinition mirrors the voice backend", () => {
  it("accepts both built-in flows unchanged", () => {
    for (const name of ["nila.json", "followup.json"]) expect(issues(readJson(name))).toEqual([]);
  });

  it("knows exactly the voice backend's locked safety blocks", () => {
    const locked = Object.keys(readJson("locked_blocks.json")).sort();
    // Required locked keys + the formerly locked (now editable) ones = the voice backend's catalog.
    const known = [...CALL_FLOW_LOCKED_KEYS.nila, ...CALL_FLOW_LOCKED_KEYS.followup, ...Object.keys(CALL_FLOW_UNLOCKED_KEYS)];
    expect(known.sort()).toEqual(locked);
    expect(nila().blocks.filter(isLockedBlock).map((b) => b.locked).sort()).toEqual([...CALL_FLOW_LOCKED_KEYS.nila].sort());
  });
});

describe("callFlowDefinition validation", () => {
  it("rejects unknown fields at every level", () => {
    expect(issues({ ...nila(), script: "x" })).not.toEqual([]);
    const f = nila();
    (f.blocks[0] as Record<string, unknown>).note = "x";
    expect(issues(f)).not.toEqual([]);
    expect(issues({ ...nila(), silence: { reprompt: "Hello?", closing: "Bye.", retries: 2 } })).not.toEqual([]);
  });

  it("allows only the documented variables (never the phone number)", () => {
    expect(unknownCallFlowVariables("Hi {{name}}, {{ honorific }} {{follow_up_detail}}")).toEqual([]);
    expect(unknownCallFlowVariables("Call {{phone_number}} {{x}} {{x}}")).toEqual(["phone_number", "x"]);
    expect(issues({ ...nila(), greeting: { text: "Hi {{phone_number}}" } }).join()).toMatch(/Unknown variable/);
  });

  it("enforces lengths, single-line fields and the hang-up marker", () => {
    const long = nila();
    (long.blocks[0] as { text: string }).text = "x".repeat(8001);
    expect(issues(long)).not.toEqual([]);
    expect(issues({ ...nila(), greeting: { text: "x".repeat(301) } })).not.toEqual([]);
    expect(issues({ ...nila(), greeting: { text: "Hi,\nthere" } }).join()).toMatch(/single line/);
    const marker = nila();
    (marker.blocks[0] as { text: string }).text += " [[END_CALL]]";
    expect(issues(marker).join()).toMatch(/END_CALL/);
    expect(issues({ ...nila(), limits: { max_duration_sec: 5 } })).not.toEqual([]);
  });

  it("keeps the locked safety blocks", () => {
    const removed = nila();
    removed.blocks = removed.blocks.filter((b) => !(isLockedBlock(b) && b.locked === "nila_data_safety"));
    expect(issues(removed).join()).toMatch(/Locked safety blocks/);
    const foreign = nila();
    foreign.blocks.push({ id: "x", locked: "followup_situations" });
    expect(issues(foreign).join()).toMatch(/Locked safety blocks/);
    const dupId = nila();
    dupId.blocks[1] = { ...dupId.blocks[1], id: dupId.blocks[0].id };
    expect(issues(dupId).join()).toMatch(/Duplicate block id/);
  });

  it("stores a transfer number but never enables transfer", () => {
    expect(issues({ ...nila(), transfer: { enabled: false, number: "+919876543210" } })).toEqual([]);
    expect(issues({ ...nila(), transfer: { enabled: true, number: "+919876543210" } })).not.toEqual([]);
    expect(issues({ ...nila(), transfer: { enabled: false, number: "98765" } })).not.toEqual([]);
  });

  it("supports English only for now", () => {
    expect(issues({ ...nila(), language: "ta" })).not.toEqual([]);
  });
});

describe("inputs", () => {
  it("draft input is strict", () => {
    expect(saveCallFlowDraftInput.safeParse({ definition: nila() }).success).toBe(true);
    expect(saveCallFlowDraftInput.safeParse({ definition: nila(), status: "PUBLISHED" }).success).toBe(false);
  });

  it("startAiCallsInput takes an optional flowId and defaults to none", () => {
    const base = { rows: [{ phone: "9876543210" }], mode: "all" };
    expect(startAiCallsInput.parse(base).flowId).toBeUndefined();
    expect(startAiCallsInput.parse({ ...base, flowId: "cf_1" }).flowId).toBe("cf_1");
  });
});

describe("pause markers and lengths", () => {
  it("accepts {{short_delay}}, {{medium_delay}} and {{long_delay}} in every editable line; other unknown variables stay rejected", () => {
    const f = nila();
    f.greeting = { text: "Hi {{title_to_use}}, {{short_delay}} {{time_greeting}}." };
    f.silence = { reprompt: "Hello? {{medium_delay}} Can you hear me?", closing: "Okay. {{long_delay}} Have a nice day." };
    (f.blocks[0] as { text: string }).text += " Say: Hi {{short_delay}} sir.";
    expect(issues(f)).toEqual([]);
    expect(issues({ ...nila(), greeting: { text: "Hi {{tiny_delay}}" } }).join()).toMatch(/Unknown variable/);
  });

  it("stores the lengths as whole numbers from 0 to 3000 ms; old flows without them stay valid", () => {
    expect(nila().pauses).toBeUndefined();
    expect(issues(nila())).toEqual([]);
    expect(issues({ ...nila(), pauses: { short_ms: 0, medium_ms: 700, long_ms: 3000 } })).toEqual([]);
    for (const bad of [
      { short_ms: -1, medium_ms: 700, long_ms: 1200 },
      { short_ms: 300, medium_ms: 3001, long_ms: 1200 },
      { short_ms: 300, medium_ms: 700, long_ms: 12.5 },
      { short_ms: 300, medium_ms: 700 },
      { short_ms: 300, medium_ms: 700, long_ms: 1200, extra: 1 },
    ]) {
      expect(issues({ ...nila(), pauses: bad })).not.toEqual([]);
    }
    expect(issues({ ...nila(), pauses: { short_ms: 3001, medium_ms: 700, long_ms: 1200 } }).join()).toMatch(/0 to 3000 ms/);
  });
});
