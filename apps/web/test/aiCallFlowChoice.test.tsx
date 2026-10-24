import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FLOW_CHOICE,
  initialFlowChoice,
  rememberedFlowChoice,
  rememberFlowChoice,
  unpublishedDraft,
  type CallFlowListItem,
  type CallFlowVersionSummary,
} from "../src/lib/callFlows";

// Start AI Calls: which flow a new run starts on, and the "unpublished edits" warning.

const v = (version: number, status: "DRAFT" | "PUBLISHED", publishedAt: string | null = null): CallFlowVersionSummary => ({
  id: `v${version}`, version, status, publishedAt, updatedAt: "2026-10-24T00:00:00Z",
});
const flow = (id: string, published: CallFlowVersionSummary | null, draft: CallFlowVersionSummary | null = null): CallFlowListItem => ({
  id, name: id, description: null, base: "nila", updatedAt: "2026-10-24T00:00:00Z", published, draft, versionCount: 1,
});

const thaara = flow("thaara-1", v(13, "PUBLISHED", "2026-10-23T08:00:00Z"));
const pooja = flow("pooja", v(2, "PUBLISHED", "2026-10-20T08:00:00Z"));

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

describe("flow a new run starts on", () => {
  it("no earlier choice: the most recently published flow (not the server default agent)", () => {
    expect(initialFlowChoice([pooja, thaara], null)).toBe("thaara-1");
  });

  it("keeps the last flow picked in this browser while it is still published", () => {
    expect(initialFlowChoice([pooja, thaara], "pooja")).toBe("pooja");
  });

  it("a remembered flow that is no longer published falls back to the newest one", () => {
    expect(initialFlowChoice([thaara], "radhi")).toBe("thaara-1");
  });

  it("a deliberate Default flow choice is kept", () => {
    expect(initialFlowChoice([pooja, thaara], DEFAULT_FLOW_CHOICE)).toBe("");
  });

  it("no published flows: the server default", () => {
    expect(initialFlowChoice([], null)).toBe("");
  });

  it("the choice is remembered ('' is stored as Default flow)", () => {
    rememberFlowChoice("pooja");
    expect(rememberedFlowChoice()).toBe("pooja");
    rememberFlowChoice("");
    expect(rememberedFlowChoice()).toBe(DEFAULT_FLOW_CHOICE);
  });
});

describe("unpublished edits warning", () => {
  it("a draft newer than the published version is flagged", () => {
    expect(unpublishedDraft(flow("thaara-1", v(13, "PUBLISHED", "2026-10-23T08:00:00Z"), v(14, "DRAFT")))?.version).toBe(14);
  });

  it("no draft, or no flow picked: no warning", () => {
    expect(unpublishedDraft(thaara)).toBeNull();
    expect(unpublishedDraft(null)).toBeNull();
  });
});
