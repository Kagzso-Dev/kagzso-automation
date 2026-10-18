import { Router } from "express";
import multer from "multer";
import {
  createWhatsAppContactInput,
  createWhatsAppTemplateInput,
  idParam,
  listWhatsAppContactsQuery,
  listWhatsAppInboundQuery,
  sendBatchHistoryQuery,
  sendWhatsAppBulkInput,
  updateWhatsAppContactInput,
  updateWhatsAppTemplateInput,
  whatsAppCredentialsInput,
} from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { whatsappConfig } from "../../config/whatsapp.js";
import {
  clearWhatsAppCredentials,
  getWhatsAppCredentialsView,
  setWhatsAppCredentials,
} from "../../domain/whatsappCredentials.js";
import { getPhoneNumberInfo } from "../../services/whatsapp.js";
import { getTemplateVerification } from "../../domain/whatsappTemplateVerify.js";
import { getArchivedTemplateIds, setTemplateArchived } from "../../domain/whatsappTemplateArchive.js";
import { getHeaderMediaMap, headerKindForFormat } from "../../domain/whatsappTemplateHeader.js";
import { mediaView } from "../../domain/whatsappMedia.js";
import { ECOSYSTEM_LIMIT_CODE } from "../../domain/whatsappCooldown.js";
import { formatFromFilename, parseWhatsAppContactFile } from "../../domain/whatsappImport.js";
import {
  createWhatsAppSendBatch,
  getWhatsAppBatchView,
  listWhatsAppSendBatches,
} from "../../domain/whatsappSend.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, conflict, notFound, wrap } from "../errors.js";

export const whatsappRouter = Router();
whatsappRouter.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* ---------------------------------------------------------------- config */

whatsappRouter.get(
  "/config",
  wrap(async (_req, res) => {
    const { configured, provider, phoneNumberId } = await getWhatsAppCredentialsView();
    res.json({ configured, provider, phoneNumberId });
  }),
);

// Admin-only: view/set the Meta Cloud API credentials from the Settings page.
// The access token, app secret and verify token are write-only — they're never
// sent back to the browser once saved.
whatsappRouter.get(
  "/credentials",
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    res.json(await getWhatsAppCredentialsView());
  }),
);

whatsappRouter.put(
  "/credentials",
  requireRole("ADMIN"),
  wrap(async (req, res) => {
    const body = whatsAppCredentialsInput.parse(req.body);
    res.json(await setWhatsAppCredentials(body));
  }),
);

whatsappRouter.delete(
  "/credentials",
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    res.json(await clearWhatsAppCredentials());
  }),
);

// Admin-only: call the Graph API with the current credentials and report the
// sender number they resolve to — a live "are these right?" check.
whatsappRouter.get(
  "/credentials/check",
  requireRole("ADMIN"),
  wrap(async (_req, res) => {
    try {
      res.json({ ok: true, phoneNumber: await getPhoneNumberInfo() });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }),
);

/* ---------------------------------------------------------------- contacts */

whatsappRouter.get(
  "/contacts",
  wrap(async (req, res) => {
    const q = listWhatsAppContactsQuery.parse(req.query);
    const where = {
      ...(q.status ? { status: q.status } : {}),
      // MySQL _ci collation makes `contains` case-insensitive already.
      ...(q.search
        ? {
            OR: [
              { phone: { contains: q.search.replace(/[^\d]/g, "") || q.search } },
              { firstName: { contains: q.search } },
              { lastName: { contains: q.search } },
              { businessName: { contains: q.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.whatsAppContact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.whatsAppContact.count({ where }),
    ]);
    // Display only: each contact's latest WhatsApp result, read from the send history.
    // Never stored on the contact, never hides it and never blocks a manual send.
    const latest = await prisma.whatsAppSend.findMany({
      where: { phone: { in: items.map((c) => c.phone) } },
      orderBy: { createdAt: "desc" },
      distinct: ["phone"],
      select: { phone: true, status: true, errorCode: true, createdAt: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true },
    });
    const byPhone = new Map(latest.map((s) => [s.phone, s]));
    const cooldownMs = whatsappConfig.marketingCooldownHours * 60 * 60 * 1000;
    res.json({
      items: items.map((c) => {
        const s = byPhone.get(c.phone);
        const cooldownUntil =
          s?.errorCode === ECOSYSTEM_LIMIT_CODE && s.failedAt && cooldownMs && s.failedAt.getTime() + cooldownMs > Date.now()
            ? new Date(s.failedAt.getTime() + cooldownMs)
            : null;
        return {
          ...c,
          lastResult: s
            ? { status: s.status, errorCode: s.errorCode, at: s.failedAt ?? s.readAt ?? s.deliveredAt ?? s.sentAt ?? s.createdAt, cooldownUntil }
            : null,
        };
      }),
      total,
      page: q.page,
      pageSize: q.pageSize,
    });
  }),
);

whatsappRouter.post(
  "/contacts",
  wrap(async (req, res) => {
    const body = createWhatsAppContactInput.parse(req.body);
    const contact = await prisma.whatsAppContact.create({ data: body });
    res.status(201).json(contact);
  }),
);

whatsappRouter.put(
  "/contacts/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateWhatsAppContactInput.parse(req.body);
    const contact = await prisma.whatsAppContact.update({ where: { id }, data: body });
    res.json(contact);
  }),
);

whatsappRouter.delete(
  "/contacts/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.whatsAppContact.findUnique({ where: { id } });
    if (!existing) throw notFound("WhatsApp contact");
    await prisma.whatsAppContact.delete({ where: { id } });
    res.status(204).end();
  }),
);

whatsappRouter.post(
  "/contacts/import",
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    const format = formatFromFilename(req.file.originalname);
    if (!format) throw badRequest("Unsupported file type — upload a .csv or .xlsx file");

    const parsed = await parseWhatsAppContactFile(
      req.file.buffer,
      format,
      whatsappConfig.defaultCountryCode,
    );

    let created = 0;
    let updated = 0;
    for (const row of parsed) {
      const data = {
        firstName: row.firstName || undefined,
        lastName: row.lastName || undefined,
        businessName: row.businessName || undefined,
      };
      const existing = await prisma.whatsAppContact.findUnique({ where: { phone: row.phone } });
      await prisma.whatsAppContact.upsert({
        where: { phone: row.phone },
        create: { phone: row.phone, ...data },
        update: data,
      });
      if (existing) updated++;
      else created++;
    }
    res.json({ created, updated, skipped: 0, total: parsed.length });
  }),
);

