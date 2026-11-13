import { Router, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import {
  createTemplateInput,
  idParam,
  previewTemplateInput,
  sendTestInput,
  updateTemplateInput,
} from "@dispatch/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.js";
import { render, letterToHtml, type RenderInput } from "../../render/render.js";
import { inlineLocalImages } from "../../render/inlineImages.js";
import { getProvider } from "../../provider/index.js";
import { env } from "../../env.js";
import {
  IMAGE_UPLOAD_MAX_BYTES,
  ImageUploadError,
  storeTemplateImage,
} from "../../domain/imageUpload.js";
import { deleteTemplate } from "../../domain/templateDelete.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { badRequest, conflict, notFound, wrap } from "../errors.js";

export const templatesRouter = Router();
templatesRouter.use(authRequired);

/**
 * The editor sends the message as a plain letter (`bodyText` + optional
 * `signature`); the render-ready `htmlBody` column is derived from it here so
 * the renderer and delivery path stay unchanged. A caller may still pass
 * `htmlBody` directly (escape hatch) when `bodyText` is absent.
 */
function deriveHtmlBody<T extends { bodyText?: string; signature?: string; htmlBody?: string }>(
  body: T,
): T & { htmlBody?: string } {
  if (body.bodyText && body.bodyText.trim()) {
    return { ...body, htmlBody: letterToHtml(body.bodyText, body.signature) };
  }
  return body;
}

/**
 * `images` / `videos` are nullable JSON columns, and Prisma won't accept a bare
 * `null` for those: map an explicit null (a caller clearing the list) to
 * `Prisma.JsonNull`, and leave an absent field (`undefined`) untouched.
 */
function mediaJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (v === undefined) return undefined;
  if (v === null) return Prisma.JsonNull;
  return v as Prisma.InputJsonValue;
}

/**
 * Template image upload. Stores the file via `storeTemplateImage` and returns
 * its public URL — the client drops that into the same `imageUrl` field a
 * pasted URL uses, so nothing downstream changes.
 */
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_UPLOAD_MAX_BYTES, files: 1 },
});

const acceptImage = (req: Request, res: Response, next: NextFunction) =>
  uploadImage.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string }).code;
    next(
      badRequest(
        code === "LIMIT_FILE_SIZE"
          ? "Image is too large — maximum size is 5 MB"
          : "Could not read the uploaded file",
      ),
    );
  });

templatesRouter.post(
  "/uploads/image",
  requireRole("ADMIN"), // editors: view only
  acceptImage,
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    try {
      const { url } = await storeTemplateImage(req.file);
      res.status(201).json({ url });
    } catch (err) {
      if (err instanceof ImageUploadError) throw badRequest(err.message);
      throw err;
    }
  }),
);

templatesRouter.get(
  "/",
  wrap(async (_req, res) => {
    res.json({
      items: await prisma.template.findMany({
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { campaigns: true, triggers: true } } },
      }),
    });
  }),
);

templatesRouter.post(
  "/",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const parsed = deriveHtmlBody(createTemplateInput.parse(req.body));
    // superRefine guarantees bodyText or htmlBody; deriveHtmlBody fills htmlBody
    // from bodyText, so at this point it is always set.
    const htmlBody = parsed.htmlBody!;
    res.status(201).json(
      await prisma.template.create({
        data: {
          ...parsed,
          htmlBody,
          images: mediaJson(parsed.images),
          videos: mediaJson(parsed.videos),
        },
      }),
    );
  }),
);

templatesRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const tpl = await prisma.template.findUnique({ where: { id } });
    if (!tpl) throw notFound("Template");
    res.json(tpl);
  }),
);

templatesRouter.put(
  "/:id",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = deriveHtmlBody(updateTemplateInput.parse(req.body));
    res.json(
      await prisma.template.update({
        where: { id },
        data: { ...body, images: mediaJson(body.images), videos: mediaJson(body.videos) },
      }),
    );
  }),
);

templatesRouter.delete(
  "/:id",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const result = await deleteTemplate(id);
    if (!result.ok) throw result.status === 404 ? notFound("Template") : conflict(result.message);
    res.status(204).end();
  }),
);

templatesRouter.post(
  "/:id/preview",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { variables } = previewTemplateInput.parse(req.body);
    const tpl = await prisma.template.findUnique({ where: { id } });
    if (!tpl) throw notFound("Template");
    const declared = Array.isArray(tpl.variables) ? (tpl.variables as string[]) : [];
    try {
      const out = render({
        subject: tpl.subject,
        htmlBody: tpl.htmlBody,
        textBody: tpl.textBody,
        declaredVariables: declared,
        vars: variables,
        unsubscribeUrl: `${env.PUBLIC_API_URL}/api/unsubscribe/preview`,
        kind: tpl.kind,
        links: tpl.links as RenderInput["links"],
        meeting: tpl.meeting as RenderInput["meeting"],
        imageUrl: tpl.imageUrl,
        videoUrl: tpl.videoUrl,
        images: tpl.images as RenderInput["images"],
        videos: tpl.videos as RenderInput["videos"],
      });
      res.json(out);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }),
);

templatesRouter.post(
  "/:id/send-test",
  requireRole("ADMIN"), // editors: view only
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { to, variables } = sendTestInput.parse(req.body);
    const tpl = await prisma.template.findUnique({ where: { id } });
    if (!tpl) throw notFound("Template");
    const declared = Array.isArray(tpl.variables) ? (tpl.variables as string[]) : [];
    const fakeLogId = `test-${randomUUID()}`;
    const out = render({
      subject: tpl.subject,
      htmlBody: tpl.htmlBody,
      textBody: tpl.textBody,
      declaredVariables: declared,
      vars: variables,
      emailLogId: fakeLogId,
      unsubscribeUrl: `${env.PUBLIC_API_URL}/api/unsubscribe/preview`,
      kind: tpl.kind,
      links: tpl.links as RenderInput["links"],
      meeting: tpl.meeting as RenderInput["meeting"],
      imageUrl: tpl.imageUrl,
      videoUrl: tpl.videoUrl,
      images: tpl.images as RenderInput["images"],
      videos: tpl.videos as RenderInput["videos"],
    });
    const { html, attachments } = await inlineLocalImages(out.html, out.attachments);
    const result = await getProvider().send({
      to,
      from: env.EMAIL_FROM,
      subject: `[TEST] ${out.subject}`,
      html,
      text: out.text,
      attachments,
      headers: {},
      tags: { emailLogId: fakeLogId },
    });
    res.json({ sent: true, provider: getProvider().name, ...result });
  }),
);
