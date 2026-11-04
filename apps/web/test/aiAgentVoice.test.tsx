// Copyright (c) 2026 Kagzso Technology Services. All rights reserved.
// Proprietary and confidential. See LICENSE.md in the repository root.
// SPDX-License-Identifier: LicenseRef-Kagzso-Proprietary
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiAgentView, AiCallLanguage } from "@dispatch/shared";
import { AiAgentForm } from "../src/components/AiAgentForm";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { AiCallLanguageProvider } from "../src/lib/aiCallLanguage";

// Settings → AI Voice: female / male voices from the language's voice backend (its list only), Roopa first and
// default for a new Tamil agent, Listen per voice, the saved voice restored on edit, independent of the contact's
// gender. fetch, object URLs and audio are stubbed: nothing reaches the API, a voice backend, Sarvam or a phone.

const TA = (id: string, name: string, gender?: string) => ({ id, name, ...(gender ? { gender } : {}), language: "Tamil (India)" });
// As the local Tamil backend lists them (.env.ta order): untagged voices come without a gender.
const VOICES = [TA("ishita", "Ishita", "female"), TA("roopa", "Roopa", "female"), TA("ritu", "Ritu", "female"), TA("simran", "Simran", "female"), TA("priya", "Priya"), TA("shubh", "Shubh", "male")];

const sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      if (init.body) sent.push({ url, method: init.method ?? "GET", body: JSON.parse(init.body) });
      if (url.startsWith("/api/call-flows/builtin")) return json({ flows: {}, locked_blocks: {}, variables: [], limits: {}, voices: VOICES, default_voice: "ishita", language: "ta" });
      if (url.startsWith("/api/call-flows")) return json({ items: [] });
      if (url.startsWith("/api/ai-agents/library")) return json([]);
      if (url === "/api/voices/preview") return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "Content-Type": "audio/wav" } });
      if (init.method === "POST" || init.method === "PUT") {
        const body = JSON.parse(init.body ?? "{}");
        return json({ ...body.agent, id: "ag1", language: "ta", knowledge: { draft: 0, approved: 0, rejected: 0, files: 0 } }, init.method === "POST" ? 201 : 200);
      }
      return json({});
    }),
  );
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function form(agent: AiAgentView | null = null, language: AiCallLanguage = "ta") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <AiCallLanguageProvider language={language}>
            <AiAgentForm agent={agent} onCreated={() => {}} />
          </AiCallLanguageProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const AGENT: AiAgentView = {
  id: "ag1",
  language: "ta",
  name: "ABC Hospital — Thaara",
  mode: "autonomous",
  categoryId: null,
  customCategory: "Healthcare",
  industryId: null,
  customIndustry: "Hospital",
  businessName: "ABC Hospital",
  objective: "Introduce AI for hospitals.",
  contactName: "Ragul",
  contactGender: "male",
  contactPhone: null,
  executiveName: "Thaara",
  companyName: "Kagzso Technology Services",
  callbackNumber: null,
  personality: "professional",
  instructions: "",
  targetDurationSec: 60,
  maxDurationSec: 105,
  guidedFlowId: null,
  voiceId: "ritu",
  voiceGender: "female",
  voiceDisplayName: "Ritu",
  voiceLanguage: "ta",
  callFlowId: null,
  liveVersion: null,
  unpublishedChanges: true,
  knowledge: { draft: 0, approved: 0, rejected: 0, files: 0 },
  createdByEmail: null,
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
};

const voiceList = () => screen.getByRole("radiogroup", { name: "Voice" });
const names = () => within(voiceList()).getAllByRole("radio").map((r) => r.closest("label")!.textContent!);
const checked = () => within(voiceList()).queryAllByRole("radio").filter((r) => (r as HTMLInputElement).checked).map((r) => r.closest("label")!.textContent!);
const genderButton = (g: "Female" | "Male") => within(screen.getByRole("radiogroup", { name: "Voice gender" })).getByRole("radio", { name: new RegExp(`^${g}`) });
const contactGender = () => screen.getByText("Gender (for sir / madam)").parentElement!.querySelector("select")!;
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByText(label).parentElement!.querySelector("input, textarea")!, { target: { value } });

