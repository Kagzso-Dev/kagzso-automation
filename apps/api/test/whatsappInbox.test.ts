import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// WhatsApp Inbox end to end through the real HTTP app, with an in-memory
// stand-in for the database (nothing touches MySQL, nothing is sent to Meta):
// the Meta webhook (verification, signed text / image / voice note / status /
// duplicate, invalid signatures) and the Inbox API (unread counts, mark read,
// "load older" paging, location links, auth).

const SECRET = "test-app-secret-0123456789abcdef";
const VERIFY = "test-verify-token";
process.env.META_WHATSAPP_APP_SECRET = SECRET;
process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY;
process.env.META_WHATSAPP_PHONE_NUMBER_ID = "P1";
process.env.META_WHATSAPP_ACCESS_TOKEN = "EAAtest";
process.env.WHATSAPP_PROVIDER = "meta";

type Row = Record<string, any>;
let seq = 0;
const db: Record<string, Row[]> = {};
const T = (n: string) => (db[n] ??= []);
const ADMIN = { id: "u1", email: "admin@test", role: "ADMIN" as const };

function match(r: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, c]) => {
    if (k === "OR") return (c as Row[]).some((w) => match(r, w));
    const v = r[k];
    if (c && typeof c === "object" && !(c instanceof Date)) {
      if ("in" in c) return c.in.includes(v);
      if ("lt" in c) return v < c.lt;
      if ("contains" in c) return String(v ?? "").includes(c.contains);
      return true;
    }
    return v instanceof Date && c instanceof Date ? v.getTime() === c.getTime() : (v ?? null) === c;
  });
}
const sortBy = (rows: Row[], orderBy?: Row) => {
  const [[f, dir] = []] = Object.entries(orderBy ?? {});
  return f ? [...rows].sort((a, b) => (dir === "desc" ? b[f] - a[f] : a[f] - b[f])) : rows;
};
const model = (n: string) => ({
  findUnique: async ({ where }: Row) => T(n).find((r) => match(r, where)) ?? null,
  findFirst: async ({ where, orderBy }: Row) => sortBy(T(n).filter((r) => match(r, where)), orderBy)[0] ?? null,
  findMany: async ({ where, orderBy, take }: Row = {}) => sortBy(T(n).filter((r) => match(r, where)), orderBy).slice(0, take ?? 1e9),
  create: async ({ data }: Row) => {
    const row = { id: `${n}-${++seq}`, createdAt: new Date(), ...data };
    T(n).push(row);
    return row;
  },
  upsert: async ({ where, create, update }: Row) => {
    const hit = T(n).find((r) => match(r, where));
    if (hit) return Object.assign(hit, update);
    const row = { id: `${n}-${++seq}`, createdAt: new Date(), ...create };
    T(n).push(row);
    return row;
  },
});
const queryRaw = vi.fn(async (..._a: unknown[]): Promise<any[]> => []);
const prismaMock = new Proxy({ $queryRaw: (...a: unknown[]) => queryRaw(...a) } as Row, {
  get: (t, p: string) => (p in t ? t[p] : model(p)),
});
vi.mock("../src/prisma.js", () => ({ prisma: prismaMock }));
const applyWhatsAppStatusEvent = vi.fn(async () => undefined);
vi.mock("../src/domain/whatsappTracking.js", () => ({ applyWhatsAppStatusEvent: (...a: unknown[]) => applyWhatsAppStatusEvent(...(a as [])) }));
const enqueueWhatsAppMediaDownload = vi.fn(async () => "job");
vi.mock("../src/queue/queues.js", () => ({ enqueueWhatsAppMediaDownload }));

let server: Server;
let base = "";
const bearer = (role: "ADMIN" | "EDITOR" = "ADMIN") =>
  `Bearer ${jwt.sign({ sub: ADMIN.id, email: ADMIN.email, role }, process.env.JWT_ACCESS_SECRET!)}`;

