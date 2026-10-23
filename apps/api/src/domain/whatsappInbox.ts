// WhatsApp Inbox: conversations built from inbound messages (whatsapp_inbound_messages)
// and what we sent to the same number (whatsapp_sends), plus free-form replies.
//
// Meta only delivers free-form (non-template) messages inside the 24-hour
// customer-service window that opens when the customer messages us, so a reply
// is refused outside it. Replies are recorded as whatsapp_sends rows without a
// batch, so the existing status webhook (sent / delivered / read / failed)
// updates them like any other send.

import { Prisma, type WhatsAppSend } from "@prisma/client";
import { classifyButtonReply, type ButtonReplyIntent } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { sendMediaMessage, sendTextMessage, WhatsAppSendError } from "../services/whatsapp.js";
import { ensureProviderMediaId, MediaError, mediaView, saveOutgoingMedia, type MediaView } from "./whatsappMedia.js";

export const CUSTOMER_WINDOW_MS = 24 * 3600_000;
/** Meta limits: text body 4096 characters, media caption 1024. */
export const TEXT_MAX = 4096;
export const CAPTION_MAX = 1024;

const digits = (phone: string) => phone.replace(/[^\d]/g, "");

export interface ConversationSummary {
  phone: string;
  name: string | null;
  lastMessageAt: string;
  lastInboundAt: string;
  lastPreview: string | null;
  lastType: string;
  inboundCount: number;
  windowOpen: boolean;
  /** Customer messages that arrived after the conversation was last read. */
  unread: number;
}

/* ------------------------------------------------------------------ read state */

/** whatsapp_conversation_reads is missing until migration 0021 is applied — then nothing counts as unread. */
const isMissingTable = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2021" || err.code === "P2010");
let warnedNoReads = false;
function noReadTable(err: unknown): never | null {
  const raw = err as { code?: string; meta?: { code?: string } };
  if (!isMissingTable(err) && raw?.meta?.code !== "1146") throw err;
  if (!warnedNoReads) {
    warnedNoReads = true;
    logger.warn("whatsapp_conversation_reads missing — run `npm run prisma:deploy` (0021_whatsapp_inbox_reads); unread counts show 0");
  }
  return null;
}

/** Unread customer messages per phone (only the phones given). */
export async function unreadByPhone(phones: string[]): Promise<Map<string, number>> {
  if (phones.length === 0) return new Map();
  const rows = await prisma
    .$queryRaw<{ phone: string; n: bigint | number }[]>`
      SELECT m.phone AS phone, COUNT(*) AS n
      FROM whatsapp_inbound_messages m
      LEFT JOIN whatsapp_conversation_reads r ON r.phone = m.phone
      WHERE m.phone IN (${Prisma.join(phones)})
        AND (r.lastReadAt IS NULL OR m.sentAt > r.lastReadAt)
      GROUP BY m.phone`
    .catch(noReadTable);
  return new Map((rows ?? []).map((r) => [r.phone, Number(r.n)]));
}

/** Total unread customer messages, and how many conversations have any (sidebar badge). */
export async function unreadTotals(): Promise<{ messages: number; conversations: number }> {
  const rows = await prisma
    .$queryRaw<{ messages: bigint | number | null; conversations: bigint | number | null }[]>`
      SELECT COUNT(*) AS messages, COUNT(DISTINCT m.phone) AS conversations
      FROM whatsapp_inbound_messages m
      LEFT JOIN whatsapp_conversation_reads r ON r.phone = m.phone
      WHERE r.lastReadAt IS NULL OR m.sentAt > r.lastReadAt`
    .catch(noReadTable);
  const r = rows?.[0];
  return { messages: Number(r?.messages ?? 0), conversations: Number(r?.conversations ?? 0) };
}

/** Mark a conversation read up to now. */
export async function markConversationRead(phoneRaw: string, actorEmail: string | null): Promise<void> {
  const phone = digits(phoneRaw);
  const now = new Date();
  await prisma.whatsAppConversationRead
    .upsert({
      where: { phone },
      create: { phone, lastReadAt: now, readByEmail: actorEmail },
      update: { lastReadAt: now, readByEmail: actorEmail },
    })
    .catch(noReadTable);
}

/* ------------------------------------------------------------------ conversation list */

