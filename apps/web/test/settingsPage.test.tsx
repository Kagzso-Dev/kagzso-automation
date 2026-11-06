import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../src/components/confirm";
import { api } from "../src/lib/api";
import { SettingsPage } from "../src/pages/Settings";

// Settings has no "AI agent industries" section any more, even for an admin with call flows on, which is the only
// state that ever showed it. lib/api is mocked: nothing reaches the API.

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role: "ADMIN", email: "a@example.com" }, loading: false, logout: () => undefined }),
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string) => {
    if (path === "/api/ai-calls/config") return { enabled: true, configured: true, canStart: true, flowEditor: true, languages: [] };
    return { items: [], hiddenItems: [], labels: {}, customized: [], bulkSend: { minDelaySec: 1, maxDelaySec: 2 } };
  }),
}));
// These sections have data of their own, and none of it has anything to do with this.
vi.mock("../src/components/CostRatesSection", () => ({ CostRatesSection: () => null }));
vi.mock("../src/components/UserAdminSections", () => ({ ChangePasswordSection: () => null, UsersSection: () => null }));
vi.mock("../src/components/BrandingSection", () => ({ BrandingSection: () => null }));
vi.mock("../src/components/CallRecordingsSection", () => ({ CallRecordingsSection: () => null }));
vi.mock("../src/components/AiCallLanguagesSection", () => ({ AiCallLanguagesSection: () => <h2>Languages stand-in</h2> }));

afterEach(cleanup);

describe("Settings", () => {
  it("has no AI agent industries section and never asks for the library", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConfirmProvider>
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </ConfirmProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Languages stand-in"); // the sections around where it was have rendered
    await new Promise((r) => setTimeout(r, 50)); // and anything that loads its data has asked
    expect(screen.queryByText(/AI agent industries/)).toBeNull();
    const asked = vi.mocked(api).mock.calls.map(([path]) => path);
    expect(asked.some((p) => p.startsWith("/api/ai-agents/library"))).toBe(false);
  });
});