beforeAll(async () => {
  const { createApp } = await import("../src/http/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  vi.clearAllMocks();
});

const PHONE = "918838931463";
const now = () => String(Math.floor(Date.now() / 1000));
const payload = (value: Row) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "P1" }, ...value } }] }] });
const sign = (body: string, secret = SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
const postHook = (body: string, signature: string | null = sign(body)) =>
  fetch(`${base}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature-256": signature } : {}) },
    body,
  });
const contacts = [{ wa_id: PHONE, profile: { name: "Ragul" } }];

describe("Meta webhook", () => {
  it("GET verification returns the challenge only for the right token", async () => {
    const ok = await fetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await ok.text()).toBe("1158201444");
    const bad = await fetch(`${base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    expect(bad.status).toBe(403);
  });

  it("text message is stored once (a duplicate delivery adds nothing)", async () => {
    const body = payload({ contacts, messages: [{ id: "wamid.T1", from: PHONE, timestamp: now(), type: "text", text: { body: "Hi, is this Kagzso?" } }] });
    expect((await postHook(body)).status).toBe(200);
    expect((await postHook(body)).status).toBe(200);
    expect(T("whatsAppInboundMessage")).toHaveLength(1);
    expect(T("whatsAppInboundMessage")[0]).toMatchObject({ phone: PHONE, profileName: "Ragul", messageType: "text", body: "Hi, is this Kagzso?" });
  });

  it("image and voice note are stored and their media queued for download once", async () => {
    const body = payload({
      contacts,
      messages: [
        { id: "wamid.I1", from: PHONE, timestamp: now(), type: "image", image: { id: "m-img", mime_type: "image/jpeg", caption: "Our shop" } },
        { id: "wamid.V1", from: PHONE, timestamp: now(), type: "audio", audio: { id: "m-voice", mime_type: "audio/ogg; codecs=opus", voice: true } },
      ],
    });
    expect((await postHook(body)).status).toBe(200);
    expect((await postHook(body)).status).toBe(200); // redelivery
    expect(T("whatsAppMedia").map((m) => [m.kind, m.providerMediaId, m.mimeType])).toEqual([
      ["image", "m-img", "image/jpeg"],
      ["audio", "m-voice", "audio/ogg"],
    ]);
    expect(enqueueWhatsAppMediaDownload).toHaveBeenCalledTimes(2);
  });

  it("status updates go to the existing status tracker (Send Queue keeps working)", async () => {
    const body = payload({ statuses: [{ id: "wamid.OUT1", status: "delivered", timestamp: now(), recipient_id: PHONE }] });
    expect((await postHook(body)).status).toBe(200);
    expect(applyWhatsAppStatusEvent).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: "wamid.OUT1", status: "delivered" }));
  });

  it("rejects an invalid or missing signature and stores nothing", async () => {
    const body = payload({ contacts, messages: [{ id: "wamid.X", from: PHONE, timestamp: now(), type: "text", text: { body: "spoof" } }] });
    expect((await postHook(body, sign(body, "wrong-secret"))).status).toBe(401);
    expect((await postHook(body, null)).status).toBe(401);
    expect(T("whatsAppInboundMessage")).toHaveLength(0);
  });
});

