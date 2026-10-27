// An approved "call again" follow-up, run at its scheduled time. It does not
// dial anything itself: it creates a normal one-call AI call run, which the
// existing `ai-call-run` worker places (same do-not-call checks, daily cap,
// voice backend and retries as every other run).
//
// The call is in the customer's list language. English calls with the default
// agent, as before; another language calls with one of its own published flows
// (the one the customer was last called with, else its newest).

import { DEFAULT_AI_CALL_LANGUAGE, maskPhone } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { aiCallsConfig } from "../config/aiCalls.js";
import { callsCountedTowardDailyCap, loadDoNotCallPhones } from "../domain/aiCalls.js";
import { aiCallLanguageBlockedReason, asAiCallLanguage, languageName, runInProgressReason } from "../domain/aiCallLanguages.js";
import { flowVersionForCallAgain } from "../domain/callFlows.js";
import { addCustomerEvent } from "../domain/aiCallFollowups.js";
import { linkCustomersToRun } from "../domain/aiCallCustomerSync.js";
import { DeferJobError } from "./engine.js";
import { enqueueAiCallRun, type AiCallFollowupJob } from "./queues.js";

const later = (ms: number) => new DeferJobError(new Date(Date.now() + ms));

async function fail(id: string, customerId: string, status: "FAILED" | "CANCELLED", why: string) {
  await prisma.aiCallFollowup.update({ where: { id }, data: { status, error: why } });
  await addCustomerEvent({ customerId, type: status === "FAILED" ? "followup_failed" : "followup_cancelled", detail: why, refId: id });
  return { [status.toLowerCase()]: why };
}

export async function processAiCallFollowup(payload: Record<string, unknown>): Promise<unknown> {
  const { followupId } = payload as unknown as AiCallFollowupJob;
  const f = await prisma.aiCallFollowup.findUnique({ where: { id: followupId }, include: { customer: true } });
  if (!f || f.status !== "APPROVED" || f.channel !== "CALL" || f.aiCallRunId) return { skipped: true };
  const c = f.customer;

  if (c.deletedAt) return fail(f.id, c.id, "CANCELLED", "Customer was deleted");
  if (c.doNotCall || (await loadDoNotCallPhones(aiCallsConfig.defaultCountryCode)).has(c.phone)) {
    return fail(f.id, c.id, "CANCELLED", "Number is on the do-not-call list");
  }
  const language = asAiCallLanguage(c.language);
  if (!aiCallsConfig.enabled) return fail(f.id, c.id, "FAILED", "AI calls are off or the voice backend is not configured");
  const unavailable = await aiCallLanguageBlockedReason(language);
  if (unavailable) {
    return fail(f.id, c.id, "FAILED", language === DEFAULT_AI_CALL_LANGUAGE ? "AI calls are off or the voice backend is not configured" : unavailable);
  }
  let flowVersionId: string | null = null;
  if (language !== DEFAULT_AI_CALL_LANGUAGE) {
    const version = await flowVersionForCallAgain(c.id, language);
    if (!version) return fail(f.id, c.id, "FAILED", `No published ${languageName(language)} call flow to call again with`);
    flowVersionId = version.id;
  }

  // One run at a time, one language at a time (same rule as the Start button): wait for the current one.
  if (await runInProgressReason(language)) throw later(60_000);
  if ((await callsCountedTowardDailyCap()) + 1 > aiCallsConfig.dailyCap) throw later(60 * 60_000);

  const run = await prisma.aiCallRun.create({
    data: {
      mode: "SELECTED",
      gapSeconds: aiCallsConfig.minGapSec,
      maxCalls: 1,
      total: 1,
      createdByEmail: f.decidedByEmail,
      skipped: { invalid: 0, duplicates: 0, doNotCall: 0, capped: 0 },
      ...(flowVersionId ? { flow: { create: { flowVersionId } } } : {}),
      logs: {
        create: [{ position: 0, customerName: c.customerName, gender: c.gender, followUpDetail: c.followUpDetail, phone: c.phone }],
      },
    },
    include: { logs: { select: { id: true } } },
  });
  await prisma.aiCallFollowup.update({ where: { id: f.id }, data: { aiCallRunId: run.id } });
  await linkCustomersToRun(run.id, [{ logId: run.logs[0]!.id, customerId: c.id }], f.decidedByEmail);
  await enqueueAiCallRun({ runId: run.id });
  await addCustomerEvent({ customerId: c.id, type: "followup_handed_over", detail: `Call again started (attempt ${f.attempt})`, refId: f.id });
  logger.info({ followupId: f.id, runId: run.id, language, phone: maskPhone(c.phone) }, "ai call follow-up → call run started");
  return { runId: run.id };
}
