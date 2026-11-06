// Voice response tuning: one saved setting per tuned language (packages/shared/src/aiCallVoiceTuning.ts). A language
// that isn't tuned never reaches the database here, so its calls cost nothing and change nothing.

import {
  AI_CALL_LANGUAGE_NAMES,
  isVoiceTuningLanguage,
  readVoiceTuning,
  VOICE_TUNING_DEFAULT_PRESET,
  VOICE_TUNING_LANGUAGES,
  voiceTuningPayload,
  voiceTuningPreset,
  type AiCallLanguage,
  type VoiceTuningLanguage,
  type VoiceTuningPayload,
  type VoiceTuningRow,
  type VoiceTuningSetting,
} from "@dispatch/shared";
import { prisma } from "../prisma.js";
import { logger } from "../logger.js";
import { getSetting, setSetting } from "./settings.js";

const key = (language: VoiceTuningLanguage) => `aiCallVoiceTuning:${language}`;

async function row(language: VoiceTuningLanguage): Promise<VoiceTuningRow> {
  const saved = await getSetting<unknown>(key(language), null);
  return { language, name: AI_CALL_LANGUAGE_NAMES[language], tuning: readVoiceTuning(saved), saved: saved !== null };
}

export function listVoiceTuning(): Promise<VoiceTuningRow[]> {
  return Promise.all(VOICE_TUNING_LANGUAGES.map(row));
}

export async function saveVoiceTuning(language: VoiceTuningLanguage, tuning: VoiceTuningSetting): Promise<VoiceTuningRow> {
  await setSetting(key(language), tuning);
  return row(language);
}

/** Reset to default: the saved value is removed, so the language follows the default from now on. */
export async function resetVoiceTuning(language: VoiceTuningLanguage): Promise<VoiceTuningRow> {
  await prisma.setting.deleteMany({ where: { key: key(language) } });
  return row(language);
}

/**
 * What a call in `language` is sent, read when it is dialled. Null for every language that isn't tuned, without
 * touching the database, and for "Current behavior". A failed read uses the default: tuning never stops a call.
 */
export async function voiceTuningForCall(language: AiCallLanguage): Promise<VoiceTuningPayload | null> {
  if (!isVoiceTuningLanguage(language)) return null;
  try {
    return voiceTuningPayload((await row(language)).tuning);
  } catch (err) {
    logger.warn({ language, err: err instanceof Error ? err.message : String(err) }, "voice tuning unreadable - using the default");
    return voiceTuningPayload(voiceTuningPreset(VOICE_TUNING_DEFAULT_PRESET));
  }
}
