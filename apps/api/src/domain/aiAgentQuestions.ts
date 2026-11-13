// Customer questions learned on Autonomous AI Agent calls (kagzso-voice-backend app/services/customer_questions.py).
//
// When an agent's call is dialled, its voice backend is sent the agent's questions (knownQuestionsForFlow). After the
// call, the backend's LLM lists the customer's general questions about the company, each one matched to one of
// those, in any wording or language, or new. They arrive here with a status callback (or the run's poll):
//
//   matched  counted on that knowledge item: calls asked on, calls where the agent gave no real answer, languages,
//            last asked. A new wording is kept beside an approved item, never written into it: changing approved
//            knowledge is an admin's decision.
//   new      a Draft Q&A in the agent's Knowledge tab (source AI_KNOWLEDGE_FROM_CALLS): the question, the customer's
//            wording and an answer the LLM drafted only from the approved knowledge the call had, or no answer when
//            nothing approved answers it (the admin writes one). A suggestion is an ordinary Draft: only an admin's
//            approval and a publish ever put it into a call, exactly like an item from an uploaded file.
//   rejected a suggestion an admin rejected keeps absorbing the same question (it is still counted), so it is
//            never suggested again; deleting it lets it come back.
//
// What a customer said is never a fact: answers come from approved knowledge or an admin. Their private details stay
// out of every suggestion (the voice backend leaves them out; here the name and business on file are checked again,
// with the knowledge content rules). Counts live in one Settings entry per agent, like the agent's voice speed (no
// new table), changed under a row lock in one transaction with the drafts, so a call counted by the webhook is never
// counted again by the poll.

import { Prisma, type AiAgentKnowledgeItem } from "@prisma/client";
import { z } from "zod";
import {
  AI_KNOWLEDGE_FROM_CALLS,
  AI_KNOWLEDGE_QUESTIONS_MAX,
  AI_KNOWLEDGE_QUESTION_MAX,
  AI_KNOWLEDGE_TEXT_MAX,
  AI_KNOWLEDGE_TOPIC_MAX,
  DEFAULT_AI_CALL_LANGUAGE,
  knowledgeTextIssues,
  type AiCallInsights,
  type AiCallLanguage,
  type AiKnowledgeCallStats,
} from "@dispatch/shared";

/** The call's sentiment and interest (call insights), counted on each question asked on it. */
export type QuestionCallInsights = Pick<AiCallInsights, "sentiment" | "interest">;
import { logger } from "../logger.js";
import { prisma } from "../prisma.js";
import { businessForCall } from "./aiCallCustomerSync.js";
import { getSetting } from "./settings.js";

/** Questions sent with one call (the voice backend accepts at most 80). */
export const MAX_KNOWN_QUESTIONS = 80;
/** Open suggestions (Draft, from calls) per agent: past this, a new question is not suggested until some are decided. */
export const MAX_OPEN_SUGGESTIONS = 50;
/** Calls remembered as counted, per agent (newest kept). */
export const MAX_COUNTED_CALLS = 2000;
export const MAX_WAYS = 5;
const DEFAULT_TOPIC = "Customer question";

export interface KnownQuestion {
  id: string;
  question: string;
}

export interface QuestionStore {
  v: 1;
  /** Calls already counted (Dispatch log ids). */
  calls: string[];
  /** Knowledge item id → its counts. */
  items: Record<string, AiKnowledgeCallStats>;
}

const statsKey = (agentId: string) => `aiAgentQuestions:${agentId}`;
const emptyStore = (): QuestionStore => ({ v: 1, calls: [], items: {} });

function asStore(value: unknown): QuestionStore {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return emptyStore();
    }
  }
  if (!v || typeof v !== "object") return emptyStore();
  const o = v as Partial<QuestionStore>;
  return {
    v: 1,
    calls: Array.isArray(o.calls) ? o.calls.filter((c): c is string => typeof c === "string") : [],
    items: o.items && typeof o.items === "object" && !Array.isArray(o.items) ? { ...o.items } : {},
  };
}

/** The agent's counts, for the Knowledge tab. Unreadable = none (the tab works as before). */
export async function questionStats(agentId: string): Promise<QuestionStore["items"]> {
  try {
    return asStore(await getSetting<unknown>(statsKey(agentId), null)).items;
  } catch (err) {
    logger.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, "ai agent question counts unreadable");
    return {};
  }
}

