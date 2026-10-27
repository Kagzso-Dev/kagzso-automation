import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AI_CALL_VOICE_SAMPLES, AI_CALL_VOICE_SAMPLES_MIXED } from "@dispatch/shared";
import { sampleLine, VoicePicker } from "../src/components/VoicePicker";
import { ToastProvider } from "../src/components/toast";

// Call Flows editor → Voice: the "Sample line to listen to" starts as the flow's own opening (what the
// customer hears first), or a line in the flow's language; Listen asks that language's voice backend.
// fetch, object URLs and audio playback are stubbed: nothing reaches a voice backend or Sarvam.

const VOICES = [
  { id: "roopa", name: "Roopa", gender: "female", language: "Tamil (India)" },
  { id: "ishita", name: "Ishita", gender: "female", language: "Tamil (India)" },
];
const bodies: Record<string, unknown>[] = [];
const urls: string[] = [];
const wav = () => new Response(new Blob(["RIFF"]), { status: 200, headers: { "Content-Type": "audio/wav" } });
let answer: (url: string) => Response = wav;
/** The player's source each time play() was called. */
let playedSrc: string[] = [];

beforeEach(() => {
  bodies.length = 0;
  urls.length = 0;
  answer = wav;
  playedSrc = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      urls.push(url);
      if (init.body) bodies.push(JSON.parse(init.body));
      return answer(url);
    }),
  );
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    playedSrc.push(this.src);
    return Promise.resolve();
  });
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const box = () => screen.getByLabelText("Sample line to listen to") as HTMLInputElement;
const picker = (props: Partial<Parameters<typeof VoicePicker>[0]> = {}) => (
  <ToastProvider>
    <VoicePicker voices={VOICES} defaultVoice="roopa" value="ishita" onChange={() => {}} {...props} />
  </ToastProvider>
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

  it("without a flow opening, the line follows the flow's language style (no style = as before)", () => {
    render(picker({ language: "ta", languageStyle: "mixed", flowLine: null }));
    expect(box().value).toBe(AI_CALL_VOICE_SAMPLES_MIXED.ta);
    cleanup();
    render(picker({ language: "ta", languageStyle: "pure", flowLine: null }));
    expect(box().value).toBe(AI_CALL_VOICE_SAMPLES.ta);
    cleanup();
    for (const language of ["ta", "hi", "kn"] as const) {
      render(picker({ language, flowLine: null })); // a flow saved before the setting: the line it had before
      expect(box().value).toBe(AI_CALL_VOICE_SAMPLES[language]);
      cleanup();
    }
    render(picker({ language: "en", flowLine: null }));
    expect(box().value).toBe("Hello, am I speaking with Ragul?");
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

  it("starts the player inside the click (silence first), then plays the sample on the same player", async () => {
    render(picker({ language: "en", flowLine: "Hello, am I speaking with Ragul? (gesture)" }));
    fireEvent.click(screen.getByRole("button", { name: "Listen to Ishita" }));
    expect(playedSrc).toHaveLength(1); // before the network answer: still inside the click
    expect(playedSrc[0]).toMatch(/^data:audio\/wav;base64,/);
    await waitFor(() => expect(playedSrc).toEqual([playedSrc[0], "blob:preview"]));
    expect(screen.getByRole("button", { name: "Stop Ishita" }).textContent).toBe("■ Playing… Stop");
  });

  it("an expired sign-in is refreshed once and the sample still plays", async () => {
    let first = true;
    answer = (url) => {
      if (url === "/api/auth/refresh") return new Response(JSON.stringify({ accessToken: "fresh" }), { status: 200 });
      if (first) {
        first = false;
        return new Response(JSON.stringify({ error: "Token expired" }), { status: 401 });
      }
      return wav();
    };
    render(picker({ language: "en", flowLine: "Hello (expired sign-in)" }));
    fireEvent.click(screen.getByRole("button", { name: "Listen to Roopa" }));
    await waitFor(() => expect(playedSrc).toContain("blob:preview"));
    expect(urls).toEqual(["/api/voices/preview", "/api/auth/refresh", "/api/voices/preview"]);
  });

  it("a failure is shown in a toast and under the box, and the button is ready again", async () => {
    answer = () => new Response(JSON.stringify({ error: "Voice preview failed: Sarvam TTS request timed out" }), { status: 503 });
    render(picker({ language: "ta", flowLine: "வணக்கம் (failure)" }));
    fireEvent.click(screen.getByRole("button", { name: "Listen to Roopa" }));
    await waitFor(() => expect(screen.getByText("Couldn't play the voice sample")).toBeTruthy());
    expect(screen.getAllByText("Voice preview failed: Sarvam TTS request timed out").length).toBe(2); // toast + inline
    expect(screen.getByRole("button", { name: "Listen to Roopa" }).textContent).toBe("▶ Listen");
  });

  it("a browser that blocks the sound says so", async () => {
    vi.mocked(window.HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
      return this.src.startsWith("blob:") ? Promise.reject(new DOMException("blocked", "NotAllowedError")) : Promise.resolve();
    });
    render(picker({ language: "en", flowLine: "Hello (blocked)" }));
    fireEvent.click(screen.getByRole("button", { name: "Listen to Roopa" }));
    await waitFor(() => expect(screen.getAllByText(/The browser blocked the sound — tap Listen again/).length).toBe(2));
  });

  it("an answer that isn't audio is an error, not silence", async () => {
    answer = () => new Response("<html>proxy page</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    render(picker({ language: "en", flowLine: "Hello (not audio)" }));
    fireEvent.click(screen.getByRole("button", { name: "Listen to Roopa" }));
    await waitFor(() => expect(screen.getAllByText("The server sent no audio for this voice — try again").length).toBe(2));
  });

  it("Listen only asks for a sample: no call, no save, nothing else", async () => {
    const onChange = vi.fn();
    render(picker({ language: "kn", flowLine: "ನಮಸ್ಕಾರ (no call)", onChange }));
    for (const name of ["Roopa", "Ishita"]) {
      fireEvent.click(screen.getByRole("button", { name: `Listen to ${name}` }));
      await waitFor(() => expect(screen.getByRole("button", { name: `Stop ${name}` }).textContent).toBe("■ Playing… Stop"));
    }
    expect(urls).toEqual(["/api/voices/preview", "/api/voices/preview"]);
    expect(onChange).not.toHaveBeenCalled(); // the chosen voice is unchanged
  });
});
