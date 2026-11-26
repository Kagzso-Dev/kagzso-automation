// Copyright (c) 2026 Kagzso Technology Services. All rights reserved.
// Proprietary and confidential. See LICENSE.md in the repository root.
// SPDX-License-Identifier: LicenseRef-Kagzso-Proprietary
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AI_AGENT_DEFAULT_INSTRUCTIONS,
  AI_AGENT_INSTRUCTIONS_MAX,
  instructionPlaceholders,
  voiceTuningPreset,
  type AiAgentView,
  type AiCallLanguage,
} from "@dispatch/shared";
import { AiAgentForm } from "../src/components/AiAgentForm";
import { sampleLanguage } from "../src/components/VoicePicker";
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
let catalogVoices: ReturnType<typeof TA>[] = VOICES; // the list the Tamil backend serves in a test
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  sent.length = 0;
  serverMax = undefined;
  catalogVoices = VOICES;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      if (init.body) sent.push({ url, method: init.method ?? "GET", body: JSON.parse(init.body) });
      if (url.startsWith("/api/call-flows/builtin")) return json({ flows: {}, locked_blocks: {}, variables: [], limits: serverMax ? { max_duration_sec: serverMax } : {}, voices: catalogVoices, default_voice: "ishita", language: "ta" });
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

  describe("cloned voices (the backend's SARVAM_TTS_VOICE_TA_*, labelled Custom)", () => {
    const clone = (id: string, name: string, gender: string) => ({ ...TA(id, name, gender), cloned: true });
    const F = "svc-00000000-0000-4000-8000-0000000000a1";
    const M1 = "svc-00000000-0000-4000-8000-0000000000b1";
    const M2 = "svc-00000000-0000-4000-8000-0000000000b2";
    // As production's Tamil backend lists its stock voices: 4 female and 6 male.
    const STOCK = [
      ...["Roopa", "Ishita", "Ritu", "Simran"].map((n) => TA(n.toLowerCase(), n, "female")),
      ...["Shubh", "Ratan", "Rohan", "Aditya", "Rahul", "Anand"].map((n) => TA(n.toLowerCase(), n, "male")),
    ];
    const CLONES = [clone(F, "Kgazso Tamil", "female"), clone(M1, "Kgazso Male 1", "male"), clone(M2, "Kgazso Male 2", "male")];

    it("they join the gender tabs (Female 5, Male 8) with a Custom label; a new agent starts on the female one", async () => {
      catalogVoices = [...CLONES, ...STOCK];
      form();
      await waitFor(() => expect(checked()).toEqual(["Kgazso TamilCustomLanguage ?Tamil (India) · female · default"]));
      expect(genderButton("Female").textContent).toBe("Female(5)");
      expect(genderButton("Male").textContent).toBe("Male(8)");
      expect(names()).toEqual([
        "Kgazso TamilCustomLanguage ?Tamil (India) · female · default",
        "RoopaTamil (India) · female",
        "IshitaTamil (India) · female",
        "RituTamil (India) · female",
        "SimranTamil (India) · female",
      ]); // only the cloned voice is labelled Custom
      fireEvent.click(genderButton("Male"));
      expect(names().slice(0, 3)).toEqual([
        "Kgazso Male 1CustomLanguage ?Tamil (India) · male",
        "Kgazso Male 2CustomLanguage ?Tamil (India) · male",
        "ShubhTamil (India) · male",
      ]);
      expect(names()).toHaveLength(8);
    });

    it("Listen plays the cloned voice with the page's line and speed; picking it saves its id on the agent", async () => {
      catalogVoices = [...CLONES, ...STOCK];
      form();
      await waitFor(() => expect(names()).toHaveLength(5));
      fireEvent.click(genderButton("Male"));
      fireEvent.click(screen.getByRole("button", { name: "Listen to Kgazso Male 2" }));
      await waitFor(() => expect(sent.find((s) => s.url === "/api/voices/preview")).toBeTruthy());
      expect(sent.find((s) => s.url === "/api/voices/preview")!.body).toMatchObject({ voice_id: M2, language: "ta", pace: 0.9 });
      fireEvent.click(within(voiceList()).getAllByRole("radio")[1]!); // Kgazso Male 2
      fill("Agent name (for your list)", "ABC Hospital — Arun");
      fill("Calling objective", "Introduce AI for hospitals.");
      fireEvent.click(screen.getByRole("button", { name: "Create AI agent" }));
      await waitFor(() => expect(sent.find((s) => s.url === "/api/ai-agents")).toBeTruthy());
      expect(sent.find((s) => s.url === "/api/ai-agents")!.body).toMatchObject({ language: "ta", agent: { voiceId: M2 } });
    });

    it("a male voice with the female default name (Thaara): a clear prompt at the voice and the name, and “Use Arun” fixes it", async () => {
      catalogVoices = [...CLONES, ...STOCK];
      form();
      await waitFor(() => expect(names()).toHaveLength(5));
      expect(screen.queryByRole("alert")).toBeNull(); // female voice, female name: nothing to say
      fireEvent.click(genderButton("Male")); // Kgazso Male 1
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Kgazso Male 1 is a male voice, but the AI introduces itself as Thaara, a female name.");
      expect(alert.textContent).toContain("Change “AI executive name” to a male name before you publish.");
      expect(screen.getByText("The AI Voice below is male: give it a male name, e.g. Arun.")).toBeTruthy(); // at the name field too
      fireEvent.click(within(alert).getByRole("button", { name: "Use “Arun”" }));
      const name = screen.getByText("AI executive name").parentElement!.querySelector("input")!;
      expect(name.value).toBe("Arun");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText(/give it a male name/)).toBeNull();
      expect(screen.getByText(/A male voice still introduces itself as/).textContent).toContain("Arun"); // the general reminder stays
      fill("Agent name (for your list)", "ABC Hospital — Arun");
      fill("Calling objective", "Introduce AI for hospitals.");
      fireEvent.click(screen.getByRole("button", { name: "Create AI agent" }));
      await waitFor(() => expect(sent.find((s) => s.url === "/api/ai-agents")).toBeTruthy());
      expect(sent.find((s) => s.url === "/api/ai-agents")!.body).toMatchObject({ agent: { executiveName: "Arun", voiceId: M1 } });
    });

    it("Sara, Nila and Tamil-letter தாரா are known female names too; any other name only gets the general reminder", async () => {
      catalogVoices = [...CLONES, ...STOCK];
      form();
      await waitFor(() => expect(names()).toHaveLength(5));
      fireEvent.click(genderButton("Male"));
      for (const female of ["Sara", " nila ", "தாரா"]) {
        fill("AI executive name", female);
        expect([female, screen.getByRole("alert").textContent]).toEqual([female, expect.stringContaining(`introduces itself as ${female.trim()}, a female name`)]);
      }
      fill("AI executive name", "Ravi"); // a name the form can't know the gender of: never guessed
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText(/A male voice still introduces itself as/).textContent).toContain("Ravi");
      fireEvent.click(genderButton("Female"));
      fill("AI executive name", "Sara");
      expect(screen.queryByRole("alert")).toBeNull(); // female voice: no warning
      expect(screen.queryByText(/A male voice still introduces itself as/)).toBeNull();
    });

    // Sarvam's record of the sample each clone was made from: "Kgazso Male 1" is an English (en-IN) one.
    const withLanguage = (v: ReturnType<typeof clone>, source_language: string) => ({ ...v, source_language });

    it("a clone made from an English sample is tagged, listed last, warned about and never a gender's first voice", async () => {
      catalogVoices = [withLanguage(CLONES[0]!, "ta-IN"), withLanguage(CLONES[1]!, "en-IN"), withLanguage(CLONES[2]!, "ta-IN"), ...STOCK];
      form();
      await waitFor(() => expect(checked()).toEqual(["Kgazso TamilCustomTamilTamil (India) · female · default"]));
      fireEvent.click(genderButton("Male"));
      expect(checked()).toEqual(["Kgazso Male 2CustomTamilTamil (India) · male"]); // never the English clone
      expect(names().at(-1)).toBe("Kgazso Male 1CustomEnglishTamil (India) · male");
      expect(screen.queryByText(/cloned from a sample in another language/)).toBeNull();
      fireEvent.click(within(voiceList()).getAllByRole("radio").at(-1)!); // picked anyway: said plainly
      const warning = screen.getByText(/cloned from a sample in another language/);
      expect(warning.textContent).toContain("Kgazso Male 1 was cloned from a sample in another language (en-IN)");
      expect(warning.textContent).toContain("Pick a voice made in Tamil, or a stock voice.");
    });

    it("an English female clone on a Tamil backend is never a new agent's voice", async () => {
      catalogVoices = [withLanguage(CLONES[0]!, "en-IN"), ...CLONES.slice(1), ...STOCK];
      form();
      await waitFor(() => expect(checked()).toEqual(["RoopaTamil (India) · female · default"]));
    });

    it("every clone gets a language tag; an unknown one says so", () => {
      expect([sampleLanguage("ta-IN"), sampleLanguage("en-IN"), sampleLanguage("hi"), sampleLanguage(undefined)]).toEqual([
        "Tamil", "English", "Hindi", "Language ?",
      ]);
    });
  });

  describe("AI Conversation Instructions (Tamil)", () => {
    const DISCOVERY = [
      "புரிஞ்சுக்கறது (முதல்ல இதுதான்)",
      "- Pitch பண்றதுக்கு முன்னாடி customer-ஓட business, அவங்க பிரச்சனை, இப்போ எப்படி வேலை நடக்குதுன்னு கேட்டுப் புரிஞ்சுக்கோங்க.",
      "- ஒவ்வொரு பதிலுக்கும் பிறகு, அவங்க சொன்னதை ஒரு சின்ன வாக்கியத்துல உங்க வார்த்தையில சொல்லி புரிஞ்சுக்கிட்டதைக் காட்டுங்க. அப்புறம் அந்த பதில்ல இருந்தே அடுத்த கேள்வி கேளுங்க.",
      "- Customer ஒரு பிரச்சனை சொன்னா, வேற topic-க்கு போகாம அதையே ஆழமா கேளுங்க: எவ்வளவு பெருசு, எப்போ இருந்து, இப்போ என்ன பண்றாங்க.",
      "- பிரச்சனை தெளிவா புரிஞ்ச பிறகு மட்டும், அதுக்கு பொருந்துற Kagzso help-ஐ Knowledge-ல இருக்கறபடி சொல்லுங்க. அதுக்கு முன்னாடி எந்த product-ம் சொல்லாதீங்க.",
      "- Customer-க்கு பிரச்சனை இல்லன்னா, ஏத்துக்கிட்டு மரியாதையா முடிங்க.",
    ];
    const box = () => screen.getByPlaceholderText(/Additional business information/) as HTMLTextAreaElement;

    it("a new Tamil agent starts with the recommended text: under 4000 characters, no placeholders, no team promises", async () => {
      form();
      await waitFor(() => expect(names()).toHaveLength(4));
      const text = box().value;
      expect(text).toBe(AI_AGENT_DEFAULT_INSTRUCTIONS.ta);
      expect(text.length).toBeLessThanOrEqual(AI_AGENT_INSTRUCTIONS_MAX);
      expect(instructionPlaceholders(text)).toEqual([]);
      expect(text).not.toMatch(/[{}"“”]/); // no placeholders, no quoted lines
      expect(text).not.toMatch(/good morning|கிட்டதான் பேசுறேனா/i); // the opening is the system's greeting
      // No team follow-up is linked to agent calls: nothing says the team will call, explain or confirm anything.
      expect(text).not.toMatch(/பண்ணுவாங்க|சொல்லுவாங்க|pass பண்றேன்|team தான் confirm|kagzso\.com/);
      expect(text).toContain("Callback, meeting, demo, team contact பத்தி எந்த வாக்குறுதியும் சொல்லாதீங்க.");
      // Discovery first: the block as given, before anything about Kagzso.
      for (const line of DISCOVERY) expect([line, text.includes(line)]).toEqual([line, true]);
      expect(text.indexOf("புரிஞ்சுக்கறது (முதல்ல இதுதான்)")).toBeLessThan(text.indexOf("Kagzso பத்தி சொல்றப்போ"));
      expect(text).not.toMatch(/Kagzso எப்படி help பண்ணலாம்னு/); // the old goal that invited an early pitch
      expect(screen.queryByRole("button", { name: /Use the recommended/ })).toBeNull(); // it is already in the box
    });

    it("agrees with the built-in agent rules (the six conflicts of 2026-11-26 are gone)", () => {
      const text = AI_AGENT_DEFAULT_INSTRUCTIONS.ta!;
      // 1. Reply length = the phone rule "Maximum two short sentences per reply unless the customer asks for more detail."
      expect(text).not.toMatch(/1-3 சின்ன வாக்கியம்/);
      expect(text).toContain("ஒரு பதில்ல அதிகபட்சம் ரெண்டு சின்ன வாக்கியம்; customer விவரமா கேட்டா மட்டும் கொஞ்சம் அதிகம்.");
      // 2. Busy / wrong person = "Do not ask when to call back and never promise a callback." / "thank the person politely and end the call"
      expect(text).not.toMatch(/எப்போ பேசலாம்னு கேளுங்க|எப்போ பேசலாம்னு கேட்டு/);
      expect(text).toContain("திரும்ப call பண்ற நேரம் கேக்காதீங்க, callback வாக்குறுதியும் வேண்டாம்.");
      expect(text).toContain("customer இருக்காங்களான்னு மரியாதையா கேளுங்க. இல்லன்னா நன்றி சொல்லி முடிங்க.");
      // 3. "Are you an AI" = "[never] add a question of your own ... after they ask who or what you are" / "continue only if they want to"
      expect(text).not.toContain("அப்புறம் அவங்க business பத்தி கேளுங்க");
      expect(text).not.toContain("அப்புறம் உங்க கேள்வி."); // "answer first, then your question" put a question after it too
      expect(text).toContain("உண்மையா சொல்லி நிறுத்துங்க. அதுக்கு அப்புறம் உங்க கேள்வி வேண்டாம்; அவங்க தொடர விரும்பினா மட்டும் தொடருங்க.");
      // 4. Interested = "Interest is a reason to keep listening, not to end the call"
      expect(text).not.toContain("அவ்வளவுதான்");
      expect(text).toContain("அவங்களுக்கு கேள்வி இருந்தா தொடர்ந்து பதில் சொல்லுங்க");
      // 5. Do-not-call = the built-in line only ("No further questions, no explanation, no recovery attempt.")
      expect(text).not.toContain("மன்னிப்பு கேட்டு call-ஐ முடிங்க");
      expect(text).toContain("DO NOT CALL பகுதியில இருக்கற வரியை மட்டும் சொல்லி உடனே call-ஐ முடிங்க.");
      // 6. How the number was found = "Never invent missing information."
      expect(text).not.toMatch(/contact list/i);
      expect(text).toContain("Number எப்படி கிடைச்சுதுன்னு உங்களுக்கு தெரியாது: அதை guess பண்ணாதீங்க, காரணம் சொல்லாதீங்க.");
      // Kept: spoken Tamil with English business words, verb last, one question, safety.
      expect(text).toContain("software, billing, GST, WhatsApp, automation மாதிரி வார்த்தைகள் English-லயே இருக்கட்டும்.");
      expect(text).toContain("வினைச்சொல் வாக்கியத்தோட கடைசியில வரணும்.");
      expect(text).toContain("ஒரு நேரத்துல ஒரு கேள்வி மட்டும்");
      expect(text).toContain("Kagzso சார்பா பேசுற AI assistant-னு உண்மையா");
    });

    it("மொழி: the reply follows the customer's language, the same rules in every language; duplicated lines are gone", () => {
      const text = AI_AGENT_DEFAULT_INSTRUCTIONS.ta!;
      const MOZHI = [
        "மொழி",
        "- Customer பேசுற மொழியிலயே பதில் சொல்லுங்க: தமிழ்ல பேசினா பேச்சுத் தமிழ், தமிழும் English-ம் கலந்து பேசினா அதே மாதிரி கலந்து, முழுசா English-ல பேசினா எளிமையான spoken English.",
        "- Customer மொழி மாத்தினா மட்டும் நீங்களும் மாத்துங்க. ஒரு பதில்ல ஒரே மொழி.",
        "- எந்த மொழியிலயும் அதே விதிகள்: அதிகபட்சம் ரெண்டு சின்ன வாக்கியம், ஒரு கேள்வி, முதல்ல புரிஞ்சுக்கறது.",
      ];
      expect(text).toContain(MOZHI.join("\n"));
      expect(text.indexOf("மொழி\n")).toBeLessThan(text.indexOf("புரிஞ்சுக்கறது (முதல்ல இதுதான்)"));
      expect(text.length).toBeLessThan(4000);
      // Nothing left that forces Tamil-only sentences.
      expect(text).not.toContain("வாக்கியம் Tamil-ஆ இருக்கணும்");
      // The three lines the built-in rules already give.
      expect(text).not.toMatch(/emoji|எண்களை வார்த்தையால/);
      expect(text).not.toContain("ஏற்கனவே பதில் சொன்ன கேள்வியை திரும்பக் கேக்காதீங்க");
      expect(text).not.toContain("Introduction, pitch திரும்ப சொல்லாதீங்க");
    });

    it("only Tamil has recommended instructions: English, Hindi and Kannada start exactly as before (an empty box)", () => {
      expect(Object.keys(AI_AGENT_DEFAULT_INSTRUCTIONS)).toEqual(["ta"]);
      for (const language of ["en", "hi", "kn"] as const) expect(AI_AGENT_DEFAULT_INSTRUCTIONS[language]).toBeUndefined();
    });

    it("an English agent starts with an empty box, as before", async () => {
      form(null, "en");
      await waitFor(() => expect(box()).toBeTruthy());
      expect(box().value).toBe("");
    });

    it("a placeholder is explained and saving waits until it is removed", async () => {
      form();
      await waitFor(() => expect(names()).toHaveLength(4));
      fill("Agent name (for your list)", "ABC Hospital — Thaara");
      fill("Calling objective", "Introduce AI for hospitals.");
      fireEvent.change(box(), { target: { value: "நீங்க {agent_name}. {contact_name} கிட்ட பேசுறீங்க." } });
      const alert = screen.getByText(/this box fills in nothing/);
      expect(alert.textContent).toContain("Remove {agent_name}, {contact_name}");
      expect((screen.getByRole("button", { name: "Create AI agent" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(box(), { target: { value: "நீங்க பணிவா பேசுங்க." } });
      expect(screen.queryByText(/this box fills in nothing/)).toBeNull();
      expect((screen.getByRole("button", { name: "Create AI agent" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("an existing agent keeps its own text; the recommended one replaces it only after a confirmation", async () => {
      form({ ...AGENT, instructions: "Do not discuss pricing." });
      await waitFor(() => expect(box().value).toBe("Do not discuss pricing."));
      fireEvent.click(screen.getByRole("button", { name: "Use the recommended Tamil instructions" }));
      fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
      await waitFor(() => expect(box().value).toBe(AI_AGENT_DEFAULT_INSTRUCTIONS.ta));
    });
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
  const pick = (name: string) => fireEvent.click(within(speeds()).getByRole("radio", { name }));
  const saveButton = () => screen.getByRole("button", { name: /save settings/i }) as HTMLButtonElement;
  const save = () => fireEvent.click(saveButton());
  const savedBody = async () => {
    await waitFor(() => expect(sent.some((s) => s.url.startsWith("/api/ai-agents"))).toBe(true));
    return sent.find((s) => s.url.startsWith("/api/ai-agents"))!.body.agent as Record<string, unknown>;
  };
  const LABELS = {
    finishedSilenceMs: "Wait after a finished sentence (ms)",
    endOfSpeechSilenceMs: "End-of-speech wait (ms)",
    extraWaitIfIncompleteMs: "Extra wait for unfinished sentences (ms)",
    hardCapMs: "Hard cap on waiting (ms, 0 = no cap)",
  } as const;
  const box = (k: keyof typeof LABELS) => screen.getByLabelText(LABELS[k]) as HTMLInputElement;
  const boxes = () => Object.fromEntries(Object.keys(LABELS).map((k) => [k, box(k as keyof typeof LABELS).value]));
  const type = (k: keyof typeof LABELS, value: string) => fireEvent.change(box(k), { target: { value } });
  const loaded = async (agent: Partial<AiAgentView>) => {
    form({ ...AGENT, voiceSpeed: 0.9, ...agent } as AiAgentView);
    await waitFor(() => screen.getByRole("radiogroup", { name: "Voice speed" }));
  };

  it("a Tamil agent is offered Use Settings, the presets and Manual, right after Voice speed, and starts on Use Settings", async () => {
    await loaded({ replySpeed: null });
    expect(within(speeds()).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Use Settings", "Fast", "Balanced", "Patient", "Current behavior", "Manual"]);
    expect(checked()).toEqual(["Use Settings"]);
    expect(screen.getByRole("radiogroup", { name: "Voice speed" }).compareDocumentPosition(speeds()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/This agent follows Settings > Voice response tuning\./)).toBeTruthy();
    expect(screen.queryByLabelText(LABELS.endOfSpeechSilenceMs)).toBeNull(); // the waits show only for Manual
  });

  it("saving an untouched agent sends null, so nothing changes for it", async () => {
    await loaded({}); // saved before this setting: the field is absent
    save();
    expect((await savedBody()).replySpeed).toBeNull();
  });

  it("a preset is saved with its numbers, says what it does, and the saved one is shown again", async () => {
    await loaded({ replySpeed: voiceTuningPreset("patient") });
    expect(checked()).toEqual(["Patient"]);
    pick("Fast");
    expect(checked()).toEqual(["Fast"]);
    expect(screen.getByText(/Replies soonest\./)).toBeTruthy();
    save();
    expect((await savedBody()).replySpeed).toEqual(voiceTuningPreset("fast"));
  });

  it("Use Settings takes a pick back to null", async () => {
    await loaded({ replySpeed: voiceTuningPreset("fast") });
    pick("Use Settings");
    save();
    expect((await savedBody()).replySpeed).toBeNull();
  });

  it("Manual opens the waits, starting from the speed picked before, and saves what is typed", async () => {
    await loaded({ replySpeed: voiceTuningPreset("patient") });
    pick("Manual");
    expect(checked()).toEqual(["Manual"]);
    expect(boxes()).toEqual({ finishedSilenceMs: "600", endOfSpeechSilenceMs: "1100", extraWaitIfIncompleteMs: "800", hardCapMs: "2000" });
    expect(screen.getByText(/Your own waits below/)).toBeTruthy();
    type("finishedSilenceMs", "500");
    type("endOfSpeechSilenceMs", "1000");
    type("hardCapMs", "0");
    save();
    expect((await savedBody()).replySpeed).toEqual({ ...voiceTuningPreset("patient"), preset: "custom", finishedSilenceMs: 500, endOfSpeechSilenceMs: 1000, hardCapMs: 0 });
  });

  it("from Use Settings, Manual starts from Balanced, the default", async () => {
    await loaded({ replySpeed: null });
    pick("Manual");
    expect(boxes()).toEqual({ finishedSilenceMs: "450", endOfSpeechSilenceMs: "900", extraWaitIfIncompleteMs: "500", hardCapMs: "1600" });
  });

  it("a saved Manual speed is shown again with its own numbers", async () => {
    await loaded({ replySpeed: { ...voiceTuningPreset("fast"), preset: "custom", endOfSpeechSilenceMs: 820 } });
    expect(checked()).toEqual(["Manual"]);
    expect(box("endOfSpeechSilenceMs").value).toBe("820");
  });

  it("a wait out of range, an empty box or a cap below the end-of-speech wait is shown in place and blocks saving", async () => {
    await loaded({ replySpeed: null });
    pick("Manual");
    expect(screen.getAllByText("300 to 2000", { selector: "p" })).toHaveLength(2); // finished-sentence and end-of-speech waits
    expect(screen.getByText("0 to 5000", { selector: "p" })).toBeTruthy(); // hard cap
    type("endOfSpeechSilenceMs", "100");
    expect(screen.getAllByText("Enter whole numbers from 300 to 2000").length).toBeGreaterThan(0);
    expect(saveButton().disabled).toBe(true);
    type("endOfSpeechSilenceMs", "");
    expect(saveButton().disabled).toBe(true);
    type("endOfSpeechSilenceMs", "1000");
    type("hardCapMs", "900");
    expect(screen.getByText("The hard cap can't be shorter than the end-of-speech wait")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    type("hardCapMs", "1500");
    expect(saveButton().disabled).toBe(false);
  });

  it("picking a preset after Manual hides the waits and saves the preset's own numbers", async () => {
    await loaded({ replySpeed: { ...voiceTuningPreset("balanced"), preset: "custom", endOfSpeechSilenceMs: 1000 } });
    pick("Fast");
    expect(screen.queryByLabelText(LABELS.endOfSpeechSilenceMs)).toBeNull();
    save();
    expect((await savedBody()).replySpeed).toEqual(voiceTuningPreset("fast"));
  });

  it("Voice speed is unchanged beside it: its own levels, typed box and value", async () => {
    await loaded({ replySpeed: null, voiceSpeed: 1.1 });
    const voice = screen.getByRole("radiogroup", { name: "Voice speed" });
    expect(within(voice).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Slow(0.8)", "Relaxed(0.9)", "Normal(1.0)", "Brisk(1.1)", "Fast(1.2)"]);
    pick("Manual");
    type("endOfSpeechSilenceMs", "1000");
    save();
    expect((await savedBody()).voiceSpeed).toBe(1.1);
  });

  it("stays on screen, and saves, when the voice backend can't list its voices", async () => {
    const real = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) =>
      url.startsWith("/api/call-flows/builtin") ? json({ message: "The voice backend is not reachable" }, 502) : real(url, init as never),
    ));
    form({ ...AGENT, replySpeed: null, voiceSpeed: 0.9 } as AiAgentView);
    await waitFor(() => speeds());
    pick("Patient");
    save();
    expect((await savedBody()).replySpeed).toEqual(voiceTuningPreset("patient"));
  });

  it("a language without voice response tuning isn't offered it", async () => {
    form({ ...AGENT, language: "en", voiceSpeed: 0.9 } as AiAgentView, "en");
    await waitFor(() => screen.getByRole("radiogroup", { name: "Voice speed" }));
    expect(screen.queryByRole("radiogroup", { name: "Reply speed" })).toBeNull();
  });
});
