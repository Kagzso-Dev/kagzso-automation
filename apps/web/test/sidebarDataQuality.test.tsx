import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "../src/components/Layout";
import { navForRole } from "../src/lib/navAccess";

// Data Quality sits right below Dashboard in Main, for admins only. Every other item, label,
// icon, section and route is exactly as before.

const BEFORE = [
  ["Main", [["/", "Dashboard", "dashboard"], ["/insights", "Insights", "insights"], ["/lists", "Lists", "lists"]]],
  ["Email", [["/contacts", "Email Contacts", "contacts"], ["/templates", "Email Templates", "templates"], ["/campaigns", "Campaigns", "campaigns"], ["/triggers", "Triggers", "triggers"]]],
  ["WhatsApp", [["/whatsapp-contacts", "WhatsApp Contacts", "whatsapp"], ["/whatsapp-templates", "WhatsApp Templates", "whatsapp"], ["/whatsapp-inbox", "WhatsApp Inbox", "inbox"]]],
  ["Calls", [["/ai-call-customers", "Voicecall Contact", "phone"], ["/call-flows", "Voice Call Flows", "phone"]]],
  ["System", [["/send-queue", "Send Queue", "activity"], ["/settings", "Settings", "settings"]]],
];
const shape = (groups: typeof NAV_GROUPS) => groups.map((g) => [g.label, g.items.map((i) => [i.to, i.label, i.icon])]);

describe("sidebar", () => {
  it("admin: Main is Dashboard, Data Quality, then the items that were there", () => {
    const admin = shape(navForRole(NAV_GROUPS, "ADMIN"));
    expect(admin[0]).toEqual(["Main", [["/", "Dashboard", "dashboard"], ["/data-quality", "Data Quality", "quality"], ["/insights", "Insights", "insights"], ["/lists", "Lists", "lists"]]]);
    expect(admin.slice(1)).toEqual(BEFORE.slice(1));
  });

  it("removing Data Quality gives back the old menu exactly", () => {
    const without = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.to !== "/data-quality") }));
    expect(shape(without)).toEqual(BEFORE);
  });

  it("editors never see it", () => {
    expect(navForRole(NAV_GROUPS, "EDITOR").flatMap((g) => g.items.map((i) => i.to))).not.toContain("/data-quality");
  });
});
