import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AI_KNOWLEDGE_FROM_CALLS, type AiAgentView, type AiKnowledgeItemView } from "@dispatch/shared";
import { AiAgentKnowledge } from "../src/components/AiAgentKnowledge";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";

// An agent's Knowledge tab with customer questions learned on calls: counts on the Q&A customers asked, suggestions
// as Drafts (an empty answer says the admin must write it), and the most asked first under "Customer questions".
// fetch is stubbed: nothing reaches the API.

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const base = { fileId: null, always: false, issues: [], industryHint: null } as const;
const ITEMS: AiKnowledgeItemView[] = [
  { ...base, id: "f1", kind: "fact", topic: "About", text: "Kagzso is in Chennai.", questions: [], status: "approved", source: "page 1" },
  {
    ...base, id: "a1", kind: "qa", topic: "Services", text: "We automate billing.", questions: ["What services do you offer?"], status: "approved", source: "row 2",
    calls: { asked: 3, unanswered: 1, lastAskedAt: "2026-11-12T10:00:00Z", languages: { ta: 2, en: 1 }, ways: ["Neenga enna service pannreenga?"], draftedFrom: [] },
  },
  {
    ...base, id: "s1", kind: "qa", topic: "Integration", text: "", questions: ["Does it work with Tally?"], status: "draft", source: AI_KNOWLEDGE_FROM_CALLS,
    issues: ["missing answer"],
    calls: { asked: 5, unanswered: 5, lastAskedAt: "2026-11-12T10:00:00Z", languages: { ta: 5 }, ways: [], draftedFrom: [] },
  },
  {
    ...base, id: "s2", kind: "qa", topic: "Languages", text: "It speaks English and Tamil.", questions: ["Which languages?"], status: "draft", source: AI_KNOWLEDGE_FROM_CALLS,
    calls: { asked: 1, unanswered: 0, lastAskedAt: "2026-11-12T10:00:00Z", languages: { en: 1 }, ways: [], draftedFrom: ["Languages"] },
  },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/knowledge") ? json({ files: [], items: ITEMS }) : json({}))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function tab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <AiAgentKnowledge agent={{ id: "ag1" } as AiAgentView} />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("Knowledge tab: customer questions", () => {
  it("shows how often each Q&A was asked, and what a suggestion still needs", async () => {
    tab();
    expect(await screen.findByText(/Customer questions\./)).toBeTruthy();
    expect(screen.getByText(/2 to review/)).toBeTruthy();
    expect(screen.getByText("Asked on 3 calls")).toBeTruthy();
    expect(screen.getByText("Also asked as: Neenga enna service pannreenga?")).toBeTruthy();
    expect(screen.getByText("No approved information answers this yet: write the answer")).toBeTruthy();
    expect(screen.getByText("Drafted from approved knowledge: Languages. Check it before approving.")).toBeTruthy();
    expect(screen.getAllByText(/not answered on/).map((e) => e.textContent)).toEqual([" · not answered on 1", " · not answered on 5"]);
  });

  it("lists only the questions customers asked, the most asked first", async () => {
    tab();
    const select = (await screen.findByDisplayValue(/^All/)) as HTMLSelectElement;
    expect(within(select).getByText("Customer questions (3)")).toBeTruthy();
    fireEvent.change(select, { target: { value: "calls" } });
    const topics = screen.getAllByRole("row").slice(1).map((r) => r.querySelector("td:nth-child(2)")!.firstChild!.textContent);
    expect(topics).toEqual(["Integration", "Services", "Languages"]);
  });
});
