import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_CALL_LANGUAGES,
  isVoiceTuningLanguage,
  readVoiceTuning,
  VOICE_TUNING_LANGUAGES,
  VOICE_TUNING_PRESETS,
  VOICE_TUNING_VALUES,
  voiceTuningPayload,
  voiceTuningPreset,
  voiceTuningSetting,
  type VoiceTuningRow,
} from "@dispatch/shared";

// Voice response tuning: Tamil only, read when a call is dialled, and nothing at all for any other language. The presets
// are written to the voice backend's tests/fixtures/voice_tuning_presets.json (UPDATE_FIXTURES=1) and compared here, so
// tests/test_turn_tuning.py proves the voice backend accepts exactly what is sent.

const settings = new Map<string, unknown>();
const reads: string[] = [];
const agentsByFlow = new Map<string, string>(); // callFlowId -> agent id
const db = vi.hoisted(() => ({ setting: {} as Record<string, unknown>, aiAgent: {} as Record<string, unknown> }));
db.aiAgent = {
  findUnique: async ({ where }: { where: { callFlowId: string } }) => {
    reads.push(`agent of ${where.callFlowId}`);
    const id = agentsByFlow.get(where.callFlowId);
    return id ? { id } : null;
  },
};
db.setting = {
  findUnique: async ({ where }: { where: { key: string } }) => {
    reads.push(where.key);
    return settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null;
  },
  upsert: async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => {
    settings.set(where.key, create.value);
    return {};
  },
  deleteMany: async ({ where }: { where: { key: string } }) => ({ count: settings.delete(where.key) ? 1 : 0 }),
};
vi.mock("../src/prisma.js", () => ({ prisma: db }));

const FIXTURE = fileURLToPath(new URL("../../../kagzso-voice-backend-english/tests/fixtures/voice_tuning_presets.json", import.meta.url));
const KEY = "aiCallVoiceTuning:ta";
const OTHER_LANGUAGES = AI_CALL_LANGUAGES.filter((l) => l !== "ta");

beforeEach(() => {
  settings.clear();
  agentsByFlow.clear();
  reads.length = 0;
});

