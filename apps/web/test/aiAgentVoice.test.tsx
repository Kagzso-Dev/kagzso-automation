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
let serverMax: number | undefined; // the voice backend's MAX_CALL_DURATION_SECONDS, as its catalog reports it
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  sent.length = 0;
  serverMax = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      if (init.body) sent.push({ url, method: init.method ?? "GET", body: JSON.parse(init.body) });
      if (url.startsWith("/api/call-flows/builtin")) return json({ flows: {}, locked_blocks: {}, variables: [], limits: serverMax ? { max_duration_sec: serverMax } : {}, voices: VOICES, default_voice: "ishita", language: "ta" });
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
    fill("Calling objective", "Introduce AI for hospitals.");
    fireEvent.click(screen.getByRole("button", { name: "Create AI agent" }));
    await waitFor(() => expect(sent.find((s) => s.url === "/api/ai-agents")).toBeTruthy());
    const { body } = sent.find((s) => s.url === "/api/ai-agents")!;
    expect(body).toMatchObject({ language: "ta", agent: { voiceId: "shubh", contactGender: "female" } });
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

  describe("voice speed", () => {
    const speeds = () => within(screen.getByRole("radiogroup", { name: "Voice speed" })).getAllByRole("radio");
    const selected = () => speeds().filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.textContent);
    const speed = (label: RegExp) => within(screen.getByRole("radiogroup", { name: "Voice speed" })).getByRole("radio", { name: label });
    const box = () => screen.getByRole("spinbutton", { name: /speed/ }) as HTMLInputElement;
    const typeSpeed = (value: string) => fireEvent.change(box(), { target: { value } });
    const saveButton = () => screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    const listen = () => screen.getByRole("button", { name: "Listen to Simran" }) as HTMLButtonElement;
    const RULE = "Enter a speed from 0.5 to 2.0";

    it("five levels; a new agent starts at the default, and the Normal level is the provider's ordinary speed", async () => {
      form();
      await waitFor(() => expect(names()).toHaveLength(4));
      expect(speeds().map((b) => b.textContent)).toEqual(["Slow(0.8)", "Relaxed(0.9)", "Normal(1.0)", "Brisk(1.1)", "Fast(1.2)"]);
      expect(selected()).toEqual(["Relaxed(0.9)"]);
    });

    it("editing restores the agent's own speed, and an agent without one shows the default", async () => {
      form({ ...AGENT, voiceSpeed: 1.1 });
      await waitFor(() => expect(selected()).toEqual(["Brisk(1.1)"]));
      cleanup();
      form(AGENT);
      await waitFor(() => expect(selected()).toEqual(["Relaxed(0.9)"]));
    });

    it("saving sends the picked speed, and Listen plays at it", async () => {
      form(AGENT);
      await waitFor(() => expect(names()).toHaveLength(4));
      fireEvent.click(speed(/^Normal/));
      expect(selected()).toEqual(["Normal(1.0)"]);
      fireEvent.click(screen.getByRole("button", { name: "Listen to Simran" }));
      await waitFor(() => expect(sent.find((s) => s.url === "/api/voices/preview")).toBeTruthy());
      expect(sent.find((s) => s.url === "/api/voices/preview")!.body).toMatchObject({ voice_id: "simran", pace: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(sent.find((s) => s.method === "PUT")).toBeTruthy());
      expect(sent.find((s) => s.method === "PUT")!.body).toMatchObject({ agent: { voiceSpeed: 1 } });
    });

    it("a speed can be typed: Listen plays at it, saving sends it, and no level shows as picked", async () => {
      form(AGENT);
      await waitFor(() => expect(names()).toHaveLength(4));
      expect(box().value).toBe("0.9");
      typeSpeed("1.37");
      expect(selected()).toEqual([]);
      expect(box().value).toBe("1.37");
      fireEvent.click(listen());
      await waitFor(() => expect(sent.find((s) => s.url === "/api/voices/preview")).toBeTruthy());
      expect(sent.find((s) => s.url === "/api/voices/preview")!.body).toMatchObject({ voice_id: "simran", pace: 1.37 });
      fireEvent.click(saveButton());
      await waitFor(() => expect(sent.find((s) => s.method === "PUT")).toBeTruthy());
      expect(sent.find((s) => s.method === "PUT")!.body).toMatchObject({ agent: { voiceSpeed: 1.37 } });
    });

    it("the box and the levels follow each other: a typed level shows as picked, and picking a level fills the box", async () => {
      form(AGENT);
      await waitFor(() => expect(names()).toHaveLength(4));
      typeSpeed("1.10");
      expect(selected()).toEqual(["Brisk(1.1)"]);
      expect(box().value).toBe("1.10"); // kept as typed
      fireEvent.click(speed(/^Fast/));
      expect(box().value).toBe("1.2");
      expect(selected()).toEqual(["Fast(1.2)"]);
    });

    it("editing shows a typed speed in the box, with no level picked", async () => {
      form({ ...AGENT, voiceSpeed: 0.85 });
      await waitFor(() => expect(box().value).toBe("0.85"));
      expect(selected()).toEqual([]);
    });

    it("a speed outside the limits, or none, is reported, and saving and Listen wait for a valid one", async () => {
      form(AGENT);
      await waitFor(() => expect(names()).toHaveLength(4));
      expect(screen.queryByText(RULE)).toBeNull();
      for (const bad of ["0.4", "2.1", "0", ""]) {
        typeSpeed(bad);
        expect(screen.getByText(RULE)).toBeTruthy();
        expect(box().getAttribute("aria-invalid")).toBe("true");
        expect(saveButton().disabled).toBe(true);
        expect(listen().disabled).toBe(true);
      }
      for (const limit of ["0.5", "2"]) {
        typeSpeed(limit);
        expect(screen.queryByText(RULE)).toBeNull();
        expect(saveButton().disabled).toBe(false);
        expect(listen().disabled).toBe(false);
      }
      expect(sent.some((s) => s.url === "/api/voices/preview")).toBe(false);
    });

    it("a sample already playing can still be stopped while the speed is being retyped", async () => {
      form(AGENT);
      await waitFor(() => expect(names()).toHaveLength(4));
      fireEvent.click(listen());
      const stop = await screen.findByRole("button", { name: "Stop Simran" });
      typeSpeed("9");
      expect((stop as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(stop);
      expect(listen().disabled).toBe(true);
    });

    it("switching to guided: a bad speed typed before can't block saving, and the saved speed stays", async () => {
      form({ ...AGENT, voiceSpeed: 1.2, guidedFlowId: "flow_g" });
      await waitFor(() => expect(names()).toHaveLength(4));
      typeSpeed("9");
      expect(saveButton().disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: /^Guided/ }));
      expect(saveButton().disabled).toBe(false);
      fireEvent.click(saveButton());
      await waitFor(() => expect(sent.find((s) => s.method === "PUT")).toBeTruthy());
      expect(sent.find((s) => s.method === "PUT")!.body).toMatchObject({ agent: { mode: "guided", voiceSpeed: 1.2 } });
    });
  });

  describe("Call settings: maximum duration", () => {
    const box = () => screen.getByRole("spinbutton", { name: "Maximum duration in seconds" }) as HTMLInputElement;
    const slider = () => screen.getByRole("slider", { name: "Maximum duration" }) as HTMLInputElement;
    const typeMax = (value: string) => fireEvent.change(box(), { target: { value } });
    const saveButton = () => screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    const RULE = "Enter whole seconds from 45 to 180";
    const BLAME = "The target must not exceed the maximum";

    it("opens on the agent's own maximum; typed seconds show in minutes, move the slider and are saved", async () => {
      form(AGENT);
      await waitFor(() => expect(box().value).toBe("105"));
      expect(screen.getByText("Maximum duration (1 min 45 s, hard stop)")).toBeTruthy();
      typeMax("180");
      expect(screen.getByText("Maximum duration (3 min, hard stop)")).toBeTruthy();
      expect(slider().value).toBe("180");
      fireEvent.click(saveButton());
      await waitFor(() => expect(sent.find((s) => s.method === "PUT")).toBeTruthy());
      expect(sent.find((s) => s.method === "PUT")!.body).toMatchObject({ agent: { maxDurationSec: 180 } });
    });

    it("the slider fills the box, and editing restores a typed maximum", async () => {
      form(AGENT);
      await waitFor(() => expect(box().value).toBe("105"));
      fireEvent.change(slider(), { target: { value: "150" } });
      expect(box().value).toBe("150");
      cleanup();
      form({ ...AGENT, maxDurationSec: 147 });
      await waitFor(() => expect(box().value).toBe("147"));
    });

    it("a maximum outside the limits, not whole, or empty is reported in place and can't be saved; the target isn't blamed", async () => {
      form(AGENT);
      await waitFor(() => expect(box().value).toBe("105"));
      expect(screen.queryByText(RULE)).toBeNull();
      for (const bad of ["3", "44", "181", "345", "12.5", ""]) {
        typeMax(bad);
        expect(screen.getByText(RULE)).toBeTruthy();
        expect(box().getAttribute("aria-invalid")).toBe("true");
        expect(saveButton().disabled).toBe(true);
        expect(screen.queryByText(BLAME)).toBeNull();
      }
      for (const limit of ["60", "180"]) {
        typeMax(limit);
        expect(screen.queryByText(RULE)).toBeNull();
        expect(saveButton().disabled).toBe(false);
      }
    });

    it("a valid maximum below the target is reported under the target", async () => {
      form(AGENT); // target 60
      await waitFor(() => expect(box().value).toBe("105"));
      typeMax("50");
      expect(screen.getByText(BLAME)).toBeTruthy();
      expect(saveButton().disabled).toBe(true);
    });

    it("says so when the voice backend stops calls earlier, and only then", async () => {
      serverMax = 120; // a backend set lower than 3 minutes
      form(AGENT);
      await waitFor(() => expect(box().value).toBe("105"));
      await waitFor(() => expect(names()).toHaveLength(4));
      const warned = () => screen.queryByText(/voice backend stops every call at 2 min/);
      expect(warned()).toBeNull();
      typeMax("120");
      expect(warned()).toBeNull();
      typeMax("150");
      expect(warned()!.textContent).toMatch(/Tamil voice backend stops every call at 2 min \(MAX_CALL_DURATION_SECONDS\)/);
      expect(saveButton().disabled).toBe(false); // it can still be saved: raising the server's limit is a separate step
      typeMax("9000");
      expect(warned()).toBeNull(); // the value itself is wrong: one message at a time
    });
  });

  it("guided agents: no AI Voice section (they call with their Call Flow's own voice)", async () => {
    form({ ...AGENT, mode: "guided", guidedFlowId: "flow_g" });
    await waitFor(() => expect(screen.getByText("Call Flow")).toBeTruthy());
    expect(screen.queryByText("AI Voice")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Voice" })).toBeNull();
  });
});