/* ---------------------------------------------------------------- templates */

whatsappRouter.get(
  "/templates",
  wrap(async (_req, res) => {
    const [rows, archived] = await Promise.all([
      prisma.whatsAppTemplate.findMany({
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { batches: true } } },
      }),
      getArchivedTemplateIds(),
    ]);
    const headers = await getHeaderMediaMap(rows.map((r) => r.id));
    // Every row is returned; `archived` lets the page / Send dialog hide archived ones.
    // `headerMedia`: the image / video / document the template is sent with (null = none).
    res.json({
      items: rows.map((r) => {
        const h = headers.get(r.id);
        return { ...r, archived: archived.has(r.id), headerMedia: h ? mediaView(h) : null };
      }),
    });
  }),
);

// Archive / restore: hides a template from the page and the Send dialog without
// deleting it (rows, batches and messages are kept). Stored in the settings table.
whatsappRouter.post(
  "/templates/:id/archive",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    if (!(await prisma.whatsAppTemplate.findUnique({ where: { id }, select: { id: true } }))) throw notFound("WhatsApp template");
    await setTemplateArchived(id, true);
    res.json({ ok: true, archived: true });
  }),
);

whatsappRouter.post(
  "/templates/:id/restore",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await setTemplateArchived(id, false);
    res.json({ ok: true, archived: false });
  }),
);

whatsappRouter.post(
  "/templates",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const body = createWhatsAppTemplateInput.parse(req.body);
    res.status(201).json(await prisma.whatsAppTemplate.create({ data: body }));
  }),
);

// Display-only: is each registered template really in Meta, approved, in that
// language? Meta's list is cached ~5 min; ?refresh=1 re-reads it. Never sends the
// token anywhere; a Meta error marks rows "unchecked", not failed.
whatsappRouter.get(
  "/templates/verify",
  wrap(async (req, res) => {
    res.json(await getTemplateVerification(req.query.refresh === "1"));
  }),
);

whatsappRouter.get(
  "/templates/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const tpl = await prisma.whatsAppTemplate.findUnique({ where: { id } });
    if (!tpl) throw notFound("WhatsApp template");
    res.json(tpl);
  }),
);

whatsappRouter.put(
  "/templates/:id",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateWhatsAppTemplateInput.parse(req.body);
    res.json(await prisma.whatsAppTemplate.update({ where: { id }, data: body }));
  }),
);

whatsappRouter.delete(
  "/templates/:id",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const inUse = await prisma.whatsAppTemplate.findUnique({
      where: { id },
      include: { _count: { select: { batches: true } } },
    });
    if (!inUse) throw notFound("WhatsApp template");
    if (inUse._count.batches > 0) throw conflict("Template has send history and can't be deleted");
    await prisma.whatsAppTemplate.delete({ where: { id } });
    res.status(204).end();
  }),
);

