// Copyright (c) 2026 Kagzso Technology Services. All rights reserved.
// Proprietary and confidential. See LICENSE.md in the repository root.
// SPDX-License-Identifier: LicenseRef-Kagzso-Proprietary
import { useState } from "react";
import {
  AI_AGENT_DEFAULT_VOICE,
  AI_AGENT_VOICE_GENDER_LABELS,
  AI_AGENT_VOICE_GENDERS,
  AI_AGENT_VOICE_SPEED_LIMITS,
  AI_AGENT_VOICE_SPEEDS,
  AI_CALL_LANGUAGE_NAMES,
  isVoiceTuningLanguage,
  VOICE_TUNING_PRESET_HINTS,
  VOICE_TUNING_PRESET_LABELS,
  VOICE_TUNING_PRESETS,
  type AiAgentVoiceGender,
  type AiCallLanguage,
  type VoiceTuningPreset,
} from "@dispatch/shared";
import { useCallFlowCatalog, type VoiceOption } from "../lib/callFlows";
import { VoicePicker } from "./VoicePicker";
import { ErrorNote, Spinner } from "./ui";

const isGender = (g: string | undefined): g is AiAgentVoiceGender => g === "female" || g === "male";

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

/**
 * How soon the AI answers once the customer stops talking: a preset of Settings > Voice response tuning, or that setting
 * itself, the default. It is read when each call is dialled, so unlike the voice speed it needs no publish.
 */
function ReplySpeed({ speed, onChange }: { speed: VoiceTuningPreset | null; onChange: (speed: VoiceTuningPreset | null) => void }) {
  const choices = [
    { value: null, label: "Use Settings" },
    ...VOICE_TUNING_PRESETS.map((p) => ({ value: p, label: VOICE_TUNING_PRESET_LABELS[p] })),
  ];
  return (
    <div>
      <label className="label">Reply speed</label>
      <div role="radiogroup" aria-label="Reply speed" className="flex flex-wrap gap-2">
        {choices.map((c) => (
          <button
            key={c.label}
            type="button"
            role="radio"
            aria-checked={speed === c.value}
            onClick={() => onChange(c.value)}
            className={`rounded-lg border px-3 py-1.5 ${speed === c.value ? "border-accent bg-tint font-semibold" : "border-line"}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-slate-550">
        How soon the AI answers once the customer stops talking. {speed ? VOICE_TUNING_PRESET_HINTS[speed] : "This agent follows Settings > Voice response tuning."}{" "}
        Applies from the next call, with no publish needed.
      </p>
    </div>
  );
}

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
  replySpeed: VoiceTuningPreset | null;
  onReplySpeedChange: (speed: VoiceTuningPreset | null) => void;
  executiveName: string;
}) {
  const catalog = useCallFlowCatalog(language);
  const [picked, setPicked] = useState<AiAgentVoiceGender | null>(null);
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
  const preferred = AI_AGENT_DEFAULT_VOICE[language];
  // The language's default voice first (Roopa for Tamil), then the backend's order.
  const ofGender = (g: AiAgentVoiceGender): VoiceOption[] =>
    all.filter((v) => v.gender === g).sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  const current = all.find((v) => v.id === value);
  const gender: AiAgentVoiceGender = picked ?? (isGender(current?.gender) ? current.gender : "female");
  const voices = ofGender(gender);
  const where = `the ${AI_CALL_LANGUAGE_NAMES[language]} voice backend`;
  const missing = !!value && !current;
  const backendDefault = all.find((v) => v.id === catalog.data?.default_voice);

  function chooseGender(g: AiAgentVoiceGender) {
    setPicked(g);
    // Switching the gender picks that gender's first voice (unless the current voice already is one).
    const first = ofGender(g)[0];
    if (first && current?.gender !== g) onChange(first.id);
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Voice gender</label>
        <div role="radiogroup" aria-label="Voice gender" className="flex flex-wrap gap-2">
          {AI_AGENT_VOICE_GENDERS.map((g) => {
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
                {AI_AGENT_VOICE_GENDER_LABELS[g]}
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
          missingNote={
            missing
              ? `This agent's saved voice "${value}" is not offered by ${where} any more. Pick a voice: publishing and calls are refused until you do.`
              : current && !isGender(current.gender)
                ? `${current.name} has no gender in ${where}'s list. Pick a listed voice.`
                : undefined
          }
        />
      )}
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
