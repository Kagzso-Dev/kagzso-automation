import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AI_CALL_VOICE_SAMPLES } from "@dispatch/shared";
import { sampleLine, VoicePicker } from "../src/components/VoicePicker";

// Call Flows editor → Voice: the "Sample line to listen to" starts as the flow's own opening (what the
// customer hears first), or a line in the flow's language; Listen asks that language's voice backend.
// fetch, object URLs and audio playback are stubbed: nothing reaches a voice backend or Sarvam.

const VOICES = [
  { id: "roopa", name: "Roopa", gender: "female", language: "Tamil (India)" },
  { id: "ishita", name: "Ishita", gender: "female", language: "Tamil (India)" },
];
const bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(new Blob(["RIFF"]), { status: 200 });
    }),
  );
  URL.createObjectURL = vi.fn(() => "blob:preview");
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const box = () => screen.getByLabelText("Sample line to listen to") as HTMLInputElement;
const picker = (props: Partial<Parameters<typeof VoicePicker>[0]> = {}) => (
  <VoicePicker voices={VOICES} defaultVoice="roopa" value="ishita" onChange={() => {}} {...props} />
);

describe("sample line", () => {
  it("starts as the flow's own opening", () => {
    render(picker({ flowLine: "Hi sir, Good evening. Am I speaking with Ragul, sir?" }));
    expect(box().value).toBe("Hi sir, Good evening. Am I speaking with Ragul, sir?");
  });

  it("without a flow opening: a line in the flow's language and script (English unchanged)", () => {
    for (const language of ["en", "ta", "hi", "kn"] as const) {
      render(picker({ language, flowLine: null }));
      expect([language, box().value]).toEqual([language, AI_CALL_VOICE_SAMPLES[language]]);
      cleanup();
    }
    expect(AI_CALL_VOICE_SAMPLES.en).toBe("Hello, am I speaking with Ragul?");
    expect(AI_CALL_VOICE_SAMPLES.ta).toMatch(/^[஀-௿\s,?]+$/); // Tamil script only
    expect(AI_CALL_VOICE_SAMPLES.hi).toMatch(/^[ऀ-ॿ\s,?]+$/); // Devanagari only
    expect(AI_CALL_VOICE_SAMPLES.kn).toMatch(/^[ಀ-೿\s,?]+$/); // Kannada script only
  });

  it("a long opening is cut after a sentence, within 200 characters", () => {
    const long = `${"Hello sir. ".repeat(15)}This part is past the limit and is left out.`;
    const line = sampleLine(long)!;
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.endsWith(".")).toBe(true);
    expect(sampleLine("   ")).toBeNull();
    expect(sampleLine("  Hi   sir,\n Good evening. ")).toBe("Hi sir, Good evening.");
  });

  it("a changed opening fills the box only while it still shows the previous one; a typed line is kept", () => {
    const { rerender } = render(picker({ flowLine: "வணக்கம் சார்." }));
    rerender(picker({ flowLine: "வணக்கம் சார், நல்ல மாலை." })); // the greeting was edited
    expect(box().value).toBe("வணக்கம் சார், நல்ல மாலை.");

    fireEvent.change(box(), { target: { value: "My own test line" } });
    rerender(picker({ flowLine: "வணக்கம் ராகுல் சார்." }));
    expect(box().value).toBe("My own test line"); // never overwritten

    fireEvent.change(box(), { target: { value: "" } });
    rerender(picker({ flowLine: "வணக்கம் ராகுல் சார், நல்ல மாலை." }));
    expect(box().value).toBe("வணக்கம் ராகுல் சார், நல்ல மாலை."); // empty again: filled
  });
});

describe("Listen", () => {
  it("asks the flow language's backend with the picked voice and the flow's opening", async () => {
    render(picker({ language: "ta", flowLine: "வணக்கம், நான் ராகுல் சாரிடம் பேசுகிறேனா? (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Listen to Ishita" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ voice_id: "ishita", text: "வணக்கம், நான் ராகுல் சாரிடம் பேசுகிறேனா? (1)", language: "ta" });
  });

  it("English requests are sent exactly as before (no language field)", async () => {
    render(picker({ language: "en", flowLine: null }));
    fireEvent.click(screen.getByRole("button", { name: "Listen to Roopa" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ voice_id: "roopa", text: "Hello, am I speaking with Ragul?" });
  });

  it("the same language, voice and line plays from the cache the second time", async () => {
    render(picker({ language: "hi", flowLine: "नमस्ते, क्या मैं राहुल सर से बात कर रही हूँ? (cache)" }));
    const listen = () => screen.getByRole("button", { name: /Listen to Roopa|Stop Roopa/ });
    fireEvent.click(listen());
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop Roopa" })).toBeTruthy());
    fireEvent.click(listen()); // stop
    fireEvent.click(listen()); // play again
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop Roopa" })).toBeTruthy());
    expect(bodies).toHaveLength(1);
  });
});
