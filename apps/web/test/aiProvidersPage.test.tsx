import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiProviderSettingsView, AiProviderView } from "@dispatch/shared";
import { AiProvidersPage } from "../src/pages/AiProviders";
import { ConfirmProvider } from "../src/components/confirm";
import { disableConsequence, usedByLiveCalls } from "../src/lib/aiProviders";

// Settings → AI providers: switching off a provider that live calls use asks first, even when another
// provider would take over; the backend's own "no usable LLM left" check (409) still asks once more.
// fetch is stubbed: nothing reaches the API, a voice backend or a provider.

const provider = (id: AiProviderView["id"], over: Partial<AiProviderView> = {}): AiProviderView => ({
  id, kind: id.endsWith("_llm") ? "llm" : id.endsWith("_stt") ? "stt" : "tts",
  label: { groq_llm: "Groq", sarvam_llm: "Sarvam AI", anthropic_llm: "Anthropic Claude", sarvam_stt: "Sarvam speech-to-text", sarvam_tts: "Sarvam text-to-speech" }[id],
  provider: id.split("_")[0]!, enabled: false, model: "m", models: ["m"], options: {}, key_configured: false,
  key_source: "none", needs_reencrypt: false, priority: null, status: "disabled", untested_model: false,
  model_allowed: true, last_test: null, ...over,
});
const view = (over: Partial<AiProviderSettingsView> = {}, providers?: AiProviderView[]): AiProviderSettingsView => ({
  language: "en", live: true, secrets_ready: true, env_llm: "sarvam:sarvam-105b-conversations",
  llm_order: ["groq_llm", "sarvam_llm", "anthropic_llm"], usable_llm: ["groq_llm", "sarvam_llm"],
  stt_providers: ["sarvam_stt"], warnings: [],
  providers: providers ?? [
    provider("groq_llm", { enabled: true, key_configured: true, key_source: "saved", status: "configured", priority: 1 }),
    provider("sarvam_llm", { enabled: true, key_configured: true, key_source: "environment", status: "configured", priority: 2 }),
    provider("anthropic_llm", { priority: 3 }),
    provider("sarvam_stt"),
    provider("sarvam_tts"),
  ],
  ...over,
});

let current: AiProviderSettingsView;
let putAnswers: Response[];
const puts: { url: string; body: Record<string, unknown> }[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  puts.length = 0;
  putAnswers = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    if (url === "/api/ai-calls/config") return json({ configured: true, languages: [] });
    if (init.method === "PUT") {
      puts.push({ url, body: JSON.parse(init.body ?? "{}") });
      return putAnswers.shift() ?? json(current);
    }
    return json(current);
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function page() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <AiProvidersPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("switch", { name: "Enable Groq" });
}
const toggle = (label: string) => fireEvent.click(screen.getByRole("switch", { name: `Enable ${label}` }));
const dialog = () => screen.findByRole("alertdialog");
const answer = async (button: "Disable" | "Continue" | "Cancel") => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
};

describe("switching off a provider used by live calls", () => {
  it("asks first; Cancel changes nothing", async () => {
    current = view();
    await page();
    toggle("Groq");
    expect((await dialog()).textContent).toMatch(/Disable Groq\?.*answers live calls now.*next provider/);
    await answer("Cancel");
    expect(puts).toEqual([]);
  });

  it("Disable switches it off", async () => {
    current = view();
    await page();
    toggle("Groq");
    await dialog();
    await answer("Disable");
    await waitFor(() => expect(puts).toEqual([{ url: "/api/ai-providers/en/providers/groq_llm", body: { enabled: false } }]));
  });

  it("asks for a fallback provider too", async () => {
    current = view();
    await page();
    toggle("Sarvam AI");
    expect((await dialog()).textContent).toMatch(/fallback for live calls/);
    await answer("Cancel");
    expect(puts).toEqual([]);
  });

  it("does not ask for a provider live calls don't use", async () => {
    current = view({ live: false });
    await page();
    toggle("Groq"); // enabled, but "Use for live calls" is off
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ enabled: false });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    current = view();
    puts.length = 0;
    toggle("Anthropic Claude"); // switching one on never asks
    await waitFor(() => expect(puts).toEqual([{ url: "/api/ai-providers/en/providers/anthropic_llm", body: { enabled: true } }]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps a usable language model unless the backend's check is confirmed too", async () => {
    current = view({ usable_llm: ["groq_llm"] }, [
      provider("groq_llm", { enabled: true, key_configured: true, key_source: "saved", status: "configured", priority: 1 }),
      provider("sarvam_llm", { priority: 2 }), provider("anthropic_llm", { priority: 3 }),
      provider("sarvam_stt"), provider("sarvam_tts"),
    ]);
    await page();
    putAnswers = [json({ error: "This leaves no usable LLM provider: live calls would use the server's .env LLM.", code: "would_leave_no_llm" }, 409)];
    toggle("Groq");
    expect((await dialog()).textContent).toMatch(/only usable language model/);
    await answer("Disable");
    expect((await dialog()).textContent).toMatch(/leaves no usable LLM provider/); // the backend's own check
    await answer("Cancel");
    expect(puts).toEqual([{ url: "/api/ai-providers/en/providers/groq_llm", body: { enabled: false } }]); // nothing confirmed

    putAnswers = [json({ error: "This leaves no usable LLM provider.", code: "would_leave_no_llm" }, 409)];
    puts.length = 0;
    toggle("Groq");
    await dialog();
    await answer("Disable");
    await dialog();
    await answer("Continue");
    await waitFor(() => expect(puts.map((p) => p.body)).toEqual([{ enabled: false }, { enabled: false, confirm: true }]));
  });
});

describe("usedByLiveCalls", () => {
  it("covers usable LLMs and the speech settings calls take, only while live", () => {
    const v = view();
    const [groq, sarvam, anthropic] = v.providers;
    expect([groq, sarvam, anthropic].map((p) => usedByLiveCalls(p!, v))).toEqual([true, true, false]);
    expect(usedByLiveCalls(groq!, view({ live: false }))).toBe(false);
    const tts = provider("sarvam_tts", { enabled: true, key_configured: true });
    expect(usedByLiveCalls(tts, v)).toBe(true);
    expect(usedByLiveCalls({ ...tts, model_allowed: false }, v)).toBe(false); // calls ignore an unverified model
    expect(disableConsequence(tts, v)).toMatch(/\.env voice settings/);
  });
});
