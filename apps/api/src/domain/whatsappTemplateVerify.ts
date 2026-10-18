// "Is this registered WhatsApp template really approved in Meta?" — display only.
//
// Compares each whatsapp_templates row (providerTemplateName + languageCode) with
// the WABA's message templates from the Graph API. Nothing here changes a row,
// the send path or the queue: sending works exactly as before whatever this says.
//
// Meta's list is cached for CACHE_MS so page renders don't hit the Graph API; the
// match itself is recomputed on every request, so edits to a row show at once.

import { prisma } from "../prisma.js";
import { listMessageTemplates, type MetaMessageTemplate } from "../services/whatsapp.js";

export type TemplateVerifyStatus = "verified" | "pending" | "failed" | "not_found" | "unchecked";

export interface TemplateVerification {
  id: string;
  status: TemplateVerifyStatus;
  /** Meta's raw status for the matching name + language, when there is one. */
  metaStatus: string | null;
  /** Human-readable why: Meta's status / category, the languages that do exist, or the Meta error. */
  reason: string;
  /**
   * The matching Meta template has a header that a send must fill in — "IMAGE",
   * "VIDEO", "DOCUMENT", "LOCATION", or "TEXT" for a header with a {{variable}}.
   * Dispatch sends body parameters only, so such a template can't be sent yet.
   * Null for no header or a static text header (Meta adds that by itself).
   */
  headerNeedsParameter: string | null;
}

/** See TemplateVerification.headerNeedsParameter. */
export function headerNeedingParameter(t: Pick<MetaMessageTemplate, "components">): string | null {
  const header = (t.components ?? []).find((c) => (c.type ?? "").toUpperCase() === "HEADER");
  if (!header) return null;
  const format = (header.format ?? "TEXT").toUpperCase();
  if (format !== "TEXT") return format;
  return /\{\{\s*\d+\s*\}\}/.test(header.text ?? "") ? "TEXT" : null;
}

interface Row {
  id: string;
  providerTemplateName: string | null;
  languageCode: string;
}

const PENDING = new Set(["PENDING", "IN_APPEAL"]);

/**
 * Pure matching. `meta` is Meta's template list, or an Error when it couldn't be
 * fetched — then every row is "unchecked" (it says nothing about the template).
 * Names and languages match exactly ("en" ≠ "en_US", as in Meta).
 */
export function verifyTemplates(rows: Row[], meta: MetaMessageTemplate[] | Error): TemplateVerification[] {
  return rows.map((row) => {
    const name = row.providerTemplateName?.trim();
    if (!name) return { id: row.id, status: "unchecked", metaStatus: null, reason: "No Meta template name set", headerNeedsParameter: null };
    if (meta instanceof Error) return { id: row.id, status: "unchecked", metaStatus: null, reason: meta.message, headerNeedsParameter: null };

    const sameName = meta.filter((t) => t.name === name);
    if (sameName.length === 0) {
      return {
        id: row.id,
        status: "not_found",
        metaStatus: null,
        reason: `No template named "${name}" in this WhatsApp Business Account`,
        headerNeedsParameter: null,
      };
    }
    const match = sameName.find((t) => t.language === row.languageCode);
    if (!match) {
      const langs = [...new Set(sameName.map((t) => t.language))].sort().join(", ");
      return {
        id: row.id,
        status: "failed",
        metaStatus: null,
        reason: `Exists in Meta only in ${langs}, not in "${row.languageCode}"`,
        headerNeedsParameter: null,
      };
    }
    const metaStatus = (match.status ?? "").toUpperCase();
    const detail = `Meta status ${metaStatus || "unknown"}${match.category ? ` · ${match.category}` : ""}`;
    const headerNeedsParameter = headerNeedingParameter(match);
    if (metaStatus === "APPROVED") return { id: row.id, status: "verified", metaStatus, reason: detail, headerNeedsParameter };
    if (PENDING.has(metaStatus)) return { id: row.id, status: "pending", metaStatus, reason: detail, headerNeedsParameter };
    // REJECTED, PAUSED, DISABLED, and anything else Meta may add (LIMIT_EXCEEDED, DELETED, …).
    return { id: row.id, status: "failed", metaStatus, reason: detail, headerNeedsParameter };
  });
}

export const CACHE_MS = 5 * 60_000;
const MIN_REFRESH_MS = 10_000; // a forced refresh can't hammer Meta faster than this

let cache: { at: number; meta: MetaMessageTemplate[] | Error } | null = null;

/** Test hook. */
export function resetTemplateVerifyCache() {
  cache = null;
}

/** Meta's template list, cached for CACHE_MS (an Error when Meta couldn't be read). */
async function metaTemplates(refresh = false): Promise<MetaMessageTemplate[] | Error> {
  const now = Date.now();
  const stale = !cache || now - cache.at > CACHE_MS || (refresh && now - cache.at > MIN_REFRESH_MS);
  if (stale) {
    let meta: MetaMessageTemplate[] | Error;
    try {
      meta = await listMessageTemplates();
    } catch (err) {
      // The message is already token-redacted (services/whatsapp.ts) and includes Meta's code / fbtrace_id.
      meta = err instanceof Error ? err : new Error(String(err));
    }
    cache = { at: now, meta };
  }
  return cache!.meta;
}

/** Meta's category for a template ("MARKETING", "UTILITY" …), or null when unknown / Meta unreachable. */
export async function metaTemplateCategory(name: string, language: string): Promise<string | null> {
  const meta = await metaTemplates();
  if (meta instanceof Error) return null;
  return meta.find((t) => t.name === name && t.language === language)?.category?.toUpperCase() ?? null;
}

/** Verification for every registered template. `refresh` re-reads Meta (at most every 10 s). */
export async function getTemplateVerification(refresh = false) {
  await metaTemplates(refresh);
  const rows = await prisma.whatsAppTemplate.findMany({
    select: { id: true, providerTemplateName: true, languageCode: true },
  });
  return {
    checkedAt: new Date(cache!.at).toISOString(),
    /** Set when Meta couldn't be reached / refused us: every named row is then "unchecked". */
    error: cache!.meta instanceof Error ? cache!.meta.message : null,
    items: verifyTemplates(rows, cache!.meta),
  };
}
