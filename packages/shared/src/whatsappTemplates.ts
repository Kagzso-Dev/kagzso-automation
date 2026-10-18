import { z } from "zod";

/* ------------------------------------------------------------------ WhatsApp templates ↔ Meta */
// Shared by the "Create in Meta" form and the API: validation, the Graph API
// payload for POST /{waba-id}/message_templates, and turning a template that
// exists in Meta into a Dispatch row (Sync from Meta). Positional parameters
// ({{1}}, {{2}} …) only — that is what Dispatch sends.

/** Recipient fields a template variable can be filled from (see buildWhatsAppVars). */
export const DISPATCH_TEMPLATE_FIELDS = ["first_name", "last_name", "full_name", "business_name", "phone"] as const;
export type DispatchTemplateField = (typeof DISPATCH_TEMPLATE_FIELDS)[number];

/** Template languages offered in the form (Meta codes; others can be typed). */
export const META_TEMPLATE_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "hi", label: "Hindi" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "kn", label: "Kannada" },
  { code: "ml", label: "Malayalam" },
  { code: "mr", label: "Marathi" },
  { code: "bn", label: "Bengali" },
  { code: "gu", label: "Gujarati" },
  { code: "pa", label: "Punjabi" },
  { code: "ur", label: "Urdu" },
  { code: "ar", label: "Arabic" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt_BR", label: "Portuguese (BR)" },
  { code: "id", label: "Indonesian" },
  { code: "ms", label: "Malay" },
];

export const TEMPLATE_HEADER_TYPES = ["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"] as const;
export type TemplateHeaderType = (typeof TEMPLATE_HEADER_TYPES)[number];

/**
 * Button types the create form offers, as in Meta's "Add button" menu. All of
 * them send with no per-message value, so Dispatch can send the template as is.
 * Meta's other types (Copy offer code, Complete flow, dynamic website links)
 * need a value on every send, which Dispatch doesn't supply yet.
 */
export const TEMPLATE_BUTTON_TYPES = ["QUICK_REPLY", "URL", "PHONE_NUMBER", "VOICE_CALL"] as const;
export type TemplateButtonType = (typeof TEMPLATE_BUTTON_TYPES)[number];

/** Meta's per-type caps (10 buttons in all). */
export const TEMPLATE_BUTTON_LIMITS: Record<TemplateButtonType, number> = { QUICK_REPLY: 10, URL: 2, PHONE_NUMBER: 1, VOICE_CALL: 1 };

const PLACEHOLDER_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Every {{…}} in a text, in order of appearance (inner text trimmed). */
export function placeholdersIn(text: string): string[] {
  return [...String(text ?? "").matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
}

/** "Company Intro!" → "company_intro" (Meta template names: a-z, 0-9, _). */
export function toMetaTemplateName(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
}

/** "kagzso_company_intro" → "Kagzso Company Intro". */
export function humanizeTemplateName(name: string): string {
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 160);
}

const buttonText = z.string().trim().min(1, "Enter the button text").max(25, "Button text can be at most 25 characters");

/** One template button. A plain string is a quick reply (the form's original shape). */
export const templateButtonInput = z.preprocess(
  (b) => (typeof b === "string" ? { type: "QUICK_REPLY", text: b } : b),
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("QUICK_REPLY"), text: buttonText }),
    z.object({
      type: z.literal("URL"),
      text: buttonText,
      url: z
        .string()
        .trim()
        .max(2000)
        .regex(/^https?:\/\/[^\s{}]+\.[^\s{}]+$/i, "Enter a full website address without variables, e.g. https://kagzso.com"),
    }),
    z.object({
      type: z.literal("PHONE_NUMBER"),
      text: buttonText,
      phone_number: z
        .string()
        .trim()
        .transform((s) => s.replace(/[\s-]/g, ""))
        .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, "Enter the phone number with country code, e.g. +919876543210")),
    }),
    z.object({ type: z.literal("VOICE_CALL"), text: buttonText }),
  ]),
);
export type TemplateButton = z.infer<typeof templateButtonInput>;

/**
 * Meta requires quick replies and the other buttons in two separate groups, so
 * quick replies go first, each group in the order they were added. Used for
 * the Graph payload and the form preview alike.
 */
export function orderTemplateButtons<T extends { type: string }>(buttons: T[]): T[] {
  return [...buttons.filter((b) => b.type === "QUICK_REPLY"), ...buttons.filter((b) => b.type !== "QUICK_REPLY")];
}

