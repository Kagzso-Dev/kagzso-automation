// Copyright (c) 2026 Kagzso Technology Services. All rights reserved.
// Proprietary and confidential. See LICENSE.md in the repository root.
// SPDX-License-Identifier: LicenseRef-Kagzso-Proprietary
import { useState } from "react";
import {
  AI_AGENT_DEFAULT_VOICE,
  AI_AGENT_MALE_EXECUTIVE_NAME,
  AI_AGENT_VOICE_GENDER_LABELS,
  AI_AGENT_VOICE_GENDERS,
  AI_AGENT_VOICE_SPEED_LIMITS,
  AI_AGENT_VOICE_SPEEDS,
  AI_CALL_LANGUAGE_NAMES,
  femaleNameForMaleVoice,
  isVoiceTuningLanguage,
  voiceLanguageMismatch,
  VOICE_TUNING_DEFAULT_PRESET,
  VOICE_TUNING_LIMITS,
  VOICE_TUNING_PRESET_HINTS,
  VOICE_TUNING_PRESET_LABELS,
  VOICE_TUNING_PRESETS,
  voiceTuningPreset,
  voiceTuningSetting,
  type AiAgentVoiceGender,
  type AiCallLanguage,
  type VoiceTuningSetting,
} from "@dispatch/shared";
import { useCallFlowCatalog, type VoiceOption } from "../lib/callFlows";
import { VoicePicker } from "./VoicePicker";
import { ErrorNote, Spinner } from "./ui";

const isGender = (g: string | undefined): g is AiAgentVoiceGender => g === "female" || g === "male";

/**
 * The voice a new agent of this language starts with: the backend's female cloned voice (SARVAM_TTS_VOICE_<LANG>_FEMALE),
 * else AI_AGENT_DEFAULT_VOICE (Roopa for Tamil) when offered. Undefined while the voices are unknown, or neither is offered.
 * Picking "Male" then starts from the backend's first male voice: its cloned male voices come first in its list.
 */
export function agentDefaultVoice(language: AiCallLanguage, voices: VoiceOption[] | undefined): string | undefined {
  // Never a clone made in another language (an English clone on a Tamil agent).
  const clone = voices?.find((v) => v.cloned && v.gender === "female" && !voiceLanguageMismatch(v.source_language, language));
  if (clone) return clone.id;
  const preferred = AI_AGENT_DEFAULT_VOICE[language];
  return preferred && voices?.some((v) => v.id === preferred) ? preferred : undefined;
}

/**
 * How fast the voice speaks: a level, or any speed typed in the box. What's typed stays as typed while the form holds
 * its number (a half-typed "1." or an empty box is never rewritten); picking a level replaces it.
 */
function VoiceSpeed({ speed, onChange, error }: { speed: number; onChange: (speed: number) => void; error?: string }) {
  const [typed, setTyped] = useState<string | null>(null);
  const { min, max } = AI_AGENT_VOICE_SPEED_LIMITS;
  return (
    <div>
      <label className="label">Voice speed</label>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="radiogroup" aria-label="Voice speed" className="flex flex-wrap gap-2">
          {AI_AGENT_VOICE_SPEEDS.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={speed === s.value}
              onClick={() => {
                setTyped(null);
                onChange(s.value);
              }}
              className={`rounded-lg border px-3 py-1.5 ${speed === s.value ? "border-accent bg-tint font-semibold" : "border-line"}`}
            >
              {s.label}
              <span className="ml-1 text-xs font-normal text-slate-550">({s.value.toFixed(1)})</span>
            </button>
          ))}
        </div>
        {/* The rule itself turns red when it's broken, so typing "0.85" doesn't push the page down on the way through "0". */}
        <label className="flex items-center gap-2">
          <span className={`text-xs ${error ? "font-semibold text-crit" : "text-slate-550"}`}>
            {error ?? `Or enter a speed (${min.toFixed(1)} to ${max.toFixed(1)})`}
          </span>
          <input
            className="input w-20"
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={0.05}
            aria-invalid={!!error}
            value={typed ?? speed}
            onChange={(e) => {
              setTyped(e.target.value);
              onChange(Number(e.target.value));
            }}
          />
        </label>
      </div>
      <p className="mt-1 text-xs text-slate-550">
        1.0 is the voice's ordinary speed. Every line of this agent's calls is spoken at this speed, and Listen plays it. Publish the agent for calls to
        follow it.
      </p>
    </div>
  );
}

