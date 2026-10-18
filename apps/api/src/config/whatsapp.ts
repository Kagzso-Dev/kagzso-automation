// WhatsApp (Meta WhatsApp Cloud API) configuration — deliberately separate
// from src/env.ts.
//
// This module is fully isolated from the email environment loader: it reads its
// own WHATSAPP_* / META_* variables, never touches EMAIL_*/SMTP_*/SEND_* and,
// crucially, NEVER throws or calls process.exit. Missing or blank credentials
// simply yield `configured: false`, which disables the WhatsApp buttons — email
// sending and app startup are unaffected.

import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { logger } from "../logger.js";

// Same defensive load as src/env.ts. dotenv never overrides already-set vars,
// so calling this again is harmless.
loadEnv();
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

function str(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function intOr(v: string | undefined, fallback: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** WHATSAPP_131049_COOLDOWN_HOURS: whole hours, 0 turns the cooldown off; missing / invalid = 24. */
function cooldownHours(v: string | undefined): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 24;
}

/** "24.0" → "v24.0"; anything already starting with "v" is kept as-is. */
function graphVersion(v: string | undefined): string {
  const t = str(v) ?? "v24.0";
  return t.startsWith("v") ? t : `v${t}`;
}

// Only the Meta Cloud API is supported. The variable exists so a future
// provider can be added without renaming anything.
const provider = (str(process.env.WHATSAPP_PROVIDER) ?? "meta").toLowerCase();
if (provider !== "meta") {
  logger.warn(
    `WHATSAPP_PROVIDER=${provider} is not supported (only "meta") — WhatsApp sending is disabled.`,
  );
}

const defaultCountryCode = (str(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE) ?? "").replace(/\D/g, "");

// Drip pacing between individual WhatsApp sends — its own knobs, independent of
// the email BULK_SEND_* settings.
const rawMin = intOr(process.env.WHATSAPP_MIN_DELAY_SEC, 8);
const rawMax = intOr(process.env.WHATSAPP_MAX_DELAY_SEC, 25);
const minDelaySec = Math.min(rawMin, rawMax);
const maxDelaySec = Math.max(rawMin, rawMax);

export const whatsappConfig = {
  provider,
  graphApiBaseUrl: "https://graph.facebook.com",
  graphApiVersion: graphVersion(process.env.META_GRAPH_API_VERSION),
  accessToken: str(process.env.META_WHATSAPP_ACCESS_TOKEN),
  phoneNumberId: str(process.env.META_WHATSAPP_PHONE_NUMBER_ID),
  wabaId: str(process.env.META_WHATSAPP_WABA_ID),
  webhookVerifyToken: str(process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN),
  appSecret: str(process.env.META_WHATSAPP_APP_SECRET),
  defaultCountryCode: defaultCountryCode || undefined,
  minDelaySec,
  maxDelaySec,
  /**
   * After Meta refuses a marketing template to a number with 131049 ("healthy
   * ecosystem"), skip further marketing templates to it for this many hours
   * (0 = off). Nothing is retried automatically; the contact is never changed.
   */
  marketingCooldownHours: cooldownHours(process.env.WHATSAPP_131049_COOLDOWN_HOURS),
  /**
   * Private folder for WhatsApp media (template headers, customer files, reply
   * attachments). Never served statically — only through authenticated routes.
   * Relative paths resolve from the process working directory, like UPLOADS_DIR.
   */
  mediaDir: str(process.env.WHATSAPP_MEDIA_DIR) ?? ".whatsapp-media",
} as const;

/** True only when the Meta Cloud API can actually be called from .env alone. */
export function isWhatsAppConfigured(): boolean {
  return Boolean(
    whatsappConfig.provider === "meta" && whatsappConfig.accessToken && whatsappConfig.phoneNumberId,
  );
}
