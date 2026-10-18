// Two-way WhatsApp template sync.
//
//  Meta → Dispatch: templates in the WABA that aren't registered here yet are
//  listed (with why any can't be used) and imported as new rows on request.
//  Registered rows whose body / variables / buttons differ from their Meta
//  template (same name + language) are listed with what differs, and follow
//  Meta only when an admin picks them. Rows are never deleted.
//
//  Dispatch → Meta: a template built in the "Create in Meta" form is submitted
//  for review (POST /{waba-id}/message_templates) and registered here at once;
//  its badge shows Meta's review status (Pending → Verified / Failed).

import {
  buildMetaTemplatePayload,
  createWhatsAppTemplateInput,
  dispatchRowForCreated,
  planMetaImport,
  planMetaUpdate,
  type CreateMetaTemplateInput,
} from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { createMessageTemplate, listMessageTemplates, uploadTemplateExample } from "../services/whatsapp.js";
import { MediaError, validateOutgoingMedia, type WhatsAppMediaKind } from "./whatsappMedia.js";
import { resetTemplateVerifyCache } from "./whatsappTemplateVerify.js";
import { setTemplateHeaderMedia } from "./whatsappTemplateHeader.js";

export class TemplateSyncError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const key = (name: string, language: string) => `${name}\u0000${language}`;

export interface SyncCandidate {
  name: string;
  language: string;
  status: string | null;
  category: string | null;
  importable: boolean;
  reason: string | null;
  warnings: string[];
  displayName: string | null;
}

