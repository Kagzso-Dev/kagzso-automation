// Call insights after an Autonomous AI Agent's call: how the customer felt (sentiment, and how it changed from the
// start of the call to the end) and how interested they were in the business offer (interest), kept apart. Read by
// the voice backend's LLM after the call, in the same request as the customer's questions
// (kagzso-voice-backend app/services/customer_questions.py), and checked again here: fixed lists only, short general
// text without personal data or the customer's name / business. Kept on the call log (sentiment, insights) and as one
// line on a saved customer's timeline.
//
// Separate from the stage: the stage still follows the call outcome exactly as before (aiCallCustomerSync), and
// nothing here starts, changes or cancels a follow-up. The one link to the outcome is a guard: a customer the call
// outcome says declined is never shown as interested.

import { Prisma } from "@prisma/client";
import {
  AI_CALL_CONCERN_LABELS,
  AI_CALL_INTEREST_LABELS,
  AI_CALL_SENTIMENT_LABELS,
  AI_CALL_SENTIMENT_RANK,
  DEFAULT_AI_CALL_LANGUAGE,
  knowledgeTextIssues,
  voiceCallInsightsSchema,
  type AiAgentCallInsights,
  type AiCallConcern,
  type AiCallConcernNote,
  type AiCallInsights,
  type AiCallLanguage,
} from "@dispatch/shared";
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { businessForCall } from "./aiCallCustomerSync.js";
import { addCustomerEvent } from "./aiCallFollowups.js";
import { mentionsAny, privateTerms } from "./aiAgentQuestions.js";

/** Longest insight text kept (the voice backend keeps 160). */
export const INSIGHT_TEXT_MAX = 160;
/** Calls read for an agent's summary (newest first). */
export const SUMMARY_CALLS = 500;
const DECLINED = new Set(["not_interested", "do_not_call"]);

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** One short general line, or "" (too long, personal data, or names the customer or their business). */
function cleanText(value: unknown, terms: readonly string[]): string {
  const t = oneLine(value);
  if (!t || t.length > INSIGHT_TEXT_MAX) return "";
  if (knowledgeTextIssues(t, { policy: false }).length || mentionsAny(t, terms)) return "";
  return t;
}

/**
 * The voice backend's `call_insights`, checked; null when there are none or they can't be read. `outcome`: the call's
 * classified outcome; a call that ended in "not interested" (or do not call) is never kept as interested.
 */
export function parseCallInsights(raw: unknown, terms: readonly string[] = [], outcome?: string | null): AiCallInsights | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = voiceCallInsightsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const interest = outcome && DECLINED.has(outcome) ? "not_interested" : d.interest;
  const note = (n: { type: AiCallConcern; text: string }): AiCallConcernNote => ({ type: n.type, text: cleanText(n.text, terms) });
  return {
    sentiment: d.sentiment ?? d.sentiment_end ?? null,
    sentimentStart: d.sentiment_start ?? null,
    sentimentEnd: d.sentiment_end ?? null,
    interest,
    objections: d.objections.slice(0, 3).map(note),
    notInterestedReason: interest === "not_interested" && d.not_interested_reason ? note(d.not_interested_reason) : null,
    requirement: cleanText(d.requirement, terms) || null,
    automationNeed: cleanText(d.automation_need, terms) || null,
  };
}