export const createMetaTemplateInput = z
  .object({
    /** Name shown in Dispatch. */
    displayName: z.string().trim().min(1, "Enter a name").max(160),
    /** Meta template name. */
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{1,512}$/, "Meta template names use lowercase letters, digits and underscores only"),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(_[A-Za-z]{2,4})?$/, "Enter a Meta language code, e.g. en or en_US"),
    category: z.enum(["MARKETING", "UTILITY"]),
    headerType: z.enum(TEMPLATE_HEADER_TYPES).default("NONE"),
    headerText: z.string().trim().max(60, "Header text can be at most 60 characters").optional().nullable(),
    body: z.string().trim().min(1, "Enter the message body").max(1024, "The body can be at most 1024 characters"),
    /** One entry per {{n}} in the body, in order: which recipient field fills it + an example for Meta's review. */
    variables: z
      .array(
        z.object({
          field: z.enum(DISPATCH_TEMPLATE_FIELDS),
          example: z.string().trim().min(1, "Give an example value for every variable").max(200),
        }),
      )
      .max(10)
      .default([]),
    footer: z.string().trim().max(60, "The footer can be at most 60 characters").optional().nullable(),
    buttons: z.array(templateButtonInput).max(10, "At most 10 buttons").default([]),
  })
  .superRefine((v, ctx) => {
    const ph = placeholdersIn(v.body);
    const expected = ph.map((_, i) => String(i + 1));
    if (ph.some((p, i) => p !== expected[i])) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "Use numbered variables in order: {{1}}, {{2}}, {{3}} …" });
    } else if (ph.length !== v.variables.length) {
      ctx.addIssue({ code: "custom", path: ["variables"], message: `The body has ${ph.length} variable(s); fill in each one` });
    }
    if (ph.length && (/^\s*\{\{/.test(v.body) || /\}\}\s*[.!?]?\s*$/.test(v.body))) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "Meta doesn't allow a variable at the very start or end of the body" });
    }
    if (v.headerType === "TEXT") {
      if (!v.headerText) ctx.addIssue({ code: "custom", path: ["headerText"], message: "Enter the header text" });
      else if (placeholdersIn(v.headerText).length) {
        ctx.addIssue({ code: "custom", path: ["headerText"], message: "Header variables aren't supported — use fixed text" });
      }
    }
    if (new Set(v.buttons.map((b) => b.text.toLowerCase())).size !== v.buttons.length) {
      ctx.addIssue({ code: "custom", path: ["buttons"], message: "Button texts must be different" });
    }
    const LABEL: Record<TemplateButtonType, string> = {
      QUICK_REPLY: "custom",
      URL: "Visit website",
      PHONE_NUMBER: "Call phone number",
      VOICE_CALL: "Call on WhatsApp",
    };
    for (const t of TEMPLATE_BUTTON_TYPES) {
      const max = TEMPLATE_BUTTON_LIMITS[t];
      if (max < 10 && v.buttons.filter((b) => b.type === t).length > max) {
        ctx.addIssue({ code: "custom", path: ["buttons"], message: `Meta allows at most ${max} "${LABEL[t]}" button${max > 1 ? "s" : ""}` });
      }
    }
  });
export type CreateMetaTemplateInput = z.infer<typeof createMetaTemplateInput>;

/** Graph API body for POST /{waba-id}/message_templates. `headerHandle` is required for media headers. */
export function buildMetaTemplatePayload(v: CreateMetaTemplateInput, headerHandle?: string | null) {
  const components: Record<string, unknown>[] = [];
  if (v.headerType === "TEXT") components.push({ type: "HEADER", format: "TEXT", text: v.headerText });
  else if (v.headerType !== "NONE") components.push({ type: "HEADER", format: v.headerType, example: { header_handle: [headerHandle] } });
  components.push({
    type: "BODY",
    text: v.body,
    ...(v.variables.length ? { example: { body_text: [v.variables.map((x) => x.example)] } } : {}),
  });
  if (v.footer) components.push({ type: "FOOTER", text: v.footer });
  if (v.buttons.length) components.push({ type: "BUTTONS", buttons: orderTemplateButtons(v.buttons) });
  return { name: v.name, language: v.language, category: v.category, parameter_format: "POSITIONAL", components };
}

/** The Dispatch row a created template is registered as (body uses {{field}} names for the preview). */
export function dispatchRowForCreated(v: CreateMetaTemplateInput) {
  return {
    name: v.displayName,
    providerTemplateName: v.name,
    languageCode: v.language,
    body: v.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => `{{${v.variables[Number(n) - 1]?.field ?? n}}}`),
    variables: v.variables.map((x) => x.field),
    buttonLabels: orderTemplateButtons(v.buttons).map((b) => b.text),
  };
}

/* ------------------------------------------------------------------ Meta → Dispatch (sync) */

export interface MetaTemplateLike {
  name: string;
  language: string;
  status?: string;
  category?: string;
  parameter_format?: string;
  components?: { type: string; format?: string; text?: string; buttons?: { type: string; text?: string; url?: string }[] }[];
}

