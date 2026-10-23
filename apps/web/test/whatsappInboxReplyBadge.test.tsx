import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WhatsAppInboxPage } from "../src/pages/WhatsAppInbox";

// WhatsApp Inbox: the display-only "Interested" / "Not now" badge on tapped
// quick-reply buttons, English and Tamil (canned API, no network).

const calls: { path: string; method: string }[] = [];
const PHONE = "918838931463";
const msg = (id: string, text: string, extra: object = {}) => ({
  id, direction: "in", at: "2026-10-23T09:00:00Z", type: "button", text, media: null, status: null, error: null, template: null, ...extra,
});

vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ user: { role: "ADMIN" } }) }));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string, init: { method?: string } = {}) => {
      calls.push({ path, method: init.method ?? "GET" });
      if (path === "/api/branding") return { labels: { appName: "Kagzso" }, customized: [] };
      if (path === "/api/whatsapp/inbox/unread-count") return { messages: 0, conversations: 0 };
      if (path.startsWith("/api/whatsapp/inbox?")) {
        return { items: [{ phone: PHONE, name: "Karthick", lastMessageAt: "2026-10-23T09:00:00Z", lastPreview: "Hello", lastType: "text",
          inboundCount: 5, windowOpen: true, unread: 0 }], total: 1, page: 1, pageSize: 50 };
      }
      if (path.startsWith(`/api/whatsapp/inbox/${PHONE}?`)) {
        return { phone: PHONE, name: "Karthick", windowOpen: true, windowEndsAt: null, hasMore: false, nextBefore: null, messages: [
          msg("a", "Yes, interested", { replyIntent: "interested" }),
          msg("b", "Not now", { replyIntent: "not_now" }),
          msg("c", "ஆர்வம் உள்ளது", { replyIntent: "interested" }),
          msg("d", "இப்போது வேண்டாம்", { replyIntent: "not_now" }),
          msg("e", "Call me tomorrow", { replyIntent: null }),
          msg("f", "Hello", { type: "text" }),
        ] };
      }
      if (path === `/api/whatsapp/inbox/${PHONE}/read`) return { ok: true };
      throw new Error(`unexpected API call: ${path}`);
    }),
  };
});

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe("Inbox reply badge", () => {
  it("shows Interested / Not now on tapped buttons in English and Tamil; text is unchanged", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WhatsAppInboxPage />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Karthick/ }));
    await screen.findByText("இப்போது வேண்டாம்");
    // Badges in message order: none on the unclear tap or on typed text.
    const badges = [...document.querySelectorAll('[title^="Quick-reply button"]')].map((e) => e.textContent);
    expect(badges).toEqual(["Interested", "Not now", "Interested", "Not now"]);
    expect(screen.getByText("ஆர்வம் உள்ளது")).toBeTruthy();
    expect(screen.getByText("Call me tomorrow")).toBeTruthy();
    // Reading the thread never writes anything except the existing "mark read".
    await waitFor(() => expect(calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual([`/api/whatsapp/inbox/${PHONE}/read`]));
  });
});