/* ---------------------------------------------------------------- bulk send */

whatsappRouter.post(
  "/send",
  wrap(async (req, res) => {
    const { templateId, contactIds, source, purgeAfter } = sendWhatsAppBulkInput.parse(req.body);
    if ((await getArchivedTemplateIds()).has(templateId)) {
      throw badRequest("That template is archived — restore it on the WhatsApp Templates page to send it");
    }
    // A template whose Meta header is an image / video / document needs that media set first.
    const needs = (await getTemplateVerification()).items.find((v) => v.id === templateId)?.headerNeedsParameter ?? null;
    if (needs) {
      const kind = headerKindForFormat(needs);
      const media = (await getHeaderMediaMap([templateId])).get(templateId);
      if (!kind) throw badRequest(`This template's ${needs.toLowerCase()} header isn't supported by Dispatch yet`);
      if (!media || media.kind !== kind) {
        throw badRequest(`This template needs a header ${kind} — add it on the WhatsApp Templates page first`);
      }
    }
    if (!(await getWhatsAppCredentialsView()).configured) {
      throw new AppError(503, "WhatsApp is not configured — set it up in Settings", "unavailable");
    }
    const template = await prisma.whatsAppTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw badRequest("templateId does not exist");
    if (!template.providerTemplateName) {
      throw badRequest(
        `Template "${template.name}" has no Meta template name — set it on the WhatsApp Templates page first`,
      );
    }

    let recipients;
    if (source === "whatsapp") {
      const rows = await prisma.whatsAppContact.findMany({ where: { id: { in: contactIds } } });
      recipients = rows.map((r) => ({
        whatsappContactId: r.id,
        phone: r.phone,
        firstName: r.firstName,
        lastName: r.lastName,
        businessName: r.businessName,
        status: r.status,
      }));
    } else {
      // Read-only seed from the email contacts table. Phone/name are snapshotted
      // into whatsapp_sends by createWhatsAppSendBatch; nothing here writes to or
      // triggers email logic.
      const rows = await prisma.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, phone: true, firstName: true, lastName: true, businessName: true },
      });
      recipients = rows.map((r) => ({
        whatsappContactId: null,
        phone: r.phone,
        firstName: r.firstName,
        lastName: r.lastName,
        businessName: r.businessName,
      }));
    }

    if (recipients.length === 0) throw badRequest("No matching contacts");
    const batchId = await createWhatsAppSendBatch({
      templateId,
      recipients,
      // Lead-gen purge: the recipient ids came in as whatsapp_contacts ids or
      // email contacts ids depending on `source`; delete from the matching table
      // once the batch finishes.
      ...(purgeAfter
        ? { purge: { table: source === "whatsapp" ? ("whatsapp" as const) : ("contact" as const), ids: contactIds } }
        : {}),
    });
    res.status(202).json({ batchId });
  }),
);

// Batch history for the Send Queue page (WhatsApp tab). Registered before the
// ":id" route so "/send/batches" isn't captured as an id.
whatsappRouter.get(
  "/send/batches",
  wrap(async (req, res) => {
    const { status } = sendBatchHistoryQuery.parse(req.query);
    res.json({ items: await listWhatsAppSendBatches(status) });
  }),
);

whatsappRouter.get(
  "/send/batches/:id",
  wrap(async (req, res) => {
    const view = await getWhatsAppBatchView(req.params.id);
    if (!view) throw notFound("WhatsApp send batch");
    res.json(view);
  }),
);

/* ---------------------------------------------------------------- inbound */

// Messages recipients sent us, as received by the Meta webhook. Newest first.
whatsappRouter.get(
  "/inbound",
  wrap(async (req, res) => {
    const q = listWhatsAppInboundQuery.parse(req.query);
    const phone = q.phone?.replace(/[^\d]/g, "");
    const where = phone ? { phone } : {};
    const [items, total] = await Promise.all([
      prisma.whatsAppInboundMessage.findMany({
        where,
        orderBy: { sentAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          provider: true,
          providerMessageId: true,
          phone: true,
          profileName: true,
          whatsappContactId: true,
          messageType: true,
          body: true,
          mediaId: true,
          mediaMimeType: true,
          replyPayload: true,
          contextMessageId: true,
          sentAt: true,
          createdAt: true,
        },
      }),
      prisma.whatsAppInboundMessage.count({ where }),
    ]);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  }),
);
