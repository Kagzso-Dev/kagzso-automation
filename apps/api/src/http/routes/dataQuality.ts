// Data Quality (admin only). Writes only data_quality_jobs / data_quality_records: no contact,
// WhatsApp contact, AI call customer, queue, call flow, template or history row is changed, and
// nothing is called or sent. The AI score uses the one service picked by DATA_QUALITY_AI_PROVIDER
// (local Ollama, Groq or Gemini; services/dataQualityAi.ts), sent a row's name and business name only.
//
//   GET    /api/data-quality/status              AI service available? live calls running?
//   GET    /api/data-quality/jobs                recent jobs
//   POST   /api/data-quality/jobs                upload .csv/.xlsx → standard checks + staging job
//   GET    /api/data-quality/jobs/:id            one job with its rows (?status=VALID|…, ?filters=<JSON>)
//   GET    /api/data-quality/jobs/:id/facets     city / state / category / … values in the file (dropdowns)
//   POST   /api/data-quality/jobs/:id/pause      stop AI scoring for now
//   POST   /api/data-quality/jobs/:id/resume     go on with AI scoring
//   POST   /api/data-quality/jobs/:id/cancel     stop AI scoring for good (checks stay)
//   POST   /api/data-quality/jobs/:id/review     approve / reject VALID rows (staging only)
//   POST   /api/data-quality/jobs/:id/review-by-score  approve rows >= minScore / reject rows below it
//   GET    /api/data-quality/jobs/:id/export     CSV of approved (or all valid) rows
//   POST   /api/data-quality/jobs/:id/export-filtered  CSV / XLSX of the filtered rows, chosen columns (audit-logged)
//   DELETE /api/data-quality/jobs/:id            remove a job that is not running

import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { idParam } from "@dispatch/shared";
import { prisma } from "../../prisma.js";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { aiCallFormatFromFilename, readAiCallSheet } from "../../domain/aiCallImport.js";
import { createDataQualityJob, detectDataQualityColumns, liveCallsRunning, overallScore } from "../../domain/dataQuality.js";
import {
  checkColumns,
  DQ_RECORD_SELECT,
  dqFiltersSchema,
  dqViewSchema,
  exportFileName,
  exportMaxRows,
  exportMustWait,
  filteredRecords,
  filtersForLog,
  hasFilters,
  loadFacets,
  matchingRows,
  streamExport,
  type DqFilters,
} from "../../domain/dataQualityExport.js";
import { enqueueDataQuality } from "../../queue/queues.js";
import { checkAi } from "../../services/dataQualityAi.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, badRequest, conflict, notFound, wrap } from "../errors.js";

export const dataQualityRouter = Router();
dataQualityRouter.use(authRequired, requireRole("ADMIN"));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const limiter = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many Data Quality requests — wait a minute and try again.", code: "rate_limited" },
  });
const uploadLimiter = limiter(10);
const readLimiter = limiter(240);
const exportLimiter = limiter(20);

const statusFilter = z.object({ status: z.enum(["VALID", "INVALID", "DUPLICATE", "EXCLUDED"]).optional(), filters: z.string().max(4000).optional() });
const exportFilteredInput = z
  .object({
    filters: dqFiltersSchema.default({}),
    view: dqViewSchema.default({}),
    columns: z.array(z.string().min(4).max(260)).min(1).max(250),
    format: z.enum(["csv", "xlsx"]),
    includeExcluded: z.boolean().default(false),
  })
  .strict();

function parseFilters(text: string): DqFilters {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw badRequest("filters must be JSON");
  }
  return dqFiltersSchema.parse(json);
}

const jobHeaders = (job: { headers: Prisma.JsonValue }) => (Array.isArray(job.headers) ? (job.headers as string[]) : null);
const reviewInput = z
  .object({ ids: z.array(z.string().min(1).max(64)).min(1).max(5000), review: z.enum(["APPROVED", "REJECTED", "PENDING"]) })
  .strict();
const reviewByScoreInput = z.object({ minScore: z.number().int().min(0).max(100), review: z.enum(["APPROVED", "REJECTED"]) }).strict();
const exportQuery = z.object({ rows: z.enum(["approved", "valid"]).default("approved") });

async function jobOr404(id: string) {
  const job = await prisma.dataQualityJob.findUnique({ where: { id } });
  if (!job) throw notFound("Data Quality job");
  return job;
}

dataQualityRouter.get(
  "/status",
  readLimiter,
  wrap(async (_req, res) => {
    const [ai, liveCalls] = await Promise.all([checkAi(), liveCallsRunning()]);
    res.json({ ai, liveCalls });
  }),
);

dataQualityRouter.get(
  "/jobs",
  readLimiter,
  wrap(async (_req, res) => {
    const items = await prisma.dataQualityJob.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    res.json({ items });
  }),
);

