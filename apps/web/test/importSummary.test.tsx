import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportCountsSummary, OverLimitNote } from "../src/components/ImportSummary";
import { ContactImportStatus } from "../src/pages/Contacts";

// The import summary: every count of a bulk import, and a clear note when rows after the
// limit were not imported. Canned API, no network.

const jobs: unknown[] = [];
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string) => {
    if (path.startsWith("/api/contacts/import/")) return jobs.length > 1 ? jobs.shift() : jobs[0];
    throw new Error(`unexpected API call: ${path}`);
  }),
}));

afterEach(() => {
  cleanup();
  jobs.length = 0;
});

/** The value shown under a summary label. */
const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

const EXAMPLE = { totalRows: 2000, maxRows: 1000, selectedRows: 1000, imported: 950, failed: 20, duplicates: 30, skippedOverLimit: 1000 };

describe("import summary", () => {
  it("the example: 2,000 uploaded, 1,000 allowed: every count, and that 1,000 rows were not imported", () => {
    render(<ImportCountsSummary counts={EXAMPLE} />);
    expect(value("Uploaded")).toBe("2,000");
    expect(value("Maximum allowed")).toBe("1,000");
    expect(value("Selected for import")).toBe("1,000");
    expect(value("Successfully imported")).toBe("950");
    expect(value("Failed")).toBe("20");
    expect(value("Duplicates")).toBe("30");
    expect(value("Skipped due to limit")).toBe("1,000");
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("This file has 2,000 rows and one import takes up to 1,000");
    expect(note.textContent).toContain("The last 1,000 rows were not imported. To import them, upload them in a separate file.");
  });

  it.each([
    ["below", 999],
    ["at", 1000],
  ])("%s the limit: no rows left out, no note", (_where, rows) => {
    render(
      <ImportCountsSummary counts={{ totalRows: rows, maxRows: 1000, selectedRows: rows, imported: rows, failed: 0, duplicates: 0, skippedOverLimit: 0 }} />,
    );
    expect(value("Skipped due to limit")).toBe("0");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("before the import (AI Call Customers preview): says which rows will not be imported", () => {
    render(<OverLimitNote totalRows={5001} maxRows={5000} skippedOverLimit={1} />);
    expect(screen.getByRole("note").textContent).toBe(
      "This file has 5,001 rows and one import takes up to 5,000, so only the first 5,000 rows will be used. The last 1 row will not be imported. Upload it in a separate file afterwards.",
    );
  });

  it("after the import, one row over the limit", () => {
    render(<OverLimitNote totalRows={5001} maxRows={5000} skippedOverLimit={1} imported />);
    expect(screen.getByRole("note").textContent).toContain("The last 1 row was not imported. To import it, upload it in a separate file.");
  });
});

describe("Contacts → Import file: the queued job", () => {
  const renderStatus = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ContactImportStatus jobId="job-1" filename="contacts.csv" onDismiss={() => {}} />
      </QueryClientProvider>,
    );

  it("shows progress, then the summary once the job has finished", async () => {
    jobs.push(
      { jobId: "job-1", state: "ACTIVE", result: null, failedReason: null },
      {
        jobId: "job-1",
        state: "COMPLETED",
        failedReason: null,
        result: {
          totalRows: 2000, maxRows: 1000, selectedRows: 1000, skippedOverLimit: 1000,
          created: 900, updated: 50, duplicates: 30, skipped: 15, rejectedDomain: 5, failed: 20,
        },
      },
    );
    renderStatus();
    expect(await screen.findByText("Importing contacts.csv…")).toBeTruthy();
    expect(await screen.findByText("Import summary: contacts.csv", {}, { timeout: 4000 })).toBeTruthy();
    expect(value("Successfully imported")).toBe("950");
    expect(value("Skipped due to limit")).toBe("1,000");
    expect(screen.getByText(/900 new, 50 already saved/).textContent).toContain("15 without an email address");
    expect(screen.getByRole("note").textContent).toContain("The last 1,000 rows were not imported");
  });

  it("a failed job says so", async () => {
    jobs.push({ jobId: "job-1", state: "DEAD", result: null, failedReason: "Invalid Record Length" });
    renderStatus();
    expect(await screen.findByText("Import of contacts.csv failed: Invalid Record Length")).toBeTruthy();
  });
});
