// AI call recordings (the voice backend records answered calls when CALL_RECORDING_ENABLED is on).
// ADMIN only, and 404 unless ENABLE_AI_CALLS is on. A recording is reached through an AI call log
// row: the voice call id comes from our database, never from the request, and no file path or
// URL is ever sent to the browser.
//
//   GET    /api/ai-calls/recordings/status?logIds=a,b   recording status per log (call list badges)
//   GET    /api/ai-calls/logs/:logId/recording          metadata
//   GET    /api/ai-calls/logs/:logId/recording/audio    the WAV, HTTP Range passed through (?download=1 to save)
//   DELETE /api/ai-calls/logs/:logId/recording          delete the file (the call log, transcript and summary stay)
//
// Every access is logged with the admin id, log id, voice call id, action and result - never a
// phone number or audio.

import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { logger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import {
  deleteRecording,
  fetchRecordingAudio,
  getRecording,
  listRecordings,
  VoiceBackendError,
} from "../../services/voiceBackend.js";
import { authRequired, requireRole } from "../middleware/auth.js";
import { AppError, notFound, wrap } from "../errors.js";

export const aiCallRecordingsRouter = Router();
aiCallRecordingsRouter.use(
  ["/recordings", "/logs/:logId/recording"],
  authRequired,
  (_req: Request, _res: Response, next: NextFunction) => {
    if (!aiCallsConfig.enabled) return next(new AppError(404, "AI calls are disabled (set ENABLE_AI_CALLS=true)", "not_found"));
    next();
  },
  requireRole("ADMIN"),
  rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
    message: { error: "Too many recording requests — wait a minute and try again.", code: "rate_limited" },
  }),
);

const logIdParam = z.object({ logId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid call log id") });
const statusQuery = z.object({ logIds: z.string().max(8000).default("") });

/** The voice call behind a log row we own; 404 for an unknown log or a call that never reached the voice backend. */
async function voiceCallOf(logId: string): Promise<string> {
  const log = await prisma.aiCallLog.findUnique({ where: { id: logId }, select: { voiceCallId: true } });
  if (!log?.voiceCallId) throw notFound("Call");
  return log.voiceCallId;
}

function audit(req: Request, logId: string, voiceCallId: string | null, action: string, result: string) {
  logger.info({ adminId: req.user!.id, logId, voiceCallId, action, result }, "call recording access");
}

function voiceError(err: unknown): never {
  if (err instanceof VoiceBackendError) {
    if (err.status === 404) throw new AppError(404, "No recording for this call", "not_found");
    throw new AppError(err.status === null || err.retryable ? 503 : 502, "The voice backend could not provide the recording", "unavailable");
  }
  throw err;
}

aiCallRecordingsRouter.get(
  "/recordings/status",
  wrap(async (req, res) => {
    const { logIds } = statusQuery.parse(req.query);
    const ids = [...new Set(logIds.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)))].slice(0, 200);
    const logs = ids.length
      ? await prisma.aiCallLog.findMany({ where: { id: { in: ids }, voiceCallId: { not: null } }, select: { id: true, voiceCallId: true } })
      : [];
    if (!logs.length) {
      res.json({ enabled: null, items: {} });
      return;
    }
    const { enabled, items } = await listRecordings(logs.map((l) => l.voiceCallId!)).catch(voiceError);
    const byCall = new Map(items.map((r) => [r.call_id, r.status]));
    res.json({ enabled, items: Object.fromEntries(logs.filter((l) => byCall.has(l.voiceCallId!)).map((l) => [l.id, byCall.get(l.voiceCallId!)])) });
  }),
);

aiCallRecordingsRouter.get(
  "/logs/:logId/recording",
  wrap(async (req, res) => {
    const { logId } = logIdParam.parse(req.params);
    const voiceCallId = await voiceCallOf(logId);
    const body = await getRecording(voiceCallId).catch(voiceError);
    audit(req, logId, voiceCallId, "view", body.recording?.status ?? "none");
    res.json(body);
  }),
);

aiCallRecordingsRouter.get(
  "/logs/:logId/recording/audio",
  wrap(async (req, res) => {
    const { logId } = logIdParam.parse(req.params);
    const download = req.query.download === "1";
    const voiceCallId = await voiceCallOf(logId);
    const range = typeof req.headers.range === "string" && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
    const upstream = await fetchRecordingAudio(voiceCallId, range).catch(voiceError);
    if (!upstream.ok || !upstream.body) {
      audit(req, logId, voiceCallId, download ? "download" : "play", `refused_${upstream.status}`);
      if (upstream.status === 416) {
        res.status(416).set("Content-Range", upstream.headers.get("content-range") ?? "").end();
        return;
      }
      if (upstream.status === 409) throw new AppError(409, "The recording is still being saved — try again in a moment", "conflict");
      if (upstream.status === 404) throw new AppError(404, "No recording is available for this call", "not_found");
      throw new AppError(503, "The voice backend could not provide the recording", "unavailable");
    }
    audit(req, logId, voiceCallId, download ? "download" : "play", String(upstream.status));
    res.status(upstream.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (download) res.setHeader("Content-Disposition", `attachment; filename="call-${logId}.wav"`);
    Readable.fromWeb(upstream.body as unknown as NodeReadableStream).pipe(res);
  }),
);

aiCallRecordingsRouter.delete(
  "/logs/:logId/recording",
  wrap(async (req, res) => {
    const { logId } = logIdParam.parse(req.params);
    const voiceCallId = await voiceCallOf(logId);
    try {
      const body = await deleteRecording(voiceCallId);
      audit(req, logId, voiceCallId, "delete", "deleted");
      res.json(body);
    } catch (err) {
      audit(req, logId, voiceCallId, "delete", "failed");
      voiceError(err);
    }
  }),
);