/** Phones whose number, WhatsApp profile name, or saved contact name / business matches `search`. */
async function phonesMatching(search: string): Promise<string[]> {
  const q = search.trim();
  const d = q.replace(/\D/g, "");
  const [inbound, contacts] = await Promise.all([
    prisma.whatsAppInboundMessage.findMany({
      where: { OR: [{ profileName: { contains: q } }, ...(d.length >= 3 ? [{ phone: { contains: d } }] : [])] },
      select: { phone: true },
      distinct: ["phone"],
      take: 500,
    }),
    prisma.whatsAppContact.findMany({
      where: { OR: [{ firstName: { contains: q } }, { lastName: { contains: q } }, { businessName: { contains: q } }] },
      select: { phone: true },
      take: 500,
    }),
  ]);
  return [...new Set([...inbound, ...contacts].map((r) => r.phone))];
}

/**
 * One row per phone that has messaged us, newest activity first, a page at a
 * time (default: the first 200, as before). `search` matches number, profile
 * name, or saved contact name / business.
 */
export async function listConversations(
  opts: { search?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: ConversationSummary[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 200));
  const restrict = opts.search?.trim() ? await phonesMatching(opts.search) : null;
  if (restrict && restrict.length === 0) return { items: [], total: 0, page, pageSize };
  const where = restrict ? { phone: { in: restrict } } : {};

  const [groups, all] = await Promise.all([
    prisma.whatsAppInboundMessage.groupBy({
      by: ["phone"],
      where,
      _max: { sentAt: true },
      _count: { _all: true },
      orderBy: { _max: { sentAt: "desc" } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.whatsAppInboundMessage.groupBy({ by: ["phone"], where }),
  ]);
  if (groups.length === 0) return { items: [], total: all.length, page, pageSize };
  const phones = groups.map((g) => g.phone);
  const [latest, contacts, unread] = await Promise.all([
    prisma.whatsAppInboundMessage.findMany({
      where: { OR: groups.map((g) => ({ phone: g.phone, sentAt: g._max.sentAt! })) },
      select: { phone: true, body: true, messageType: true, profileName: true },
    }),
    prisma.whatsAppContact.findMany({ where: { phone: { in: phones } }, select: { phone: true, firstName: true, lastName: true } }),
    unreadByPhone(phones),
  ]);
  const byPhone = new Map(latest.map((m) => [m.phone, m]));
  const names = new Map(contacts.map((c) => [c.phone, [c.firstName, c.lastName].filter(Boolean).join(" ") || null]));
  const items = groups.map((g) => {
    const last = byPhone.get(g.phone);
    const at = g._max.sentAt!;
    return {
      phone: g.phone,
      name: names.get(g.phone) ?? last?.profileName ?? null,
      lastMessageAt: at.toISOString(),
      lastInboundAt: at.toISOString(),
      lastPreview: last?.body ?? null,
      lastType: last?.messageType ?? "text",
      inboundCount: g._count._all,
      windowOpen: Date.now() - at.getTime() < CUSTOMER_WINDOW_MS,
      unread: unread.get(g.phone) ?? 0,
    };
  });
  return { items, total: all.length, page, pageSize };
}

/* ------------------------------------------------------------------ one conversation */

export interface ThreadMessage {
  id: string;
  direction: "in" | "out";
  at: string;
  type: string;
  text: string | null;
  media: MediaView | null;
  status: string | null; // outbound: QUEUED … READ / FAILED
  error: string | null;
  template: string | null; // outbound template name, if it was a template send
  /** Inbound location messages: coordinates for a map link. */
  location?: { latitude: number; longitude: number; name: string | null; address: string | null } | null;
  /** Inbound quick-reply taps: "interested" / "not_now" badge (display only), null when unclear. */
  replyIntent?: ButtonReplyIntent | null;
}

/**
 * Display-only intent of each tapped quick-reply: the button text, else its position
 * on the template the tap replies to (found from the reply's context message id).
 * Read-only lookups; nothing is written.
 */
async function replyIntents(
  inbound: { id: string; messageType: string; body: string | null; replyPayload: string | null; contextMessageId: string | null }[],
): Promise<Map<string, ButtonReplyIntent | null>> {
  const taps = inbound.filter((m) => m.messageType === "button" || m.messageType === "interactive");
  const out = new Map<string, ButtonReplyIntent | null>();
  if (!taps.length) return out;
  const contextIds = [...new Set(taps.map((m) => m.contextMessageId).filter((x): x is string => !!x))];
  const sends = contextIds.length
    ? await prisma.whatsAppSend.findMany({
        where: { providerMessageId: { in: contextIds } },
        select: { providerMessageId: true, templateId: true, batch: { select: { templateId: true } } },
      })
    : [];
  const templateOf = new Map(sends.map((s) => [s.providerMessageId!, s.templateId ?? s.batch?.templateId ?? null]));
  const templateIds = [...new Set([...templateOf.values()].filter((x): x is string => !!x))];
  const templates = templateIds.length
    ? await prisma.whatsAppTemplate.findMany({ where: { id: { in: templateIds } }, select: { id: true, buttonLabels: true } })
    : [];
  const labelsOf = new Map(templates.map((t) => [t.id, t.buttonLabels]));
  for (const m of taps) {
    const templateId = m.contextMessageId ? templateOf.get(m.contextMessageId) : null;
    out.set(
      m.id,
      classifyButtonReply({
        messageType: m.messageType,
        text: m.body,
        payload: m.replyPayload,
        buttonLabels: templateId ? labelsOf.get(templateId) : undefined,
      }),
    );
  }
  return out;
}

function locationOf(raw: unknown): ThreadMessage["location"] {
  const loc = (raw as { location?: { latitude?: unknown; longitude?: unknown; name?: unknown; address?: unknown } } | null)?.location;
  const lat = Number(loc?.latitude);
  const lng = Number(loc?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng, name: typeof loc?.name === "string" ? loc.name : null, address: typeof loc?.address === "string" ? loc.address : null };
}

/**
 * Messages for one phone, oldest first: the newest `limit` (default 200, as
 * before), or with `before` the `limit` messages older than that time ("Load
 * older"). `hasMore` says whether older messages exist; pass `nextBefore` back.
 */
export async function getConversation(phoneRaw: string, opts: { before?: Date | null; limit?: number } | number = {}) {
  const o = typeof opts === "number" ? { limit: opts } : opts;
  const limit = Math.min(200, Math.max(1, o.limit ?? 200));
  const phone = digits(phoneRaw);
  const before = o.before ?? null;
  const [inbound, outbound, contact, lastInbound] = await Promise.all([
    prisma.whatsAppInboundMessage.findMany({
      where: { phone, ...(before ? { sentAt: { lt: before } } : {}) },
      orderBy: { sentAt: "desc" },
      take: limit,
      select: { id: true, sentAt: true, messageType: true, body: true, profileName: true, replyPayload: true, contextMessageId: true },
    }),
    prisma.whatsAppSend.findMany({
      where: { phone, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { batch: { select: { template: { select: { name: true } } } } },
    }),
    prisma.whatsAppContact.findUnique({ where: { phone }, select: { firstName: true, lastName: true } }),
    prisma.whatsAppInboundMessage.findFirst({ where: { phone }, orderBy: { sentAt: "desc" }, select: { sentAt: true, profileName: true } }),
  ]);
  const locationIds = inbound.filter((m) => m.messageType === "location").map((m) => m.id);
  const [inMedia, outMedia, locations, intents] = await Promise.all([
    inbound.length ? prisma.whatsAppMedia.findMany({ where: { inboundMessageId: { in: inbound.map((m) => m.id) } } }) : [],
    outbound.length
      ? prisma.whatsAppSendMedia.findMany({ where: { sendId: { in: outbound.map((s) => s.id) } }, include: { media: true } })
      : [],
    locationIds.length ? prisma.whatsAppInboundMessage.findMany({ where: { id: { in: locationIds } }, select: { id: true, raw: true } }) : [],
    replyIntents(inbound),
  ]);
  const inMediaBy = new Map(inMedia.map((m) => [m.inboundMessageId!, m]));
  const outMediaBy = new Map(outMedia.map((l) => [l.sendId, l.media]));
  const locBy = new Map(locations.map((l) => [l.id, locationOf(l.raw)]));

  // Merge both directions on one time line; keep the newest `limit`.
  const merged = [
    ...inbound.map((m) => {
      const media = inMediaBy.get(m.id);
      return {
        key: m.sentAt.getTime(),
        msg: {
          id: m.id,
          direction: "in" as const,
          at: m.sentAt.toISOString(),
          type: m.messageType,
          text: m.body,
          media: media ? mediaView(media) : null,
          status: null,
          error: null,
          template: null,
          ...(m.messageType === "location" ? { location: locBy.get(m.id) ?? null } : {}),
          ...(intents.has(m.id) ? { replyIntent: intents.get(m.id) ?? null } : {}),
        } as ThreadMessage,
      };
    }),
    ...outbound.map((s) => {
      const media = outMediaBy.get(s.id);
      return {
        key: s.createdAt.getTime(),
        msg: {
          id: s.id,
          direction: "out" as const,
          at: (s.sentAt ?? s.createdAt).toISOString(),
          type: media ? media.kind : s.batchId ? "template" : "text",
          text: s.body,
          media: media ? mediaView(media) : null,
          status: s.status,
          error: s.error,
          template: s.batch?.template.name ?? null,
        } as ThreadMessage,
      };
    }),
  ].sort((a, b) => b.key - a.key);
  const pageItems = merged.slice(0, limit);
  const hasMore = merged.length > limit || inbound.length === limit || outbound.length === limit;
  const oldest = pageItems[pageItems.length - 1];

  const windowEndsAt = lastInbound ? new Date(lastInbound.sentAt.getTime() + CUSTOMER_WINDOW_MS) : null;
  return {
    phone,
    name: [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || lastInbound?.profileName || null,
    windowOpen: !!windowEndsAt && windowEndsAt.getTime() > Date.now(),
    windowEndsAt: windowEndsAt?.toISOString() ?? null,
    messages: pageItems.reverse().map((x) => x.msg),
    hasMore: hasMore && !!oldest,
    nextBefore: hasMore && oldest ? new Date(oldest.key).toISOString() : null,
  };
}

export class ReplyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Send a free-form reply (text, or one attachment with an optional caption).
 * Refused outside the 24-hour window. The message is recorded either way
 * (SENT with Meta's id, or FAILED with Meta's error).
 */
export async function sendReply(
  phoneRaw: string,
  input: { text?: string | null; file?: { data: Buffer; declaredMime?: string | null; filename?: string | null } | null },
  actorEmail: string,
): Promise<ThreadMessage> {
  const phone = digits(phoneRaw);
  const text = (input.text ?? "").trim();
  if (!text && !input.file) throw new ReplyError(400, "Type a message or attach a file");

  const lastInbound = await prisma.whatsAppInboundMessage.findFirst({
    where: { phone },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true, profileName: true },
  });
  if (!lastInbound) throw new ReplyError(409, "This number hasn't messaged you — start the conversation with an approved template");
  if (Date.now() - lastInbound.sentAt.getTime() >= CUSTOMER_WINDOW_MS) {
    throw new ReplyError(409, "The 24-hour reply window has closed — send an approved template instead");
  }

  let media = null;
  if (input.file) {
    try {
      media = await saveOutgoingMedia(input.file.data, input.file, "REPLY", ["image", "video", "audio", "document", "sticker"], actorEmail);
    } catch (err) {
      if (err instanceof MediaError) throw new ReplyError(err.status, err.message);
      throw err;
    }
    const captionAllowed = ["image", "video", "document"].includes(media.kind);
    if (text && !captionAllowed) throw new ReplyError(400, `WhatsApp ${media.kind} messages can't have a caption — send the text separately`);
    if (text.length > CAPTION_MAX) throw new ReplyError(400, `Captions can be at most ${CAPTION_MAX} characters`);
  } else if (text.length > TEXT_MAX) {
    throw new ReplyError(400, `Messages can be at most ${TEXT_MAX} characters`);
  }

  const contact = await prisma.whatsAppContact.findUnique({ where: { phone }, select: { id: true, firstName: true, lastName: true, businessName: true } });
  const send: WhatsAppSend = await prisma.whatsAppSend.create({
    data: {
      phone,
      whatsappContactId: contact?.id ?? null,
      name: [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || lastInbound.profileName || null,
      businessName: contact?.businessName ?? null,
      body: text || (media ? `[${media.kind}] ${media.filename ?? ""}`.trim() : ""),
      status: "SENDING",
      provider: "meta",
    },
  });
  if (media) await prisma.whatsAppSendMedia.create({ data: { sendId: send.id, mediaId: media.id, role: "attachment" } });

  try {
    const { providerMessageId } = media
      ? await sendMediaMessage({
          to: phone,
          mediaType: media.kind as "image" | "video" | "audio" | "document" | "sticker",
          mediaId: await ensureProviderMediaId(media),
          caption: text || undefined,
          filename: media.kind === "document" ? (media.filename ?? undefined) : undefined,
        })
      : await sendTextMessage({ to: phone, body: text });
    const done = await prisma.whatsAppSend.update({
      where: { id: send.id },
      data: { status: "SENT", providerMessageId, sentAt: new Date() },
    });
    logger.info({ sendId: send.id, kind: media?.kind ?? "text", by: actorEmail }, "whatsapp inbox reply sent");
    return toThread(done, media ? mediaView(media) : null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await prisma.whatsAppSend.update({
      where: { id: send.id },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorCode: err instanceof WhatsAppSendError ? (err.code ?? null) : null,
        error: message.slice(0, 2000),
      },
    });
    logger.warn({ sendId: send.id, err: message }, "whatsapp inbox reply failed");
    return toThread(failed, media ? mediaView(media) : null);
  }
}

function toThread(s: WhatsAppSend, media: MediaView | null): ThreadMessage {
  return {
    id: s.id,
    direction: "out",
    at: (s.sentAt ?? s.createdAt).toISOString(),
    type: media ? media.kind : "text",
    text: s.body,
    media,
    status: s.status,
    error: s.error,
    template: null,
  };
}