/** Position → recipient field for templates imported from Meta: {{1}} first name, {{2}} business name. */
const IMPORT_FIELDS: Record<string, DispatchTemplateField> = { "1": "first_name", "2": "business_name" };

export type MetaImportPlan =
  | {
      ok: true;
      row: { name: string; providerTemplateName: string; languageCode: string; body: string; variables: string[]; buttonLabels: string[] };
      warnings: string[];
    }
  | { ok: false; reason: string };

/**
 * How a Meta template becomes a Dispatch row: exact name + language, the body
 * with {{1}} → {{first_name}}, {{2}} → {{business_name}}, quick-reply buttons in
 * order. Templates Dispatch can't send correctly are refused with the reason.
 */
export function planMetaImport(t: MetaTemplateLike, fields: Record<string, DispatchTemplateField> = IMPORT_FIELDS): MetaImportPlan {
  const comps = t.components ?? [];
  const body = comps.find((c) => c.type?.toUpperCase() === "BODY")?.text ?? "";
  if (!body) return { ok: false, reason: "No body text" };
  const ph = placeholdersIn(body);
  if ((t.parameter_format ?? "").toUpperCase() === "NAMED" || ph.some((p) => !/^\d+$/.test(p))) {
    return { ok: false, reason: "Uses named variables ({{name}}) — Dispatch sends numbered variables only" };
  }
  const positions = [...new Set(ph)].sort((a, b) => Number(a) - Number(b));
  if (positions.some((p) => !fields[p])) {
    return { ok: false, reason: `Has ${positions.length} variables — Dispatch can fill {{1}} (first name) and {{2}} (business name)` };
  }
  const warnings: string[] = [];
  const header = comps.find((c) => c.type?.toUpperCase() === "HEADER");
  const hf = (header?.format ?? "").toUpperCase();
  if (hf === "TEXT" && placeholdersIn(header?.text ?? "").length) return { ok: false, reason: "Header has a variable — not supported yet" };
  if (hf === "LOCATION") return { ok: false, reason: "Location headers aren't supported yet" };
  if (["IMAGE", "VIDEO", "DOCUMENT"].includes(hf)) warnings.push(`Add the header ${hf.toLowerCase()} on the templates page before sending`);
  const buttons = comps.find((c) => c.type?.toUpperCase() === "BUTTONS")?.buttons ?? [];
  if (buttons.some((b) => b.type?.toUpperCase() === "URL" && placeholdersIn(b.url ?? "").length)) {
    return { ok: false, reason: "Has a URL button with a variable — not supported yet" };
  }
  const known = (b: { type: string }) => (TEMPLATE_BUTTON_TYPES as readonly string[]).includes((b.type ?? "").toUpperCase());
  if (buttons.some((b) => !known(b))) warnings.push("Only custom, website and call buttons are listed; other buttons still show in WhatsApp");
  return {
    ok: true,
    row: {
      name: humanizeTemplateName(t.name),
      providerTemplateName: t.name,
      languageCode: t.language,
      body: body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => `{{${fields[n] ?? n}}}`),
      variables: positions.map((p) => fields[p]!),
      buttonLabels: buttons.filter((b) => known(b) && b.text).map((b) => b.text!).slice(0, 10),
    },
    warnings,
  };
}

export type MetaUpdatePlan =
  | { ok: true; changes: string[]; row: { body: string; variables: string[]; buttonLabels: string[] }; warnings: string[] }
  | { ok: false; reason: string };

/**
 * How a registered row follows its Meta template (same name + language): body,
 * variables and buttons are taken from Meta, while each {{n}} keeps the
 * recipient field the row already fills it from. `changes` lists what differs
 * ("Body", "Variables", "Buttons"); empty means the row already matches Meta.
 * The row's name, id and send history are never part of it.
 */
export function planMetaUpdate(
  existing: { body: string; variables: unknown; buttonLabels: unknown },
  t: MetaTemplateLike,
): MetaUpdatePlan {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const fields: Record<string, DispatchTemplateField> = { ...IMPORT_FIELDS };
  list(existing.variables).forEach((f, i) => {
    if ((DISPATCH_TEMPLATE_FIELDS as readonly string[]).includes(f)) fields[String(i + 1)] = f as DispatchTemplateField;
  });
  const plan = planMetaImport(t, fields);
  if (!plan.ok) return plan;
  const { body, variables, buttonLabels } = plan.row;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const changes = [
    ...(body !== existing.body ? ["Body"] : []),
    ...(!same(variables, list(existing.variables)) ? ["Variables"] : []),
    ...(!same(buttonLabels, list(existing.buttonLabels)) ? ["Buttons"] : []),
  ];
  return { ok: true, changes, row: { body, variables, buttonLabels }, warnings: plan.warnings };
}
