// Status callbacks from kagzso-voice-backend: POST /api/webhooks/ai-calls.
//
// Mounted in http/app.ts BEFORE express.json(): the signature is an
// HMAC-SHA256 over "<X-Kagzso-Timestamp>.<raw body>" with AI_CALL_WEBHOOK_SECRET,
// sent as X-Kagzso-Signature: sha256=<hex>. Unsigned, mis-signed or stale
// (> 5 min) requests are rejected. If the secret is unset the endpoint is off
// and runs advance by polling the voice backend instead.

import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { aiCallsConfig } from "../../config/aiCalls.js";
import { applyVoiceUpdate, isValidAiCallSignature, parseUtc } from "../../domain/aiCalls.js";
import { prisma } from "../../prisma.js";
import { logger } from "../../logger.js";
import { AppError, badRequest, unauthorized, wrap } from "../errors.js";

export const aiCallWebhookRouter = Router();

const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true });

const callbackBody = z.object({
  event: z.string().max(40).optional(),
  log_id: z.string().min(1).max(64),
  run_id: z.string().max(64).optional().nullable(),
  call_id: z.string().max(64).optional().nullable(),
  provider_call_id: z.string().max(64).optional().nullable(),
  status: z.string().max(32).optional().nullable(),
  outcome: z.string().max(32).optional().nullable(),
  summary: z.string().max(10_000).optional().nullable(),
  hangup_cause: z.string().max(200).optional().nullable(),
  duration_seconds: z.number().int().min(0).optional().nullable(),
  ended_at: z.string().max(40).optional().nullable(),
  learned_business: z.string().max(200).optional().nullable(),
  transcript: z
    .array(z.object({ speaker: z.string().max(20), text: z.string().max(5000) }))
    .max(500)
    .optional()
    .nullable(),
});

aiCallWebhookRouter.post(
  "/",
  limiter,
  express.raw({ type: "*/*", limit: "2mb" }),
  wrap(async (req, res) => {
    const secret = aiCallsConfig.webhookSecret;
    if (!secret) throw new AppError(503, "AI call webhook secret is not configured", "unavailable");

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ts = req.headers["x-kagzso-timestamp"];
    const sig = req.headers["x-kagzso-signature"];
    if (!isValidAiCallSignature(raw, typeof ts === "string" ? ts : undefined, typeof sig === "string" ? sig : undefined, secret)) {
      throw unauthorized("Invalid webhook signature");
    }

    let body: z.infer<typeof callbackBody>;
    try {
      body = callbackBody.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw badRequest("Webhook body is not valid");
    }

    const log = await prisma.aiCallLog.findUnique({
      where: { id: body.log_id },
      select: { id: true, runId: true, voiceCallId: true },
    });
    // Unknown / mismatched ids are acknowledged (no retry storm) but ignored.
    if (!log || (body.run_id && body.run_id !== log.runId) || (log.voiceCallId && body.call_id && body.call_id !== log.voiceCallId)) {
      logger.warn({ logId: body.log_id, event: body.event }, "ai call callback for unknown call ignored");
      return res.json({ ok: true, ignored: true });
    }

    const status = await applyVoiceUpdate(log.id, {
      status: body.status,
      voiceCallId: body.call_id,
      providerCallId: body.provider_call_id,
      outcome: body.outcome,
      summary: body.summary,
      transcript: body.transcript,
      durationSec: body.duration_seconds,
      endedAt: parseUtc(body.ended_at),
      error: body.hangup_cause,
      learnedBusiness: body.learned_business,
    });
    logger.debug({ logId: log.id, event: body.event, status }, "ai call callback applied");
    res.json({ ok: true, status });
  }),
);
