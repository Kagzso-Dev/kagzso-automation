import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CallRecordingsSection } from "../src/components/CallRecordingsSection";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";

// Settings > Call recordings > Recent recordings: the row Delete button (canned API, no network).

const calls: { path: string; method: string }[] = [];
let failDelete = false;

vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ user: { role: "ADMIN" } }) }));
vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    api: vi.fn(async (path: string, init: { method?: string } = {}) => {
      calls.push({ path, method: init.method ?? "GET" });
      if (path === "/api/ai-calls/recordings/settings") {
        return { enabled: true, storage_configured: true, retention_days: 90, default_retention_days: 90, max_retention_days: 3650,
          counts: { completed: 2, processing: 0, failed: 0, deleted: 1 }, total_bytes: 1737688, oldest_at: null, disk_free_bytes: 27e9 };
      }
      if (path.startsWith("/api/ai-calls/recordings/recent")) {
        return { items: [
          { logId: "log_a", customerName: "Ragul", outcome: "interested", durationSec: 47, at: "2026-10-20T08:33:00Z", testCall: true, status: "completed", recordingMs: 47400 },
          { logId: "log_b", customerName: "Priya", outcome: null, durationSec: 7, at: "2026-10-20T08:30:00Z", testCall: false, status: "deleted", recordingMs: 6900 },
        ] };
      }
      if (path === "/api/ai-calls/logs/log_a/recording" && init.method === "DELETE") {
        if (failDelete) throw new real.ApiError(502, "The voice backend could not provide the recording");
        return { ok: true };
      }
      throw new Error(`unexpected API call: ${path}`);
    }),
  };
});

afterEach(() => {
  cleanup();
  calls.length = 0;
  failDelete = false;
});

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <CallRecordingsSection />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const confirmDelete = async () => {
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Delete this recording?")).toBeTruthy();
  expect(within(dialog).getByText(/The call, transcript and summary will be kept/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
};

describe("Recent recordings: Delete", () => {
  it("shows Delete only on recorded rows; a deleted row says so", async () => {
    renderSection();
    expect(await screen.findByRole("button", { name: "Delete the recording of Ragul" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete the recording of Priya" })).toBeNull();
    expect(screen.getAllByText("This recording was deleted.")).toHaveLength(1);
  });

  it("asks first, then deletes only that recording and updates the row in place", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Delete the recording of Ragul" }));
    await confirmDelete();
    await waitFor(() => expect(screen.getAllByText("This recording was deleted.")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Delete the recording of Ragul" })).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ path: "/api/ai-calls/logs/log_a/recording", method: "DELETE" }]);
  });

  it("Cancel deletes nothing; a failed delete leaves the row unchanged", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Delete the recording of Ragul" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    failDelete = true;
    fireEvent.click(screen.getByRole("button", { name: "Delete the recording of Ragul" }));
    await confirmDelete();
    expect(await screen.findByText("Couldn't delete the recording")).toBeTruthy(); // error toast
    expect(screen.getByRole("button", { name: "Delete the recording of Ragul" })).toBeTruthy();
    expect(screen.getAllByText("This recording was deleted.")).toHaveLength(1);
  });
});
