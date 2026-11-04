// Copyright (c) 2026 Kagzso Technology Services. All rights reserved.
// Proprietary and confidential. See LICENSE.md in the repository root.
// SPDX-License-Identifier: LicenseRef-Kagzso-Proprietary
import { useState } from "react";
import {
  AI_AGENT_DEFAULT_VOICE,
  AI_AGENT_VOICE_GENDER_LABELS,
  AI_AGENT_VOICE_GENDERS,
  AI_CALL_LANGUAGE_NAMES,
  type AiAgentVoiceGender,
  type AiCallLanguage,
} from "@dispatch/shared";
import { useCallFlowCatalog, type VoiceOption } from "../lib/callFlows";
import { VoicePicker } from "./VoicePicker";
import { ErrorNote, Spinner } from "./ui";

const isGender = (g: string | undefined): g is AiAgentVoiceGender => g === "female" || g === "male";

/**
 * Settings → AI Voice (autonomous agents): the AI's own voice, from the voices the language's voice backend offers
 * with a gender (its list is the only one). Female / Male only filters the list; picking a voice changes the form,
 * saved with "Save settings". Listen plays a sample (text-to-speech only, never a call). Independent of the contact's
 * gender: the customer is addressed by the Contact section's gender whatever voice speaks.
 */
export function AiAgentVoice({
  language,
  value,
  onChange,
  executiveName,
}: {
  language: AiCallLanguage;
  /** The picked voice id ("" = none: the voice backend's default voice). */
  value: string;
  onChange: (voiceId: string) => void;
  executiveName: string;
}) {
  const catalog = useCallFlowCatalog(language);
  const [picked, setPicked] = useState<AiAgentVoiceGender | null>(null);
  if (catalog.isLoading) return <Spinner />;
  if (catalog.error) return <ErrorNote error={catalog.error} />;

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
          missingNote={
            missing
              ? `This agent's saved voice "${value}" is not offered by ${where} any more. Pick a voice: publishing and calls are refused until you do.`
              : current && !isGender(current.gender)
                ? `${current.name} has no gender in ${where}'s list. Pick a listed voice.`
                : undefined
          }
        />
      )}
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