/** Meta templates (name + language) not registered in Dispatch yet. */
export async function findNewMetaTemplates(): Promise<SyncCandidate[]> {
  const [meta, rows] = await Promise.all([
    listMessageTemplates(),
    prisma.whatsAppTemplate.findMany({ select: { providerTemplateName: true, languageCode: true } }),
  ]);
  const known = new Set(rows.filter((r) => r.providerTemplateName).map((r) => key(r.providerTemplateName!, r.languageCode)));
  return meta
    .filter((t) => !known.has(key(t.name, t.language)))
    .map((t) => {
      const plan = planMetaImport(t);
      return {
        name: t.name,
        language: t.language,
        status: t.status ?? null,
        category: t.category ?? null,
        importable: plan.ok,
        reason: plan.ok ? null : plan.reason,
        warnings: plan.ok ? plan.warnings : [],
        displayName: plan.ok ? plan.row.name : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Import Meta templates as new rows (all importable new ones, or just `only`).
 * Rows are created exactly like the "Register existing" form does.
 */
export async function importMetaTemplates(only?: { name: string; language: string }[]) {
  const [meta, rows] = await Promise.all([
    listMessageTemplates(),
    prisma.whatsAppTemplate.findMany({ select: { providerTemplateName: true, languageCode: true } }),
  ]);
  const known = new Set(rows.filter((r) => r.providerTemplateName).map((r) => key(r.providerTemplateName!, r.languageCode)));
  const wanted = only ? new Set(only.map((o) => key(o.name, o.language))) : null;
  const imported: { id: string; name: string; providerTemplateName: string; languageCode: string }[] = [];
  const skipped: { name: string; language: string; reason: string }[] = [];
  for (const t of meta) {
    const k = key(t.name, t.language);
    if (known.has(k) || (wanted && !wanted.has(k))) continue;
    const plan = planMetaImport(t);
    if (!plan.ok) {
      skipped.push({ name: t.name, language: t.language, reason: plan.reason });
      continue;
    }
    const row = await prisma.whatsAppTemplate.create({ data: createWhatsAppTemplateInput.parse(plan.row) });
    known.add(k);
    imported.push({ id: row.id, name: row.name, providerTemplateName: row.providerTemplateName!, languageCode: row.languageCode });
  }
  if (imported.length) resetTemplateVerifyCache();
  logger.info({ imported: imported.length, skipped: skipped.length }, "whatsapp templates imported from Meta");
  return { imported, skipped };
}

export interface SyncUpdate {
  id: string;
  name: string;
  providerTemplateName: string;
  languageCode: string;
  status: string | null;
  /** What differs from Meta: "Body", "Variables", "Buttons". */
  changes: string[];
  updatable: boolean;
  reason: string | null;
  warnings: string[];
  /** Meta's version as it would be stored (body with {{field}} names). */
  metaBody: string | null;
  metaButtons: string[];
}

const templateRows = () =>
  prisma.whatsAppTemplate.findMany({
    where: { providerTemplateName: { not: null } },
    select: { id: true, name: true, providerTemplateName: true, languageCode: true, body: true, variables: true, buttonLabels: true },
  });

/** Registered templates whose Meta template (same name + language) now differs from the row. */
export async function findChangedMetaTemplates(): Promise<SyncUpdate[]> {
  const [meta, rows] = await Promise.all([listMessageTemplates(), templateRows()]);
  const byKey = new Map(meta.map((t) => [key(t.name, t.language), t]));
  const out: SyncUpdate[] = [];
  for (const r of rows) {
    const t = byKey.get(key(r.providerTemplateName!, r.languageCode));
    if (!t) continue; // not in Meta (or another language) — the Verify badge reports that
    const plan = planMetaUpdate(r, t);
    if (plan.ok && plan.changes.length === 0) continue;
    out.push({
      id: r.id,
      name: r.name,
      providerTemplateName: r.providerTemplateName!,
      languageCode: r.languageCode,
      status: t.status ?? null,
      changes: plan.ok ? plan.changes : [],
      updatable: plan.ok,
      reason: plan.ok ? null : plan.reason,
      warnings: plan.ok ? plan.warnings : [],
      metaBody: plan.ok ? plan.row.body : null,
      metaButtons: plan.ok ? plan.row.buttonLabels : [],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Make the picked rows follow their Meta template (body, variables, buttons). Name and id stay. */
export async function updateFromMetaTemplates(ids: string[], actorEmail: string) {
  const [meta, rows] = await Promise.all([listMessageTemplates(), templateRows()]);
  const byKey = new Map(meta.map((t) => [key(t.name, t.language), t]));
  const wanted = new Set(ids);
  const updated: { id: string; name: string; changes: string[] }[] = [];
  const skipped: { id: string; name: string; reason: string }[] = [];
  for (const r of rows) {
    if (!wanted.has(r.id)) continue;
    const t = byKey.get(key(r.providerTemplateName!, r.languageCode));
    if (!t) {
      skipped.push({ id: r.id, name: r.name, reason: `Not found in Meta as ${r.providerTemplateName} (${r.languageCode})` });
      continue;
    }
    const plan = planMetaUpdate(r, t);
    if (!plan.ok) {
      skipped.push({ id: r.id, name: r.name, reason: plan.reason });
      continue;
    }
    if (plan.changes.length === 0) continue;
    await prisma.whatsAppTemplate.update({ where: { id: r.id }, data: plan.row });
    updated.push({ id: r.id, name: r.name, changes: plan.changes });
  }
  if (updated.length) resetTemplateVerifyCache();
  logger.info({ updated: updated.map((u) => ({ id: u.id, changes: u.changes })), skipped: skipped.length, by: actorEmail }, "whatsapp templates updated from Meta");
  return { updated, skipped };
}

/** Media a header example may be (Meta's Resumable Upload accepts JPEG, PNG, MP4, PDF). */
const EXAMPLE_TYPES: Record<string, { kind: WhatsAppMediaKind; mimes: string[] }> = {
  IMAGE: { kind: "image", mimes: ["image/jpeg", "image/png"] },
  VIDEO: { kind: "video", mimes: ["video/mp4"] },
  DOCUMENT: { kind: "document", mimes: ["application/pdf"] },
};

/**
 * Submit a template to Meta and register it here. For an image / video /
 * document header the file is uploaded as Meta's review example and also kept
 * as the header media every send uses.
 */
export async function createTemplateInMeta(
  input: CreateMetaTemplateInput,
  file: { data: Buffer; declaredMime?: string | null; filename?: string | null } | null,
  actorEmail: string,
) {
  const exists = await prisma.whatsAppTemplate.findFirst({
    where: { providerTemplateName: input.name, languageCode: input.language },
    select: { id: true },
  });
  if (exists) throw new TemplateSyncError(409, `A template named ${input.name} (${input.language}) is already registered`);

  const media = EXAMPLE_TYPES[input.headerType];
  let handle: string | null = null;
  if (media) {
    if (!file) throw new TemplateSyncError(400, `Attach the header ${media.kind} (Meta needs an example to review)`);
    let v;
    try {
      v = validateOutgoingMedia(file.data, file, [media.kind]);
    } catch (err) {
      if (err instanceof MediaError) throw new TemplateSyncError(400, err.message);
      throw err;
    }
    if (!media.mimes.includes(v.mimeType)) {
      throw new TemplateSyncError(400, `For a ${media.kind} header Meta accepts ${media.mimes.map((m) => m.split("/")[1]!.toUpperCase()).join(" or ")} only`);
    }
    handle = await uploadTemplateExample({ data: file.data, mimeType: v.mimeType, filename: v.filename });
  }

  const meta = await createMessageTemplate(buildMetaTemplatePayload(input, handle));
  const row = await prisma.whatsAppTemplate.create({ data: createWhatsAppTemplateInput.parse(dispatchRowForCreated(input)) });
  if (media && file) await setTemplateHeaderMedia(row.id, file, actorEmail);
  resetTemplateVerifyCache();
  logger.info({ templateId: row.id, metaId: meta.id, name: input.name, status: meta.status, by: actorEmail }, "whatsapp template created in Meta and registered");
  return { template: row, meta };
}
