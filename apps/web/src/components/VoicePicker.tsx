import { useEffect, useRef, useState } from "react";
import { getAccessToken } from "../lib/api";
import { AI_CALL_VOICE_SAMPLES, DEFAULT_AI_CALL_LANGUAGE, type AiCallLanguage, type CallFlowPauses } from "@dispatch/shared";
import type { VoiceOption } from "../lib/callFlows";

/**
 * Voice choice for a call flow, with a Listen button per voice. Listening only
 * plays a sample (POST /api/voices/preview — text-to-speech, never a call); it
 * never changes the chosen voice. Picking a voice changes the form, which is
 * saved by the editor's own Save button. The sample is spoken by the flow
 * language's own voice backend, and starts as a line in that language.
 */

export const DEFAULT_SAMPLE = AI_CALL_VOICE_SAMPLES.en;

/** Previews already fetched this session: language + voice + text + pause lengths → object URL. */
const played = new Map<string, string>();

async function fetchPreview(voiceId: string, text: string, pauses: CallFlowPauses | undefined, language: AiCallLanguage): Promise<string> {
  const key = `${language}\u0000${voiceId}\u0000${text}\u0000${pauses ? `${pauses.short_ms}/${pauses.medium_ms}/${pauses.long_ms}` : ""}`;
  const hit = played.get(key);
  if (hit) return hit;
  const token = getAccessToken();
  const res = await fetch("/api/voices/preview", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    // {{short_delay}} etc. in the sample play as real silence of the flow's lengths.
    body: JSON.stringify({
      voice_id: voiceId,
      text,
      ...(pauses ? { pauses } : {}),
      ...(language !== DEFAULT_AI_CALL_LANGUAGE ? { language } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Couldn't play the preview (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  played.set(key, url);
  return url;
}

export function VoicePicker({
  voices,
  defaultVoice,
  value,
  onChange,
  pauses,
  language = DEFAULT_AI_CALL_LANGUAGE,
}: {
  voices: VoiceOption[];
  defaultVoice: string;
  /** The flow's voice_id (null = the default voice). */
  value: string | null | undefined;
  onChange: (voiceId: string) => void;
  /** The flow's pause lengths, for {{short_delay}} etc. in the sample line (absent = the defaults). */
  pauses?: CallFlowPauses;
  /** The flow's language: which voice backend speaks the sample, and the sample's starting line. */
  language?: AiCallLanguage;
}) {
  const defaultSample = AI_CALL_VOICE_SAMPLES[language];
  const [sample, setSample] = useState(defaultSample);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef(0);

  const known = !value || voices.some((v) => v.id === value);
  const selected = value && known ? value : defaultVoice;
  const defaultName = voices.find((v) => v.id === defaultVoice)?.name ?? defaultVoice;

  function stop() {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }
  useEffect(() => stop, []);

  async function listen(voiceId: string) {
    if (playing === voiceId) return stop();
    stop(); // only one preview at a time
    const text = sample.replace(/\s+/g, " ").trim() || defaultSample;
    const mine = ++request.current;
    setError(null);
    setLoading(voiceId);
    try {
      const url = await fetchPreview(voiceId, text, pauses, language);
      if (mine !== request.current) return; // another Listen was pressed meanwhile
      const el = new Audio(url);
      audio.current = el;
      el.onended = () => audio.current === el && setPlaying(null);
      setPlaying(voiceId);
      await el.play();
    } catch (err) {
      if (mine === request.current) {
        setPlaying(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mine === request.current) setLoading(null);
    }
  }

  return (
    <div>
      <ul role="radiogroup" aria-label="Voice" className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
        {voices.map((v) => {
          const on = v.id === selected;
          const meta = [v.language, v.gender].filter(Boolean).join(" · ") + (v.id === defaultVoice ? " · default" : "");
          return (
            <li
              key={v.id}
              className={`flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm transition-colors ${
                on ? "border-accent bg-tint ring-1 ring-accent" : "border-line hover:border-accent/50"
              }`}
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                <input type="radio" name="flow-voice" className="mt-0.5 shrink-0" checked={on} onChange={() => onChange(v.id)} />
                <span className="min-w-0">
                  <span className="block truncate font-medium" title={v.name}>{v.name}</span>
                  <span className="block truncate text-xs text-slate-550" title={meta}>
                    {[v.language, v.gender].filter(Boolean).join(" · ")}
                    {v.id === defaultVoice ? " · default" : ""}
                  </span>
                </span>
              </label>
              <button
                type="button"
                className="btn-ghost w-full whitespace-nowrap px-2.5 py-1 text-xs"
                aria-label={`${playing === v.id ? "Stop" : "Listen to"} ${v.name}`}
                disabled={loading !== null && loading !== v.id}
                onClick={() => void listen(v.id)}
              >
                {loading === v.id ? "Loading…" : playing === v.id ? "■ Stop" : "▶ Listen"}
              </button>
            </li>
          );
        })}
      </ul>
      {!known && <p className="mt-1.5 text-xs text-warn">Previous voice is no longer available, using {defaultName}.</p>}
      <label className="label mt-3">Sample line to listen to</label>
      <input className="input" maxLength={200} value={sample} onChange={(e) => setSample(e.target.value)} placeholder={defaultSample} />
      <span className="mt-1 block text-xs text-slate-550">{sample.length}/200 · only plays a sample — nothing is called or saved.</span>
      {error && <p className="mt-1 text-xs text-crit">{error}</p>}
    </div>
  );
}
