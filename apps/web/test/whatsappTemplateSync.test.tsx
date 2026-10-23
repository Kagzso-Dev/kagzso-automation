import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WhatsAppTemplatesPage } from "../src/pages/WhatsAppTemplates";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";
import { recentStatusChange, trackMetaStatuses, type TemplateVerification } from "../src/lib/whatsapp";

// WhatsApp Templates ↔ Meta (canned API, no network, nothing sent to Meta):
// fresh Sync list on every open, Verify refreshes it too, the "can't be imported"
// banner, and the display-only Meta badges.

const calls: { path: string; method: string }[] = [];
let metaList: object[] = [];
let verifyItems: TemplateVerification[] = [];

const ROWS = [
  { id: "t_en", name: "Company Intro", providerTemplateName: "kagzso_company_intro", languageCode: "en", body: "Hi {{first_name}}",
    variables: ["first_name"], buttonLabels: ["Interested"], updatedAt: "2026-10-20T08:00:00Z" },
  { id: "t_ta", name: "Kagzso Automation Intro Ta", providerTemplateName: "kagzso_automation_intro_ta", languageCode: "ta",
    body: "வணக்கம் {{first_name}}", variables: ["first_name"], buttonLabels: ["ஆர்வம் உள்ளது"], updatedAt: "2026-10-23T08:00:00Z" },
];

const candidate = (name: string, language: string, importable: boolean, reason: string | null = null) => ({
  name, language, status: "APPROVED", category: "MARKETING", importable, reason, warnings: [], displayName: importable ? name : null,
});

vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ user: { role: "ADMIN" } }) }));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string, init: { method?: string } = {}) => {
      calls.push({ path, method: init.method ?? "GET" });
      if (path === "/api/branding") return { labels: { appName: "Kagzso" }, customized: [] };
      if (path === "/api/whatsapp/templates") return { items: ROWS };
      if (path.startsWith("/api/whatsapp/templates/verify")) return { checkedAt: new Date().toISOString(), error: null, items: verifyItems };
      if (path === "/api/whatsapp/templates/meta-sync") return { items: metaList };
      if (path === "/api/whatsapp/templates/meta-sync/updates") return { items: [] };
      throw new Error(`unexpected API call: ${path}`);
    }),
  };
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
  metaList = [];
  verifyItems = [
    { id: "t_en", status: "verified", metaStatus: "APPROVED", reason: "Meta status APPROVED · MARKETING", headerNeedsParameter: null },
    { id: "t_ta", status: "verified", metaStatus: "APPROVED", reason: "Meta status APPROVED · MARKETING", headerNeedsParameter: null },
  ];
});