describe("Reply speed", () => {
  const speeds = () => screen.getByRole("radiogroup", { name: "Reply speed" });
  const checked = () => within(speeds()).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent);
  const save = () => fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
  const savedBody = async () => {
    await waitFor(() => expect(sent.some((s) => s.url.startsWith("/api/ai-agents"))).toBe(true));
    return sent.find((s) => s.url.startsWith("/api/ai-agents"))!.body.agent as Record<string, unknown>;
  };

  it("a Tamil agent is offered Use Settings and the presets, right after Voice speed, and starts on Use Settings", async () => {
    form({ ...AGENT, replySpeed: null, voiceSpeed: 0.9 });
    await waitFor(() => screen.getByRole("radiogroup", { name: "Voice speed" }));
    expect(within(speeds()).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Use Settings", "Fast", "Balanced", "Patient", "Current behavior"]);
    expect(checked()).toEqual(["Use Settings"]);
    expect(screen.getByRole("radiogroup", { name: "Voice speed" }).compareDocumentPosition(speeds()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/This agent follows Settings > Voice response tuning\./)).toBeTruthy();
  });

  it("saving an untouched agent sends null, so nothing changes for it", async () => {
    form({ ...AGENT, voiceSpeed: 0.9 }); // saved before this setting: the field is absent
    await waitFor(() => speeds());
    save();
    expect((await savedBody()).replySpeed).toBeNull();
  });

  it("a pick is saved, says what it does, and the saved one is shown again", async () => {
    form({ ...AGENT, replySpeed: "patient", voiceSpeed: 0.9 });
    await waitFor(() => speeds());
    expect(checked()).toEqual(["Patient"]);
    fireEvent.click(within(speeds()).getByRole("radio", { name: "Fast" }));
    expect(checked()).toEqual(["Fast"]);
    expect(screen.getByText(/Replies soonest\./)).toBeTruthy();
    save();
    expect((await savedBody()).replySpeed).toBe("fast");
  });

  it("Use Settings takes a pick back to null", async () => {
    form({ ...AGENT, replySpeed: "fast", voiceSpeed: 0.9 });
    await waitFor(() => speeds());
    fireEvent.click(within(speeds()).getByRole("radio", { name: "Use Settings" }));
    save();
    expect((await savedBody()).replySpeed).toBeNull();
  });

  it("stays on screen, and saves, when the voice backend can't list its voices", async () => {
    const real = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) =>
      url.startsWith("/api/call-flows/builtin") ? json({ message: "The voice backend is not reachable" }, 502) : real(url, init as never),
    ));
    form({ ...AGENT, replySpeed: null, voiceSpeed: 0.9 });
    await waitFor(() => speeds());
    fireEvent.click(within(speeds()).getByRole("radio", { name: "Patient" }));
    save();
    expect((await savedBody()).replySpeed).toBe("patient");
  });

  it("a language without voice response tuning isn't offered it", async () => {
    form({ ...AGENT, language: "en", voiceSpeed: 0.9 }, "en");
    await waitFor(() => screen.getByRole("radiogroup", { name: "Voice speed" }));
    expect(screen.queryByRole("radiogroup", { name: "Reply speed" })).toBeNull();
  });
});
