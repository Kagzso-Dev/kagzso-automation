import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiCallLanguage } from "@dispatch/shared";
import { AiAgentsPage } from "../src/pages/AiAgents";
import { AiAgentForm } from "../src/components/AiAgentForm";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { AiCallLanguageProvider } from "../src/lib/aiCallLanguage";

// AI Agents page: the new-agent form starts from the defaults (Thaara, Kagzso Technology Services, Male,
// 1 min target, 1 min 45 s maximum) and creates the agent in the section's language. fetch is stubbed:
// nothing reaches the API, a voice backend or a phone.

const posts: { url: string; body: Record<string, unknown> }[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const LIBRARY = [{ id: "cat_h", name: "Healthcare", archivedAt: null, industries: [{ id: "ind_h", categoryId: "cat_h", name: "Hospital", discoveryTopics: "Billing", archivedAt: null }] }];

beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      if (url === "/api/ai-calls/config") {
        return json({ enabled: true, configured: true, canStart: true, flowEditor: true, languages: [{ code: "ta", name: "Tamil", configured: true, enabled: true }] });
      }
      if (url.startsWith("/api/ai-agents/library")) return json(LIBRARY);
      if (url.startsWith("/api/call-flows")) return json({ items: [] });
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

/** The option texts of the select under a label. */
const options = (label: string) => [...(field(label) as unknown as HTMLSelectElement).options].map((o) => o.textContent);

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
    expect(create.disabled).toBe(true); // name, category, industry, business and objective are required
    fireEvent.change(field("Agent name"), { target: { value: "ABC Hospital - Thaara" } });
    await waitFor(() => expect(options("Category")).toContain("Healthcare"));
    fireEvent.change(field("Category"), { target: { value: "cat_h" } });
    expect(options("Industry")).toEqual(["Pick an industry…", "Hospital", "Other – Enter manually"]);
    fireEvent.change(field("Industry"), { target: { value: "ind_h" } });
    fireEvent.change(field("Business / company name"), { target: { value: "ABC Hospital" } });
    fireEvent.change(field("Calling objective"), { target: { value: "Introduce AI and automation for hospitals." } });
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
        categoryId: "cat_h",
        customCategory: null,
        industryId: "ind_h",
        customIndustry: null,
        businessName: "ABC Hospital",
        contactName: "Ragul",
        contactGender: "unspecified",
        executiveName: "Thaara",
        companyName: "Kagzso Technology Services",
        instructions: "Do not discuss pricing.",
        targetDurationSec: 60,
        maxDurationSec: 105,
      },
    });
  });

  it("Other – Enter manually: typed category and industry; a typed name already in the list is offered as that entry", async () => {
    page("en");
    fireEvent.click(await screen.findByRole("button", { name: "New AI agent" }));
    await waitFor(() => expect(options("Category")).toEqual(["Pick a category…", "Healthcare", "Other – Enter manually"]));
    expect(screen.queryByText("Category name")).toBeNull();

    // A typed category: the industry is typed too (library industries belong to library categories).
    fireEvent.change(field("Category"), { target: { value: "__other__" } });
    expect(field("Industry").disabled).toBe(true);
    expect(options("Industry")).toEqual(["Other – Enter manually"]);
    fireEvent.change(field("Category name"), { target: { value: "  healthcare " } });
    expect(screen.getByText(/“Healthcare” is already in the list, so it will be saved as that category/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select it" }));
    expect(field("Category").value).toBe("cat_h");
    expect(screen.queryByText("Category name")).toBeNull();
    expect(field("Industry").value).toBe("__other__"); // still typed, now under Healthcare

    fireEvent.change(field("Industry name"), { target: { value: "Dental   clinic" } });
    fireEvent.change(field("Agent name"), { target: { value: "Smile Dental" } });
    fireEvent.change(field("Business / company name"), { target: { value: "Smile Dental" } });
    fireEvent.change(field("Calling objective"), { target: { value: "Introduce AI for clinics." } });
    const create = screen.getByRole("button", { name: "Create AI agent" }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.agent).toMatchObject({ categoryId: "cat_h", customCategory: null, industryId: null, customIndustry: "Dental   clinic" });
  });

  it("Other chosen but nothing typed: the agent can't be created and says what is missing", async () => {
    page("en");
    fireEvent.click(await screen.findByRole("button", { name: "New AI agent" }));
    await waitFor(() => expect(options("Category")).toContain("Healthcare"));
    fireEvent.change(field("Category"), { target: { value: "__other__" } });
    fireEvent.change(field("Category name"), { target: { value: "   " } });
    expect(screen.getByText("Enter the category")).toBeTruthy();
    expect(screen.getByText("Enter the industry")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create AI agent" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("editing restores typed names as “Other – Enter manually” with the name filled in", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const agent = {
      id: "ag9", language: "en", name: "ABC Mills", mode: "autonomous", categoryId: null, customCategory: "Manufacturing", industryId: null,
      customIndustry: "Textile mill", businessName: "ABC Mills", objective: "o", contactName: null, contactGender: "male", contactPhone: null,
      executiveName: "Thaara", companyName: "Kagzso Technology Services", callbackNumber: null, personality: "professional", instructions: "",
      targetDurationSec: 60, maxDurationSec: 105, guidedFlowId: null, voiceId: null, callFlowId: null, liveVersion: null, unpublishedChanges: true,
      knowledge: { draft: 0, approved: 0, rejected: 0, files: 0 }, voiceGender: null, voiceDisplayName: null, voiceLanguage: null,
      createdByEmail: null, createdAt: "", updatedAt: "",
    } as const;
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <ConfirmProvider>
            <AiCallLanguageProvider language="en">
              <AiAgentForm agent={agent} onCreated={() => {}} />
            </AiCallLanguageProvider>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(options("Category")).toContain("Healthcare"));
    expect(field("Category").value).toBe("__other__");
    expect(field("Category name").value).toBe("Manufacturing");
    expect(field("Industry").value).toBe("__other__");
    expect(field("Industry name").value).toBe("Textile mill");
  });

  it("a language without reviewed opening lines offers guided agents only", async () => {
    page("te");
    expect(await screen.findByText(/only guided agents/)).toBeTruthy();
  });
});
