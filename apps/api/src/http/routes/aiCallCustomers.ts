// AI Call Customers (Contacts page → "AI Call Customers" tab). ADMIN and EDITOR;
// 404 while ENABLE_AI_CALLS is off, like /api/ai-calls.
//
//   GET    /api/ai-call-customers               list (search, gender, stage, page)
//   GET    /api/ai-call-customers/callable      every live customer (AI Call modal source)
//   GET    /api/ai-call-customers/sample        sample .xlsx for the import
//   POST   /api/ai-call-customers/parse         upload .xlsx/.csv → headers, rows, detected columns
//   POST   /api/ai-call-customers/import        import mapped rows (valid rows only)
//   POST   /api/ai-call-customers               add one
//   PUT    /api/ai-call-customers/:id           edit
//   POST   /api/ai-call-customers/delete        soft delete { ids }
//   GET    /api/ai-call-customers/:id           detail: calls, follow-ups, timeline
//   POST   /api/ai-call-customers/:id/stage     review: approve / reject / change stage
//   POST   /api/ai-call-customers/:id/followups add a follow-up (pending approval)
//   POST   /api/ai-call-customers/call          start AI calls for saved customers
//
// Each language has its own list: ?language=ta on list / callable / import / add (absent =
// English, exactly as before), and `language` in the /call body (only that list is called).

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import {
  aiCallCustomerInput,
  aiCallLanguageQuery,
  bulkIdsInput,
  callAiCallCustomersInput,
  createFollowupInput,
  detectAiCallCustomerColumns,
  idParam,
  importAiCallCustomersInput,
  listAiCallCustomersQuery,
  setAiCallStageInput,
} from "@dispatch/shared";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { aiCallFormatFromFilename, readAiCallSheet } from "../../domain/aiCallImport.js";
import {
  callableCustomers,
  createCustomer,
  CustomerError,
  customerDetail,
  importCustomers,
  listCustomers,
  setCustomerStage,
  softDeleteCustomers,
  updateCustomer,
} from "../../domain/aiCallCustomers.js";
import { buildSampleCustomersWorkbook } from "../../domain/aiCallCustomerSample.js";
import { createManualFollowup, FollowupError } from "../../domain/aiCallFollowups.js";
import { prisma } from "../../prisma.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, wrap } from "../errors.js";
import { planAndStartAiCallRun } from "./aiCalls.js";

export const aiCallCustomersRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many requests — wait a minute and try again.", code: "rate_limited" },
  });
const readLimiter = limiter(240);
const writeLimiter = limiter(120);
const callLimiter = limiter(10);

function featureGate(_req: Request, _res: Response, next: NextFunction) {
  if (!aiCallsConfig.enabled) return next(new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found"));
  next();
}
aiCallCustomersRouter.use(authRequired, featureGate, requireRole("ADMIN", "EDITOR"));

/** Domain errors → HTTP errors. */
function toHttp(err: unknown): never {
  if (err instanceof CustomerError || err instanceof FollowupError) {
    const code = err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : err.status >= 500 ? "unavailable" : "bad_request";
    throw new AppError(err.status, err.message, code);
  }
  throw err;
}
const guarded = <T>(p: Promise<T>) => p.catch(toHttp);

aiCallCustomersRouter.get(
  "/",
  readLimiter,
  wrap(async (req, res) => {
    res.json(await listCustomers(listAiCallCustomersQuery.parse(req.query)));
  }),
);

aiCallCustomersRouter.get(
  "/callable",
  readLimiter,
  wrap(async (req, res) => {
    const { language } = aiCallLanguageQuery.parse(req.query);
    res.json({ items: await callableCustomers(language) });
  }),
);

aiCallCustomersRouter.get(
  "/sample",
  readLimiter,
  wrap(async (_req, res) => {
    const buf = await buildSampleCustomersWorkbook();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="sample-ai-call-customers.xlsx"');
    res.send(buf);
  }),
);

aiCallCustomersRouter.post(
  "/parse",
  readLimiter,
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest("File required (multipart field 'file')");
    const format = aiCallFormatFromFilename(req.file.originalname);
    if (!format) throw badRequest("Unsupported file type — upload a .xlsx or .csv file");
    let sheet;
    try {
      sheet = await readAiCallSheet(req.file.buffer, format);
    } catch (err) {
      throw badRequest(`Couldn't read the file: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (sheet.headers.length === 0) throw badRequest("The file has no header row");
    if (sheet.rows.length === 0) throw badRequest("The file has no data rows");
    res.json({ headers: sheet.headers, rows: sheet.rows, truncated: sheet.truncated, mapping: detectAiCallCustomerColumns(sheet.headers) });
  }),
);

aiCallCustomersRouter.post(
  "/import",
  writeLimiter,
  wrap(async (req, res) => {
    const { rows } = importAiCallCustomersInput.parse(req.body);
    const { language } = aiCallLanguageQuery.parse(req.query);
    res.json(await guarded(importCustomers(rows, req.user!.email, language)));
  }),
);

aiCallCustomersRouter.post(
  "/delete",
  writeLimiter,
  wrap(async (req, res) => {
    const { ids } = bulkIdsInput.parse(req.body);
    res.json({ deleted: await softDeleteCustomers(ids, req.user!.email) });
  }),
);

aiCallCustomersRouter.post(
  "/call",
  callLimiter,
  wrap(async (req, res) => {
    const body = callAiCallCustomersInput.parse(req.body);
    // Rows in exactly the order the browser sent, so selectedIndexes line up.
    // A missing / deleted id, or a customer of another language's list, becomes an empty row
    // (reported as invalid, never dialled).
    const found = await prisma.aiCallCustomer.findMany({
      where: { id: { in: body.customerIds }, deletedAt: null, language: body.language },
      select: { id: true, customerName: true, gender: true, followUpDetail: true, phone: true },
    });
    const byId = new Map(found.map((c) => [c.id, c]));
    const rows = body.customerIds.map((id) => {
      const c = byId.get(id);
      return { customerName: c?.customerName ?? null, gender: c?.gender ?? null, followUpDetail: c?.followUpDetail ?? null, phone: c?.phone ?? "" };
    });
    const { customerIds, ...rest } = body;
    const out = await planAndStartAiCallRun({ ...rest, rows }, req.user!, customerIds.map((id) => (byId.has(id) ? id : null)));
    res.status(out.status).json(out.json);
  }),
);

aiCallCustomersRouter.post(
  "/",
  writeLimiter,
  wrap(async (req, res) => {
    const input = aiCallCustomerInput.parse(req.body);
    const { language } = aiCallLanguageQuery.parse(req.query);
    res.status(201).json(await guarded(createCustomer(input, req.user!.email, language)));
  }),
);

aiCallCustomersRouter.get(
  "/:id",
  readLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    res.json(await guarded(customerDetail(id)));
  }),
);

aiCallCustomersRouter.put(
  "/:id",
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const input = aiCallCustomerInput.parse(req.body);
    res.json(await guarded(updateCustomer(id, input, req.user!.email)));
  }),
);

aiCallCustomersRouter.post(
  "/:id/stage",
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { stage, note } = setAiCallStageInput.parse(req.body);
    res.json(await guarded(setCustomerStage(id, stage, req.user!.email, note)));
  }),
);

aiCallCustomersRouter.post(
  "/:id/followups",
  writeLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const input = createFollowupInput.parse(req.body);
    res.status(201).json(await guarded(createManualFollowup(id, input, req.user!.email)));
  }),
);