describe("Settings → AI Voice", () => {
  it("a new Tamil agent: the four female voices, Roopa first and selected; each with language, gender and Listen", async () => {
    form();
    await waitFor(() => expect(names()).toHaveLength(4));
    expect(names()).toEqual([
      "RoopaTamil (India) · female · default",
      "IshitaTamil (India) · female",
      "RituTamil (India) · female",
      "SimranTamil (India) · female",
    ]);
    expect(checked()).toEqual(["RoopaTamil (India) · female · default"]);
    for (const n of ["Roopa", "Ishita", "Ritu", "Simran"]) expect(screen.getByRole("button", { name: `Listen to ${n}` })).toBeTruthy();
    expect(genderButton("Female").textContent).toBe("Female(4)");
    expect(genderButton("Male").textContent).toBe("Male(1)"); // Shubh only: Priya has no gender, so isn't listed
    expect(screen.queryByText(/Priya/)).toBeNull();
  });

  it("Male lists the backend's male voices; the pick is saved per agent and the contact's gender stays its own", async () => {
    form();
    await waitFor(() => expect(names()).toHaveLength(4));
    fireEvent.click(genderButton("Male"));
    expect(names()).toEqual(["ShubhTamil (India) · male"]);
    expect(checked()).toEqual(["ShubhTamil (India) · male"]);
    fireEvent.change(contactGender(), { target: { value: "female" } }); // female customer, male voice
    expect(checked()).toEqual(["ShubhTamil (India) · male"]); // the voice doesn't follow the contact
    fill("Agent name (for your list)", "ABC Hospital — Thaara");
    // The library is empty here: the category and industry are typed by hand ("Other – Enter manually").
    fireEvent.change(screen.getByText("Category").parentElement!.querySelector("select")!, { target: { value: "__other__" } });
    fill("Category name", "Healthcare");
    fill("Industry name", "Hospital");
    fill("Business / company name", "ABC Hospital");
    fill("Calling objective", "Introduce AI for hospitals.");
    fireEvent.click(screen.getByRole("button", { name: "Create AI agent" }));
    await waitFor(() => expect(sent.find((s) => s.url === "/api/ai-agents")).toBeTruthy());
    const { body } = sent.find((s) => s.url === "/api/ai-agents")!;
    expect(body).toMatchObject({ language: "ta", agent: { voiceId: "shubh", contactGender: "female", customCategory: "Healthcare", customIndustry: "Hospital" } });
  });

  it("editing restores the saved voice (Ritu), and a male voice opens on Male", async () => {
    form(AGENT);
    await waitFor(() => expect(checked()).toEqual(["RituTamil (India) · female"]));
    cleanup();
    form({ ...AGENT, voiceId: "shubh", voiceGender: "male", voiceDisplayName: "Shubh", contactGender: "female" });
    await waitFor(() => expect(checked()).toEqual(["ShubhTamil (India) · male"]));
    expect(genderButton("Male").getAttribute("aria-checked")).toBe("true");
    expect(contactGender().value).toBe("female");
  });

  it("saving an edited agent sends the picked voice", async () => {
    form(AGENT);
    await waitFor(() => expect(checked()).toEqual(["RituTamil (India) · female"]));
    fireEvent.click(within(voiceList()).getAllByRole("radio")[3]!); // Simran
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(sent.find((s) => s.method === "PUT")).toBeTruthy());
    expect(sent.find((s) => s.method === "PUT")!.body).toMatchObject({ agent: { voiceId: "simran" } });
  });

  it("a saved voice the backend no longer offers is reported, and nothing is shown as selected", async () => {
    form({ ...AGENT, voiceId: "kavya", voiceDisplayName: "Kavya" });
    await waitFor(() => expect(names()).toHaveLength(4));
    expect(checked()).toEqual([]);
    expect(screen.getByText(/saved voice "kavya" is not offered by the Tamil voice backend any more/)).toBeTruthy();
  });

  it("Listen plays the voice through the Tamil voice backend (a sample only: nothing is saved or called)", async () => {
    form(AGENT);
    await waitFor(() => expect(names()).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Listen to Simran" }));
    await waitFor(() => expect(sent.find((s) => s.url === "/api/voices/preview")).toBeTruthy());
    expect(sent.find((s) => s.url === "/api/voices/preview")!.body).toMatchObject({ voice_id: "simran", language: "ta" });
    expect(sent.some((s) => s.method === "PUT" || s.url === "/api/ai-agents")).toBe(false);
    expect(checked()).toEqual(["RituTamil (India) · female"]); // listening never changes the pick
  });

  it("guided agents: no AI Voice section (they call with their Call Flow's own voice)", async () => {
    form({ ...AGENT, mode: "guided", guidedFlowId: "flow_g" });
    await waitFor(() => expect(screen.getByText("Call Flow")).toBeTruthy());
    expect(screen.queryByText("AI Voice")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Voice" })).toBeNull();
  });
});
