// WhatsApp template sync with Meta (ADMIN only), mounted next to /api/whatsapp.
//
//   GET  /api/whatsapp/templates/meta-sync     Meta templates not registered here yet (+ why any can't be used)
//   POST /api/whatsapp/templates/meta-sync     import them { templates?: [{ name, language }] } (all when omitted)
//   GET  /api/whatsapp/templates/meta-sync/updates   registered templates that differ from Meta (+ what differs)
//   POST /api/whatsapp/templates/meta-sync/updates   make the picked ones follow Meta { ids: [...] }
//   POST /api/whatsapp/templates/meta-create   submit a new template to Meta for review and register it
//                                              (multipart: "template" = JSON, optional "file" = header example)

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { createMetaTemplateInput } from "@dispatch/shared";
import {
  createTemplateInMeta,
  findChangedMetaTemplates,
  findNewMetaTemplates,
  importMetaTemplates,
  TemplateSyncError,
  updateFromMetaTemplates,
} from "../../domain/whatsappTemplateSync.js";
import { MEDIA_MAX_BYTES } from "../../domain/whatsappMedia.js";
import { WhatsAppNotConfiguredError, WhatsAppSendError } from "../../services/whatsapp.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, wrap } from "../errors.js";

export const whatsappTemplateSyncRouter = Router();

const admin = [authRequired, requireRole("ADMIN")];
const limiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_MAX_BYTES, files: 1, fields: 3 } });
const acceptFile = (req: Request, res: Response, next: NextFunction) =>
  upload.single("file")(req, res, (err: unknown) =>
    err ? next(badRequest((err as { code?: string }).code === "LIMIT_FILE_SIZE" ? "Header file is too large" : "Could not read the upload")) : next(),
  );

/** Meta / config problems → a clear HTTP error (Meta's message, token already redacted). */
function toHttp(err: unknown): never {
  if (err instanceof TemplateSyncError) throw new AppError(err.status, err.message, err.status === 409 ? "conflict" : "bad_request");
  if (err instanceof WhatsAppNotConfiguredError) throw new AppError(503, err.message, "unavailable");
  if (err instanceof WhatsAppSendError) throw new AppError(err.retryable ? 503 : 502, err.message, "meta_error");
  throw err;
}

whatsappTemplateSyncRouter.get(
  "/templates/meta-sync",
  ...admin,
  limiter,
  wrap(async (_req, res) => {
    res.json({ items: await findNewMetaTemplates().catch(toHttp) });
  }),
);

const importBody = z.object({
  templates: z.array(z.object({ name: z.string().min(1).max(512), language: z.string().min(1).max(16) })).max(250).optional(),
});

whatsappTemplateSyncRouter.post(
  "/templates/meta-sync",
  ...admin,
  limiter,
  wrap(async (req, res) => {
    const { templates } = importBody.parse(req.body ?? {});
    res.json(await importMetaTemplates(templates).catch(toHttp));
  }),
);

whatsappTemplateSyncRouter.get(
  "/templates/meta-sync/updates",
  ...admin,
  limiter,
  wrap(async (_req, res) => {
    res.json({ items: await findChangedMetaTemplates().catch(toHttp) });
  }),
);

const updateBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(250) });

whatsappTemplateSyncRouter.post(
  "/templates/meta-sync/updates",
  ...admin,
  limiter,
  wrap(async (req, res) => {
    const { ids } = updateBody.parse(req.body ?? {});
    res.json(await updateFromMetaTemplates(ids, req.user!.email).catch(toHttp));
  }),
);

whatsappTemplateSyncRouter.post(
  "/templates/meta-create",
  ...admin,
  limiter,
  acceptFile,
  wrap(async (req, res) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(req.body?.template ?? ""));
    } catch {
      throw badRequest("Template details missing (multipart field 'template' with JSON)");
    }
    const input = createMetaTemplateInput.parse(raw);
    const file = req.file ? { data: req.file.buffer, declaredMime: req.file.mimetype, filename: req.file.originalname } : null;
    const out = await createTemplateInMeta(input, file, req.user!.email).catch(toHttp);
    res.status(201).json(out);
  }),
);
