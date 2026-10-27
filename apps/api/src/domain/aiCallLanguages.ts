// AI call languages: one voice backend per language (config/aiCalls voiceBackendFor).
//
//   - English is always offered and can't be switched off: it works exactly as before.
//   - Tamil, Hindi and Kannada always have pages (AI_CALL_STANDARD_LANGUAGES), even before their
//     voice backend is set up: they just can't call yet. Any other language is offered once its
//     voice backend is configured (VOICE_BACKEND_URL_<CODE>).
//   - An admin can switch any of them off (Settings → AI call languages). Switched off: its pages
//     are hidden, new runs are refused and queued calls of a running run are cancelled before dialling.
//   - Flows and saved customers have their own language column. A run's language is its pinned
//     flow's; a run without a flow uses the default agent, which is English.
//   - One run at a time per language (each language's calls are independent).

import type { Prisma } from "@prisma/client";
import {
  AI_CALL_LANGUAGE_NAMES,
  DEFAULT_AI_CALL_LANGUAGE,
  isAiCallLanguage,
  type AiCallLanguage,
  type AiCallLanguageInfo,
} from "@dispatch/shared";
import { isAiCallsConfigured, offeredAiCallLanguages } from "../config/aiCalls.js";
import { prisma } from "../prisma.js";
import { voiceBackendSettingNames } from "../services/voiceBackend.js";
import { getSetting, setSetting } from "./settings.js";

/** Setting key: the languages an admin switched off (English is never in it). */
export const AI_CALL_LANGUAGES_DISABLED_KEY = "aiCallLanguagesDisabled";

export class AiCallLanguageError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "AiCallLanguageError";
  }
}

/** A stored language code, English for anything unknown (rows from before languages are "en"). */
export function asAiCallLanguage(v: unknown): AiCallLanguage {
  return isAiCallLanguage(v) ? v : DEFAULT_AI_CALL_LANGUAGE;
}

export const languageName = (l: AiCallLanguage) => AI_CALL_LANGUAGE_NAMES[l];

export async function disabledAiCallLanguages(): Promise<Set<AiCallLanguage>> {
  const stored = await getSetting<unknown>(AI_CALL_LANGUAGES_DISABLED_KEY, []);
  return new Set((Array.isArray(stored) ? stored : []).filter(isAiCallLanguage).filter((l) => l !== DEFAULT_AI_CALL_LANGUAGE));
}

/** Every offered language (English first) with whether its backend is set up and whether it is switched on. */
export async function listAiCallLanguages(): Promise<AiCallLanguageInfo[]> {
  const disabled = await disabledAiCallLanguages();
  return offeredAiCallLanguages().map((code) => ({
    code,
    name: AI_CALL_LANGUAGE_NAMES[code],
    configured: isAiCallsConfigured(code),
    enabled: !disabled.has(code),
  }));
}

/** Admin switch. English can't be switched off; a language that has no pages (not offered) can't be changed. */
export async function setAiCallLanguageEnabled(language: AiCallLanguage, enabled: boolean): Promise<AiCallLanguageInfo[]> {
  if (language === DEFAULT_AI_CALL_LANGUAGE) throw new AiCallLanguageError(400, "English AI calls can't be switched off here");
  if (!offeredAiCallLanguages().includes(language)) {
    throw new AiCallLanguageError(404, `${languageName(language)} has no voice backend yet — set ${voiceBackendSettingNames(language)} first`);
  }
  const disabled = await disabledAiCallLanguages();
  if (enabled) disabled.delete(language);
  else disabled.add(language);
  await setSetting(AI_CALL_LANGUAGES_DISABLED_KEY, [...disabled].sort());
  return listAiCallLanguages();
}

/**
 * Why calls in `language` can't be started right now, or null. English keeps its original message
 * (VOICE_BACKEND_URL / VOICE_BACKEND_API_KEY); another language also needs to be switched on.
 */
export async function aiCallLanguageBlockedReason(language: AiCallLanguage): Promise<string | null> {
  if (language === DEFAULT_AI_CALL_LANGUAGE) {
    return isAiCallsConfigured(language) ? null : "Voice backend is not configured — set VOICE_BACKEND_URL and VOICE_BACKEND_API_KEY";
  }
  if (!isAiCallsConfigured(language)) {
    return `${languageName(language)} voice backend is not configured — set ${voiceBackendSettingNames(language)}`;
  }
  if ((await disabledAiCallLanguages()).has(language)) {
    return `${languageName(language)} AI calls are switched off (Settings → AI call languages)`;
  }
  return null;
}

/** Runs of one language. English = runs without a flow (the default agent) or with an English flow. */
export function runLanguageWhere(language: AiCallLanguage): Prisma.AiCallRunWhereInput {
  const ofLanguage: Prisma.AiCallRunWhereInput = { flow: { is: { flowVersion: { is: { flow: { is: { language } } } } } } };
  return language === DEFAULT_AI_CALL_LANGUAGE ? { OR: [{ flow: { is: null } }, ofLanguage] } : ofLanguage;
}

/** The run of this language still dialling, if any (one run at a time per language). */
export function runningRunOf(language: AiCallLanguage) {
  return prisma.aiCallRun.findFirst({ where: { status: "RUNNING", ...runLanguageWhere(language) }, select: { id: true } });
}

/** A run's language: its pinned flow's, English for a run without a flow. */
export async function languageOfRun(runId: string): Promise<AiCallLanguage> {
  const link = await prisma.aiCallRunFlow.findUnique({
    where: { runId },
    select: { flowVersion: { select: { flow: { select: { language: true } } } } },
  });
  return asAiCallLanguage(link?.flowVersion.flow.language);
}

/** Each run's language, for many runs at once (runs without a flow are English). */
export async function languagesOfRuns(runIds: string[]): Promise<Map<string, AiCallLanguage>> {
  const links = runIds.length
    ? await prisma.aiCallRunFlow.findMany({
        where: { runId: { in: runIds } },
        select: { runId: true, flowVersion: { select: { flow: { select: { language: true } } } } },
      })
    : [];
  const out = new Map<string, AiCallLanguage>(runIds.map((id) => [id, DEFAULT_AI_CALL_LANGUAGE]));
  for (const l of links) out.set(l.runId, asAiCallLanguage(l.flowVersion.flow.language));
  return out;
}
