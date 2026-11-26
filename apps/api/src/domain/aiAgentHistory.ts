// An AI Agent call's customer history: what Dispatch recorded about this contact's earlier calls, and the follow-up
// this call is for, sent with the call (voice backend customer_history). Only for an agent whose admin's instructions
// lead (compiler 4+, autonomous.instructions_lead): every other call - Nila, Follow-up, Call Flows, Guided, agents
// published before - is placed exactly as before, without it.
//
// Only this contact's own records, in this call's language: the contact row is per phone and language, each earlier
// call must be linked to that row, have the same phone and have run in the same language. At most the 2 newest
// COMPLETED calls; text is what the system already keeps (the one-sentence summary and the general, private-detail-free
// insights). No transcript. The voice backend decides when the AI may use it (only once the person has shown they are
// the customer) and drops it for a call without a customer name.

import type { Prisma } from "@prisma/client";
import { DEFAULT_AI_CALL_LANGUAGE, type AiCallLanguage } from "@dispatch/shared";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { customerOfCall } from "./aiCallCustomerSync.js";
import { storedInsights } from "./aiCallInsights.js";

/** Earlier calls sent with a call (newest first). */
export const HISTORY_CALLS = 2;
const SUMMARY_MAX = 300;
const NOTE_MAX = 300;

export interface VoiceHistoryCall {
  date: string; // YYYY-MM-DD
  outcome?: string;
  summary?: string;
  interest?: string;
  requirement?: string;
  automation_need?: string;
  callback_request?: { type: "explicit" | "suggested"; when?: string };
}

export interface VoiceCustomerHistory {
  calls: VoiceHistoryCall[];
  call_again?: { reason?: string; note?: string; scheduled_for?: string };
}

/** True for a flow compiled with the admin's instructions leading (an AI Agent published with compiler 4+). */
export function instructionsLeadFlow(definition: unknown): boolean {
  const autonomous = (definition as { autonomous?: { instructions_lead?: unknown; natural_lines?: unknown } } | null)?.autonomous;
  return autonomous?.instructions_lead === true && autonomous.natural_lines === true;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const clip = (s: string | null | undefined, max: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};

function historyCall(log: { endedAt: Date | null; outcome: string | null; summary: string | null; insights: Prisma.JsonValue }): VoiceHistoryCall {
  const i = storedInsights(log.insights);
  const out: VoiceHistoryCall = { date: day(log.endedAt!) };
  const outcome = clip(log.outcome, 32);
  const summary = clip(log.summary, SUMMARY_MAX);
  if (outcome) out.outcome = outcome;
  if (summary) out.summary = summary;
  if (i?.interest && i.interest !== "unclear") out.interest = i.interest;
  const requirement = clip(i?.requirement, 160);
  const automation = clip(i?.automationNeed, 160);
  if (requirement) out.requirement = requirement;
  if (automation) out.automation_need = automation;
  if (i?.callbackRequest) {
    const when = clip(i.callbackRequest.when, 80);
    out.callback_request = { type: i.callbackRequest.type, ...(when ? { when } : {}) };
  }
  return out;
}

/**
 * The history for one call about to be dialled, or null (not an instructions-lead agent flow, no contact on file, nothing
 * recorded). Never throws: a call without its history is placed exactly as before.
 */
export async function historyForCall(input: {
  logId: string;
  runId: string;
  phone: string;
  language: AiCallLanguage;
  flowDefinition: unknown;
}): Promise<VoiceCustomerHistory | null> {
  if (!instructionsLeadFlow(input.flowDefinition)) return null;
  try {
    const customer = await customerOfCall(input.logId, input.phone, input.language);
    if (!customer || customer.deletedAt) return null;
    const links = await prisma.aiCallCustomerCall.findMany({ where: { customerId: customer.id }, select: { logId: true } });
    const ids = links.map((l) => l.logId).filter((id) => id !== input.logId);
    const logs = ids.length
      ? await prisma.aiCallLog.findMany({
          where: { id: { in: ids }, status: "COMPLETED", endedAt: { not: null }, phone: input.phone },
          orderBy: { endedAt: "desc" },
          take: 10, // a few more than needed: calls in another language are skipped below
          select: {
            endedAt: true,
            outcome: true,
            summary: true,
            insights: true,
            run: { select: { flow: { select: { flowVersion: { select: { flow: { select: { language: true } } } } } } } },
          },
        })
      : [];
    const calls = logs
      .filter((l) => (l.run.flow?.flowVersion.flow.language ?? DEFAULT_AI_CALL_LANGUAGE) === input.language)
      .slice(0, HISTORY_CALLS)
      .map(historyCall);

    // A "call again" follow-up placed this run: why the team asked for it (its reason, note and scheduled day).
    const followup = await prisma.aiCallFollowup.findFirst({
      where: { aiCallRunId: input.runId, customerId: customer.id, channel: "CALL" },
      select: { reason: true, note: true, scheduledAt: true },
    });
    const again = followup
      ? {
          ...(clip(followup.reason, 64) ? { reason: clip(followup.reason, 64) } : {}),
          ...(clip(followup.note, NOTE_MAX) ? { note: clip(followup.note, NOTE_MAX) } : {}),
          ...(followup.scheduledAt ? { scheduled_for: day(followup.scheduledAt) } : {}),
        }
      : null;
    const callAgain = again && Object.keys(again).length ? again : null;
    if (!calls.length && !callAgain) return null;
    return { calls, ...(callAgain ? { call_again: callAgain } : {}) };
  } catch (err) {
    logger.warn({ logId: input.logId, err: err instanceof Error ? err.message : String(err) }, "ai agent call history unreadable");
    return null;
  }
}