/* ------------------------------------------------------------------ text checks */
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const questionKey = (s: string) => oneLine(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

function questionsOf(i: Pick<AiAgentKnowledgeItem, "questions">): string[] {
  return Array.isArray(i.questions) ? (i.questions as unknown[]).filter((q): q is string => typeof q === "string") : [];
}

/** What identifies the customer: the words of their name and their business, as Dispatch has them. */
export function privateTerms(customerName: string | null | undefined, business: string | null | undefined): string[] {
  const terms = oneLine(customerName).split(/[\s.,]+/).filter((w) => w.length >= 3);
  const b = oneLine(business);
  return b.length >= 3 ? [...terms, b] : terms;
}

export function mentionsAny(text: string, terms: readonly string[]): boolean {
  const low = text.toLowerCase();
  return terms.some((t) => {
    const term = t.toLowerCase();
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7f]+$/.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(low);
    }
    return low.includes(term);
  });
}

/** A question or wording fit to keep: one line, within the limit, no personal data, not naming the customer. */
function usableQuestion(text: string, terms: readonly string[]): boolean {
  return (
    text.length >= 3 &&
    text.length <= AI_KNOWLEDGE_QUESTION_MAX &&
    knowledgeTextIssues(text, { policy: false }).length === 0 &&
    !mentionsAny(text, terms)
  );
}

function clipTopic(topic: string): string {
  const t = oneLine(topic).replace(/[{}[\]]/g, "");
  if (t.length <= AI_KNOWLEDGE_TOPIC_MAX) return t || DEFAULT_TOPIC;
  return t.slice(0, AI_KNOWLEDGE_TOPIC_MAX).replace(/\s+\S*$/, "").trim() || DEFAULT_TOPIC;
}

/* ------------------------------------------------------------------ the voice backend's list */
const learnedQuestion = z.object({
  question: z.string().max(300),
  topic: z.string().max(100).optional().default(""),
  asked: z.string().max(300).optional().default(""),
  known_id: z.string().max(64).nullable().optional().default(null),
  answered: z.boolean().optional().default(false),
  answer: z.string().max(1000).nullable().optional().default(null),
  answer_from: z.array(z.string().max(100)).max(5).optional().default([]),
});
export type LearnedQuestion = z.infer<typeof learnedQuestion>;
const learnedList = z.array(learnedQuestion).max(10);

