import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AI_CALL_LANGUAGES, aiAgentLanguageSupported, type AiAgentView, type AiCallLanguage } from "@dispatch/shared";
import { AiAgentsPage } from "../src/pages/AiAgents";
import { AiAgentForm } from "../src/components/AiAgentForm";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { AiCallLanguageProvider } from "../src/lib/aiCallLanguage";

// AI Agents page: the new-agent form starts from the defaults (Thaara, Kagzso Technology Services, Male,
// 1 min target, 1 min 45 s maximum) and creates the agent in the section's language. fetch is stubbed:
// nothing reaches the API, a voice backend or a phone.

const posts: { url: string; body: Record<string, unknown> }[] = [];
const RETIRED = ["categoryId", "customCategory", "industryId", "customIndustry", "businessName"];
let flowItems: unknown[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  posts.length = 0;
  flowItems = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      if (url === "/api/ai-calls/config") {
        return json({ enabled: true, configured: true, canStart: true, flowEditor: true, languages: [{ code: "ta", name: "Tamil", configured: true, enabled: true }] });
      }
      if (url.startsWith("/api/ai-agents/library")) throw new Error("the form must not load the industry library");
      if (url.startsWith("/api/call-flows")) return json({ items: flowItems });
      if (init.method === "POST" && url === "/api/ai-agents") {
        const body = JSON.parse(init.body ?? "{}");
        posts.push({ url, body });
        return json({ ...body.agent, id: "ag1", language: body.language, callFlowId: null, liveVersion: null, unpublishedChanges: true, knowledge: { draft: 0, approved: 0, rejected: 0, files: 0 } }, 201);
      }
      if (url.startsWith("/api/ai-agents/ag1/knowledge")) return json({ files: [], items: [] });
      if (url.startsWith("/api/ai-agents/ag1")) return json({ ...posts[0]!.body.agent as object, id: "ag1", language: "en", mode: "autonomous", callFlowId: null, liveVersion: null, unpublishedChanges: true, knowledge: { draft: 0, approved: 0, rejected: 0, files: 0 } });
      if (url.startsWith("/api/ai-agents")) return json([]);
      return json({});
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function page(language: AiCallLanguage = "en") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <AiCallLanguageProvider language={language}>
            <AiAgentsPage />
          </AiCallLanguageProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The input under a label (or a section heading), found by the label's text. */
const field = (label: string) =>
  screen.getAllByText((_, el) => !!el && ["LABEL", "H3"].includes(el.tagName) && (el.textContent ?? "").startsWith(label))[0]!.parentElement!.querySelector(
    "input, select, textarea",
  ) as HTMLInputElement;

/** An agent saved before the Business card went: its old fields are still on the row. */
const oldAgent = (language: AiCallLanguage) => {
  const autonomous = aiAgentLanguageSupported(language);
  return {
    id: "ag9", language, name: "ABC Mills", mode: autonomous ? "autonomous" : "guided", categoryId: "cat_h", customCategory: null, industryId: null,
    customIndustry: "Textile mill", businessName: "ABC Mills", objective: autonomous ? "o" : "", contactName: null, contactGender: "male", contactPhone: null,
    executiveName: "Thaara", companyName: "Kagzso Technology Services", callbackNumber: null, personality: "professional", instructions: "",
    targetDurationSec: 60, maxDurationSec: 105, guidedFlowId: autonomous ? null : "flow1", voiceId: null, callFlowId: null, liveVersion: null, unpublishedChanges: true,
    knowledge: { draft: 0, approved: 0, rejected: 0, files: 0 }, voiceGender: null, voiceDisplayName: null, voiceLanguage: null,
    createdByEmail: null, createdAt: "", updatedAt: "",
  } as unknown as AiAgentView;
};

/** Everything the Business card showed, and everything that opened from it. */
function noBusinessUi() {
  for (const gone of ["Business", "Category", "Industry", "Business / company name"]) expect(screen.queryByText(gone)).toBeNull();
  for (const gone of [/Pick a category/, /Pick an industry/, /AI agent industries/, /discovery topics/i, /Other . Enter manually/, /Enter the business name/]) {
    expect(screen.queryByText(gone)).toBeNull();
  }
  expect(screen.queryByPlaceholderText("e.g. ABC Hospital")).toBeNull();
}

/** Opens an old agent in the form, saves it unchanged, and returns what was sent. */
async function saveOldAgent(language: AiCallLanguage) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const puts: Record<string, unknown>[] = [];
  (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init: { method?: string; body?: string } = {}) => {
    if (init.method === "PUT") puts.push(JSON.parse(init.body ?? "{}").agent);
    return json({ items: flowItems });
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <AiCallLanguageProvider language={language}>
            <AiAgentForm agent={oldAgent(language)} onCreated={() => {}} />
          </AiCallLanguageProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  expect(field("Agent name").value).toBe("ABC Mills");
  if (aiAgentLanguageSupported(language)) expect(field("Calling objective").value).toBe("o");
  noBusinessUi();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(puts).toHaveLength(1));
  return puts[0]!;
}