describe("the settings", () => {
  it("Tamil is the only language with tuning, and the Balanced values are the agreed ones", () => {
    expect(VOICE_TUNING_LANGUAGES).toEqual(["ta"]);
    expect(OTHER_LANGUAGES.filter(isVoiceTuningLanguage)).toEqual([]);
    expect(VOICE_TUNING_VALUES.balanced).toEqual({ finishedSilenceMs: 450, endOfSpeechSilenceMs: 900, extraWaitIfIncompleteMs: 500, hardCapMs: 1600, minWordsBeforeReply: 1 });
    expect(VOICE_TUNING_VALUES.current).toMatchObject({ endOfSpeechSilenceMs: 700, extraWaitIfIncompleteMs: 0, hardCapMs: 0 });
  });

  it("every preset is valid, and each preset's waits fit inside its cap", () => {
    for (const p of VOICE_TUNING_PRESETS) {
      expect(voiceTuningSetting.safeParse(voiceTuningPreset(p)).success).toBe(true);
      const v = VOICE_TUNING_VALUES[p];
      if (v.hardCapMs) expect(v.endOfSpeechSilenceMs + v.extraWaitIfIncompleteMs).toBeLessThanOrEqual(v.hardCapMs);
    }
  });

  it("writes / matches the presets the voice backend validates", () => {
    const sent = Object.fromEntries(VOICE_TUNING_PRESETS.filter((p) => p !== "current").map((p) => [p, voiceTuningPayload(voiceTuningPreset(p))]));
    const json = JSON.stringify(sent, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") {
      mkdirSync(new URL(".", `file:///${FIXTURE.replace(/\\/g, "/")}`), { recursive: true });
      writeFileSync(FIXTURE, json);
    }
    expect(readFileSync(FIXTURE, "utf8")).toBe(json);
  });

  it("no saved value, or anything unreadable, is Balanced: old data never breaks a call", () => {
    for (const bad of [null, undefined, "x", 5, {}, { preset: "fast" }, { preset: "nope", finishedSilenceMs: 1 }]) {
      expect(readVoiceTuning(bad)).toEqual(voiceTuningPreset("balanced"));
    }
  });

  it("a saved preset always means its own numbers; custom keeps what was typed", () => {
    expect(readVoiceTuning({ ...voiceTuningPreset("fast"), endOfSpeechSilenceMs: 999 })).toEqual(voiceTuningPreset("fast"));
    const custom = { ...voiceTuningPreset("balanced"), preset: "custom" as const, endOfSpeechSilenceMs: 1000 };
    expect(readVoiceTuning(custom)).toEqual(custom);
  });

  it("refuses numbers that make no sense", () => {
    const custom = { ...voiceTuningPreset("balanced"), preset: "custom" as const };
    const message = (v: Record<string, unknown>) => voiceTuningSetting.safeParse({ ...custom, ...v }).error?.issues[0]?.message;
    expect(message({ hardCapMs: 800 })).toMatch(/hard cap can't be shorter/);
    expect(message({ endOfSpeechSilenceMs: 400 })).toMatch(/can't be shorter than the wait after a finished sentence/);
    expect(message({ endOfSpeechSilenceMs: 9999 })).toMatch(/from 300 to 2000/);
    expect(message({ extraWaitIfIncompleteMs: -1 })).toMatch(/from 0 to 2000/);
    expect(message({ hardCapMs: 0 })).toBeUndefined(); // 0 = no cap
  });
});

describe("what a call is sent", () => {
  const forCall = async (language: string) => (await import("../src/domain/aiCallVoiceTuning.js")).voiceTuningForCall(language as "ta");

  it.each(OTHER_LANGUAGES)("%s: nothing, and the database is never read", async (language) => {
    settings.set(`aiCallVoiceTuning:${language}`, voiceTuningPreset("fast")); // even if a value somehow existed
    expect(await forCall(language)).toBeNull();
    expect(reads).toEqual([]);
  });

  it("Tamil with nothing saved: Balanced", async () => {
    expect(await forCall("ta")).toEqual({
      preset: "balanced",
      finished_silence_ms: 450,
      end_of_speech_silence_ms: 900,
      extra_wait_if_incomplete_ms: 500,
      hard_cap_ms: 1600,
      min_words_before_reply: 1,
    });
  });

  it("Tamil on Current behavior: nothing at all, an exact rollback", async () => {
    settings.set(KEY, voiceTuningPreset("current"));
    expect(await forCall("ta")).toBeNull();
  });

  it("Tamil reads the saved value on every call, so a change reaches the next one", async () => {
    settings.set(KEY, voiceTuningPreset("fast"));
    expect((await forCall("ta"))?.end_of_speech_silence_ms).toBe(750);
    settings.set(KEY, voiceTuningPreset("patient"));
    expect((await forCall("ta"))?.end_of_speech_silence_ms).toBe(1100);
  });

  it("a database that can't be read uses Balanced: tuning never stops a call", async () => {
    const original = db.setting.findUnique;
    db.setting.findUnique = async () => {
      throw new Error("database down");
    };
    expect((await forCall("ta"))?.preset).toBe("balanced");
    db.setting.findUnique = original;
  });
});

describe("an AI agent's own reply speed", () => {
  const forCall = async (language: string, flowId?: string | null) =>
    (await import("../src/domain/aiCallVoiceTuning.js")).voiceTuningForCall(language as "ta", flowId);
  const AGENT_KEY = "aiAgentReplySpeed:ag1";
  const MANUAL = { ...voiceTuningPreset("balanced"), preset: "custom" as const, finishedSilenceMs: 500, endOfSpeechSilenceMs: 1000, hardCapMs: 1800 };
  beforeEach(() => void agentsByFlow.set("flow-of-ag1", "ag1"));

  it("no pick: exactly the language's setting, on an agent's flow as on any other", async () => {
    settings.set(KEY, voiceTuningPreset("patient"));
    expect(await forCall("ta", "flow-of-ag1")).toEqual(await forCall("ta", "some-other-flow"));
    expect((await forCall("ta", "flow-of-ag1"))?.preset).toBe("patient");
  });

  it("a pick wins over the language's setting, and only on that agent's flow", async () => {
    settings.set(KEY, voiceTuningPreset("patient"));
    settings.set(AGENT_KEY, voiceTuningPreset("fast"));
    expect(await forCall("ta", "flow-of-ag1")).toEqual(voiceTuningPayload(voiceTuningPreset("fast")));
    expect((await forCall("ta", "some-other-flow"))?.preset).toBe("patient");
    expect((await forCall("ta"))?.preset).toBe("patient");
    expect((await forCall("ta", null))?.preset).toBe("patient");
  });

  it("Manual: the waits go to the call exactly as typed", async () => {
    settings.set(KEY, voiceTuningPreset("fast"));
    settings.set(AGENT_KEY, MANUAL);
    expect(await forCall("ta", "flow-of-ag1")).toEqual({
      preset: "custom",
      finished_silence_ms: 500,
      end_of_speech_silence_ms: 1000,
      extra_wait_if_incomplete_ms: 500,
      hard_cap_ms: 1800,
      min_words_before_reply: 1,
    });
  });

  it("a saved preset always means its own numbers, and a bare name (the first version's) still reads", async () => {
    settings.set(AGENT_KEY, { ...voiceTuningPreset("fast"), endOfSpeechSilenceMs: 999 });
    expect((await forCall("ta", "flow-of-ag1"))?.end_of_speech_silence_ms).toBe(750);
    settings.set(AGENT_KEY, "patient");
    expect(await forCall("ta", "flow-of-ag1")).toEqual(voiceTuningPayload(voiceTuningPreset("patient")));
  });

  it("Current behavior sends nothing for that agent, whatever the language's setting", async () => {
    settings.set(KEY, voiceTuningPreset("fast"));
    settings.set(AGENT_KEY, voiceTuningPreset("current"));
    expect(await forCall("ta", "flow-of-ag1")).toBeNull();
  });

  it("read on every call, so a new pick reaches the next one", async () => {
    settings.set(AGENT_KEY, voiceTuningPreset("fast"));
    expect((await forCall("ta", "flow-of-ag1"))?.preset).toBe("fast");
    settings.set(AGENT_KEY, MANUAL);
    expect((await forCall("ta", "flow-of-ag1"))?.end_of_speech_silence_ms).toBe(1000);
  });

  it.each([["custom"], ["turbo"], [1.2], [{ preset: "fast" }], [{ ...MANUAL, hardCapMs: 9999 }], [{ ...MANUAL, finishedSilenceMs: 1500 }]])(
    "an unreadable saved value (%j) follows the language's setting",
    async (bad) => {
      settings.set(KEY, voiceTuningPreset("patient"));
      settings.set(AGENT_KEY, bad);
      expect((await forCall("ta", "flow-of-ag1"))?.preset).toBe("patient");
    },
  );

  it.each(OTHER_LANGUAGES)("%s: still nothing, and neither the agent nor Settings is read", async (language) => {
    settings.set(AGENT_KEY, MANUAL);
    expect(await forCall(language, "flow-of-ag1")).toBeNull();
    expect(reads).toEqual([]);
  });

  it("an agent that can't be read uses Balanced: tuning never stops a call", async () => {
    const original = db.aiAgent.findUnique;
    db.aiAgent.findUnique = async () => {
      throw new Error("database down");
    };
    expect((await forCall("ta", "flow-of-ag1"))?.preset).toBe("balanced");
    db.aiAgent.findUnique = original;
  });

  it("saving a pick or Manual waits, and removing it with null; a language without tuning saves nothing", async () => {
    const { agentReplySpeed, saveAgentReplySpeed } = await import("../src/domain/aiCallVoiceTuning.js");
    await saveAgentReplySpeed("ag1", "ta", voiceTuningPreset("fast"));
    expect(await agentReplySpeed("ag1", "ta")).toEqual(voiceTuningPreset("fast"));
    await saveAgentReplySpeed("ag1", "ta", MANUAL);
    expect(settings.get(AGENT_KEY)).toEqual(MANUAL);
    expect(await agentReplySpeed("ag1", "ta")).toEqual(MANUAL);
    await saveAgentReplySpeed("ag1", "ta", null);
    expect(settings.has(AGENT_KEY)).toBe(false);
    expect(await agentReplySpeed("ag1", "ta")).toBeNull();

    reads.length = 0;
    await saveAgentReplySpeed("ag2", "en", MANUAL);
    expect(settings.has("aiAgentReplySpeed:ag2")).toBe(false);
    expect(await agentReplySpeed("ag2", "en")).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe("the request to the voice backend", () => {
  async function sent(extra: Record<string, unknown>) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ success: true, call_id: "c1", provider_call_id: null }), { status: 200 });
    });
    process.env.VOICE_BACKEND_URL = "http://voice.test";
    process.env.VOICE_BACKEND_API_KEY = "voice-key-0123456789";
    vi.resetModules();
    const { placeVoiceCall } = await import("../src/services/voiceBackend.js");
    await placeVoiceCall({ customerName: "Ragul", gender: "male", followUpDetail: null, phone: "+919876543210", runId: "r1", logId: "l1", ...extra });
    vi.unstubAllGlobals();
    return bodies[0]!;
  }

  it("carries tuning only when it is given", async () => {
    expect(await sent({})).not.toHaveProperty("voice_tuning");
    expect(await sent({ voiceTuning: null })).not.toHaveProperty("voice_tuning");
    const payload = voiceTuningPayload(voiceTuningPreset("balanced"));
    expect((await sent({ voiceTuning: payload })).voice_tuning).toEqual(payload);
  });
});

