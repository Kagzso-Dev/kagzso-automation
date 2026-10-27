import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiCallLanguage } from "@dispatch/shared";
import { RunningCallsNote } from "../src/components/RunningCallsNote";
import { AiCallLanguageProvider } from "../src/lib/aiCallLanguage";

// Every language's call pages say which language is calling right now (one language calls at a time).
// Canned API, no network.

let running: { runId: string; language: AiCallLanguage } | null = null;
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string) => {
    if (path === "/api/ai-calls/running") return { running };
    throw new Error(`unexpected API call: ${path}`);
  }),
}));

afterEach(() => {
  cleanup();
  running = null;
});

function renderOn(language: AiCallLanguage) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiCallLanguageProvider language={language}>
        <RunningCallsNote />
      </AiCallLanguageProvider>
    </QueryClientProvider>,
  );
}

describe("running calls note", () => {
  it("on another language's page: which language is calling, and that this one waits", async () => {
    running = { runId: "r1", language: "ta" };
    renderOn("en");
    const note = await screen.findByRole("status");
    expect(note.textContent).toBe(
      "Calling now: Tamil. One language calls at a time — English calls and test calls can start once that run finishes.",
    );
  });

  it("on the calling language's own page: the others wait for it", async () => {
    running = { runId: "r1", language: "hi" };
    renderOn("hi");
    expect((await screen.findByRole("status")).textContent).toBe("Calling now: Hindi. Other languages can start calls once this run finishes.");
  });

  it("nothing while no run is dialling", async () => {
    const { container } = renderOn("kn");
    await waitFor(() => expect(container.innerHTML).toBe(""));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
