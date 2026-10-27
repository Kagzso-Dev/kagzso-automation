import { describe, expect, it } from "vitest";
import { canSeePath, navForRole } from "../../web/src/lib/navAccess.js";

// The web app's rule for pages editors don't get (sidebar + routes): Email Templates,
// WhatsApp Templates and Voice Call Flows. Admins keep everything.

const NAV = [
  { label: "Main", items: [{ to: "/" }] },
  { label: "Email", items: [{ to: "/contacts" }, { to: "/templates" }] },
  { label: "WhatsApp", items: [{ to: "/whatsapp-contacts" }, { to: "/whatsapp-templates" }] },
  { label: "Calls", items: [{ to: "/ai-call-customers" }, { to: "/call-flows" }] },
  { label: "System", items: [{ to: "/send-queue" }, { to: "/settings" }] },
];
const paths = (groups: typeof NAV) => groups.flatMap((g) => g.items.map((i) => i.to));

describe("editor access to the template and call-flow editors", () => {
  it("an editor doesn't see the three items; their sections keep their other items", () => {
    const editor = navForRole(NAV, "EDITOR");
    expect(paths(editor)).toEqual(["/", "/contacts", "/whatsapp-contacts", "/ai-call-customers", "/send-queue", "/settings"]);
    expect(editor.map((g) => g.label)).toEqual(["Main", "Email", "WhatsApp", "Calls", "System"]);
  });

  it("an admin sees every item, unchanged", () => {
    expect(navForRole(NAV, "ADMIN")).toEqual(NAV);
  });

  it("a section left empty for an editor loses its heading", () => {
    const calls = [{ label: "Main", items: [{ to: "/" }] }, { label: "Calls", items: [{ to: "/call-flows" }] }];
    expect(navForRole(calls, "EDITOR").map((g) => g.label)).toEqual(["Main"]);
    expect(navForRole(calls, "ADMIN").map((g) => g.label)).toEqual(["Main", "Calls"]);
  });

  it("route guard: editors are turned away from the three URLs only", () => {
    for (const p of ["/templates", "/whatsapp-templates", "/call-flows"]) {
      expect(canSeePath(p, "EDITOR")).toBe(false);
      expect(canSeePath(p, "ADMIN")).toBe(true);
    }
    for (const p of ["/", "/contacts", "/whatsapp-contacts", "/ai-call-customers", "/campaigns", "/triggers", "/send-queue", "/settings"]) {
      expect(canSeePath(p, "EDITOR")).toBe(true);
    }
  });
});

describe("AI call language pages (/ta/call-flows, …)", () => {
  it("follow the English page's rule", () => {
    for (const p of ["/ta/call-flows", "/hi/call-flows", "/kn/call-flows"]) {
      expect(canSeePath(p, "EDITOR")).toBe(false);
      expect(canSeePath(p, "ADMIN")).toBe(true);
    }
    for (const p of ["/ta/ai-call-customers", "/kn/ai-call-customers", "/lists/abc"]) expect(canSeePath(p, "EDITOR")).toBe(true);
    // Not a language prefix: unchanged.
    expect(canSeePath("/en/call-flows", "EDITOR")).toBe(true);
    expect(canSeePath("/xx/call-flows", "EDITOR")).toBe(true);
  });
});

describe("admin-only pages (Data Quality)", () => {
  it("only an admin sees /data-quality, in the menu and by URL", () => {
    expect(canSeePath("/data-quality", "ADMIN")).toBe(true);
    for (const role of ["EDITOR", undefined, null, "VIEWER"]) expect(canSeePath("/data-quality", role)).toBe(false);
    const withDq = [{ label: "Main", items: [{ to: "/" }, { to: "/data-quality" }] }, ...NAV.slice(1)];
    expect(paths(navForRole(withDq, "ADMIN"))).toEqual(["/", "/data-quality", ...paths(NAV).slice(1)]);
    expect(navForRole(withDq, "EDITOR")).toEqual(navForRole(NAV, "EDITOR")); // editors: exactly as before
  });
});
