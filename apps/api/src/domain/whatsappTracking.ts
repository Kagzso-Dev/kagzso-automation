// Applies WhatsApp delivery-status events (from the Meta webhook) to the
// whatsapp_sends ledger. Mirrors domain/tracking.ts (email) in shape, but kept
// separate on purpose: WhatsApp send/tracking code never imports from the
// email tree.

import type { WhatsAppSendStatus } from "@prisma/client";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { purgeConfirmedRecipient } from "../queue/whatsappBulkSend.js";

// Rank so status only ever advances. FAILED is highest — once Meta reports a
// message failed, a stray out-of-order "sent"/"delivered" redelivery of the
// same webhook can't downgrade it.
const RANK: Record<WhatsAppSendStatus, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
  SKIPPED: 0,
};

export type WhatsAppStatusValue = "sent" | "delivered" | "read" | "failed";

export interface WhatsAppStatusEvent {
  providerMessageId: string;
  /** Meta's status value. Anything else (e.g. "deleted") is ignored. */
  status: WhatsAppStatusValue | (string & {});
  /** When Meta says the transition happened; defaults to now. */
  timestamp?: Date;
  errorCode?: string;
  errorMessage?: string;
}

const STATUS_MAP: Record<WhatsAppStatusValue, WhatsAppSendStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

export async function applyWhatsAppStatusEvent(ev: WhatsAppStatusEvent): Promise<void> {
  const mapped = STATUS_MAP[ev.status as WhatsAppStatusValue];
  if (!mapped) return;

  const send = await prisma.whatsAppSend.findFirst({
    where: { providerMessageId: ev.providerMessageId },
    orderBy: { createdAt: "desc" },
  });
  if (!send) {
    logger.warn(
      { providerMessageId: ev.providerMessageId, status: ev.status },
      "whatsapp status event: no matching send",
    );
    return;
  }
  if (RANK[mapped] <= RANK[send.status]) return; // idempotent / out-of-order no-op

  const at = ev.timestamp ?? new Date();
  const data: Record<string, unknown> = { status: mapped };
  if (mapped === "DELIVERED" || mapped === "READ") {
    if (!send.deliveredAt) data.deliveredAt = at;
  }
  if (mapped === "READ") data.readAt = at;
  if (mapped === "FAILED") {
    data.failedAt = at;
    if (ev.errorCode) data.errorCode = ev.errorCode.slice(0, 32);
    data.error = ev.errorMessage
      ? `${ev.errorCode ? `Meta ${ev.errorCode}` : "Meta"}: ${ev.errorMessage}`.slice(0, 2000)
      : send.error;
  }

  await prisma.whatsAppSend.update({ where: { id: send.id }, data });
  logger.info({ whatsappSendId: send.id, status: mapped }, "whatsapp status event applied");
  // Lead-gen batches delete a recipient only once delivery is confirmed (never on a failure).
  if (mapped === "DELIVERED" || mapped === "READ") await purgeConfirmedRecipient(send.id);
}
