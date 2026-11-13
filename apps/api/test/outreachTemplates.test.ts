import { describe, expect, it } from "vitest";
import type { Contact } from "@prisma/client";
import { createTemplateInput } from "@dispatch/shared";
import { render } from "../src/render/render.js";
import { buildVars } from "../src/domain/vars.js";
import {
  OUTREACH_SIGNATURE,
  outreachTemplates,
  planOutreachImport,
} from "../src/domain/outreachTemplates.js";

const templates = outreachTemplates();

function contact(businessName: string | null): Contact {
  return {
    id: "c1",
    email: "ops@example.com",
    firstName: "Asha",
    lastName: null,
    phone: null,
    businessName,
    customFields: {},
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("KAGZSO outreach email templates", () => {
  it("has all 15 from the PDF, in order, with unique ids and names", () => {
    expect(templates).toHaveLength(15);
    expect(new Set(templates.map((t) => t.id)).size).toBe(15);
    expect(new Set(templates.map((t) => t.name)).size).toBe(15);
    templates.forEach((t, i) => {
      expect(t.name).toMatch(new RegExp(`^KAGZSO Outreach ${String(i + 1).padStart(2, "0")} – `));
    });
  });

  it("keeps every bullet point from the PDF", () => {
    const bullets = templates.map((t) => (t.bodyText!.match(/^• /gm) ?? []).length);
    expect(bullets).toEqual([9, 10, 12, 11, 12, 12, 12, 12, 12, 12, 12, 13, 12, 6, 6]);
  });

  it("is a valid editor template: letter body, KAGZSO signature, no [Placeholder] left", () => {
    for (const t of templates) {
      expect(createTemplateInput.safeParse(t).success).toBe(true);
      expect(t.kind).toBe("LETTER");
      expect(t.signature).toBe(OUTREACH_SIGNATURE);
      expect(`${t.subject}\n${t.bodyText}`).not.toMatch(/\[[^\]]+\]/);
      expect(t.bodyText).toContain("Greetings from KAGZSO Technology Services.");
      expect(t.bodyText).toContain("FREE initial");
    }
  });

  it("uses only {{business_name}}, declared wherever it appears", () => {
    for (const t of templates) {
      const used = [...`${t.subject}\n${t.bodyText}`.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
      expect(new Set(used)).toEqual(new Set(t.variables));
      for (const v of used) expect(v).toBe("business_name");
    }
    const noVars = templates.filter((t) => t.variables.length === 0).map((t) => t.id);
    expect(noVars).toEqual(["kagzso-outreach-12-corporate", "kagzso-outreach-14-universal"]);
  });

  it("renders with the contact's business name, bullets and signature", () => {
    for (const t of templates) {
      const out = render({
        subject: t.subject,
        htmlBody: t.htmlBody,
        declaredVariables: t.variables,
        vars: buildVars(contact("Apollo Hospitals")),
      });
      if (t.variables.length) expect(`${out.subject}\n${out.html}`).toContain("Apollo Hospitals");
      expect(out.subject).not.toContain("{{");
      expect(out.html).not.toContain("{{");
      expect(out.html).toContain("• ");
      expect(out.html).toContain("Automating Today. Empowering Tomorrow.");
      expect(out.html).toContain("Contact: +91 9092490661");
      expect(out.text).toContain("Best Regards,");
    }
    const first = render({
      subject: templates[0]!.subject,
      htmlBody: templates[0]!.htmlBody,
      declaredVariables: templates[0]!.variables,
      vars: buildVars(contact("Apollo Hospitals")),
    });
    expect(first.subject).toBe("AI & RPA Automation Opportunities for Apollo Hospitals");
  });

  it("still sends to a contact with no business name (no missing-variable error)", () => {
    for (const t of templates) {
      expect(() =>
        render({ subject: t.subject, htmlBody: t.htmlBody, declaredVariables: t.variables, vars: buildVars(contact(null)) }),
      ).not.toThrow();
    }
  });

  it("plan is add-only: skips ids or names already on the server", () => {
    const plan = planOutreachImport(templates, [
      { id: "kagzso-outreach-01-hospitals", name: "renamed by the user" },
      { id: "some-other-id", name: "kagzso outreach 02 – logistics & supply chain" },
      { id: "seed-welcome", name: "Welcome email" },
    ]);
    expect(plan[0]).toMatchObject({ action: "skip", reason: "already added" });
    expect(plan[1]).toMatchObject({ action: "skip", reason: "a template with this name already exists" });
    expect(plan.slice(2).every((s) => s.action === "create")).toBe(true);
    expect(planOutreachImport(templates, []).every((s) => s.action === "create")).toBe(true);
  });
});