describe("AI Agents page", () => {
  it("new agent: defaults, then created in the section's language", async () => {
    page("ta");
    fireEvent.click(await screen.findByRole("button", { name: "New AI agent" }));
    expect(field("AI executive name").value).toBe("Thaara");
    expect(field("Calling on behalf of").value).toBe("Kagzso Technology Services");
    expect(field("Gender (for sir / madam)").value).toBe("male");
    expect(screen.getByText("Target duration (1 min)")).toBeTruthy();
    expect(screen.getByText("Maximum duration (1 min 45 s, hard stop)")).toBeTruthy();
    expect(screen.getByText("AI Conversation Instructions")).toBeTruthy();

    const create = screen.getByRole("button", { name: "Create AI agent" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // the name and the objective are required
    fireEvent.change(field("Agent name"), { target: { value: "ABC Hospital - Thaara" } });
    fireEvent.change(field("Calling objective"), { target: { value: "Introduce AI and automation." } });
    fireEvent.change(field("Contact person's name"), { target: { value: "Ragul" } });
    fireEvent.change(field("Gender (for sir / madam)"), { target: { value: "unspecified" } });
    fireEvent.change(field("AI Conversation Instructions"), { target: { value: "Do not discuss pricing." } });
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({
      language: "ta",
      agent: {
        mode: "autonomous",
        name: "ABC Hospital - Thaara",
        objective: "Introduce AI and automation.",
        contactName: "Ragul",
        contactGender: "unspecified",
        executiveName: "Thaara",
        companyName: "Kagzso Technology Services",
        instructions: "Do not discuss pricing.",
        targetDurationSec: 60,
        maxDurationSec: 105,
      },
    });
    const sent = posts[0]!.body.agent as Record<string, unknown>;
    for (const k of RETIRED) expect(sent).not.toHaveProperty(k);
  });

  it("the form has no Business card: no category, industry or business name, and no reference to the library", async () => {
    page("ta");
    fireEvent.click(await screen.findByRole("button", { name: "New AI agent" }));
    for (const gone of ["Business", "Category", "Industry", "Business / company name"]) expect(screen.queryByText(gone)).toBeNull();
    expect(screen.queryByText(/AI agent industries/)).toBeNull();
    expect(screen.queryByText(/Other – Enter manually/)).toBeNull();
    expect(field("Calling objective")).toBeTruthy(); // it lived in that card, and it is still required
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a language without reviewed opening lines offers guided agents only", async () => {
    page("te");
    expect(await screen.findByText(/only guided agents/)).toBeTruthy();
  });
});

// One shared form serves every section, and this keeps it that way: each language is opened, created in and edited.
describe.each(AI_CALL_LANGUAGES)("the %s section", (language) => {
  const autonomous = aiAgentLanguageSupported(language);
  beforeEach(() => {
    flowItems = [{ id: "flow1", name: "Nila", published: { version: 3 } }];
  });

  it("has no Business UI on a new agent, and creating one works", async () => {
    page(language);
    fireEvent.click(await screen.findByRole("button", { name: "New AI agent" }));
    noBusinessUi();
    fireEvent.change(field("Agent name"), { target: { value: "Agent" } });
    if (autonomous) {
      fireEvent.change(field("Calling objective"), { target: { value: "Introduce AI and automation." } });
    } else {
      await screen.findByRole("option", { name: /Nila/ });
      fireEvent.change(field("Published Call Flow"), { target: { value: "flow1" } });
    }
    const create = screen.getByRole("button", { name: "Create AI agent" }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.language).toBe(language);
    const sent = posts[0]!.body.agent as Record<string, unknown>;
    expect(sent.mode).toBe(autonomous ? "autonomous" : "guided");
    for (const k of RETIRED) expect(sent).not.toHaveProperty(k);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("opens and saves an old agent, sending none of its old business fields", async () => {
    const sent = await saveOldAgent(language);
    expect(sent.guidedFlowId ?? null).toBe(autonomous ? null : "flow1");
    for (const k of RETIRED) expect(sent).not.toHaveProperty(k);
    expect(console.error).not.toHaveBeenCalled();
  });
});
