import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AiCallInsights } from "@dispatch/shared";
import { AgentInsightsCard, CallInsightsLine, InterestBadge, QuestionMood } from "../src/components/CallInsights";

// Call insights in the UI: sentiment and interest shown apart, how the mood changed during the call, the mood behind a
// customer question, and the agent's summary. Display only.

afterEach(cleanup);

const insights = (over: Partial<AiCallInsights> = {}): AiCallInsights => ({
  sentiment: "positive",
  sentimentStart: "neutral",
  sentimentEnd: "positive",
  interest: "exploring",
  objections: [{ type: "pricing", text: "worried it may be costly" }],
  notInterestedReason: null,
  requirement: "payment reminders",
  automationNeed: null,
  ...over,
});

describe("call insights", () => {
  it("one call: the mood from start to end, and interest beside it (not mixed)", () => {
    render(<CallInsightsLine insights={insights()} />);
    const line = screen.getByLabelText("Call insights").textContent;
    expect(line).toContain("SentimentNeutral→Positive");
    expect(line).toContain("InterestExploring");
    expect(line).toContain("Objection: Pricing (worried it may be costly)");
    expect(line).toContain("Needs: payment reminders");
  });

  it("a polite decline: positive and not interested, with the reason the customer gave", () => {
    render(
      <CallInsightsLine
        insights={insights({ sentimentStart: "positive", interest: "not_interested", objections: [], notInterestedReason: { type: "existing_system", text: "" } })}
      />,
    );
    const line = screen.getByLabelText("Call insights").textContent;
    expect(line).toContain("SentimentPositive");
    expect(line).not.toContain("→");
    expect(line).toContain("Not interested");
    expect(line).toContain("Reason: Has a system already");
  });

  it("nothing for a call without insights, or an unknown value", () => {
    const { container } = render(
      <>
        <CallInsightsLine insights={null} />
        <InterestBadge interest={"whatever" as never} />
      </>,
    );
    expect(container.textContent).toBe("");
  });

  it("behind a customer question: the customers' mood and how many were interested", () => {
    render(
      <QuestionMood
        stats={{
          asked: 4,
          unanswered: 0,
          lastAskedAt: "2026-11-13T00:00:00Z",
          languages: { ta: 4 },
          ways: [],
          draftedFrom: [],
          sentiments: { positive: 2, confused: 1 },
          interests: { interested: 1, highly_interested: 1, exploring: 2 },
        }}
      />,
    );
    expect(screen.getByText("Customers' mood: 2 positive, 1 confused · asked by 2 interested customers")).toBeTruthy();
  });

  it("an older count without insights shows nothing extra", () => {
    const { container } = render(<QuestionMood stats={{ asked: 1, unanswered: 0, lastAskedAt: "x", languages: {}, ways: [], draftedFrom: [] }} />);
    expect(container.textContent).toBe("");
  });

  it("the agent's summary", () => {
    render(
      <AgentInsightsCard
        insights={{
          calls: 12,
          sentiment: { positive: 5, neutral: 4, negative: 3 },
          interest: { interested: 3, exploring: 6, not_interested: 3 },
          change: { better: 4, same: 6, worse: 2 },
          concerns: [{ type: "pricing", count: 4, examples: ["too costly"] }],
        }}
      />,
    );
    const card = screen.getByLabelText("Call insights").textContent!;
    expect(card).toContain("12 calls");
    expect(card).toContain("5 positive, 4 neutral, 3 negative");
    expect(card).toContain("6 exploring, 3 interested, 3 not interested");
    expect(card).toContain("mood got better on 4, stayed the same on 6, got worse on 2");
    expect(card).toContain("Pricing: 4 calls (too costly)");
  });

  it("no summary before any call has insights", () => {
    const { container } = render(<AgentInsightsCard insights={null} />);
    expect(container.textContent).toBe("");
  });
});
