import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { voiceTuningPreset, type VoiceTuningRow, type VoiceTuningSetting } from "@dispatch/shared";
import { ToastProvider } from "../src/components/toast";
import { VoiceResponseTuningSection } from "../src/components/VoiceResponseTuningSection";

// Settings > Voice response tuning: one Tamil row, presets that save at once, Advanced values and Reset. fetch is
// stubbed: nothing reaches the API, a voice backend or a phone.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const row = (tuning: VoiceTuningSetting, saved = true): VoiceTuningRow => ({ language: "ta", name: "Tamil", tuning, saved });

let current: VoiceTuningRow;
const sent: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
  sent.length = 0;
  current = row(voiceTuningPreset("balanced"), false);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET") return json({ items: [current] });
      const body = init.body ? JSON.parse(init.body) : undefined;
      sent.push({ method, url, body });
      current = method === "PUT" ? row(body) : row(voiceTuningPreset("balanced"), false);
      return json(current);
    }),
  );
  vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function section() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <VoiceResponseTuningSection />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const presets = () => within(screen.getByRole("group", { name: "Tamil response mode" }));
const preset = (name: RegExp) => presets().getByRole("button", { name });
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

describe("Voice response tuning", () => {
  it("shows one Tamil row with Balanced as the default, and no other language", async () => {
    section();
    expect(await screen.findByText("Tamil")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Voice response tuning" })).toBeTruthy();
    expect(preset(/^Balanced \(default\)/).getAttribute("aria-pressed")).toBe("true");
    expect(presets().getAllByRole("button").map((b) => b.textContent)).toEqual([
      expect.stringMatching(/^Fast/),
      expect.stringMatching(/^Balanced/),
      expect.stringMatching(/^Patient/),
      expect.stringMatching(/^Current behavior/),
    ]);
    for (const other of ["Hindi", "Telugu", "Kannada", "English"]) expect(screen.queryByText(other)).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a preset saves at once, so Current behavior is an instant rollback", async () => {
    section();
    fireEvent.click(await screen.findByRole("button", { name: /^Current behavior/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PUT", url: "/api/ai-calls/voice-tuning/ta", body: voiceTuningPreset("current") });
    await waitFor(() => expect(preset(/^Current behavior/).getAttribute("aria-pressed")).toBe("true"));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("Advanced: typed values are saved as custom", async () => {
    section();
    await screen.findByText("Tamil");
    expect(field(/End-of-speech wait/).value).toBe("900");
    expect(field(/Extra wait for unfinished/).value).toBe("500");
    expect(field(/Hard cap/).value).toBe("1600");
    fireEvent.change(field(/End-of-speech wait/), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save values" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({ preset: "custom", endOfSpeechSilenceMs: 1000, extraWaitIfIncompleteMs: 500, hardCapMs: 1600 });
    expect(await screen.findByText("Using custom values from Advanced.")).toBeTruthy();
  });

  it("bad numbers can't be saved and say why", async () => {
    section();
    await screen.findByText("Tamil");
    fireEvent.change(field(/Hard cap/), { target: { value: "300" } });
    expect(screen.getByText(/hard cap can't be shorter/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save values" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field(/Hard cap/), { target: { value: "" } });
    expect((screen.getByRole("button", { name: "Save values" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Reset to default removes the saved value, and is off while nothing is saved", async () => {
    current = row(voiceTuningPreset("patient"));
    section();
    fireEvent.click(await screen.findByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(sent).toEqual([{ method: "DELETE", url: "/api/ai-calls/voice-tuning/ta", body: undefined }]));
    await waitFor(() => expect(preset(/^Balanced/).getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("stays out of the way while AI calls are off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "AI calls are disabled" }, 404)));
    section();
    await waitFor(() => expect(screen.queryByText("Voice response tuning")).toBeNull());
  });
});
