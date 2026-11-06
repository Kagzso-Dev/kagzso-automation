// Voice response tuning (Settings → Voice response tuning): how long a call waits for the customer before replying.
// Tamil only. A language that is not in VOICE_TUNING_LANGUAGES is never read, never saved and never sent anything, so
// its calls stay exactly as they are. Adding a language = its code here, plus a rules entry in the voice backend's
// app/services/turn_tuning.py.
//
// The values are read when a call is dialled and go with that call only (voice backend: OutboundCallRequest.voice_tuning).
// "Current behavior" sends nothing at all, so it is an exact rollback. No saved value = Balanced.

import { z } from "zod";
import type { AiCallLanguage } from "./aiCallLanguages.js";

export const VOICE_TUNING_LANGUAGES = ["ta"] as const;
export type VoiceTuningLanguage = (typeof VOICE_TUNING_LANGUAGES)[number];

export function isVoiceTuningLanguage(language: AiCallLanguage | string): language is VoiceTuningLanguage {
  return (VOICE_TUNING_LANGUAGES as readonly string[]).includes(language);
}

export const VOICE_TUNING_PRESETS = ["fast", "balanced", "patient", "current"] as const;
export type VoiceTuningPreset = (typeof VOICE_TUNING_PRESETS)[number];
export const VOICE_TUNING_DEFAULT_PRESET: VoiceTuningPreset = "balanced";
export const VOICE_TUNING_PRESET_LABELS: Record<VoiceTuningPreset, string> = {
  fast: "Fast",
  balanced: "Balanced",
  patient: "Patient",
  current: "Current behavior",
};
export const VOICE_TUNING_PRESET_HINTS: Record<VoiceTuningPreset, string> = {
  fast: "Replies soonest. A customer who pauses a lot may be answered early.",
  balanced: "Quick after a finished sentence, patient after an unfinished one.",
  patient: "For customers who pause a lot. Replies a little later.",
  current: "Exactly as calls worked before this setting: 700 ms of silence, no extra wait, no cap.",
};

export interface VoiceTuningValues {
  /** Silence before replying after a clearly finished sentence. */
  finishedSilenceMs: number;
  /** Silence before replying when the sentence could go either way. */
  endOfSpeechSilenceMs: number;
  /** Added to that wait when the sentence sounds unfinished. */
  extraWaitIfIncompleteMs: number;
  /** The most silence a call ever waits. 0 = no cap. */
  hardCapMs: number;
  /** Fewer words than this count as unfinished (a short answer such as "ஆமா" always counts as finished). */
  minWordsBeforeReply: number;
}

export const VOICE_TUNING_VALUES: Record<VoiceTuningPreset, VoiceTuningValues> = {
  fast: { finishedSilenceMs: 350, endOfSpeechSilenceMs: 750, extraWaitIfIncompleteMs: 300, hardCapMs: 1200, minWordsBeforeReply: 1 },
  balanced: { finishedSilenceMs: 450, endOfSpeechSilenceMs: 900, extraWaitIfIncompleteMs: 500, hardCapMs: 1600, minWordsBeforeReply: 1 },
  patient: { finishedSilenceMs: 600, endOfSpeechSilenceMs: 1100, extraWaitIfIncompleteMs: 800, hardCapMs: 2000, minWordsBeforeReply: 1 },
  current: { finishedSilenceMs: 700, endOfSpeechSilenceMs: 700, extraWaitIfIncompleteMs: 0, hardCapMs: 0, minWordsBeforeReply: 1 },
};

/** What the voice backend accepts (app/schemas/calls.py VoiceTuning has the same limits). */
export const VOICE_TUNING_LIMITS = {
  finishedSilenceMs: { min: 300, max: 2000 },
  endOfSpeechSilenceMs: { min: 300, max: 2000 },
  extraWaitIfIncompleteMs: { min: 0, max: 2000 },
  hardCapMs: { min: 0, max: 5000 },
  minWordsBeforeReply: { min: 1, max: 5 },
} as const;

const whole = (key: keyof typeof VOICE_TUNING_LIMITS) => {
  const { min, max } = VOICE_TUNING_LIMITS[key];
  const rule = `Enter whole numbers from ${min} to ${max}`;
  return z.coerce.number({ invalid_type_error: rule }).int(rule).min(min, rule).max(max, rule);
};

/** One language's saved setting: a preset, or "custom" for numbers typed under Advanced. */
export const voiceTuningSetting = z
  .object({
    preset: z.enum([...VOICE_TUNING_PRESETS, "custom"]),
    finishedSilenceMs: whole("finishedSilenceMs"),
    endOfSpeechSilenceMs: whole("endOfSpeechSilenceMs"),
    extraWaitIfIncompleteMs: whole("extraWaitIfIncompleteMs"),
    hardCapMs: whole("hardCapMs"),
    minWordsBeforeReply: whole("minWordsBeforeReply"),
  })
  .strict()
  .superRefine((t, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (t.preset === "custom" && t.hardCapMs > 0 && t.hardCapMs < t.endOfSpeechSilenceMs) {
      issue("hardCapMs", "The hard cap can't be shorter than the end-of-speech wait");
    }
    if (t.finishedSilenceMs > t.endOfSpeechSilenceMs) {
      issue("endOfSpeechSilenceMs", "The end-of-speech wait can't be shorter than the wait after a finished sentence");
    }
  });
export type VoiceTuningSetting = z.infer<typeof voiceTuningSetting>;

/** A preset as a saved setting. */
export const voiceTuningPreset = (preset: VoiceTuningPreset): VoiceTuningSetting => ({ preset, ...VOICE_TUNING_VALUES[preset] });

/** A saved value as a call may use it: anything unreadable (old or hand-edited data) is the default, never an error. */
export function readVoiceTuning(saved: unknown): VoiceTuningSetting {
  const parsed = voiceTuningSetting.safeParse(saved);
  if (!parsed.success) return voiceTuningPreset(VOICE_TUNING_DEFAULT_PRESET);
  // A preset always means its own numbers, so a later change to a preset reaches everyone who picked it.
  return parsed.data.preset === "custom" ? parsed.data : voiceTuningPreset(parsed.data.preset);
}

/** What goes on the call to the voice backend. */
export interface VoiceTuningPayload {
  preset: string;
  finished_silence_ms: number;
  end_of_speech_silence_ms: number;
  extra_wait_if_incomplete_ms: number;
  hard_cap_ms: number;
  min_words_before_reply: number;
}

/** The call's payload, or null for "Current behavior": the call then runs exactly as it always did. */
export function voiceTuningPayload(t: VoiceTuningSetting): VoiceTuningPayload | null {
  if (t.preset === "current") return null;
  return {
    preset: t.preset,
    finished_silence_ms: t.finishedSilenceMs,
    end_of_speech_silence_ms: t.endOfSpeechSilenceMs,
    extra_wait_if_incomplete_ms: t.extraWaitIfIncompleteMs,
    hard_cap_ms: t.hardCapMs,
    min_words_before_reply: t.minWordsBeforeReply,
  };
}

/** GET /api/ai-calls/voice-tuning: one row per tuned language. */
export interface VoiceTuningRow {
  language: VoiceTuningLanguage;
  name: string;
  tuning: VoiceTuningSetting;
  /** False = nothing saved: the default applies. */
  saved: boolean;
}