describe("Inbox API", () => {
  const api = (path: string, init: RequestInit = {}, role: "ADMIN" | "EDITOR" = "ADMIN") =>
    fetch(base + path, { ...init, headers: { Authorization: bearer(role), "Content-Type": "application/json" } });
  const inbound = (minsAgo: number, extra: Row = {}) =>
    T("whatsAppInboundMessage").push({
      id: `in-${++seq}`,
      providerMessageId: `wamid.${seq}`,
      phone: PHONE,
      sentAt: new Date(Date.now() - minsAgo * 60_000),
      messageType: "text",
      body: `msg ${minsAgo}`,
      profileName: "Ragul",
      raw: {},
      ...extra,
    });

  it("is admin-only", async () => {
    for (const p of ["/api/whatsapp/inbox", "/api/whatsapp/inbox/unread-count", `/api/whatsapp/inbox/${PHONE}`]) {
      expect((await api(p, {}, "EDITOR")).status).toBe(403);
    }
    expect((await api(`/api/whatsapp/inbox/${PHONE}/read`, { method: "POST" }, "EDITOR")).status).toBe(403);
  });

  it("mark read stores the read time; unread counts come from the read table", async () => {
    expect((await api(`/api/whatsapp/inbox/${PHONE}/read`, { method: "POST" })).status).toBe(200);
    expect(T("whatsAppConversationRead")[0]).toMatchObject({ phone: PHONE, readByEmail: ADMIN.email });
    queryRaw.mockResolvedValueOnce([{ messages: 3n, conversations: 2n }]);
    expect(await (await api("/api/whatsapp/inbox/unread-count")).json()).toEqual({ messages: 3, conversations: 2 });
  });

  it("unread counts are 0 (not an error) before migration 0021 is applied", async () => {
    queryRaw.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Table doesn't exist", { code: "P2010", clientVersion: "t", meta: { code: "1146" } }));
    const res = await api("/api/whatsapp/inbox/unread-count");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: 0, conversations: 0 });
  });

  it("thread pages: newest first page, then 'load older' with before=", async () => {
    for (let i = 1; i <= 5; i++) inbound(i * 10); // 10…50 minutes ago
    const first: any = await (await api(`/api/whatsapp/inbox/${PHONE}?limit=2`)).json();
    expect(first.messages.map((m: Row) => m.text)).toEqual(["msg 20", "msg 10"]); // oldest → newest
    expect(first.hasMore).toBe(true);
    const older: any = await (await api(`/api/whatsapp/inbox/${PHONE}?limit=2&before=${encodeURIComponent(first.nextBefore)}`)).json();
    expect(older.messages.map((m: Row) => m.text)).toEqual(["msg 40", "msg 30"]);
    const last: any = await (await api(`/api/whatsapp/inbox/${PHONE}?limit=2&before=${encodeURIComponent(older.nextBefore)}`)).json();
    expect(last.messages.map((m: Row) => m.text)).toEqual(["msg 50"]);
    expect(last.hasMore).toBe(false);
    expect(first.windowOpen).toBe(true);
  });

  it("location messages carry coordinates for a map link", async () => {
    inbound(1, { messageType: "location", body: "Kagzso — Chennai", raw: { type: "location", location: { latitude: 13.0827, longitude: 80.2707, name: "Kagzso", address: "Chennai" } } });
    const t: any = await (await api(`/api/whatsapp/inbox/${PHONE}`)).json();
    expect(t.messages[0].location).toEqual({ latitude: 13.0827, longitude: 80.2707, name: "Kagzso", address: "Chennai" });
  });

  it("quick-reply taps get an Interested / Not now badge (English and Tamil); nothing is written", async () => {
    T("whatsAppTemplate").push(
      { id: "tpl-en", name: "Company Intro", buttonLabels: ["Yes, interested", "Not now"] },
      { id: "tpl-ta", name: "Kagzso Automation Intro Ta", buttonLabels: ["ஆர்வம் உள்ளது", "இப்போது வேண்டாம்"] },
      { id: "tpl-odd", name: "Odd buttons", buttonLabels: ["சரி, சொல்லுங்கள்", "அப்புறம் பேசலாம்"] },
    );
    const sent = (id: string, templateId: string, minsAgo: number) =>
      T("whatsAppSend").push({ id: `s-${id}`, phone: PHONE, providerMessageId: `wamid.out.${id}`, templateId, batchId: "b1", status: "READ",
        body: "template", createdAt: new Date(Date.now() - minsAgo * 60_000), sentAt: new Date(Date.now() - minsAgo * 60_000) });
    sent("en", "tpl-en", 60);
    sent("ta", "tpl-ta", 50);
    sent("odd", "tpl-odd", 40);
    inbound(9, { messageType: "button", body: "Yes, interested", replyPayload: "Yes, interested", contextMessageId: "wamid.out.en" });
    inbound(8, { messageType: "button", body: "Not now", replyPayload: "Not now", contextMessageId: "wamid.out.en" });
    inbound(7, { messageType: "button", body: "ஆர்வம் உள்ளது", replyPayload: "ஆர்வம் உள்ளது", contextMessageId: "wamid.out.ta" });
    inbound(6, { messageType: "button", body: "இப்போது வேண்டாம்", replyPayload: "இப்போது வேண்டாம்", contextMessageId: "wamid.out.ta" });
    // Not a known phrase: told by its position on the template it replies to.
    inbound(5, { messageType: "button", body: "அப்புறம் பேசலாம்", replyPayload: "அப்புறம் பேசலாம்", contextMessageId: "wamid.out.odd" });
    inbound(4, { messageType: "button", body: "Call me tomorrow", replyPayload: "Call me tomorrow", contextMessageId: "wamid.unknown" });
    inbound(3, { messageType: "text", body: "Interested" }); // typed, not a button tap
    // The in-memory db adds an empty table when one is read, so compare tables that hold rows.
    const rows = () => JSON.stringify(Object.entries(db).filter(([, r]) => r.length).sort(([x], [y]) => x.localeCompare(y)));
    const before = rows();

    const t: any = await (await api(`/api/whatsapp/inbox/${PHONE}`)).json();
    const ins = t.messages.filter((m: Row) => m.direction === "in");
    expect(ins.map((m: Row) => [m.text, m.replyIntent])).toEqual([
      ["Yes, interested", "interested"],
      ["Not now", "not_now"],
      ["ஆர்வம் உள்ளது", "interested"],
      ["இப்போது வேண்டாம்", "not_now"],
      ["அப்புறம் பேசலாம்", "not_now"],
      ["Call me tomorrow", null],
      ["Interested", undefined],
    ]);
    // Tamil text comes back unchanged, and no row anywhere was added or changed.
    expect(rows()).toBe(before);
  });
});