dataQualityRouter.post(
  "/jobs",
  uploadLimiter,
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
    const mapping = detectDataQualityColumns(sheet.headers);
    if (!mapping.phone) {
      throw badRequest(`No phone column found. Name one of the columns "Phone" or "Mobile". Columns in the file: ${sheet.headers.join(", ")}`);
    }
    const ai = await checkAi();
    const job = await createDataQualityJob({
      filename: req.file.originalname,
      headers: sheet.headers,
      rows: sheet.rows,
      mapping,
      byEmail: req.user!.email,
      ai,
      defaultCountryCode: aiCallsConfig.defaultCountryCode,
    });
    logger.info(
      { jobId: job.id, by: req.user!.email, total: job.total, valid: job.valid, invalid: job.invalid, duplicates: job.duplicates, excluded: job.excluded, ai: job.aiStatus },
      "data quality job created",
    );
    res.status(201).json({ job, truncated: sheet.truncated });
  }),
);

dataQualityRouter.get(
  "/jobs/:id",
  readLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { status, filters: filtersText } = statusFilter.parse(req.query);
    const job = await jobOr404(id);
    const filters = filtersText ? parseFilters(filtersText) : null;
    // With filters: the whole file is checked, 500 rows at a time. The original row (raw) is never sent.
    const records =
      filters && hasFilters(filters)
        ? await filteredRecords(id, jobHeaders(job), filters, { status })
        : await prisma.dataQualityRecord.findMany({
            where: { jobId: id, ...(status ? { status } : {}) },
            orderBy: { rowIndex: "asc" },
            take: 5000,
            select: DQ_RECORD_SELECT,
          });
    res.json({ job, records: records.map((r) => ({ ...r, score: overallScore(r.ruleScore, r.aiScore) })) });
  }),
);

dataQualityRouter.get(
  "/jobs/:id/facets",
  readLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const headers = jobHeaders(await jobOr404(id));
    res.json({ headers, ...(await loadFacets(id, headers)) });
  }),
);

dataQualityRouter.post(
  "/jobs/:id/pause",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await jobOr404(id);
    const { count } = await prisma.dataQualityJob.updateMany({ where: { id, status: "RUNNING" }, data: { status: "PAUSED", waitingReason: null } });
    if (count !== 1) throw conflict("Only a running job can be paused");
    logger.info({ jobId: id, by: req.user!.email }, "data quality job paused");
    res.json(await jobOr404(id));
  }),
);

dataQualityRouter.post(
  "/jobs/:id/resume",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await jobOr404(id);
    const runToken = randomUUID();
    const { count } = await prisma.dataQualityJob.updateMany({ where: { id, status: "PAUSED" }, data: { status: "RUNNING", runToken } });
    if (count !== 1) throw conflict("Only a paused job can be resumed");
    await enqueueDataQuality({ jobId: id, runToken });
    logger.info({ jobId: id, by: req.user!.email }, "data quality job resumed");
    res.json(await jobOr404(id));
  }),
);

dataQualityRouter.post(
  "/jobs/:id/cancel",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    await jobOr404(id);
    const { count } = await prisma.dataQualityJob.updateMany({
      where: { id, status: { in: ["RUNNING", "PAUSED"] } },
      data: { status: "CANCELLED", aiStatus: "cancelled", waitingReason: null, finishedAt: new Date() },
    });
    if (count !== 1) throw conflict("Only a running or paused job can be cancelled");
    await prisma.dataQualityRecord.updateMany({ where: { jobId: id, aiState: "PENDING" }, data: { aiState: "SKIPPED" } });
    logger.info({ jobId: id, by: req.user!.email }, "data quality job cancelled");
    res.json(await jobOr404(id));
  }),
);

dataQualityRouter.post(
  "/jobs/:id/review",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = reviewInput.parse(req.body);
    await jobOr404(id);
    // Only VALID rows can be approved: invalid, duplicate and excluded rows never leave staging.
    const { count } = await prisma.dataQualityRecord.updateMany({
      where: { jobId: id, id: { in: body.ids }, status: "VALID" },
      data: { review: body.review },
    });
    logger.info({ jobId: id, by: req.user!.email, review: body.review, rows: count }, "data quality rows reviewed");
    res.json({ updated: count });
  }),
);