type ReplyField = "finishedSilenceMs" | "endOfSpeechSilenceMs" | "extraWaitIfIncompleteMs" | "hardCapMs";
/** Manual reply speed: the waits of Settings > Voice response tuning (Advanced), plus the wait after a finished sentence. */
const REPLY_FIELDS: { key: ReplyField; label: string }[] = [
  { key: "finishedSilenceMs", label: "Wait after a finished sentence (ms)" },
  { key: "endOfSpeechSilenceMs", label: "End-of-speech wait (ms)" },
  { key: "extraWaitIfIncompleteMs", label: "Extra wait for unfinished sentences (ms)" },
  { key: "hardCapMs", label: "Hard cap on waiting (ms, 0 = no cap)" },
];
type ReplyChoice = VoiceTuningSetting["preset"] | null;

/**
 * How soon the AI answers once the customer stops talking: Use Settings (the default: Settings > Voice response tuning),
 * one of its presets, or Manual, the same waits typed by hand. Manual starts from the speed picked before it (Balanced,
 * the default, after Use Settings). It is read when each call is dialled, so unlike the voice speed it needs no publish.
 */
function ReplySpeed({ speed, onChange }: { speed: VoiceTuningSetting | null; onChange: (speed: VoiceTuningSetting | null) => void }) {
  const picked: ReplyChoice = speed?.preset ?? null;
  const choices: { value: ReplyChoice; label: string }[] = [
    { value: null, label: "Use Settings" },
    ...VOICE_TUNING_PRESETS.map((p) => ({ value: p, label: VOICE_TUNING_PRESET_LABELS[p] })),
    { value: "custom", label: "Manual" },
  ];
  function choose(value: ReplyChoice) {
    if (value === null) onChange(null);
    else if (value === "custom") onChange({ ...(speed ?? voiceTuningPreset(VOICE_TUNING_DEFAULT_PRESET)), preset: "custom" });
    else onChange(voiceTuningPreset(value));
  }
  const manual = speed?.preset === "custom" ? speed : null;
  const check = manual ? voiceTuningSetting.safeParse(manual) : null;
  const fieldError = (k: ReplyField) => (check && !check.success ? check.error.issues.find((i) => i.path[0] === k)?.message : undefined);
  const hint =
    picked === null
      ? "This agent follows Settings > Voice response tuning."
      : picked === "custom"
        ? "Your own waits below: lower numbers answer sooner, higher ones give a customer who pauses more time."
        : VOICE_TUNING_PRESET_HINTS[picked];
  return (
    <div>
      <label className="label">Reply speed</label>
      <div role="radiogroup" aria-label="Reply speed" className="flex flex-wrap gap-2">
        {choices.map((c) => (
          <button
            key={c.label}
            type="button"
            role="radio"
            aria-checked={picked === c.value}
            onClick={() => choose(c.value)}
            className={`rounded-lg border px-3 py-1.5 ${picked === c.value ? "border-accent bg-tint font-semibold" : "border-line"}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-slate-550">
        How soon the AI answers once the customer stops talking. {hint} Applies from the next call, with no publish needed.
      </p>
      {manual && (
        // Two columns: every label fits on one line, so the boxes line up.
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {REPLY_FIELDS.map(({ key, label }) => {
            const { min, max } = VOICE_TUNING_LIMITS[key];
            const value = manual[key];
            const error = fieldError(key);
            return (
              <div key={key}>
                <label className="label" htmlFor={`reply-speed-${key}`}>
                  {label}
                </label>
                <input
                  id={`reply-speed-${key}`}
                  type="number"
                  inputMode="numeric"
                  className="input"
                  min={min}
                  max={max}
                  step={50}
                  aria-invalid={!!error}
                  value={Number.isNaN(value) ? "" : value}
                  onChange={(e) => onChange({ ...manual, [key]: e.target.valueAsNumber })}
                />
                {/* The range turns into the error in place, so typing "900" doesn't push the page down on the way through "9". */}
                <p className={`mt-1 text-xs ${error ? "font-semibold text-crit" : "text-slate-550"}`}>{error ?? `${min} to ${max}`}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A filter of the voice list: a gender, or the Sarvam Bulbul v4 Flash voices. */
type VoiceGroup = AiAgentVoiceGender | "v4";

/**
 * Settings → AI Voice (autonomous agents): the AI's own voice, from the voices the language's voice backend offers
 * with a gender (its list is the only one). Female / Male only filters the list; picking a voice changes the form,
 * saved with "Save settings". Listen plays a sample (text-to-speech only, never a call), at the speed picked here.
 * Independent of the contact's gender: the customer is addressed by the Contact section's gender whatever voice speaks.
 */
export function AiAgentVoice({
  language,
  value,
  onChange,
  speed,
  onSpeedChange,
  speedError,
  replySpeed,
  onReplySpeedChange,
  executiveName,
  onExecutiveNameChange,
}: {
  language: AiCallLanguage;
  /** The picked voice id ("" = none: the voice backend's default voice). */
  value: string;
  onChange: (voiceId: string) => void;
  /** How fast the AI speaks: a level or a typed speed. */
  speed: number;
  onSpeedChange: (speed: number) => void;
  /** What's wrong with a typed speed: Listen waits for a valid one, as saving does. */
  speedError?: string;
  /** This agent's own reply speed; null = the language's setting. Offered only in a language with voice response tuning. */
  replySpeed: VoiceTuningSetting | null;
  onReplySpeedChange: (speed: VoiceTuningSetting | null) => void;
  executiveName: string;
  /** Sets "AI executive name" (the male name offered when a male voice would say a female name). */
  onExecutiveNameChange?: (name: string) => void;
}) {
  const catalog = useCallFlowCatalog(language);
  const [picked, setPicked] = useState<VoiceGroup | null>(null);
  // Needs nothing from the voice backend, so it stays on screen while the voices load or can't be listed.
  const reply = isVoiceTuningLanguage(language) ? <ReplySpeed speed={replySpeed} onChange={onReplySpeedChange} /> : null;
  if (catalog.isLoading || catalog.error) {
    return (
      <div className="space-y-3">
        {catalog.error ? <ErrorNote error={catalog.error} /> : <Spinner />}
        {reply}
      </div>
    );
  }

  const all = catalog.data?.voices ?? [];
  const preferred = agentDefaultVoice(language, all);
  // The language's default voice first (its cloned voice, else Roopa for Tamil), then the backend's order; a clone made
  // in another language last, so picking a gender never starts on it.
  const foreign = (v: VoiceOption) => voiceLanguageMismatch(v.source_language, language);
  // Sarvam Bulbul v4 Flash voices: their own group (Sarvam states no gender for them, so they're not in Female / Male
  // unless the backend tags one).
  const isV4 = (v: VoiceOption) => !!v.model?.startsWith("bulbul:v4");
  const v4Voices = all.filter(isV4);
  const ofGender = (g: VoiceGroup): VoiceOption[] =>
    g === "v4"
      ? v4Voices
      : all
          .filter((v) => v.gender === g)
          .sort((a, b) => Number(foreign(a)) - Number(foreign(b)) || Number(b.id === preferred) - Number(a.id === preferred));
  const current = all.find((v) => v.id === value);
  const gender: VoiceGroup =
    picked ?? (isGender(current?.gender) ? current.gender : current && isV4(current) ? "v4" : "female");
  const voices = ofGender(gender);
  const groups: VoiceGroup[] = v4Voices.length ? [...AI_AGENT_VOICE_GENDERS, "v4"] : [...AI_AGENT_VOICE_GENDERS];
  const showModels = new Set(all.map((v) => v.model).filter(Boolean)).size > 1;
  const where = `the ${AI_CALL_LANGUAGE_NAMES[language]} voice backend`;
  const missing = !!value && !current;
  const backendDefault = all.find((v) => v.id === catalog.data?.default_voice);

  function chooseGender(g: VoiceGroup) {
    setPicked(g);
    // Switching the gender picks that gender's first voice (unless the current voice already is one).
    const first = ofGender(g)[0];
    const inGroup = g === "v4" ? !!current && isV4(current) : current?.gender === g;
    if (first && !inGroup) onChange(first.id);
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Voice gender</label>
        <div role="radiogroup" aria-label="Voice gender" className="flex flex-wrap gap-2">
          {groups.map((g) => {
            const count = ofGender(g).length;
            return (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={gender === g}
                disabled={count === 0}
                onClick={() => chooseGender(g)}
                className={`rounded-lg border px-3 py-1.5 ${gender === g ? "border-accent bg-tint font-semibold" : "border-line"} disabled:opacity-50`}
              >
                {g === "v4" ? "Sarvam v4 Flash" : AI_AGENT_VOICE_GENDER_LABELS[g]}
                <span className="ml-1 text-xs font-normal text-slate-550">({count})</span>
              </button>
            );
          })}
        </div>
      </div>

      {voices.length === 0 ? (
        <p className="text-xs text-warn">
          {where[0]!.toUpperCase() + where.slice(1)} offers no {gender} voice. A voice is listed here only with a gender, as that backend's
          SARVAM_TTS_VOICES or Sarvam's documentation states it.
        </p>
      ) : (
        <VoicePicker
          voices={voices}
          defaultVoice={preferred && voices.some((v) => v.id === preferred) ? preferred : (catalog.data?.default_voice ?? voices[0]!.id)}
          value={value || null}
          onChange={onChange}
          language={language}
          pace={speed}
          listenOff={!!speedError}
          showModels={showModels}
          missingNote={
            missing
              ? `This agent's saved voice "${value}" is not offered by ${where} any more. Pick a voice: publishing and calls are refused until you do.`
              : current && !isGender(current.gender) && !isV4(current)
                ? `${current.name} has no gender in ${where}'s list. Pick a listed voice.`
                : undefined
          }
        />
      )}
      {gender === "v4" && (
        <p className="text-xs text-slate-550">
          Sarvam Bulbul v4 Flash voices: each is always spoken with the v4 Flash model, and a call falls back to a v3 voice if
          Sarvam refuses it. Sarvam states no gender for them, so listen before you pick. Every other voice stays on its own model.
        </p>
      )}
      {current && foreign(current) && (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn" role="alert">
          <strong>{current.name}</strong> was cloned from a sample in another language ({current.source_language}), so in a{" "}
          {AI_CALL_LANGUAGE_NAMES[language]} call it sounds like someone reading {AI_CALL_LANGUAGE_NAMES[language]} with an accent.
          Pick a voice made in {AI_CALL_LANGUAGE_NAMES[language]}, or a stock voice.
        </p>
      )}
      {current?.gender === "male" &&
        (femaleNameForMaleVoice(executiveName, current.gender) ? (
          // A known female name (the default Thaara, Sara, Nila): the customer would hear a man say a woman's name.
          <div className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn" role="alert">
            <p>
              <strong>{current.name}</strong> is a male voice, but the AI introduces itself as <strong>{executiveName.trim()}</strong>, a
              female name. Change “AI executive name” to a male name before you publish.
            </p>
            {onExecutiveNameChange && (
              <button
                type="button"
                className="btn-ghost mt-2 px-2.5 py-1 text-xs"
                onClick={() => onExecutiveNameChange(AI_AGENT_MALE_EXECUTIVE_NAME)}
              >
                Use “{AI_AGENT_MALE_EXECUTIVE_NAME}”
              </button>
            )}
          </div>
        ) : (
          <p className="text-xs text-warn" role="note">
            A male voice still introduces itself as <strong>{executiveName.trim() || "the AI executive name"}</strong>. If that is a
            female name, change “AI executive name” to a male name before publishing. The published prompt tells the AI its voice is
            male; Tamil first-person verbs such as பேசுறேன் and சொல்றேன் are the same for a man or a woman.
          </p>
        ))}
      <VoiceSpeed speed={speed} onChange={onSpeedChange} error={speedError} />
      {reply}
      {!value && (
        <p className="text-xs text-slate-550">
          No voice picked: calls use {where}'s default voice{backendDefault ? ` (${backendDefault.name})` : ""}, as before.
        </p>
      )}
      <p className="text-xs text-slate-550">
        One voice for the whole call: the greeting, every reply and the closing, with the same calm, polite, professional delivery. The voice
        doesn't change how the customer is addressed (that follows the contact's gender), and the AI still introduces itself as{" "}
        {executiveName.trim() || "the AI executive name"} — pick a name that suits the voice.
      </p>
    </div>
  );
}
