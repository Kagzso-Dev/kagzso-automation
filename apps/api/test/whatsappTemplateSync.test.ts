import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMetaTemplatePayload,
  createMetaTemplateInput,
  dispatchRowForCreated,
  planMetaImport,
  planMetaUpdate,
  toMetaTemplateName,
} from "@dispatch/shared";

// Two-way template sync with Meta mocked (nothing is ever submitted):
// the create-form rules and Graph payload, Meta → Dispatch import planning,
// and the import / create flows against an in-memory template table.

/* ------------------------------------------------------------------ pure rules */

const base = {
  displayName: "Company Intro",
  name: "kagzso_company_intro_v2",
  language: "en",
  category: "MARKETING" as const,
  body: "Hi {{1}}, this is Kagzso. We help {{2}} save time. Reply below.",
  variables: [
    { field: "first_name" as const, example: "Karthick" },
    { field: "business_name" as const, example: "Acme" },
  ],
  footer: "AI | Automation",
  buttons: ["Yes, interested", "Not now"],
};

describe("create-in-Meta form rules", () => {
  it("accepts a valid template and builds Meta's payload (positional, examples, quick replies)", () => {
    const v = createMetaTemplateInput.parse(base);
    expect(buildMetaTemplatePayload(v)).toEqual({
      name: "kagzso_company_intro_v2",
      language: "en",
      category: "MARKETING",
      parameter_format: "POSITIONAL",
      components: [
        { type: "BODY", text: base.body, example: { body_text: [["Karthick", "Acme"]] } },
        { type: "FOOTER", text: "AI | Automation" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes, interested" }, { type: "QUICK_REPLY", text: "Not now" }] },
      ],
    });
  });

  it("text and media headers", () => {
    const text = createMetaTemplateInput.parse({ ...base, headerType: "TEXT", headerText: "Kagzso" });
    expect(buildMetaTemplatePayload(text).components[0]).toEqual({ type: "HEADER", format: "TEXT", text: "Kagzso" });
    const img = createMetaTemplateInput.parse({ ...base, headerType: "IMAGE" });
    expect(buildMetaTemplatePayload(img, "4::handle").components[0]).toEqual({ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::handle"] } });
  });

  it("registers the row with field names in the preview", () => {
    const row = dispatchRowForCreated(createMetaTemplateInput.parse(base));
    expect(row).toEqual({
      name: "Company Intro",
      providerTemplateName: "kagzso_company_intro_v2",
      languageCode: "en",
      body: "Hi {{first_name}}, this is Kagzso. We help {{business_name}} save time. Reply below.",
      variables: ["first_name", "business_name"],
      buttonLabels: ["Yes, interested", "Not now"],
    });
  });

  it("website, phone and WhatsApp-call buttons: custom ones first, each with only its own fields", () => {
    const v = createMetaTemplateInput.parse({
      ...base,
      buttons: [
        { type: "URL", text: "Visit website", url: "https://kagzso.com", phone_number: "ignored" },
        "Need help?",
        { type: "PHONE_NUMBER", text: "Call us", phone_number: "+91 98765-43210" },
        { type: "VOICE_CALL", text: "Call on WhatsApp" },
        { type: "QUICK_REPLY", text: "Not now" },
      ],
    });
    expect(buildMetaTemplatePayload(v).components.at(-1)).toEqual({
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Need help?" },
        { type: "QUICK_REPLY", text: "Not now" },
        { type: "URL", text: "Visit website", url: "https://kagzso.com" },
        { type: "PHONE_NUMBER", text: "Call us", phone_number: "+919876543210" },
        { type: "VOICE_CALL", text: "Call on WhatsApp" },
      ],
    });
    expect(dispatchRowForCreated(v).buttonLabels).toEqual(["Need help?", "Not now", "Visit website", "Call us", "Call on WhatsApp"]);
  });

  it.each([
    [{ buttons: [{ type: "URL", text: "Open", url: "kagzso.com" }] }, /full website address/],
    [{ buttons: [{ type: "URL", text: "Open", url: "https://kagzso.com/{{1}}" }] }, /without variables/],
    [{ buttons: [{ type: "PHONE_NUMBER", text: "Call", phone_number: "9876543210" }] }, /country code/],
    [{ buttons: [1, 2, 3].map((n) => ({ type: "URL", text: `Site ${n}`, url: `https://k${n}.com` })) }, /at most 2 \W+Visit website/],
    [{ buttons: [{ type: "VOICE_CALL", text: "Call A" }, { type: "VOICE_CALL", text: "Call B" }] }, /at most 1 \W+Call on WhatsApp/],
    [{ buttons: [{ type: "COPY_CODE", text: "Copy" }] }, /invalid_union_discriminator|Invalid discriminator/],
  ])("rejects buttons %o", (over, msg) => {
    const r = createMetaTemplateInput.safeParse({ ...base, ...over });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(msg);
  });

  it.each([
    [{ name: "Company Intro" }, /lowercase/],
    [{ body: "Hi {{2}}, hello {{1}} there." }, /in order/],
    [{ variables: [{ field: "first_name", example: "K" }] }, /2 variable/],
    [{ body: "{{1}} welcome to Kagzso", variables: [{ field: "first_name", example: "K" }] }, /start or end/],
    [{ body: "Welcome to Kagzso, {{1}}", variables: [{ field: "first_name", example: "K" }] }, /start or end/],
    [{ headerType: "TEXT" }, /header text/],
    [{ headerType: "TEXT", headerText: "Hi {{1}}" }, /Header variables/],
    [{ buttons: ["Yes", "yes"] }, /different/],
    [{ buttons: Array.from({ length: 11 }, (_, i) => `B${i}`) }, /At most 10/],
    [{ footer: "x".repeat(61) }, /60 characters/],
  ])("rejects %o", (over, msg) => {
    const r = createMetaTemplateInput.safeParse({ ...base, ...over });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(msg);
  });

  it("toMetaTemplateName makes a valid Meta name", () => {
    expect(toMetaTemplateName("Company Intro!  v2")).toBe("company_intro_v2");
  });
});

describe("Meta → Dispatch import planning", () => {
  const body = (text: string) => ({ type: "BODY", text });
  it("maps {{1}} → first name, {{2}} → business name, quick replies in order", () => {
    const p = planMetaImport({
      name: "kagzso_services_intro",
      language: "en",
      components: [
        { type: "HEADER", format: "IMAGE" },
        body("Hi {{1}}, we help {{2}}."),
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes, interested" }, { type: "QUICK_REPLY", text: "Not now" }] },
      ],
    });
    expect(p).toEqual({
      ok: true,
      row: {
        name: "Kagzso Services Intro",
        providerTemplateName: "kagzso_services_intro",
        languageCode: "en",
        body: "Hi {{first_name}}, we help {{business_name}}.",
        variables: ["first_name", "business_name"],
        buttonLabels: ["Yes, interested", "Not now"],
      },
      warnings: ["Add the header image on the templates page before sending"],
    });
  });

  it.each([
    [{ parameter_format: "NAMED", components: [body("Hi {{name}}")] }, /named variables/],
    [{ components: [body("{{1}} {{2}} {{3}}")] }, /3 variables/],
    [{ components: [{ type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, body("x")] }, /Header has a variable/],
    [{ components: [{ type: "HEADER", format: "LOCATION" }, body("x")] }, /Location/],
    [{ components: [body("x"), { type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://k.com/{{1}}" }] }] }, /URL button/],
    [{ components: [] }, /No body/],
  ])("refuses templates Dispatch can't send: %o", (t, reason) => {
    const p = planMetaImport({ name: "x", language: "en", ...t });
    expect(p.ok).toBe(false);
    expect(p.ok ? "" : p.reason).toMatch(reason);
  });
});

describe("registered template follows Meta", () => {
  const meta = (text: string, buttons: { type: string; text: string; url?: string }[] = []) => ({
    name: "kagzso_ai_automation_intro",
    language: "en",
    components: [{ type: "BODY", text }, ...(buttons.length ? [{ type: "BUTTONS", buttons }] : [])],
  });
  const row = { body: "Hi {{first_name}}, meet Kagzso AI.", variables: ["first_name"], buttonLabels: ["Need help?"] };

  it("already matching → no changes", () => {
    expect(planMetaUpdate(row, meta("Hi {{1}}, meet Kagzso AI.", [{ type: "QUICK_REPLY", text: "Need help?" }]))).toMatchObject({ ok: true, changes: [] });
  });

  it("lists what differs and takes Meta's body and buttons", () => {
    const p = planMetaUpdate(
      row,
      meta("Hi {{1}}, meet Kagzso AI automation.", [
        { type: "QUICK_REPLY", text: "Need help?" },
        { type: "URL", text: "Visit website", url: "https://kagzso.com" },
      ]),
    );
    expect(p).toEqual({
      ok: true,
      changes: ["Body", "Buttons"],
      row: { body: "Hi {{first_name}}, meet Kagzso AI automation.", variables: ["first_name"], buttonLabels: ["Need help?", "Visit website"] },
      warnings: [],
    });
  });

  it("keeps the field each {{n}} is filled from (e.g. full name, or a 3rd variable the row already maps)", () => {
    const custom = { body: "Dear {{full_name}} of {{business_name}} ({{phone}})", variables: ["full_name", "business_name", "phone"], buttonLabels: [] };
    const p = planMetaUpdate(custom, meta("Dear {{1}} from {{2}} ({{3}})"));
    expect(p).toMatchObject({ ok: true, changes: ["Body"], row: { body: "Dear {{full_name}} from {{business_name}} ({{phone}})", variables: ["full_name", "business_name", "phone"] } });
  });

  it("refuses what Dispatch can't send, with the reason", () => {
    const p = planMetaUpdate(row, meta("Hi {{1}}", [{ type: "URL", text: "Open", url: "https://k.com/{{1}}" }]));
    expect(p.ok).toBe(false);
    expect(p.ok ? "" : p.reason).toMatch(/URL button/);
  });
});

/* ------------------------------------------------------------------ flows (mocked Meta + DB) */

type Row = Record<string, any>;
const templates: Row[] = [];
let seq = 0;
vi.mock("../src/prisma.js", () => ({
  prisma: {
    whatsAppTemplate: {
      findMany: async () => templates.map((t) => ({ ...t })),
      findFirst: async ({ where }: Row) => templates.find((t) => t.providerTemplateName === where.providerTemplateName && t.languageCode === where.languageCode) ?? null,
      create: async ({ data }: Row) => {
        const row = { id: `t${++seq}`, ...data };
        templates.push(row);
        return row;
      },
      update: async ({ where, data }: Row) => Object.assign(templates.find((t) => t.id === where.id)!, data),
    },
  },
}));
const meta = {
  listMessageTemplates: vi.fn(async (): Promise<any[]> => []),
  createMessageTemplate: vi.fn(async (_p: any) => ({ id: "meta-123", status: "PENDING" })),
  uploadTemplateExample: vi.fn(async (_f: any) => "4::handle"),
};
vi.mock("../src/services/whatsapp.js", async (orig) => ({ ...(await orig<object>()), ...meta }));
const setTemplateHeaderMedia = vi.fn(async () => ({}));
vi.mock("../src/domain/whatsappTemplateHeader.js", () => ({ setTemplateHeaderMedia }));
vi.mock("../src/domain/whatsappTemplateVerify.js", () => ({ resetTemplateVerifyCache: vi.fn() }));

const { findNewMetaTemplates, importMetaTemplates, createTemplateInMeta, findChangedMetaTemplates, updateFromMetaTemplates } = await import(
  "../src/domain/whatsappTemplateSync.js"
);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64)]);

beforeEach(() => {
  templates.length = 0;
  vi.clearAllMocks();
  templates.push({ id: "old", name: "Company Intro", providerTemplateName: "kagzso_company_intro", languageCode: "en" });
  meta.listMessageTemplates.mockResolvedValue([
    { name: "kagzso_company_intro", language: "en", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}" }] },
    { name: "kagzso_offer", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hi {{1}}, offer." }] },
    { name: "kagzso_offer", language: "ta", status: "PENDING", components: [{ type: "BODY", text: "வணக்கம் {{1}}" }] },
    { name: "kagzso_named", language: "en", parameter_format: "NAMED", components: [{ type: "BODY", text: "Hi {{first}}" }] },
  ]);
});

describe("Sync from Meta", () => {
  it("lists only templates not registered yet, with why any can't be imported", async () => {
    const list = await findNewMetaTemplates();
    expect(list.map((c) => [c.name, c.language, c.importable])).toEqual([
      ["kagzso_named", "en", false],
      ["kagzso_offer", "en", true],
      ["kagzso_offer", "ta", true],
    ]);
  });

  it("imports the importable ones as new rows; never touches existing rows", async () => {
    const r = await importMetaTemplates();
    expect(r.imported.map((i) => [i.providerTemplateName, i.languageCode])).toEqual([
      ["kagzso_offer", "en"],
      ["kagzso_offer", "ta"],
    ]);
    expect(r.skipped).toEqual([{ name: "kagzso_named", language: "en", reason: expect.stringMatching(/named/) }]);
    expect(templates.find((t) => t.id === "old")).toEqual({ id: "old", name: "Company Intro", providerTemplateName: "kagzso_company_intro", languageCode: "en" });
    // Running it again imports nothing.
    expect((await importMetaTemplates()).imported).toHaveLength(0);
  });

  it("can import a chosen subset", async () => {
    const r = await importMetaTemplates([{ name: "kagzso_offer", language: "ta" }]);
    expect(r.imported.map((i) => i.languageCode)).toEqual(["ta"]);
  });
});

describe("Update from Meta", () => {
  beforeEach(() => {
    Object.assign(templates[0]!, { body: "Hello {{full_name}}", variables: ["full_name"], buttonLabels: [] });
    templates.push({ id: "same", name: "Offer", providerTemplateName: "kagzso_offer", languageCode: "en", body: "Hi {{first_name}}, offer.", variables: ["first_name"], buttonLabels: [] });
    templates.push({ id: "gone", name: "Gone", providerTemplateName: "kagzso_gone", languageCode: "en", body: "x", variables: [], buttonLabels: [] });
  });

  it("lists only registered templates that differ from Meta, with what differs", async () => {
    const list = await findChangedMetaTemplates();
    expect(list).toEqual([
      expect.objectContaining({ id: "old", changes: ["Body"], updatable: true, metaBody: "Hi {{full_name}}", status: "APPROVED" }),
    ]);
  });

  it("updates only the picked rows: body follows Meta, field choice, name and id stay", async () => {
    const r = await updateFromMetaTemplates(["old", "same", "gone"], "admin@x");
    expect(r.updated).toEqual([{ id: "old", name: "Company Intro", changes: ["Body"] }]);
    expect(r.skipped).toEqual([{ id: "gone", name: "Gone", reason: expect.stringMatching(/Not found in Meta/) }]);
    expect(templates.find((t) => t.id === "old")).toMatchObject({ name: "Company Intro", body: "Hi {{full_name}}", variables: ["full_name"] });
    expect(templates.find((t) => t.id === "same")).toMatchObject({ body: "Hi {{first_name}}, offer." });
    expect(await findChangedMetaTemplates()).toEqual([]);
  });
});

describe("Create in Meta", () => {
  it("submits, then registers the row", async () => {
    const out = await createTemplateInMeta(createMetaTemplateInput.parse(base), null, "admin@x");
    expect(meta.createMessageTemplate).toHaveBeenCalledTimes(1);
    expect(meta.uploadTemplateExample).not.toHaveBeenCalled();
    expect(out.meta).toEqual({ id: "meta-123", status: "PENDING" });
    expect(templates.at(-1)).toMatchObject({ providerTemplateName: "kagzso_company_intro_v2", variables: ["first_name", "business_name"] });
  });

  it("image header: uploads the example, sends its handle, keeps the file as header media", async () => {
    await createTemplateInMeta(createMetaTemplateInput.parse({ ...base, headerType: "IMAGE" }), { data: PNG, filename: "banner.png" }, "admin@x");
    expect(meta.uploadTemplateExample).toHaveBeenCalledWith({ data: PNG, mimeType: "image/png", filename: "banner.png" });
    expect((meta.createMessageTemplate.mock.calls[0]![0] as any).components[0]).toEqual({ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::handle"] } });
    expect(setTemplateHeaderMedia).toHaveBeenCalledTimes(1);
  });

  it("refuses before calling Meta: duplicate name, missing / wrong header file", async () => {
    await expect(createTemplateInMeta(createMetaTemplateInput.parse({ ...base, name: "kagzso_company_intro" }), null, "a")).rejects.toMatchObject({ status: 409 });
    await expect(createTemplateInMeta(createMetaTemplateInput.parse({ ...base, headerType: "IMAGE" }), null, "a")).rejects.toThrow(/Attach the header image/);
    await expect(createTemplateInMeta(createMetaTemplateInput.parse({ ...base, headerType: "DOCUMENT" }), { data: MP3, filename: "a.mp3" }, "a")).rejects.toMatchObject({ status: 400 });
    expect(meta.createMessageTemplate).not.toHaveBeenCalled();
    expect(meta.uploadTemplateExample).not.toHaveBeenCalled();
  });

  it("if Meta rejects the template, nothing is registered", async () => {
    meta.createMessageTemplate.mockRejectedValueOnce(new Error("Meta 400 (#100): Invalid parameter"));
    const before = templates.length;
    await expect(createTemplateInMeta(createMetaTemplateInput.parse(base), null, "a")).rejects.toThrow(/Invalid parameter/);
    expect(templates).toHaveLength(before);
  });
});
