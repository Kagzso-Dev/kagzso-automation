// Call insights after an Autonomous AI Agent's call: how the customer felt (sentiment) and how interested they were in
// the business offer (interest), kept apart: a friendly customer is not an interested one, and asking questions alone
// is "exploring", never "interested". Read by the voice backend's LLM after the call, in the same request as the
// customer's questions (kagzso-voice-backend app/services/customer_questions.py), and checked again in Dispatch
// (apps/api domain/aiCallInsights.ts). Never used on a call; the customer's stage still follows the call outcome.

import { z } from "zod";

/** How the customer felt. Interest is separate (AI_CALL_INTERESTS). */
export const AI_CALL_SENTIMENTS = ["positive", "neutral", "confused", "hesitant", "negative", "frustrated"] as const;
export type AiCallSentiment = (typeof AI_CALL_SENTIMENTS)[number];

/** How interested the customer was in the business offer, at the end of the call. */
export const AI_CALL_INTERESTS = ["exploring", "interested", "highly_interested", "not_interested", "unclear"] as const;
export type AiCallInterest = (typeof AI_CALL_INTERESTS)[number];

/** What an objection or a "not interested" was about. */
export const AI_CALL_CONCERNS = ["pricing", "existing_system", "trust", "timing", "no_need", "other"] as const;
export type AiCallConcern = (typeof AI_CALL_CONCERNS)[number];

export const AI_CALL_SENTIMENT_LABELS: Record<AiCallSentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  confused: "Confused",
  hesitant: "Hesitant",
  negative: "Negative",
  frustrated: "Frustrated",
};

export const AI_CALL_INTEREST_LABELS: Record<AiCallInterest, string> = {
  exploring: "Exploring",
  interested: "Interested",
  highly_interested: "Highly interested",
  not_interested: "Not interested",
  unclear: "Unclear",
};

export const AI_CALL_CONCERN_LABELS: Record<AiCallConcern, string> = {
  pricing: "Pricing",
  existing_system: "Has a system already",
  trust: "Trust",
  timing: "Timing",
  no_need: "No need",
  other: "Other",
};

/** Better or worse, for "how it changed during the call" (negative and frustrated are the worst). */
export const AI_CALL_SENTIMENT_RANK: Record<AiCallSentiment, number> = {
  frustrated: 0,
  negative: 1,
  hesitant: 2,
  confused: 2,
  neutral: 3,
  positive: 4,
};

/** Interests that count as an interested customer (FAQ analytics: "asked by interested customers"). */
export const isInterested = (i: AiCallInterest | null | undefined) => i === "interested" || i === "highly_interested";

export interface AiCallConcernNote {
  type: AiCallConcern;
  /** Short, general English; "" when it could only be said with a private detail. */
  text: string;
}

/** What Dispatch keeps on the call log (`insights` JSON; the overall sentiment is also in its own column). */
export interface AiCallInsights {
  sentiment: AiCallSentiment | null;
  sentimentStart: AiCallSentiment | null;
  sentimentEnd: AiCallSentiment | null;
  interest: AiCallInterest;
  objections: AiCallConcernNote[];
  /** Only when not interested, and only if the customer gave a reason. */
  notInterestedReason: AiCallConcernNote | null;
  /** The customer's main business requirement, when they said it. */
  requirement: string | null;
  /** What they would want automated, when they said it. */
  automationNeed: string | null;
}

/** An agent's call insights (Knowledge tab, GET /api/ai-agents/:id/knowledge `insights`): its newest calls, counted. */
export interface AiAgentCallInsights {
  /** Calls with insights that were read. */
  calls: number;
  /** Overall sentiment per call. */
  sentiment: Partial<Record<AiCallSentiment, number>>;
  /** Interest at the end of the call. */
  interest: Partial<Record<AiCallInterest, number>>;
  /** From the start of the call to the end: calls where the customer's mood got better, stayed, got worse. */
  change: { better: number; same: number; worse: number };
  /** Objections and not-interested reasons, most common first, with a few examples (general text only). */
  concerns: { type: AiCallConcern; count: number; examples: string[] }[];
}

const text = (max: number) => z.string().max(max).nullable().optional().catch(null);
const choice = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values).nullable().optional().catch(null);
const concern = z.object({ type: z.enum(AI_CALL_CONCERNS).catch("other"), text: z.string().max(300).catch("") });

/** The voice backend's `call_insights` (snake_case), as sent; anything it can't read is null / dropped. */
export const voiceCallInsightsSchema = z.object({
  sentiment: choice(AI_CALL_SENTIMENTS),
  sentiment_start: choice(AI_CALL_SENTIMENTS),
  sentiment_end: choice(AI_CALL_SENTIMENTS),
  interest: z.enum(AI_CALL_INTERESTS).catch("unclear"),
  objections: z.array(concern).max(5).catch([]),
  not_interested_reason: concern.nullable().optional().catch(null),
  requirement: text(300),
  automation_need: text(300),
});
