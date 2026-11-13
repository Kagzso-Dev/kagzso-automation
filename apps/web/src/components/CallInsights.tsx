// Call insights after an Autonomous AI Agent's call (sentiment and interest, kept apart; apps/api
// domain/aiCallInsights.ts). Shown beside a customer's stage, on their calls, in the agent's Knowledge tab, and behind
// each customer question. Display only: nothing here changes a stage, a follow-up or a call.

import {
  AI_CALL_CONCERN_LABELS,
  AI_CALL_INTEREST_LABELS,
  AI_CALL_INTERESTS,
  AI_CALL_SENTIMENT_LABELS,
  AI_CALL_SENTIMENTS,
  isInterested,
  type AiAgentCallInsights,
  type AiCallConcernNote,
  type AiCallInsights,
  type AiCallInterest,
  type AiCallSentiment,
  type AiKnowledgeCallStats,
} from "@dispatch/shared";
import { Badge, type BadgeTone } from "./ui";

const SENTIMENT_TONE: Record<AiCallSentiment, BadgeTone> = {
  positive: "ok",
  neutral: "neutral",
  confused: "warn",
  hesitant: "warn",
  negative: "crit",
  frustrated: "crit",
};

const INTEREST_TONE: Record<AiCallInterest, BadgeTone> = {
  highly_interested: "ok",
  interested: "ok",
  exploring: "accent",
  not_interested: "neutral",
  unclear: "neutral",
};

export function SentimentBadge({ sentiment }: { sentiment: AiCallSentiment | null | undefined }) {
  if (!sentiment || !(sentiment in SENTIMENT_TONE)) return null;
  return <Badge tone={SENTIMENT_TONE[sentiment]}>{AI_CALL_SENTIMENT_LABELS[sentiment]}</Badge>;
}

export function InterestBadge({ interest }: { interest: AiCallInterest | null | undefined }) {
  if (!interest || !(interest in INTEREST_TONE)) return null;
  return <Badge tone={INTEREST_TONE[interest]}>{AI_CALL_INTEREST_LABELS[interest]}</Badge>;
}

const concernText = (n: AiCallConcernNote) => `${AI_CALL_CONCERN_LABELS[n.type] ?? n.type}${n.text ? ` (${n.text})` : ""}`;

/** One call's insights: sentiment from start to end, interest, and what the customer said they need or doubted. */
export function CallInsightsLine({ insights }: { insights: AiCallInsights | null | undefined }) {
  if (!insights) return null;
  const { sentimentStart: start, sentimentEnd: end } = insights;
  const changed = start && end && start !== end;
  return (
    <div className="mt-1 space-y-1 text-xs" aria-label="Call insights">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-slate-550">Sentiment</span>
        {changed ? (
          <>
            <SentimentBadge sentiment={start} />
            <span className="text-slate-550">→</span>
            <SentimentBadge sentiment={end} />
          </>
        ) : (
          <SentimentBadge sentiment={end ?? insights.sentiment} />
        )}
        <span className="ml-2 text-slate-550">Interest</span>
        <InterestBadge interest={insights.interest} />
      </div>
      {insights.notInterestedReason && <div className="text-slate-550">Reason: {concernText(insights.notInterestedReason)}</div>}
      {insights.objections.length > 0 && (
        <div className="text-slate-550">
          Objection{insights.objections.length > 1 ? "s" : ""}: {insights.objections.map(concernText).join("; ")}
        </div>
      )}
      {insights.requirement && <div className="text-slate-550">Needs: {insights.requirement}</div>}
      {insights.automationNeed && <div className="text-slate-550">Wants automated: {insights.automationNeed}</div>}
    </div>
  );
}

const counted = (record: Partial<Record<string, number>> | undefined, order: readonly string[], labels: Record<string, string>) =>
  order.filter((k) => (record?.[k] ?? 0) > 0).map((k) => `${record![k]} ${labels[k]!.toLowerCase()}`);

/** Behind one customer question: how the customers felt when they asked it, and how many were interested. */
export function QuestionMood({ stats }: { stats: AiKnowledgeCallStats | undefined }) {
  if (!stats?.sentiments && !stats?.interests) return null;
  const moods = counted(stats.sentiments, AI_CALL_SENTIMENTS, AI_CALL_SENTIMENT_LABELS);
  const interested = Object.entries(stats.interests ?? {})
    .filter(([k]) => isInterested(k as AiCallInterest))
    .reduce((n, [, v]) => n + v, 0);
  const parts = [
    moods.length ? `Customers' mood: ${moods.join(", ")}` : null,
    interested ? `asked by ${interested} interested customer${interested === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length ? <div className="text-xs text-slate-550">{parts.join(" · ")}</div> : null;
}

/** The agent's call insights, from its newest calls (Knowledge tab). */
export function AgentInsightsCard({ insights }: { insights: AiAgentCallInsights | null | undefined }) {
  if (!insights || insights.calls === 0) return null;
  const sentiments = counted(insights.sentiment, AI_CALL_SENTIMENTS, AI_CALL_SENTIMENT_LABELS);
  const interests = counted(insights.interest, AI_CALL_INTERESTS, AI_CALL_INTEREST_LABELS);
  const { better, same, worse } = insights.change;
  return (
    <section className="mb-4 rounded-lg border border-line px-4 py-3 text-sm" aria-label="Call insights">
      <div className="mb-1 font-medium text-ink">
        Call insights <span className="font-normal text-slate-550">· {insights.calls} call{insights.calls === 1 ? "" : "s"}</span>
      </div>
      <p className="mb-2 text-xs text-slate-550">
        Read after each call: how the customer felt and how interested they were, kept apart (asking questions alone counts as
        exploring). Shown for review only; stages and follow-ups still follow the call outcome.
      </p>
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
        <dt className="text-slate-550">Sentiment</dt>
        <dd>{sentiments.join(", ") || "—"}</dd>
        <dt className="text-slate-550">Interest</dt>
        <dd>{interests.join(", ") || "—"}</dd>
        {better + same + worse > 0 && (
          <>
            <dt className="text-slate-550">During the call</dt>
            <dd>
              mood got better on {better}, stayed the same on {same}, got worse on {worse}
            </dd>
          </>
        )}
        {insights.concerns.length > 0 && (
          <>
            <dt className="text-slate-550">Common concerns</dt>
            <dd>
              {insights.concerns.slice(0, 4).map((c) => (
                <div key={c.type}>
                  {AI_CALL_CONCERN_LABELS[c.type]}: {c.count} call{c.count === 1 ? "" : "s"}
                  {c.examples.length > 0 && <span className="text-slate-550"> ({c.examples.join("; ")})</span>}
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