dataQualityRouter.post(
  "/jobs/:id/review-by-score",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { minScore, review } = reviewByScoreInput.parse(req.body);
    await jobOr404(id);
    // A score is final only once its AI score is in (or will never come).
    if (await prisma.dataQualityRecord.findFirst({ where: { jobId: id, status: "VALID", aiState: "PENDING" }, select: { id: true } })) {
      throw conflict("Some rows are still waiting for their AI score. Let scoring finish, or cancel it, then review by score.");
    }
    // APPROVED: score >= minScore; REJECTED: score < minScore. Rows already reviewed by hand keep their decision.
    const pending = await prisma.dataQualityRecord.findMany({
      where: { jobId: id, status: "VALID", review: "PENDING" },
      select: { id: true, ruleScore: true, aiScore: true },
    });
    const ids = pending
      .filter((r) => {
        const score = overallScore(r.ruleScore, r.aiScore);
        return score != null && (review === "APPROVED" ? score >= minScore : score < minScore);
      })
      .map((r) => r.id);
    const { count } = ids.length
      ? await prisma.dataQualityRecord.updateMany({ where: { jobId: id, id: { in: ids }, status: "VALID", review: "PENDING" }, data: { review } })
      : { count: 0 };
    logger.info({ jobId: id, by: req.user!.email, review, minScore, rows: count }, "data quality rows reviewed by score");
    res.json({ updated: count });
  }),
);

/** Spreadsheet-safe cell: quoted per RFC 4180, and text a spreadsheet would run as a formula gets a leading '. */
export function exportCell(value: string | number | null | undefined): string {
  let v = value == null ? "" : String(value);
  if (/^[=@\t\r]/.test(v) || /^[+-](?!\d)/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

dataQualityRouter.get(
  "/jobs/:id/export",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const { rows } = exportQuery.parse(req.query);
    await jobOr404(id);
    const records = await prisma.dataQualityRecord.findMany({
      where: { jobId: id, status: "VALID", ...(rows === "approved" ? { review: "APPROVED" } : {}) },
      orderBy: { rowIndex: "asc" },
      select: DQ_RECORD_SELECT,
    });
    const head = ["row", "name", "phone", "business_name", "email", "score", "rule_score", "ai_score", "ai_notes", "issues", "notes", "review"];
    const lines = records.map((r) =>
      [
        r.rowIndex + 2,
        r.name,
        r.phone,
        r.businessName,
        r.email,
        overallScore(r.ruleScore, r.aiScore),
        r.ruleScore,
        r.aiScore,
        r.aiNotes,
        (r.issues as string[]).join(" "),
        (r.flags as string[]).join(" "),
        r.review.toLowerCase(),
      ]
        .map(exportCell)
        .join(","),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="data-quality-${rows}-${id.slice(0, 8)}.csv"`);
    res.send([head.join(","), ...lines].join("\r\n") + "\r\n");
  }),
);

dataQualityRouter.post(
  "/jobs/:id/export-filtered",
  exportLimiter,
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const body = exportFilteredInput.parse(req.body);
    const job = await jobOr404(id);
    const headers = jobHeaders(job);
    const columns = [...new Set(body.columns)];
    try {
      checkColumns(columns, headers);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    if (await exportMustWait()) {
      throw new AppError(503, "The server is busy scoring a file and memory is low. Try again shortly.", "try_again");
    }

    const exportJob = { id, filename: job.filename, createdAt: job.createdAt, headers };
    const request = { ...body, columns };
    const rowIndexes = await matchingRows(exportJob, request);
    const max = exportMaxRows();
    if (rowIndexes.length > max) {
      throw new AppError(
        413,
        `These filters match ${rowIndexes.length.toLocaleString("en-IN")} rows; one export can hold at most ${max.toLocaleString("en-IN")}. Narrow the filters and try again.`,
        "too_many_rows",
      );
    }
    // Audit: who, when, which file, filters (text searches hidden), columns, row count. No contact data.
    await prisma.dataQualityExportLog.create({
      data: {
        jobId: id,
        filename: job.filename,
        byEmail: req.user!.email,
        format: body.format,
        filters: filtersForLog(body.filters, body.view) as Prisma.InputJsonValue,
        columns,
        includeExcluded: body.includeExcluded,
        rowCount: rowIndexes.length,
      },
    });
    logger.info(
      { jobId: id, by: req.user!.email, format: body.format, rows: rowIndexes.length, columns: columns.length, includeExcluded: body.includeExcluded },
      "data quality filtered export",
    );

    const name = exportFileName(job.filename, body.filters, body.view, body.format, new Date(), env.SCHEDULER_TIMEZONE);
    res.setHeader("Content-Type", body.format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("X-Row-Count", String(rowIndexes.length));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Row-Count");
    try {
      await streamExport(res, exportJob, request, rowIndexes, env.SCHEDULER_TIMEZONE);
    } catch (err) {
      // Headers are already sent: end the download instead of answering with JSON.
      logger.error({ err, jobId: id }, "data quality filtered export failed");
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }),
);

dataQualityRouter.delete(
  "/jobs/:id",
  wrap(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const job = await jobOr404(id);
    if (job.status === "RUNNING") throw conflict("Pause or cancel the job before removing it");
    await prisma.dataQualityJob.delete({ where: { id } }); // its rows go with it (cascade)
    logger.info({ jobId: id, by: req.user!.email }, "data quality job removed");
    res.json({ ok: true });
  }),
);
