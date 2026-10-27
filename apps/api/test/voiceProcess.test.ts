import { afterEach, describe, expect, it, vi } from "vitest";

// Starting a language's voice backend from Settings (services/voiceProcess.ts): the guards that
// stop it before any command runs. Nothing here starts a process or reaches a database.

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return import("../src/services/voiceProcess.js");
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Back to the test defaults (test/setup.ts): nothing started, no Tamil backend.
  process.env.AI_CALL_BACKEND_CONTROL = "false";
  process.env.VOICE_BACKEND_URL_TA = "";
});

describe("voice backend processes", () => {
  it("names match deploy/ecosystem.config.cjs", async () => {
    const { voicePm2Name, voiceEnvFile } = await load({});
    expect(voicePm2Name("en")).toBe("kagzso_orchestrator_voice");
    expect(voicePm2Name("ta")).toBe("kagzso_orchestrator_voice_ta");
    expect(voiceEnvFile("en")).toBe(".env");
    expect(voiceEnvFile("kn")).toBe(".env.kn");
  });

  it("a started backend never sees Dispatch's own settings", async () => {
    const { cleanEnv } = await load({ DATABASE_URL: "mysql://dispatch", LOG_LEVEL: "debug", JWT_ACCESS_SECRET: "s3cret" });
    const env = cleanEnv({ KAGZSO_ENV_FILE: ".env.ta" });
    expect(env.KAGZSO_ENV_FILE).toBe(".env.ta");
    expect(env.PATH ?? env.Path).toBeTruthy();
    for (const k of ["DATABASE_URL", "LOG_LEVEL", "JWT_ACCESS_SECRET", "VOICE_BACKEND_API_KEY"]) expect(env).not.toHaveProperty(k);
    delete process.env.DATABASE_URL;
  });

  it("AI_CALL_BACKEND_CONTROL=false: a backend that is down is not started from Settings", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const { startVoiceBackend, VoiceProcessError } = await load({
      AI_CALL_BACKEND_CONTROL: "false",
      VOICE_BACKEND_URL_TA: "http://127.0.0.1:8003",
      VOICE_BACKEND_API_KEY: "k",
    });
    await expect(startVoiceBackend("ta")).rejects.toBeInstanceOf(VoiceProcessError);
    await expect(startVoiceBackend("ta")).rejects.toThrow(/turned off/);
  });

  it("a language without a voice backend says what to set", async () => {
    const { startVoiceBackend } = await load({ VOICE_BACKEND_URL_TA: "" });
    await expect(startVoiceBackend("ta")).rejects.toThrow(/set VOICE_BACKEND_URL_TA \(npm run voice:lang:init -- ta\)/);
  });

  it("a backend on another machine is never started from here", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const { startVoiceBackend } = await load({
      AI_CALL_BACKEND_CONTROL: "true",
      VOICE_BACKEND_URL_TA: "http://10.0.0.5:8003",
      VOICE_BACKEND_API_KEY: "k",
    });
    await expect(startVoiceBackend("ta")).rejects.toThrow(/on another machine \(10\.0\.0\.5:8003\)/);
  });

  it("already answering: nothing is started", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const { startVoiceBackend } = await load({ VOICE_BACKEND_URL_TA: "http://127.0.0.1:8003", VOICE_BACKEND_API_KEY: "k" });
    expect(await startVoiceBackend("ta")).toEqual({ started: false, how: "already_running" });
  });
});
