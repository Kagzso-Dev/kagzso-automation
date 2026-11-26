// Orchestrator for one AI-call run. Same drip shape as queue/whatsappBulkSend.ts:
// one job row per run that re-schedules itself with DeferJobError.
//
// Calls are strictly sequential: the next customer is dialled only after the
// previous call reached a final status AND `gapSeconds` passed since it ended.
// While a call is in flight the job polls the voice backend every few seconds,
// so the run still advances if a status callback never arrives.
//
// Every call of a run goes through the voice backend of the run's language (its
// pinned flow's; no flow = English). If an admin switches that language off, the
// call in flight finishes and the calls still queued are cancelled.

import {
  autonomousCallBlockedReason,
  DEFAULT_AI_CALL_LANGUAGE,
  maskPhone,
  type AiCallLanguage,
} from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { aiCallsConfig } from "../config/aiCalls.js";
import {
  applyVoiceUpdate,
  IN_FLIGHT_AI_CALL_STATUSES,
  loadDoNotCallPhones,
  parseUtc,
} from "../domain/aiCalls.js";
import { disabledAiCallLanguages, languageName } from "../domain/aiCallLanguages.js";
import { voiceTuningForCall } from "../domain/aiCallVoiceTuning.js";
import { pinnedFlowForRun } from "../domain/callFlows.js";
import { businessForCall, markCustomerCalling, syncCustomerFromLog } from "../domain/aiCallCustomerSync.js";
import { knownQuestionsForFlow } from "../domain/aiAgentQuestions.js";
import { historyForCall } from "../domain/aiAgentHistory.js";
import { getVoiceCall, placeVoiceCall, VoiceBackendError } from "../services/voiceBackend.js";
import { isHardStopEnabled } from "../config/hardStop.js";
import { claimAiCallLog } from "../domain/hardStop.js";
import { DeferJobError } from "./engine.js";
import type { AiCallRunJob } from "./queues.js";

const POLL_MS = 5000;

const deferFor = (ms: number) => new DeferJobError(new Date(Date.now() + ms));

/** The run's "AI Greeting Delay" (kept in its skipped JSON); null for runs started before it existed. */
export function greetingDelayOf(skipped: unknown): number | null {
  const v = (skipped as { greetingDelaySec?: unknown } | null)?.greetingDelaySec;
  return typeof v === "number" && v >= 0 && v <= 10 ? v : null;
}

async function finish(runId: string): Promise<Record<string, number>> {
  if (isHardStopEnabled()) {
    // Only a run still RUNNING becomes DONE: one a hard stop cancelled meanwhile stays CANCELLED.
    await prisma.aiCallRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { status: "DONE", nextCallAt: null } });
  } else {
    await prisma.aiCallRun.update({ where: { id: runId }, data: { status: "DONE", nextCallAt: null } });
  }
  const rows = await prisma.aiCallLog.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r._count._all;
  logger.info({ runId, ...counts }, "ai call run complete");
  return counts;
}

/** The language was switched off in Settings: cancel the calls not dialled yet (like Cancel run). */
async function stopForDisabledLanguage(runId: string, language: AiCallLanguage): Promise<Record<string, unknown>> {
  const queued = await prisma.aiCallLog.findMany({ where: { runId, status: "QUEUED" }, select: { id: true } });
  const why = `Not called — ${languageName(language)} AI calls were switched off in Settings`;
  await prisma.$transaction([
    prisma.aiCallRun.update({ where: { id: runId }, data: { status: "CANCELLED", nextCallAt: null } }),
    prisma.aiCallLog.updateMany({ where: { runId, status: "QUEUED" }, data: { status: "CANCELLED", error: why } }),
  ]);
  for (const l of queued) await syncCustomerFromLog(l.id);
  logger.info({ runId, language, cancelled: queued.length }, "ai call run stopped — language switched off");
  return { stopped: "language_disabled", cancelled: queued.length };
}

/** One poll of the voice backend for this log's call, applied like a status callback. Never throws. */
async function refreshFromVoice(runId: string, log: { id: string; phone: string; voiceCallId: string }, language: AiCallLanguage) {
  try {
    const d = await getVoiceCall(log.voiceCallId, language);
    await applyVoiceUpdate(log.id, {
      status: d.status,
      providerCallId: d.provider_call_id,
      outcome: d.outcome,
      summary: d.summary,
      transcript: d.transcripts ?? null,
      durationSec: d.duration_seconds,
      endedAt: parseUtc(d.ended_at),
      error: d.hangup_cause,
      learnedBusiness: d.learned_business,
      customerQuestions: d.customer_questions,
      callInsights: d.call_insights,
    });
  } catch (err) {
    logger.warn(
      { runId, logId: log.id, phone: maskPhone(log.phone), err: err instanceof Error ? err.message : String(err) },
      "ai call status poll failed",
    );
  }
}