afterEach(() => {
  cleanup();
  calls.length = 0;
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <WhatsAppTemplatesPage />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const syncReads = () => calls.filter((c) => c.path === "/api/whatsapp/templates/meta-sync").length;

describe("Sync from Meta", () => {
  it("re-reads Meta every time the window opens: a template made in Meta shows without reloading", async () => {
    renderPage();
    await screen.findByText("Company Intro");
    await waitFor(() => expect(syncReads()).toBe(1));
    expect(screen.queryByText(/in Meta isn't in/)).toBeNull();

    // Created in WhatsApp Manager after the page was opened.
    metaList = [candidate("kagzso_new_offer", "ta", true)];
    fireEvent.click(screen.getByRole("button", { name: "Sync from Meta" }));
    await screen.findByText("Sync templates from Meta");
    expect(await screen.findByLabelText("Import kagzso_new_offer")).toBeTruthy();
    expect(syncReads()).toBe(2);
  });

  it("Verify with Meta also refreshes the Sync list and the banner", async () => {
    renderPage();
    await screen.findByText("Company Intro");
    await waitFor(() => expect(syncReads()).toBe(1));

    metaList = [candidate("kagzso_new_offer", "en", true)];
    fireEvent.click(screen.getByRole("button", { name: "Verify with Meta" }));
    await screen.findByText(/1 template in Meta isn't in Kagzso yet/);
    expect(calls.some((c) => c.path === "/api/whatsapp/templates/verify?refresh=1")).toBe(true);
    expect(syncReads()).toBe(2);
  });

  it("the banner also says what can't be imported, and See why opens the reasons", async () => {
    metaList = [
      candidate("kagzso_automation_intro_ta", "ta", true),
      candidate("kagzso_three_vars", "en", false, "Has 3 variables — Dispatch can fill {{1}} (first name) and {{2}} (business name)"),
    ];
    renderPage();
    await screen.findByText(/1 template in Meta isn't in Kagzso yet/);
    expect(screen.getByText(/1 more template in Meta can't be imported yet/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "See why" }));
    await screen.findByText(/Has 3 variables/);
    expect((screen.getByLabelText("Import kagzso_three_vars") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Import kagzso_automation_intro_ta") as HTMLInputElement).disabled).toBe(false);
  });

  it("nothing is imported or written: every request is a read", async () => {
    metaList = [candidate("kagzso_new_offer", "en", true)];
    renderPage();
    await screen.findByText(/isn't in Kagzso yet/);
    fireEvent.click(screen.getByRole("button", { name: "Verify with Meta" }));
    fireEvent.click(screen.getByRole("button", { name: "Review & import" }));
    await screen.findByLabelText("Import kagzso_new_offer");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("Meta badges (display only)", () => {
  it("shows Meta's status and category; a name or language missing in Meta is Not found in Meta", async () => {
    verifyItems = [
      { id: "t_en", status: "not_found", metaStatus: null, reason: 'No template named "kagzso_company_intro"', headerNeedsParameter: null },
      { id: "t_ta", status: "failed", metaStatus: null, reason: 'Exists in Meta only in en, not in "ta"', headerNeedsParameter: null },
    ];
    renderPage();
    await waitFor(() => expect(screen.getAllByText("Not found in Meta")).toHaveLength(2));
  });

  it("shows status · category under the badge", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText("approved · marketing")).toHaveLength(2));
  });

  it("flags a Meta status that changed since this browser last checked", async () => {
    localStorage.setItem("whatsapp-template-meta-status", JSON.stringify({ t_ta: { status: "APPROVED" } }));
    verifyItems = [
      verifyItems[0]!,
      { id: "t_ta", status: "failed", metaStatus: "PAUSED", reason: "Meta status PAUSED · MARKETING", headerNeedsParameter: null },
    ];
    renderPage();
    const badge = await screen.findByText("Status changed");
    expect(badge.closest("[title]")?.getAttribute("title")).toBe("Meta status was approved, now paused");
    expect(screen.getAllByText("Status changed")).toHaveLength(1);
  });
});

describe("status tracking", () => {
  const v = (id: string, status: TemplateVerification["status"], metaStatus: string | null): TemplateVerification => ({
    id, status, metaStatus, reason: "", headerNeedsParameter: null,
  });
  const now = new Date("2026-10-23T10:00:00Z");

  it("first sighting is recorded, not flagged; a change is flagged for 7 days", () => {
    const first = trackMetaStatuses({}, [v("a", "verified", "APPROVED")], now);
    expect(first).toEqual({ a: { status: "APPROVED" } });
    expect(recentStatusChange(first.a, now)).toBeNull();

    const changed = trackMetaStatuses(first, [v("a", "not_found", null)], now);
    expect(recentStatusChange(changed.a, now)).toEqual({ from: "APPROVED", to: "NOT_FOUND" });
    expect(recentStatusChange(changed.a, new Date("2026-11-01T10:00:00Z"))).toBeNull();
  });

  it("a check that couldn't reach Meta changes nothing", () => {
    const seen = { a: { status: "APPROVED" } };
    expect(trackMetaStatuses(seen, [v("a", "unchecked", null)], now)).toEqual(seen);
  });
});
