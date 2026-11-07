// Voice response tuning: one saved setting per tuned language (packages/shared/src/aiCallVoiceTuning.ts), and an AI
// Agent's own preset when it picked one. A language that isn't tuned never reaches the database here, so its calls cost
// nothing and change nothing.

import {
  AI_CALL_LANGUAGE_NAMES,
  isVoiceTuningLanguage,
  readAgentReplySpeed,
  readVoiceTuning,
  VOICE_TUNING_DEFAULT_PRESET,
  VOICE_TUNING_LANGUAGES,
  voiceTuningPayload,
  voiceTuningPreset,
  type AiCallLanguage,
  type VoiceTuningLanguage,
  type VoiceTuningPayload,
  type VoiceTuningPreset,
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

/** An agent's reply speed lives in Settings, beside its row, as its voice speed does. Absent = the language's setting. */
const agentKey = (agentId: string) => `aiAgentReplySpeed:${agentId}`;

export async function agentReplySpeed(agentId: string, language: string): Promise<VoiceTuningPreset | null> {
  if (!isVoiceTuningLanguage(language)) return null;
  return readAgentReplySpeed(await getSetting<unknown>(agentKey(agentId), null));
}

/** Null removes the agent's pick, so it follows the language's setting again. Only a tuned language ever saves one. */
export async function saveAgentReplySpeed(agentId: string, language: string, speed: VoiceTuningPreset | null): Promise<void> {
  if (!isVoiceTuningLanguage(language)) return;
  if (speed) await setSetting(agentKey(agentId), speed);
  else await prisma.setting.deleteMany({ where: { key: agentKey(agentId) } });
}

/** The reply speed of the autonomous agent compiled into this flow, if it picked one. Any other flow has none. */
async function flowReplySpeed(flowId: string, language: string): Promise<VoiceTuningPreset | null> {
  const agent = await prisma.aiAgent.findUnique({ where: { callFlowId: flowId }, select: { id: true } });
  return agent ? agentReplySpeed(agent.id, language) : null;
}

/**
 * What a call in `language` is sent, read when it is dialled: the preset of the agent behind `flowId` if it picked one,
 * else the language's setting. Null for every language that isn't tuned, without touching the database, and for
 * "Current behavior". A failed read uses the default: tuning never stops a call.
 */
export async function voiceTuningForCall(language: AiCallLanguage, flowId?: string | null): Promise<VoiceTuningPayload | null> {
  if (!isVoiceTuningLanguage(language)) return null;
  try {
    const own = flowId ? await flowReplySpeed(flowId, language) : null;
    return voiceTuningPayload(own ? voiceTuningPreset(own) : (await row(language)).tuning);
  } catch (err) {
    logger.warn({ language, err: err instanceof Error ? err.message : String(err) }, "voice tuning unreadable - using the default");
    return voiceTuningPayload(voiceTuningPreset(VOICE_TUNING_DEFAULT_PRESET));
  }
}
