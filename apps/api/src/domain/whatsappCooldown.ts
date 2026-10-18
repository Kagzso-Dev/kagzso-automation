// Meta 131049 ("healthy ecosystem engagement"): Meta refused a marketing template to
// a number because it got too many recently. Sending more marketing templates soon
// after only fails again, so a drip batch skips that number until the cooldown is
// over (WHATSAPP_131049_COOLDOWN_HOURS, default 24). Nothing is retried
// automatically and the contact row is never touched — it stays listed and can be
// sent to manually once the cooldown is over, or with a non-marketing template.

import { prisma } from "../prisma.js";
import { whatsappConfig } from "../config/whatsapp.js";
import { metaTemplateCategory } from "./whatsappTemplateVerify.js";

export const ECOSYSTEM_LIMIT_CODE = "131049";

/**
 * When the cooldown for `phone` ends, or null when this template may be sent now.
 * Applies to MARKETING templates, and to templates whose category Meta can't tell
 * us right now (they would most likely fail the same way).
 */
export async function marketingCooldownUntil(
  phone: string,
  template: { providerTemplateName: string | null; languageCode: string },
  now = new Date(),
): Promise<Date | null> {
  const hours = whatsappConfig.marketingCooldownHours;
  if (!hours || !phone) return null;
  const windowMs = hours * 60 * 60 * 1000;
  const last = await prisma.whatsAppSend.findFirst({
    where: { phone, errorCode: ECOSYSTEM_LIMIT_CODE, failedAt: { gte: new Date(now.getTime() - windowMs) } },
    orderBy: { failedAt: "desc" },
    select: { failedAt: true },
  });
  if (!last?.failedAt) return null;
  if (template.providerTemplateName) {
    const category = await metaTemplateCategory(template.providerTemplateName, template.languageCode);
    if (category && category !== "MARKETING") return null;
  }
  return new Date(last.failedAt.getTime() + windowMs);
}
