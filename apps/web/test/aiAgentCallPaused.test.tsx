import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AI_AGENT_DEFAULTS, type AiAgentView } from "@dispatch/shared";
import { AiAgentCall } from "../src/components/AiAgentCall";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";

// The agent's Call tab: Kannada Autonomous AI calls are paused (until native-speaker review) - the tab says so and
// offers no call button; every other language, and Kannada Guided agents, keep the call form.

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string) => {
    if (path.startsWith("/api/ai-calls/config")) return { enabled: true, configured: true, canStart: true, flowEditor: true, languages: [] };
    throw new Error(`unexpected API call in test: ${path}`);
  }),
}));

afterEach(cleanup);

const agent = (language: AiAgentView["language"], mode: AiAgentView["mode"]): AiAgentView =>
  ({
    ...AI_AGENT_DEFAULTS,
    id: `a_${language}_${mode}`,
    language,
    mode,
    name: "ABC Hospital - Thaara",
    contactName: "Ragul",
    contactPhone: "+919876543210",
    callFlowId: "f1",
    liveVersion: 1,
    unpublishedChanges: false,
    knowledge: { draft: 0, approved: 0, rejected: 0, files: 0 },
    createdByEmail: null,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  }) as unknown as AiAgentView;

function renderCall(a: AiAgentView) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <ConfirmProvider>
            <AiAgentCall agent={a} />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("AI agent Call tab", () => {
  it("a Kannada autonomous agent: calls are paused, with the reason, and no call button", () => {
    renderCall(agent("kn", "autonomous"));
    expect(screen.getByText("Calls are paused")).toBeTruthy();
    expect(screen.getByText(/Kannada Autonomous AI calls are paused until a native speaker has reviewed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /call/i })).toBeNull();
  });

  it.each([
    ["en", "autonomous"],
    ["ta", "autonomous"],
    ["hi", "autonomous"],
    ["kn", "guided"],
  ] as const)("%s %s agent: the call form, no pause notice", (language, mode) => {
    renderCall(agent(language, mode));
    expect(screen.queryByText("Calls are paused")).toBeNull();
    expect(screen.getByRole("button", { name: /call/i })).toBeTruthy();
  });
});
