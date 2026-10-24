// Data Quality AI scoring: one staging job row per run, then re-schedules itself (the drip
// shape of queue/aiCallRun.ts). Only the service picked by DATA_QUALITY_AI_PROVIDER is called
// (services/dataQualityAi.ts), and only with a row's name and business name.
//
//   - one row per run, one AI request at a time, each with a timeout (DATA_QUALITY_AI_TIMEOUT_SEC)
//   - DATA_QUALITY_AI_MIN_GAP_MS between rows (cloud services have per-minute limits)
//   - "too many requests" → the same row is tried again later (not counted as a failure)
//   - waits while live AI calls are running, so the voice server stays fast
//   - PAUSED / CANCELLED / a newer runToken (resume) stop this run at its next step
//   - service down or 5 failed rows → the rest is SKIPPED, the standard checks stay

import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { dataQualityConfig, PROVIDER_LABELS } from "../config/dataQuality.js";
import { aiPrompt, liveCallsRunning, parseAiAnswer } from "../domain/dataQuality.js";
import { AiError, checkAi, generateJson } from "../services/dataQualityAi.js";
import { DeferJobError } from "./engine.js";
import type { DataQualityJobPayload } from "./queues.js";

const LIVE_CALLS_RECHECK_MS = 30_000;
export const MAX_AI_FAILURES = 5;
export const WAITING_FOR_CALLS = "Paused automatically: live AI calls are running";

const deferFor = (ms: number) => new DeferJobError(new Date(Date.now() + ms));

/** Status changes only while the job is still RUNNING, so a pause / cancel meanwhile wins. */
function updateRunning(jobId: string, data: Parameters<typeof prisma.dataQualityJob.updateMany>[0]["data"]) {
  return prisma.dataQualityJob.updateMany({ where: { id: jobId, status: "RUNNING" }, data });
}

async function stopAi(jobId: string, note: string) {
  await prisma.dataQualityRecord.updateMany({ where: { jobId, aiState: "PENDING" }, data: { aiState: "SKIPPED" } });
  await updateRunning(jobId, { status: "DONE", aiStatus: "unavailable", note: note.slice(0, 300), waitingReason: null, finishedAt: new Date() });
  logger.warn({ jobId, note }, "data quality: AI scoring stopped, standard checks kept");
}

export async function processDataQuality(payload: Record<string, unknown>): Promise<unknown> {
  const { jobId, runToken } = payload as unknown as DataQualityJobPayload;
  const settings = dataQualityConfig.ai;
  const label = PROVIDER_LABELS[settings.provider];
  const job = await prisma.dataQualityJob.findUnique({ where: { id: jobId } });
  if (!job) return { skipped: "job gone" };
  if (job.status !== "RUNNING" || job.runToken !== runToken) return { stopped: job.status };

  if (await liveCallsRunning()) {
    if (job.waitingReason !== WAITING_FOR_CALLS) await updateRunning(jobId, { waitingReason: WAITING_FOR_CALLS });
    throw deferFor(LIVE_CALLS_RECHECK_MS);
  }

  const next = await prisma.dataQualityRecord.findFirst({ where: { jobId, aiState: "PENDING" }, orderBy: { rowIndex: "asc" } });
  if (!next) {
    await updateRunning(jobId, { status: "DONE", aiStatus: "done", waitingReason: null, finishedAt: new Date() });
    logger.info({ jobId, aiDone: job.aiDone, aiFailures: job.aiFailures }, "data quality job complete");
    return { done: true };
  }

  // A local server can stop at any time; a cloud service is checked at upload (and by its errors).
  if (settings.provider === "ollama" || settings.problem) {
    const health = await checkAi(settings);
    if (!health.available) {
      await stopAi(jobId, `${label} not available: ${health.reason ?? "unknown"}`);
      return { stopped: "ai unavailable" };
    }
  }

  try {
    const answer = parseAiAnswer(await generateJson(aiPrompt(next), settings));
    await prisma.dataQualityRecord.update({ where: { id: next.id }, data: { aiState: "DONE", aiScore: answer.score, aiNotes: answer.notes } });
    await prisma.dataQualityJob.update({ where: { id: jobId }, data: { aiDone: { increment: 1 }, waitingReason: null } });
  } catch (err) {
    if (err instanceof AiError && err.retryAfterMs != null) {
      // Rate limited: the row stays PENDING and is tried again; not a failure.
      await updateRunning(jobId, { waitingReason: `Waiting: ${label} rate limit, trying again shortly` });
      throw deferFor(err.retryAfterMs);
    }
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await prisma.dataQualityRecord.update({ where: { id: next.id }, data: { aiState: "ERROR", aiNotes: message } });
    await prisma.dataQualityJob.update({ where: { id: jobId }, data: { aiFailures: { increment: 1 }, waitingReason: null } });
    if (job.aiFailures + 1 >= MAX_AI_FAILURES) {
      await stopAi(jobId, `AI scoring stopped after ${MAX_AI_FAILURES} failed rows: ${message}`);
      return { stopped: "too many failures" };
    }
  }
  throw deferFor(settings.minGapMs);
}