/**
 * How long after an answered call ends the run keeps asking the voice backend for its result. The hangup gives the
 * final status first; the outcome, summary and transcript are saved a moment later, when the conversation is
 * finalized (a classification takes up to about 30 s).
 */
export const AI_CALL_RESULT_SETTLE_MS = 60_000;

/**
 * A completed call whose result (outcome) hasn't arrived: ask the voice backend again, up to AI_CALL_RESULT_SETTLE_MS
 * after it ended. Polling stopped at the final status, so the result came only with the signed status callback: one
 * missed or refused callback (STATUS_CALLBACK_URL / secret not set on that language's backend) left the Result empty
 * for good, and a run's last call was never asked at all (the job finished). Returns true while it is still waiting.
 */
async function settleEndedCall(runId: string, language: AiCallLanguage): Promise<boolean> {
  const log = await prisma.aiCallLog.findFirst({
    where: {
      runId,
      status: "COMPLETED",
      outcome: null,
      voiceCallId: { not: null },
      endedAt: { gte: new Date(Date.now() - AI_CALL_RESULT_SETTLE_MS) },
    },
    orderBy: { endedAt: "desc" },
  });
  if (!log?.voiceCallId) return false;
  await refreshFromVoice(runId, { id: log.id, phone: log.phone, voiceCallId: log.voiceCallId }, language);
  const fresh = await prisma.aiCallLog.findUnique({ where: { id: log.id }, select: { outcome: true } });
  if (fresh?.outcome) return false;
  logger.debug({ runId, logId: log.id, voiceCallId: log.voiceCallId }, "ai call ended — waiting for its result");
  return true;
}

/** Refresh an in-flight call from the voice backend; time it out if it never ends. Returns true if still in flight. */
async function pollInFlight(runId: string, language: AiCallLanguage): Promise<boolean> {
  const log = await prisma.aiCallLog.findFirst({
    where: { runId, status: { in: [...IN_FLIGHT_AI_CALL_STATUSES] } },
    orderBy: { position: "asc" },
  });
  if (!log) return false;

  if (log.voiceCallId) await refreshFromVoice(runId, { id: log.id, phone: log.phone, voiceCallId: log.voiceCallId }, language);

  const fresh = await prisma.aiCallLog.findUnique({ where: { id: log.id } });
  if (!fresh || !IN_FLIGHT_AI_CALL_STATUSES.includes(fresh.status)) return false;
  const startedAt = fresh.startedAt?.getTime() ?? Date.now();
  if (Date.now() - startedAt > aiCallsConfig.callTimeoutSec * 1000) {
    await prisma.aiCallLog.update({
      where: { id: fresh.id },
      data: {
        status: "FAILED",
        endedAt: new Date(),
        error: `No final status from the voice backend within ${aiCallsConfig.callTimeoutSec}s`,
      },
    });
    logger.warn({ runId, logId: fresh.id, phone: maskPhone(fresh.phone) }, "ai call timed out — moving on");
    await syncCustomerFromLog(fresh.id);
    return false;
  }
  return true;
}

/**
 * One iteration: settle the in-flight call (if any), honour the gap, then dial
 * the next QUEUED customer and re-schedule. A per-call failure is recorded on
 * the log row and the run moves on.
 */
