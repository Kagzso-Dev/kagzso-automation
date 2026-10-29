import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { App } from "../src/App";
import { Layout } from "../src/components/Layout";
import { AiProvidersLink, SidebarMenuSection } from "../src/pages/Settings";

// Settings → Sidebar menu: "AI Providers" can be hidden from the (admin-only) menu. Hiding only
// removes the menu item: the page still opens by direct link and from Settings → "Open AI Providers",
// and editors never get it. lib/api is mocked: nothing reaches the API, a provider or a database.

let role: "ADMIN" | "EDITOR" = "ADMIN";
let stored: string[] = [];
const puts: unknown[] = [];

vi.mock("../src/lib/auth", () => ({
  useAuth: () => ({ user: { role, email: "a@example.com" }, loading: false, logout: () => undefined }),
}));
// The real pages fetch a lot; stand-ins are enough to prove the route opens.
vi.mock("../src/pages/AiProviders", () => ({ AiProvidersPage: () => <h1>AI providers page</h1> }));
vi.mock("../src/pages/Dashboard", () => ({ DashboardPage: () => <h1>Dashboard page</h1> }));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string, init: { method?: string; json?: { hiddenItems: string[] } } = {}) => {
      if (path === "/api/settings/sidebar") {
        if (init.method === "PUT") {
          puts.push(init.json);
          stored = init.json?.hiddenItems ?? [];
        }
        return { hiddenItems: stored };
      }
      if (path === "/api/branding") return { labels: { appName: "Kagzso" }, customized: [] };
      if (path === "/api/ai-calls/config") return { enabled: false, configured: false, languages: [] };
      if (path === "/api/whatsapp/inbox/unread-count") return { messages: 0, conversations: 0 };
      throw new Error(`unexpected API call: ${path}`);
    }),
  };
});

beforeEach(() => {
  role = "ADMIN";
  stored = [];
  puts.length = 0;
});
afterEach(() => cleanup());

function renderAt(path: string, ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
const menu = () => within(screen.getByRole("navigation", { name: "Main" }));
const menuHasAiProviders = () => menu().queryByRole("link", { name: "AI Providers" }) !== null;
const aiSwitch = () => screen.findByRole("switch", { name: "Show AI Providers in the sidebar" });
const settle = () => menu().findByRole("link", { name: "Settings" }); // sidebar setting loaded

describe("Sidebar menu: AI Providers", () => {
  it("default is Shown: admins see it in the menu, and the row says Shown with its note", async () => {
    renderAt("/settings", <Layout><SidebarMenuSection isAdmin /></Layout>);
    await settle();
    expect(menuHasAiProviders()).toBe(true);
    const sw = await aiSwitch();
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Admins can still open AI Providers from Settings.")).toBeTruthy();
  });

  it("the toggle hides and shows the item for admins (after Save)", async () => {
    renderAt("/settings", <Layout><SidebarMenuSection isAdmin /></Layout>);
    await settle();
    fireEvent.click(await aiSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(menuHasAiProviders()).toBe(false));
    expect(puts.at(-1)).toEqual({ hiddenItems: ["ai-providers"] });

    fireEvent.click(await aiSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(menuHasAiProviders()).toBe(true));
    expect(puts.at(-1)).toEqual({ hiddenItems: [] });
  });

  it("Reset to default shows it again", async () => {
    stored = ["ai-providers", "insights"];
    renderAt("/settings", <Layout><SidebarMenuSection isAdmin /></Layout>);
    await settle();
    await waitFor(() => expect(menu().queryByRole("link", { name: "Insights" })).toBeNull());
    expect(menuHasAiProviders()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(menuHasAiProviders()).toBe(true));
    expect(puts.at(-1)).toEqual({ hiddenItems: [] });
  });

  it("hidden: the page still opens by direct link for admins", async () => {
    stored = ["ai-providers"];
    renderAt("/admin/ai-providers", <App />);
    expect(await screen.findByRole("heading", { name: "AI providers page" })).toBeTruthy();
    await settle();
    expect(menuHasAiProviders()).toBe(false);
  });

  it("Settings → Open AI Providers goes to the page, even while it's hidden from the menu", async () => {
    stored = ["ai-providers"];
    renderAt(
      "/settings",
      <Routes>
        <Route path="/settings" element={<AiProvidersLink />} />
        <Route path="/admin/ai-providers" element={<h1>AI providers page</h1>} />
      </Routes>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Open AI Providers" }));
    expect(await screen.findByRole("heading", { name: "AI providers page" })).toBeTruthy();
  });

  it("non-admins never see it: not in the menu, no panel row, and the direct link goes to the Dashboard", async () => {
    role = "EDITOR";
    renderAt("/settings", <Layout><SidebarMenuSection isAdmin={false} /></Layout>);
    await settle();
    expect(menuHasAiProviders()).toBe(false);
    expect(screen.queryByRole("switch", { name: "Show AI Providers in the sidebar" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Show Insights in the sidebar" })).toBeTruthy(); // panel is there
    cleanup();

    renderAt("/admin/ai-providers", <App />);
    expect(await screen.findByRole("heading", { name: "Dashboard page" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "AI providers page" })).toBeNull();
  });
});
