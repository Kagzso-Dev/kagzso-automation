import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import flowFixture from "../../../deploy/callflows/thaara-natural.json";
import { CallFlowsPage } from "../src/pages/CallFlows";
import { ConfirmProvider } from "../src/components/confirm";
import { ToastProvider } from "../src/components/toast";

// Voice Call Flows page with canned API answers (no network, no database): selecting a
// flow shows both the editor and the Live preview.

const definition = flowFixture as unknown as Record<string, unknown>;
const version = {
  id: "ver1",
  version: 1,
  status: "DRAFT",
  publishedAt: null,
  updatedAt: "2026-10-20T09:00:00.000Z",
  createdAt: "2026-10-20T09:00:00.000Z",
  createdByEmail: "admin@test",
  definition,
  definitionHash: "hash1",
};

const responses: Record<string, unknown> = {
  "/api/ai-calls/config": { enabled: true, configured: true, canStart: true, flowEditor: true, testCallNumbers: [] },
  "/api/call-flows/builtin": {
    flows: {},
    locked_blocks: {},
    variables: [],
    limits: { max_duration_sec: 300, max_block_chars: 20000, max_prompt_chars: 60000 },
    voices: [{ id: "roopa", name: "Roopa", language: "en-IN", gender: "female" }],
    default_voice: "roopa",
  },
  "/api/call-flows": {
    items: [
      { id: "flow1", name: "Thaara natural", description: null, base: "nila", updatedAt: version.updatedAt, published: null, draft: version, versionCount: 1 },
    ],
  },
  "/api/call-flows/flow1": { id: "flow1", name: "Thaara natural", description: null, base: "nila", versions: [version] },
  "/api/call-flows/preview": {
    valid: true,
    errors: [],
    greeting: "Hello, am I speaking with Ragul?",
    system_prompt: "PROMPT",
    script_chars: 6,
    silence_reprompt: "Hello, can you hear me?",
    silence_closing: "Thank you.",
    max_duration_sec: 180,
  },
};

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(async (path: string) => {
    if (!(path in responses)) throw new Error(`unexpected API call in test: ${path}`);
    return responses[path];
  }),
}));

afterEach(cleanup);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <ConfirmProvider>
            <CallFlowsPage />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("Voice Call Flows layout", () => {
  it("shows the editor and the Live preview when a flow is selected", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Thaara natural"));

    expect(await screen.findByRole("button", { name: /Save draft/ })).toBeTruthy(); // the editor
    expect(screen.getByText("Live preview")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("“Hello, am I speaking with Ragul?”")).toBeTruthy()); // preview rendered
    expect(screen.getByRole("radiogroup", { name: "Voice" })).toBeTruthy();
    // pause settings next to Max call duration (an old flow shows the defaults) and their chips
    expect((screen.getByLabelText("Short delay (ms)") as HTMLInputElement).value).toBe("300");
    expect((screen.getByLabelText("Medium delay (ms)") as HTMLInputElement).value).toBe("700");
    expect((screen.getByLabelText("Long delay (ms)") as HTMLInputElement).value).toBe("1200");
    for (const chip of ["{{short_delay}}", "{{medium_delay}}", "{{long_delay}}"]) expect(screen.getByRole("button", { name: chip })).toBeTruthy();
  });

  it("warns when calls are recorded and the flow has no recording notice", async () => {
    const catalog = responses["/api/call-flows/builtin"] as Record<string, unknown>;
    catalog.recording_enabled = true;
    try {
      renderPage();
      fireEvent.click(await screen.findByText("Thaara natural"));
      expect(await screen.findByText(/Call recording is on, but this flow has no recording notice/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText(/Recording notice/), { target: { value: "This call may be recorded." } });
      expect(screen.queryByText(/Call recording is on, but this flow has no recording notice/)).toBeNull();
    } finally {
      delete catalog.recording_enabled;
    }
  });

  it("identity question: empty by default (built-in line shown), editable, and in the Live preview", async () => {
    const preview = responses["/api/call-flows/preview"] as Record<string, unknown>;
    preview.identity_question = "Am I speaking with Ragul, sir?";
    preview.identity_reask = "Sorry, am I speaking with Ragul?";
    try {
      renderPage();
      fireEvent.click(await screen.findByText("Thaara natural"));
      const question = (await screen.findByLabelText(/Identity question/)) as HTMLInputElement;
      const reask = screen.getByLabelText(/asked once more/) as HTMLInputElement;
      expect(question.value).toBe(""); // old flows keep the built-in lines
      expect(question.placeholder).toBe("Am I speaking with {{customer_name}}, {{title_to_use}}?");
      expect(reask.placeholder).toBe("Sorry, am I speaking with {{customer_name}}?");
      fireEvent.change(question, { target: { value: "Am I speaking with {{customer_name}}? This is Thaara." } });
      expect(question.value).toBe("Am I speaking with {{customer_name}}? This is Thaara.");
      expect(screen.getByRole("button", { name: /Save draft/ }).hasAttribute("disabled")).toBe(false);
      await waitFor(() => expect(screen.getByText("“Am I speaking with Ragul, sir?”")).toBeTruthy());
      expect(screen.getByText("Then the system asks")).toBeTruthy();
    } finally {
      delete preview.identity_question;
      delete preview.identity_reask;
    }
  });

  it("shows the flow list and no editor before a flow is selected", async () => {
    renderPage();
    expect(await screen.findByText("Thaara natural")).toBeTruthy();
    expect(screen.getByText("Select a call flow or create a new one.")).toBeTruthy();
    expect(screen.queryByText("Live preview")).toBeNull();
  });
});
