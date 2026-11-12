// AI voice calls: run planning (validation, dedupe, do-not-call, random pick)
// and voice-backend status mapping. The pure functions here are unit-tested;
// the DB helpers at the bottom are thin.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { AiCallStatus } from "@prisma/client";
import { checkAiCallRow, normalizePhoneE164, type StartAiCallsInput } from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { saveLearnedBusiness, syncCustomerFromLog } from "./aiCallCustomerSync.js";
import { saveCustomerQuestions } from "./aiAgentQuestions.js";

/* ------------------------------------------------------------------ random selection */

/**
 * In-place Fisher–Yates shuffle. `rand(n)` returns a uniform integer in
 * [0, n); defaults to crypto.randomInt so the order is not predictable.
 */
export function fisherYatesShuffle<T>(items: T[], rand: (n: number) => number = randomInt): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** `n` distinct items chosen uniformly at random (input is not modified). */
export function pickRandom<T>(items: readonly T[], n: number, rand?: (n: number) => number): T[] {
  return fisherYatesShuffle([...items], rand).slice(0, Math.max(0, n));
}

/* ------------------------------------------------------------------ planning */

export interface AiCallTarget {
  /** Index of the row in the uploaded file (as sent by the browser). */
  rowIndex: number;
  customerName: string | null;
  gender: "male" | "female" | "unknown";
  followUpDetail: string | null;
  phone: string; // E.164
}

export interface AiCallPlan {
  targets: AiCallTarget[];
  skipped: { invalid: number; duplicates: number; doNotCall: number; capped: number };
  /** Rows that can't be called, for the UI. */
  invalidRows: { rowIndex: number; errors: string[] }[];
}

/**
 * Decide exactly who a run will call. Order: restrict to the selected rows
 * (selected mode) → drop invalid phones → dedupe by E.164 (first row wins) →
 * drop do-not-call numbers → random pick (random mode) → apply the cap. Every
 * phone appears at most once, so a run never calls the same number twice.
 */
export function planAiCallRun(
  input: Pick<StartAiCallsInput, "rows" | "mode" | "randomCount" | "selectedIndexes" | "maxCalls">,
  opts: { doNotCall: Set<string>; hardCap: number; defaultCountryCode?: string; rand?: (n: number) => number },
): AiCallPlan {
  const selected = new Set(input.selectedIndexes);
  const skipped = { invalid: 0, duplicates: 0, doNotCall: 0, capped: 0 };
  const invalidRows: AiCallPlan["invalidRows"] = [];
  const seen = new Set<string>();
  const pool: AiCallTarget[] = [];

  input.rows.forEach((row, rowIndex) => {
    if (input.mode === "selected" && !selected.has(rowIndex)) return;
    const check = checkAiCallRow(row, opts.defaultCountryCode);
    if (!check.phone || check.errors.length > 0) {
      skipped.invalid++;
      invalidRows.push({ rowIndex, errors: check.errors });
      return;
    }
    if (seen.has(check.phone)) {
      skipped.duplicates++;
      return;
    }
    seen.add(check.phone);
    if (opts.doNotCall.has(check.phone)) {
      skipped.doNotCall++;
      return;
    }
    pool.push({
      rowIndex,
      customerName: row.customerName?.trim() || null,
      gender: check.gender,
      followUpDetail: row.followUpDetail?.trim() || null,
      phone: check.phone,
    });
  });

  const cap = Math.max(0, Math.min(input.maxCalls, opts.hardCap));
  let targets: AiCallTarget[];
  if (input.mode === "random") {
    const wanted = Math.min(input.randomCount, pool.length);
    targets = pickRandom(pool, Math.min(wanted, cap), opts.rand);
    skipped.capped = wanted - targets.length;
  } else {
    targets = pool.slice(0, cap);
    skipped.capped = pool.length - targets.length;
  }
  return { targets, skipped, invalidRows };
}

/* ------------------------------------------------------------------ status mapping */

export const FINAL_AI_CALL_STATUSES: readonly AiCallStatus[] = [
  "COMPLETED",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "CANCELLED",
];
export const IN_FLIGHT_AI_CALL_STATUSES: readonly AiCallStatus[] = ["DIALING", "RINGING", "IN_PROGRESS"];

export const isFinalAiCallStatus = (s: AiCallStatus) => FINAL_AI_CALL_STATUSES.includes(s);

/** kagzso-voice-backend CallStatus → AiCallStatus. Unknown values → null (ignored). */
export function mapVoiceStatus(raw: string | null | undefined): AiCallStatus | null {
  switch ((raw ?? "").toLowerCase().replace(/-/g, "_")) {
    case "created":
    case "initiating":
      return "DIALING";
    case "ringing":
      return "RINGING";
    case "answered":
    case "connected":
    case "speaking":
    case "listening":
    case "processing":
      return "IN_PROGRESS";
    case "completed":
      return "COMPLETED";
    case "no_answer":
      return "NO_ANSWER";
    case "busy":
      return "BUSY";
    case "failed":
    case "cancelled":
      return "FAILED";
    default:
      return null;
  }
}

const RANK: Record<AiCallStatus, number> = {
  QUEUED: 0,
  DIALING: 1,
  RINGING: 2,
  IN_PROGRESS: 3,
  COMPLETED: 9,
  NO_ANSWER: 9,
  BUSY: 9,
  FAILED: 9,
  CANCELLED: 9,
};

/**
 * Status after an update arrives. Never regresses (a late "ringing" callback
 * can't undo "in progress") and never leaves a final state — callbacks and
 * polling race, and out-of-order delivery must be harmless.
 */
export function nextAiCallStatus(current: AiCallStatus, incoming: AiCallStatus | null): AiCallStatus {
  if (!incoming || isFinalAiCallStatus(current)) return current;
  return RANK[incoming] >= RANK[current] ? incoming : current;
}

