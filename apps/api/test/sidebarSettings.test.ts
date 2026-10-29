import { describe, expect, it } from "vitest";
import { HIDEABLE_NAV_ITEMS, normalizeHiddenNavItems, sidebarSettingsInput } from "@dispatch/shared";

describe("sidebar menu setting", () => {
  it("only Insights, Lists, Campaigns, Triggers, WhatsApp Inbox, Settings (editors) and AI Providers can be hidden", () => {
    expect([...HIDEABLE_NAV_ITEMS]).toEqual(["insights", "lists", "campaigns", "triggers", "whatsapp-inbox", "settings-editors", "ai-providers"]);
  });

  it("AI Providers: hideable, and shown (default) when a saved list doesn't mention it", () => {
    expect(sidebarSettingsInput.parse({ hiddenItems: ["ai-providers"] }).hiddenItems).toEqual(["ai-providers"]);
    expect(normalizeHiddenNavItems(["insights", "settings-editors"])).not.toContain("ai-providers"); // pre-existing saved value
    expect(normalizeHiddenNavItems([])).toEqual([]); // Reset to default
  });

  it("WhatsApp Inbox: hideable, and shown when an older saved list doesn't mention it", () => {
    expect(sidebarSettingsInput.parse({ hiddenItems: ["whatsapp-inbox"] }).hiddenItems).toEqual(["whatsapp-inbox"]);
    expect(normalizeHiddenNavItems(["lists", "campaigns"])).not.toContain("whatsapp-inbox"); // pre-existing saved value
    expect(normalizeHiddenNavItems(["whatsapp-inbox", "insights"])).toEqual(["insights", "whatsapp-inbox"]);
    expect(sidebarSettingsInput.parse({ hiddenItems: [...HIDEABLE_NAV_ITEMS] }).hiddenItems).toHaveLength(7); // all at once
  });

  it("accepts any subset of the hideable items, including none", () => {
    expect(sidebarSettingsInput.parse({ hiddenItems: [] }).hiddenItems).toEqual([]);
    expect(sidebarSettingsInput.parse({ hiddenItems: ["lists", "insights"] }).hiddenItems).toEqual(["lists", "insights"]);
  });

  it("rejects items that are never hideable", () => {
    for (const item of ["settings", "dashboard", "contacts", "send-queue", "call-flows"]) {
      expect(sidebarSettingsInput.safeParse({ hiddenItems: [item] }).success).toBe(false);
    }
    expect(sidebarSettingsInput.safeParse({}).success).toBe(false);
  });

  it("a missing or broken stored value means show everything", () => {
    expect(normalizeHiddenNavItems(undefined)).toEqual([]);
    expect(normalizeHiddenNavItems(null)).toEqual([]);
    expect(normalizeHiddenNavItems("insights")).toEqual([]);
    expect(normalizeHiddenNavItems({ hidden: ["lists"] })).toEqual([]);
  });

  it("drops unknown values and duplicates, keeps menu order", () => {
    expect(normalizeHiddenNavItems(["triggers", "settings", "insights", "triggers", 42])).toEqual(["insights", "triggers"]);
  });
});