/** The timeline line, e.g. "Sentiment: Neutral → Positive · Interest: Exploring · Objection: Pricing (too costly)". */
export function insightsLine(i: AiCallInsights): string {
  const s = (v: AiCallInsights["sentiment"]) => (v ? AI_CALL_SENTIMENT_LABELS[v] : null);
  const start = s(i.sentimentStart);
  const end = s(i.sentimentEnd);
  const feeling = start && end && start !== end ? `${start} → ${end}` : (end ?? s(i.sentiment));
  const concern = (n: AiCallConcernNote) => `${AI_CALL_CONCERN_LABELS[n.type]}${n.text ? ` (${n.text})` : ""}`;
  return [
    feeling ? `Sentiment: ${feeling}` : null,
    `Interest: ${AI_CALL_INTEREST_LABELS[i.interest]}`,
    i.notInterestedReason ? `Reason: ${concern(i.notInterestedReason)}` : null,
    i.objections.length ? `Objection${i.objections.length > 1 ? "s" : ""}: ${i.objections.map(concern).join("; ")}` : null,
    i.requirement ? `Needs: ${i.requirement}` : null,
    i.automationNeed ? `Wants automated: ${i.automationNeed}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Prisma JSON for the stored insights, read back safely (null when it isn't an object). */
export function storedInsights(value: Prisma.JsonValue | null | undefined): AiCallInsights | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as unknown as AiCallInsights) : null;
}

/**
 * One call's insights: checked, kept on the call log, and once on the saved customer's timeline (calls from the
 * customer list). Idempotent (webhook and poll may both deliver them). Returns what was kept. Never throws: a problem
 * here never affects the call's status update.
 */
export async function saveCallInsights(logId: string, raw: unknown): Promise<AiCallInsights | null> {
  try {
    if (!raw) return null;
    const log = await prisma.aiCallLog.findUnique({
      where: { id: logId },
      select: { outcome: true, phone: true, customerName: true, runId: true },
    });
    if (!log) return null;
    const pinned = await prisma.aiCallRunFlow.findUnique({
      where: { runId: log.runId },
      select: { flowVersion: { select: { flow: { select: { language: true } } } } },
    });
    const language = (pinned?.flowVersion.flow?.language ?? DEFAULT_AI_CALL_LANGUAGE) as AiCallLanguage;
    const terms = privateTerms(log.customerName, await businessForCall(logId, log.phone, language));
    const insights = parseCallInsights(raw, terms, log.outcome);
    if (!insights) return null;
    await prisma.aiCallLog.update({
      where: { id: logId },
      data: { sentiment: insights.sentiment, insights: insights as unknown as Prisma.InputJsonValue },
    });
    const link = await prisma.aiCallCustomerCall.findUnique({ where: { logId } });
    if (link) {
      const seen = await prisma.aiCallCustomerEvent.findFirst({
        where: { customerId: link.customerId, type: "call_insights", refId: logId },
        select: { id: true },
      });
      if (!seen) await addCustomerEvent({ customerId: link.customerId, type: "call_insights", detail: insightsLine(insights), refId: logId });
    }
    logger.info({ logId, sentiment: insights.sentiment, interest: insights.interest }, "ai call insights saved");
    return insights;
  } catch (err) {
    logger.warn({ logId, err: err instanceof Error ? err.message : String(err) }, "ai call insights not saved");
    return null;
  }
}

/* ------------------------------------------------------------------ an agent's summary (Knowledge tab) */
/** Pure: the summary of these calls' insights (the newest SUMMARY_CALLS of an agent). */
export function summarizeInsights(list: (AiCallInsights | null)[]): AiAgentCallInsights {
  const out: AiAgentCallInsights = { calls: 0, sentiment: {}, interest: {}, change: { better: 0, same: 0, worse: 0 }, concerns: [] };
  const concerns = new Map<AiCallConcern, { count: number; examples: string[] }>();
  for (const i of list) {
    if (!i) continue;
    out.calls += 1;
    if (i.sentiment) out.sentiment[i.sentiment] = (out.sentiment[i.sentiment] ?? 0) + 1;
    out.interest[i.interest] = (out.interest[i.interest] ?? 0) + 1;
    if (i.sentimentStart && i.sentimentEnd) {
      const d = AI_CALL_SENTIMENT_RANK[i.sentimentEnd] - AI_CALL_SENTIMENT_RANK[i.sentimentStart];
      out.change[d > 0 ? "better" : d < 0 ? "worse" : "same"] += 1;
    }
    const notes = [...(i.objections ?? []), ...(i.notInterestedReason ? [i.notInterestedReason] : [])];
    for (const type of new Set(notes.map((n) => n.type))) {
      const c = concerns.get(type) ?? { count: 0, examples: [] };
      c.count += 1; // once per call
      for (const n of notes) {
        if (n.type === type && n.text && c.examples.length < 3 && !c.examples.some((e) => e.toLowerCase() === n.text.toLowerCase())) {
          c.examples.push(n.text);
        }
      }
      concerns.set(type, c);
    }
  }
  out.concerns = [...concerns.entries()].map(([type, c]) => ({ type, ...c })).sort((a, b) => b.count - a.count);
  return out;
}

/** The agent's call insights (its Call Flow's calls), or null when it has none yet or they can't be read. Never throws. */
export async function agentCallInsights(agentId: string): Promise<AiAgentCallInsights | null> {
  try {
    const agent = await prisma.aiAgent.findUnique({ where: { id: agentId }, select: { callFlowId: true } });
    if (!agent?.callFlowId) return null;
    const logs = await prisma.aiCallLog.findMany({
      where: { insights: { not: Prisma.AnyNull }, run: { flow: { flowVersion: { flowId: agent.callFlowId } } } },
      orderBy: { createdAt: "desc" },
      take: SUMMARY_CALLS,
      select: { insights: true },
    });
    const summary = summarizeInsights(logs.map((l) => storedInsights(l.insights)));
    return summary.calls ? summary : null;
  } catch (err) {
    logger.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, "ai agent call insights unreadable");
    return null;
  }
}
