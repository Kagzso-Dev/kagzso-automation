import { readFile } from "node:fs/promises";
import { Router } from "express";
import {
  createContactInput,
  idParam,
  listContactsQuery,
  sendBatchHistoryQuery,
  sendManualBulkInput,
  sendManualEmailInput,
  updateContactInput,
} from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { enqueueContactImport } from "../../queue/queues.js";
import { CONTACT_FILE_IN_MEMORY_BYTES, formatFromFilename, parseContactUpload } from "../../domain/contactImport.js";
import { importUpload, removeUpload, unreadableFile } from "../importUpload.js";
import { isEmailDomainAllowed } from "../../domain/allowedDomains.js";
import {
  createManualSendBatch,
  getBatchView,
  listManualSendBatches,
  retryFailedItems,
  sendManualEmail,
} from "../../domain/manualSend.js";
import { authRequired } from "../middleware/auth.js";
import { badRequest, notFound, wrap } from "../errors.js";

export const contactsRouter = Router();
contactsRouter.use(authRequired);

contactsRouter.get(
  "/",
  wrap(async (req, res) => {
    const q = listContactsQuery.parse(req.query);
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.listId ? { memberships: { some: { listId: q.listId } } } : {}),
      // MySQL columns use a _ci collation, so `contains` is already
      // case-insensitive; Prisma's `mode` option is Postgres-only.
      ...(q.search
        ? {
            OR: [
              { email: { contains: q.search } },
              { firstName: { contains: q.search } },
              { lastName: { contains: q.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.contact.count({ where }),
    ]);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  }),
);

contactsRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = createContactInput.parse(req.body);
    const email = body.email.toLowerCase();
    if (!(await isEmailDomainAllowed(email))) {
      throw badRequest(`Email domain is not on the approved sending list: ${email}`);
    }
    const contact = await prisma.contact.create({
      data: { ...body, email, customFields: body.customFields ?? {} },
    });
    res.status(201).json(contact);
  }),
);

contactsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const contact = await prisma.contact.findUnique({
      where: { id },
      include: {
        memberships: { include: { list: true } },
        emailLogs: { orderBy: { createdAt: "desc" }, take: 20 },
        unsubscribe: true,
      },
    });
    if (!contact) throw notFound("Contact");
    res.json(contact);
  }),
);

contactsRouter.put(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = updateContactInput.parse(req.body);
    const email = body.email?.toLowerCase();
    if (email && !(await isEmailDomainAllowed(email))) {
      throw badRequest(`Email domain is not on the approved sending list: ${email}`);
    }
    const contact = await prisma.contact.update({
      where: { id },
      data: { ...body, ...(email ? { email } : {}) },
    });
    res.json(contact);
  }),
);

contactsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const contact = await prisma.contact.findUnique({ where: { id } });
    if (!contact) throw notFound("Contact");
    // Memberships and the unsubscribe row cascade; email logs do not (they have
    // no onDelete rule), so clear them first or the delete hits a FK constraint.
    await prisma.$transaction([
      prisma.emailLog.deleteMany({ where: { contactId: id } }),
      prisma.contact.delete({ where: { id } }),
    ]);
    res.status(204).end();
  }),
);

contactsRouter.post(
  "/:id/send",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { templateId } = sendManualEmailInput.parse(req.body);
    const contact = await prisma.contact.findUnique({ where: { id } });
    if (!contact) throw notFound("Contact");
    const template = await prisma.template.findUnique({ where: { id: templateId } });
    if (!template) throw badRequest("templateId does not exist");
    const result = await sendManualEmail(id, templateId);
    if (result.status === "skipped") throw badRequest(`Cannot send: ${result.reason}`);
    res.status(202).json(result);
  }),
);

/* ------------------------------------------------ drip (sequential) bulk send */

// Send a template to many selected contacts one at a time, with a random gap
// between each (Settings → Bulk send pacing). Runs server-side as a
// `manual-bulk-send` queue job, so it survives the tab closing.
contactsRouter.post(
  "/send",
  wrap(async (req, res) => {
    const { templateId, contactIds, purgeAfter } = sendManualBulkInput.parse(req.body);
    const template = await prisma.template.findUnique({ where: { id: templateId } });
    if (!template) throw badRequest("templateId does not exist");
    const batchId = await createManualSendBatch(templateId, contactIds, { purgeAfter });
    res.status(202).json({ batchId });
  }),
);

// Batch history for the Send Queue page (Email tab). Must be registered before
// the ":id" route below so "/send/batches" isn't captured as an id.
contactsRouter.get(
  "/send/batches",
  wrap(async (req, res) => {
    const { status } = sendBatchHistoryQuery.parse(req.query);
    res.json({ items: await listManualSendBatches(status) });
  }),
);

// Progress poll for one batch (Send Queue detail view).
contactsRouter.get(
  "/send/batches/:id",
  wrap(async (req, res) => {
    const view = await getBatchView(req.params.id);
    if (!view) throw notFound("Send batch");
    res.json(view);
  }),
);

// Start a fresh batch containing only the contacts that failed in :id.
contactsRouter.post(
  "/send/batches/:id/retry",
  wrap(async (req, res) => {
    const batchId = await retryFailedItems(req.params.id);
    if (!batchId) throw badRequest("Nothing to retry — no failed contacts in that batch");
    res.status(202).json({ batchId });
  }),
);

// Stop a running batch; contacts not yet sent are left untouched.
contactsRouter.post(
  "/send/batches/:id/cancel",
  wrap(async (req, res) => {
    const batch = await prisma.manualSendBatch.findUnique({ where: { id: req.params.id } });
    if (!batch) throw notFound("Send batch");
    if (batch.status === "RUNNING") {
      await prisma.manualSendBatch.update({
        where: { id: batch.id },
        data: { status: "CANCELLED", nextItemAt: null },
      });
    }
    res.json({ status: batch.status === "RUNNING" ? "CANCELLED" : batch.status });
  }),
);

contactsRouter.post(
  "/import",
  importUpload(),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    const file = req.file;
    try {
      const format = formatFromFilename(file.originalname);
      if (!format) throw badRequest("Unsupported file type — upload a .csv, .xlsx, or .pdf file");
      const listId = typeof req.body.listId === "string" && req.body.listId ? req.body.listId : undefined;
      // Up to 10 MB the worker reads the file, as before. A bigger one is read here row by row and
      // the job gets only the rows to import (the first IMPORT_MAX_ROWS) and the counts.
      const jobId =
        file.size <= CONTACT_FILE_IN_MEMORY_BYTES
          ? await enqueueContactImport({
              fileBase64: (await readFile(file.path)).toString("base64"),
              filename: file.originalname,
              format,
              listId,
            })
          : await enqueueContactImport({
              parsed: await parseContactUpload(file.path, file.size, format).catch(unreadableFile),
              filename: file.originalname,
              format,
              listId,
            });
      res.status(202).json({ jobId, status: "queued" });
    } finally {
      await removeUpload(file);
    }
  }),
);

contactsRouter.get(
  "/import/:jobId",
  wrap(async (req, res) => {
    const job = await prisma.job.findUnique({ where: { id: req.params.jobId } });
    if (!job || job.queue !== "csv-import") throw notFound("Import job");
    res.json({
      jobId: job.id,
      state: job.status,
      result: job.result,
      failedReason: job.lastError,
    });
  }),
);