describe("Settings → Voice response tuning", () => {
  let server: Server;
  let base = "";
  const token = (role: "ADMIN" | "EDITOR") => jwt.sign({ sub: `u-${role}`, email: `${role.toLowerCase()}@test`, role }, process.env.JWT_ACCESS_SECRET!);
  const call = (path: string, role: "ADMIN" | "EDITOR", init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}/api/ai-calls${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(role)}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  beforeAll(async () => {
    process.env.ENABLE_AI_CALLS = "true";
    vi.resetModules();
    const { createApp } = await import("../src/http/app.js");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("one row, Tamil, on Balanced until something is saved", async () => {
    const { items } = (await (await call("/voice-tuning", "ADMIN")).json()) as { items: VoiceTuningRow[] };
    expect(items).toEqual([{ language: "ta", name: "Tamil", tuning: voiceTuningPreset("balanced"), saved: false }]);
  });

  it("admins only", async () => {
    expect((await call("/voice-tuning", "EDITOR")).status).toBe(403);
    expect((await call("/voice-tuning/ta", "EDITOR", { method: "PUT", body: voiceTuningPreset("fast") })).status).toBe(403);
    expect((await call("/voice-tuning/ta", "EDITOR", { method: "DELETE" })).status).toBe(403);
    expect(settings.has(KEY)).toBe(false);
  });

  it("saves and resets to default", async () => {
    const saved = (await (await call("/voice-tuning/ta", "ADMIN", { method: "PUT", body: voiceTuningPreset("patient") })).json()) as VoiceTuningRow;
    expect(saved).toMatchObject({ saved: true, tuning: { preset: "patient", endOfSpeechSilenceMs: 1100 } });
    expect(settings.get(KEY)).toMatchObject({ preset: "patient" });
    const reset = (await (await call("/voice-tuning/ta", "ADMIN", { method: "DELETE" })).json()) as VoiceTuningRow;
    expect(reset).toEqual({ language: "ta", name: "Tamil", tuning: voiceTuningPreset("balanced"), saved: false });
    expect(settings.has(KEY)).toBe(false);
  });

  it("refuses bad numbers and every other language", async () => {
    const bad = { ...voiceTuningPreset("balanced"), preset: "custom", hardCapMs: 100 };
    expect((await call("/voice-tuning/ta", "ADMIN", { method: "PUT", body: bad })).status).toBe(400);
    for (const language of OTHER_LANGUAGES) {
      expect((await call(`/voice-tuning/${language}`, "ADMIN", { method: "PUT", body: voiceTuningPreset("fast") })).status).toBe(400);
      expect((await call(`/voice-tuning/${language}`, "ADMIN", { method: "DELETE" })).status).toBe(400);
    }
    expect([...settings.keys()]).toEqual([]);
  });
});