export async function processAiCallRun(payload: Record<string, unknown>): Promise<unknown> {
  const { runId } = payload as unknown as AiCallRunJob;
  const run = await prisma.aiCallRun.findUnique({ where: { id: runId } });
  if (!run) return { skipped: "run gone" };
  // The run's language is its pinned flow's (no flow = the default agent = English).
  const flow = await pinnedFlowForRun(runId);
  const language = flow?.language ?? DEFAULT_AI_CALL_LANGUAGE;

  if (await pollInFlight(runId, language)) throw deferFor(POLL_MS);
  // Also for a stopped run and before the run finishes: its last call's result still comes in.
  if (await settleEndedCall(runId, language)) throw deferFor(POLL_MS);
  if (run.status !== "RUNNING") return { stopped: run.status };
  if (language !== DEFAULT_AI_CALL_LANGUAGE && (await disabledAiCallLanguages()).has(language)) {
    return stopForDisabledLanguage(runId, language);
  }

  const next = await prisma.aiCallLog.findFirst({
    where: { runId, status: "QUEUED" },
    orderBy: { position: "asc" },
  });
  if (!next) return { done: true, ...(await finish(runId)) };

  const last = await prisma.aiCallLog.findFirst({
    where: { runId, endedAt: { not: null } },
    orderBy: { endedAt: "desc" },
    select: { endedAt: true },
  });
  const dueAt = last?.endedAt ? last.endedAt.getTime() + run.gapSeconds * 1000 : 0;
  if (dueAt > Date.now()) {
    await prisma.aiCallRun.update({ where: { id: runId }, data: { nextCallAt: new Date(dueAt) } });
    throw new DeferJobError(new Date(dueAt));
  }

  // Re-check opt-outs at dial time: someone may have unsubscribed since the run started.
  const doNotCall = await loadDoNotCallPhones(aiCallsConfig.defaultCountryCode);
  if (doNotCall.has(next.phone)) {
    const skip = { status: "FAILED" as const, error: "Skipped — number is on the do-not-call list" };
    if (isHardStopEnabled()) {
      // Only while still QUEUED, so a skip can never overwrite a call a hard stop cancelled.
      await prisma.aiCallLog.updateMany({ where: { id: next.id, status: "QUEUED" }, data: skip });
    } else {
      await prisma.aiCallLog.update({ where: { id: next.id }, data: skip });
    }
    logger.info({ runId, logId: next.id, phone: maskPhone(next.phone) }, "ai call skipped (do-not-call)");
    await syncCustomerFromLog(next.id);
    throw deferFor(1000);
  }

  // Autonomous AI Agent calls paused in this language (AI_AGENT_AUTONOMOUS_CALLS_BLOCKED): never dialled, even
  // for a run queued before the pause. Checked at dial time, like do-not-call.
  const paused = flow ? autonomousCallBlockedReason(flow.language, flow.definition) : null;
  if (paused) {
    if (isHardStopEnabled()) {
      await prisma.aiCallLog.updateMany({ where: { id: next.id, status: "QUEUED" }, data: { status: "FAILED", error: `Skipped — ${paused}` } });
    } else {
      await prisma.aiCallLog.update({ where: { id: next.id }, data: { status: "FAILED", error: `Skipped — ${paused}` } });
    }
    logger.info({ runId, logId: next.id, phone: maskPhone(next.phone), language }, "ai call skipped (autonomous calls paused)");
    await syncCustomerFromLog(next.id);
    throw deferFor(1000);
  }

  if (isHardStopEnabled()) {
    // Hard stop check point: dial only if the run is still running and this call still QUEUED. A stop that got there
    // first wins (nothing is dialled); the next run of this job re-reads the run and stops.
    if (!(await claimAiCallLog(runId, next.id))) throw deferFor(1000);
  } else {
    await prisma.aiCallLog.update({ where: { id: next.id }, data: { status: "DIALING", startedAt: new Date() } });
  }
  await prisma.aiCallRun.update({ where: { id: runId }, data: { nextCallAt: null } });
  await markCustomerCalling(next.id);
  try {
    const greetingDelaySec = greetingDelayOf(run.skipped);
    // Every call carries the contact's business: the voice backend decides how each kind of flow uses it.
    const customerBusiness = await businessForCall(next.id, next.phone, language);
    // Null for every language without tuning (nothing is read), and for "Current behavior". The flow finds an AI Agent's own reply speed.
    const voiceTuning = await voiceTuningForCall(language, flow?.flowId);
    // An Autonomous AI Agent's flow only: its questions, so the customer's are learned after the call. Null otherwise.
    const knownQuestions = await knownQuestionsForFlow(flow?.flowId);
    // An AI Agent whose admin's instructions lead only: this contact's earlier calls in this language. Null otherwise.
    const customerHistory = flow
      ? await historyForCall({ logId: next.id, runId, phone: next.phone, language, flowDefinition: flow.definition })
      : null;
    const { callId, providerCallId } = await placeVoiceCall({
      // Runs without the setting (older runs, test calls) call exactly as before.
      ...(greetingDelaySec != null ? { greetingDelaySec } : {}),
      ...(customerBusiness ? { customerBusiness } : {}),
      ...(voiceTuning ? { voiceTuning } : {}),
      ...(knownQuestions ? { knownQuestions } : {}),
      ...(customerHistory ? { customerHistory } : {}),
      customerName: next.customerName,
      gender: next.gender,
      followUpDetail: next.followUpDetail,
      phone: next.phone,
      runId,
      logId: next.id,
      flow,
      // English runs call exactly as before (the default backend).
      ...(language !== DEFAULT_AI_CALL_LANGUAGE ? { language } : {}),
    });
    await prisma.aiCallLog.update({
      where: { id: next.id },
      data: { voiceCallId: callId, ...(providerCallId ? { providerCallId } : {}) },
    });
    logger.info(
      { runId, logId: next.id, phone: maskPhone(next.phone), voiceCallId: callId, flowId: flow?.flowId, flowVersion: flow?.version, language },
      "ai call placed",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.aiCallLog.update({
      where: { id: next.id },
      data: { status: "FAILED", endedAt: new Date(), error: message.slice(0, 2000) },
    });
    logger.warn(
      {
        runId,
        logId: next.id,
        phone: maskPhone(next.phone),
        err: message,
        retryable: err instanceof VoiceBackendError && err.retryable,
      },
      "ai call failed to start — continuing run",
    );
    await syncCustomerFromLog(next.id);
  }
  throw deferFor(POLL_MS);
}