/** The voice backend's list, or [] when it isn't one: a bad list never breaks the call's status update. */
export function parseLearnedQuestions(raw: unknown): LearnedQuestion[] {
  const parsed = learnedList.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/* ------------------------------------------------------------------ counting (pure) */
type QaItem = Pick<AiAgentKnowledgeItem, "id" | "status" | "source" | "questions" | "text" | "topic">;

export interface Planned {
  /** New Draft Q&A suggestions. `key` stands for its id in `store.items` until it is created. */
  creates: { key: string; topic: string; text: string; questions: string[] }[];
  /** Open suggestions to update: another wording, or a drafted answer where it had none. */
  updates: { id: string; text: string; questions: string[] }[];
  /** New questions not suggested: too many open suggestions. */
  skipped: number;
}

interface Work {
  id: string;
  status: string;
  source: string | null;
  topic: string;
  text: string;
  questions: string[];
  isNew: boolean;
  changed: boolean;
}

const has = (list: string[], q: string) => list.some((x) => questionKey(x) === questionKey(q));

/**
 * What one call's questions change, without any I/O: drafts to create or update, and the counts (`store` is
 * changed in place). `items` are the agent's Q&A items. Returns null when this call was already counted.
 */
export function planQuestions(
  store: QuestionStore,
  items: QaItem[],
  logId: string,
  questions: LearnedQuestion[],
  opts: { language: string; now: Date; terms: readonly string[]; insights?: QuestionCallInsights | null },
): Planned | null {
  if (store.calls.includes(logId)) return null;
  // Working copies: a question asked twice in one call, or a suggestion created a moment ago, is found again.
  const work: Work[] = items.map((i) => ({
    id: i.id,
    status: i.status,
    source: i.source,
    topic: i.topic,
    text: i.text,
    questions: questionsOf(i),
    isNew: false,
    changed: false,
  }));
  const openSuggestion = (w: Work) => w.source === AI_KNOWLEDGE_FROM_CALLS && w.status === "DRAFT";
  let open = work.filter(openSuggestion).length;
  let skipped = 0;
  const counted = new Set<string>();

  for (const q of questions) {
    const question = oneLine(q.question);
    if (!usableQuestion(question, opts.terms)) continue;
    const asked = oneLine(q.asked);
    const wording = asked && usableQuestion(asked, opts.terms) ? asked : "";
    // A drafted answer only with the approved knowledge it came from (the voice backend checked both).
    const drafted = q.answer && q.answer_from.length ? oneLine(q.answer).slice(0, AI_KNOWLEDGE_TEXT_MAX) : "";
    let draftedNow = false;

    // The voice backend's match first; then a question already written word for word on an item.
    let item = q.known_id ? work.find((w) => w.id === q.known_id) : undefined;
    item ??= work.find((w) => has(w.questions, question));
    if (!item) {
      if (open >= MAX_OPEN_SUGGESTIONS) {
        skipped += 1;
        continue;
      }
      item = {
        id: `new:${work.filter((w) => w.isNew).length}`,
        status: "DRAFT",
        source: AI_KNOWLEDGE_FROM_CALLS,
        topic: clipTopic(q.topic),
        text: drafted,
        questions: [question],
        isNew: true,
        changed: true,
      };
      work.push(item);
      open += 1;
      draftedNow = !!drafted;
    } else if (openSuggestion(item) && !item.text && drafted) {
      item.text = drafted; // an open suggestion without an answer gets the first drafted one
      item.changed = draftedNow = true;
    }
    // An open suggestion takes the customer's wording among its questions (Tamil, Hindi, ... beside the English).
    if (wording && openSuggestion(item) && item.questions.length < AI_KNOWLEDGE_QUESTIONS_MAX && !has(item.questions, wording)) {
      item.questions = [...item.questions, wording];
      item.changed = true;
    }

    const stats: AiKnowledgeCallStats = store.items[item.id] ?? {
      asked: 0,
      unanswered: 0,
      lastAskedAt: opts.now.toISOString(),
      languages: {},
      ways: [],
      draftedFrom: [],
    };
    if (!counted.has(item.id)) {
      // Once per call, however often it came up in it.
      counted.add(item.id);
      stats.asked += 1;
      stats.unanswered += q.answered ? 0 : 1;
      stats.languages = { ...stats.languages, [opts.language]: (stats.languages[opts.language] ?? 0) + 1 };
      stats.lastAskedAt = opts.now.toISOString();
      // Call insights (absent from an older voice backend): how the customer felt on the call, and how interested they were.
      const sentiment = opts.insights?.sentiment;
      const interest = opts.insights?.interest;
      if (sentiment) stats.sentiments = { ...stats.sentiments, [sentiment]: (stats.sentiments?.[sentiment] ?? 0) + 1 };
      if (interest) stats.interests = { ...stats.interests, [interest]: (stats.interests?.[interest] ?? 0) + 1 };
    }
    // A wording an item doesn't take in (approved, from a file, rejected or full) is kept beside it for the admin.
    if (wording && !has(item.questions, wording)) {
      stats.ways = [wording, ...stats.ways.filter((w) => questionKey(w) !== questionKey(wording))].slice(0, MAX_WAYS);
    }
    if (draftedNow) stats.draftedFrom = q.answer_from.slice(0, 3);
    store.items[item.id] = stats;
  }
  store.calls = [...store.calls, logId].slice(-MAX_COUNTED_CALLS);
  return {
    creates: work.filter((w) => w.isNew).map((w) => ({ key: w.id, topic: w.topic, text: w.text, questions: w.questions })),
    updates: work.filter((w) => !w.isNew && w.changed).map((w) => ({ id: w.id, text: w.text, questions: w.questions })),
    skipped,
  };
}

/* ------------------------------------------------------------------ I/O */
/** The agent whose generated flow this is (autonomous, not archived), or null. */
async function agentOfFlow(flowId: string): Promise<{ id: string } | null> {
  return prisma.aiAgent.findFirst({ where: { callFlowId: flowId, archivedAt: null, mode: "AUTONOMOUS" }, select: { id: true } });
}

/**
 * The questions to send with a call of this flow: null unless it is an Autonomous AI Agent's (then the voice backend
 * learns nothing, as before). Approved Q&A first, then open suggestions most asked first, then other drafts, then
 * rejected suggestions (so a rejected question is recognised and not suggested again). Never throws.
 */
export async function knownQuestionsForFlow(flowId: string | null | undefined): Promise<KnownQuestion[] | null> {
  if (!flowId) return null;
  try {
    const agent = await agentOfFlow(flowId);
    if (!agent) return null;
    const [items, stats] = await Promise.all([
      prisma.aiAgentKnowledgeItem.findMany({
        where: { agentId: agent.id, kind: "qa" },
        select: { id: true, status: true, source: true, questions: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      questionStats(agent.id),
    ]);
    const asked = (id: string) => stats[id]?.asked ?? 0;
    const rank = (i: (typeof items)[number]) =>
      i.status === "APPROVED" ? 0 : i.status === "DRAFT" && i.source === AI_KNOWLEDGE_FROM_CALLS ? 1 : i.status === "DRAFT" ? 2 : 3;
    return items
      .filter((i) => i.status !== "REJECTED" || i.source === AI_KNOWLEDGE_FROM_CALLS)
      .map((i) => ({ i, question: questionsOf(i)[0] ?? "" }))
      .filter(({ question }) => question.trim())
      .sort((a, b) => rank(a.i) - rank(b.i) || asked(b.i.id) - asked(a.i.id))
      .slice(0, MAX_KNOWN_QUESTIONS)
      .map(({ i, question }) => ({ id: i.id, question: oneLine(question).slice(0, 300) }));
  } catch (err) {
    logger.warn({ flowId, err: err instanceof Error ? err.message : String(err) }, "ai agent questions unreadable - call placed without learning");
    return null;
  }
}

/**
 * One call's learned questions: counted, and new ones suggested as Draft Q&A. Idempotent per call (webhook and poll
 * may both deliver them). Never throws: a problem here never affects the call's status update.
 */
export async function saveCustomerQuestions(logId: string, raw: unknown, insights: QuestionCallInsights | null = null): Promise<void> {
  try {
    const questions = parseLearnedQuestions(raw);
    if (!questions.length) return;
    const log = await prisma.aiCallLog.findUnique({ where: { id: logId }, select: { runId: true, phone: true, customerName: true } });
    if (!log) return;
    const pinned = await prisma.aiCallRunFlow.findUnique({
      where: { runId: log.runId },
      select: { flowVersion: { select: { flowId: true, flow: { select: { language: true } } } } },
    });
    if (!pinned) return;
    const agent = await agentOfFlow(pinned.flowVersion.flowId);
    if (!agent) return;
    const language = pinned.flowVersion.flow?.language ?? DEFAULT_AI_CALL_LANGUAGE;
    const terms = privateTerms(log.customerName, await businessForCall(logId, log.phone, language as AiCallLanguage));
    const key = statsKey(agent.id);
    const result = await prisma.$transaction(
      async (tx) => {
        // The row exists before it is locked, so two first deliveries can't both start from nothing.
        await tx.$executeRaw`INSERT IGNORE INTO \`Setting\` (\`key\`, \`value\`, \`updatedAt\`) VALUES (${key}, ${JSON.stringify(emptyStore())}, NOW(3))`;
        const rows = await tx.$queryRaw<{ value: unknown }[]>`SELECT \`value\` FROM \`Setting\` WHERE \`key\` = ${key} FOR UPDATE`;
        const store = asStore(rows[0]?.value);
        const items = await tx.aiAgentKnowledgeItem.findMany({
          where: { agentId: agent.id, kind: "qa" },
          select: { id: true, status: true, source: true, questions: true, text: true, topic: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        const plan = planQuestions(store, items, logId, questions, { language, now: new Date(), terms, insights });
        if (!plan) return null;
        // The upload module (file readers) is loaded only when a suggestion is written: the run worker never needs it otherwise.
        const { itemIssues } = plan.creates.length || plan.updates.length ? await import("./aiAgentKnowledge.js") : { itemIssues: () => [] };
        const alive = new Set(items.map((i) => i.id));
        for (const c of plan.creates) {
          const draft = { kind: "qa" as const, topic: c.topic, text: c.text, questions: c.questions };
          const created = await tx.aiAgentKnowledgeItem.create({
            data: {
              agentId: agent.id,
              ...draft,
              questions: c.questions as unknown as Prisma.InputJsonValue,
              issues: itemIssues(draft) as unknown as Prisma.InputJsonValue,
              source: AI_KNOWLEDGE_FROM_CALLS,
            },
          });
          store.items[created.id] = store.items[c.key]!;
          alive.add(created.id);
        }
        for (const u of plan.updates) {
          const before = items.find((i) => i.id === u.id)!;
          const next = { kind: "qa" as const, topic: before.topic, text: u.text, questions: u.questions };
          // Only while it is still an open suggestion: an admin may have edited or decided it meanwhile.
          await tx.aiAgentKnowledgeItem.updateMany({
            where: { id: u.id, agentId: agent.id, status: "DRAFT", source: AI_KNOWLEDGE_FROM_CALLS, text: before.text },
            data: {
              text: next.text,
              questions: next.questions as unknown as Prisma.InputJsonValue,
              issues: itemIssues(next) as unknown as Prisma.InputJsonValue,
            },
          });
        }
        // Counts of deleted items go with them (and the placeholders of the new ones, now under their ids).
        for (const id of Object.keys(store.items)) if (!alive.has(id)) delete store.items[id];
        await tx.setting.update({ where: { key }, data: { value: store as unknown as Prisma.InputJsonValue } });
        return plan;
      },
      { timeout: 20_000 },
    );
    if (result) {
      logger.info(
        { logId, agentId: agent.id, questions: questions.length, suggested: result.creates.length, skipped: result.skipped },
        "ai agent customer questions counted",
      );
    }
  } catch (err) {
    logger.warn({ logId, err: err instanceof Error ? err.message : String(err) }, "ai agent customer questions not saved");
  }
}