/* ------------------------------------------------------------------ voice-backend updates */

export interface VoiceCallUpdate {
  status?: string | null;
  voiceCallId?: string | null;
  providerCallId?: string | null;
  outcome?: string | null;
  summary?: string | null;
  transcript?: { speaker: string; text: string }[] | null;
  durationSec?: number | null;
  endedAt?: Date | null;
  error?: string | null;
  /** The business the customer said they run, on a call that had none on file (saved Voicecall Contact). */
  learnedBusiness?: string | null;
  /** The customer's questions after an AI Agent's call (domain/aiAgentQuestions checks and counts them). */
  customerQuestions?: unknown;
}

export function formatTranscript(lines: { speaker: string; text: string }[]): string {
  return lines
    .map((l) => `${l.speaker === "customer" ? "Customer" : "Agent"}: ${String(l.text ?? "").trim()}`)
    .join("\n");
}

/** Apply a status callback / poll result to one log row. Returns the new status. */
export async function applyVoiceUpdate(logId: string, u: VoiceCallUpdate): Promise<AiCallStatus | null> {
  const log = await prisma.aiCallLog.findUnique({ where: { id: logId } });
  if (!log) return null;
  const status = nextAiCallStatus(log.status, mapVoiceStatus(u.status));
  const becameFinal = status !== log.status && isFinalAiCallStatus(status);
  await prisma.aiCallLog.update({
    where: { id: logId },
    data: {
      status,
      ...(u.voiceCallId && !log.voiceCallId ? { voiceCallId: u.voiceCallId.slice(0, 64) } : {}),
      ...(u.providerCallId ? { providerCallId: u.providerCallId.slice(0, 64) } : {}),
      ...(u.outcome ? { outcome: u.outcome.slice(0, 32) } : {}),
      ...(u.summary ? { summary: u.summary.slice(0, 5000) } : {}),
      ...(u.transcript && u.transcript.length > 0 ? { transcript: formatTranscript(u.transcript) } : {}),
      ...(u.durationSec != null ? { durationSec: u.durationSec } : {}),
      ...(becameFinal ? { endedAt: u.endedAt ?? new Date() } : {}),
      ...(becameFinal && status === "FAILED" && u.error ? { error: u.error.slice(0, 2000) } : {}),
    },
  });
  // Saved AI Call Customers: update the stage once the call is final, and again
  // when the classified outcome arrives later. No-op for calls from a file.
  const outcomeChanged = !!u.outcome && u.outcome.slice(0, 32) !== log.outcome;
  if (isFinalAiCallStatus(status) && (becameFinal || outcomeChanged)) await syncCustomerFromLog(logId);
  if (u.learnedBusiness) await saveLearnedBusiness(logId, u.learnedBusiness);
  if (u.customerQuestions) await saveCustomerQuestions(logId, u.customerQuestions); // never throws; once per call
  return status;
}

/* ------------------------------------------------------------------ do-not-call */

/**
 * Every phone (E.164) that must not be called: email contacts that are not
 * ACTIVE or have unsubscribed, WhatsApp contacts that unsubscribed / blocked,
 * anyone who asked not to be called on an earlier AI call, and saved AI Call
 * Customers marked Do not call.
 */
export async function loadDoNotCallPhones(defaultCountryCode: string): Promise<Set<string>> {
  const [contacts, waContacts, optedOut, savedDnc] = await Promise.all([
    prisma.contact.findMany({
      where: { phone: { not: null }, OR: [{ status: { not: "ACTIVE" } }, { unsubscribe: { isNot: null } }] },
      select: { phone: true },
    }),
    prisma.whatsAppContact.findMany({
      where: { status: { in: ["UNSUBSCRIBED", "BLOCKED"] } },
      select: { phone: true },
    }),
    prisma.aiCallLog.findMany({ where: { outcome: "do_not_call" }, select: { phone: true }, distinct: ["phone"] }),
    // Saved AI Call Customers marked Do not call — including soft-deleted ones (permanent).
    prisma.aiCallCustomer.findMany({ where: { doNotCall: true }, select: { phone: true } }),
  ]);
  const out = new Set<string>();
  for (const { phone } of [...contacts, ...waContacts, ...optedOut, ...savedDnc]) {
    const e164 = phone ? normalizePhoneE164(phone, defaultCountryCode) : null;
    if (e164) out.add(e164);
  }
  return out;
}

/** Calls dialled in the last 24h plus calls still queued in running runs. */
export async function callsCountedTowardDailyCap(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [dialled, queued] = await Promise.all([
    prisma.aiCallLog.count({ where: { startedAt: { gte: since } } }),
    prisma.aiCallLog.count({ where: { status: "QUEUED", run: { status: "RUNNING" } } }),
  ]);
  return dialled + queued;
}

/* ------------------------------------------------------------------ callback signature */

/** Callbacks older/newer than this are rejected (replay protection). */
export const AI_CALL_WEBHOOK_TOLERANCE_SEC = 300;

/** hex HMAC-SHA256 over "<timestamp>.<raw body>" — what the voice backend sends in X-Kagzso-Signature. */
export function signAiCallWebhook(secret: string, timestamp: string, raw: Buffer | string): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
}

export function isValidAiCallSignature(
  raw: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature || !/^\d{9,11}$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > AI_CALL_WEBHOOK_TOLERANCE_SEC) return false;
  const expected = Buffer.from(`sha256=${signAiCallWebhook(secret, timestamp, raw)}`);
  const given = Buffer.from(signature.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The voice backend stores naive UTC datetimes ("2026-10-10T09:15:00"). */
export function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(/(z|[+-]\d\d:?\d\d)$/i.test(value) ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
