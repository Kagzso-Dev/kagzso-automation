import { useEffect, useRef, useState } from "react";
import { apiResponse } from "../lib/api";
import { useToast } from "./toast";
import {
  AI_CALL_VOICE_SAMPLES,
  AI_CALL_VOICE_SAMPLES_MIXED,
  DEFAULT_AI_CALL_LANGUAGE,
  type AiCallLanguage,
  type CallFlowLanguageStyle,
  type CallFlowPauses,
} from "@dispatch/shared";
import type { VoiceOption } from "../lib/callFlows";

/**
 * Voice choice for a call flow, with a Listen button per voice. Listening only
 * plays a sample (POST /api/voices/preview — text-to-speech, never a call); it
 * never changes the chosen voice. Picking a voice changes the form, which is
 * saved by the editor's own Save button. The sample is spoken by the flow
 * language's own voice backend. It starts as the flow's own opening (what the
 * customer hears first), or a line in that language while the flow can't be previewed.
 */

export const DEFAULT_SAMPLE = AI_CALL_VOICE_SAMPLES.en;
export const SAMPLE_MAX = 200;

/** A line for the sample box: whitespace collapsed, at most 200 characters, cut after a sentence (or word) when longer. */
export function sampleLine(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= SAMPLE_MAX) return t;
  const head = t.slice(0, SAMPLE_MAX);
  const sentence = Math.max(...[".", "?", "!", "।"].map((p) => head.lastIndexOf(p)));
  if (sentence > 0) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(" ");
  return word > 0 ? head.slice(0, word) : head;
}

/** Previews already fetched this session: language + voice + text + pause lengths → object URL (the oldest is revoked past 20). */
const played = new Map<string, string>();
const PLAYED_MAX = 20;

/** A very short silent WAV: played inside the click so the browser (iOS Safari above all) lets the same player play the real sample after it has loaded. */
const SILENCE = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA";

async function fetchPreview(voiceId: string, text: string, pauses: CallFlowPauses | undefined, language: AiCallLanguage): Promise<string> {
  const key = `${language}\u0000${voiceId}\u0000${text}\u0000${pauses ? `${pauses.short_ms}/${pauses.medium_ms}/${pauses.long_ms}` : ""}`;
  const hit = played.get(key);
  if (hit) return hit;
  let res: Response;
  try {
    // Signed in like every other request: an expired access token is refreshed once (a long editing session).
    res = await apiResponse("/api/voices/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // {{short_delay}} etc. in the sample play as real silence of the flow's lengths.
      body: JSON.stringify({
        voice_id: voiceId,
        text,
        ...(pauses ? { pauses } : {}),
        ...(language !== DEFAULT_AI_CALL_LANGUAGE ? { language } : {}),
      }),
    });
  } catch {
    throw new Error("Couldn't reach the server — check the connection and try again");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 401) throw new Error("Your sign-in has expired — reload the page and sign in again");
    throw new Error(body?.error ?? `Couldn't play the preview (${res.status})`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("audio/")) throw new Error("The server sent no audio for this voice — try again");
  const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: type.split(";")[0] }));
  played.set(key, url);
  while (played.size > PLAYED_MAX) {
    const [oldest, old] = played.entries().next().value!;
    played.delete(oldest);
    URL.revokeObjectURL(old);
  }
  return url;
}

/** Why the browser didn't play the sample, in words (play() rejections are DOMExceptions). */
function playError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "The browser blocked the sound — tap Listen again (and check the phone isn't on silent)";
  if (name === "NotSupportedError") return "This browser can't play the sample audio";
  return err instanceof Error ? err.message : String(err);
}

export function VoicePicker({
  voices,
  defaultVoice,
  value,
  onChange,
  pauses,
  language = DEFAULT_AI_CALL_LANGUAGE,
  flowLine,
  languageStyle,
}: {
  voices: VoiceOption[];
  defaultVoice: string;
  /** The flow's voice_id (null = the default voice). */
  value: string | null | undefined;
  onChange: (voiceId: string) => void;
  /** The flow's pause lengths, for {{short_delay}} etc. in the sample line (absent = the defaults). */
  pauses?: CallFlowPauses;
  /** The flow's language: which voice backend speaks the sample, and the sample's line when there is no flowLine. */
  language?: AiCallLanguage;
  /** The flow's own opening as the customer hears it (from the Live preview); null while it can't be previewed. */
  flowLine?: string | null;
  /** The flow's language style (non-English): picks the fallback line when there is no flowLine. */
  languageStyle?: CallFlowLanguageStyle;
}) {
  const fallback = (languageStyle === "mixed" ? AI_CALL_VOICE_SAMPLES_MIXED[language] : undefined) ?? AI_CALL_VOICE_SAMPLES[language];
  const defaultSample = sampleLine(flowLine) ?? fallback;
  const [sample, setSample] = useState(defaultSample);
  // A new default (the flow's opening was edited): filled in only while the box is empty or still shows
  // the previous default. A line typed here is never replaced.
  const shownDefault = useRef(defaultSample);
  useEffect(() => {
    if (shownDefault.current === defaultSample) return;
    const previous = shownDefault.current;
    shownDefault.current = defaultSample;
    setSample((s) => (s.trim() === "" || s === previous ? defaultSample : s));
  }, [defaultSample]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One player for every Listen (only one sample plays at a time), unlocked inside the click.
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef(0);
  const toast = useToast();

  const known = !value || voices.some((v) => v.id === value);
  const selected = value && known ? value : defaultVoice;
  const defaultName = voices.find((v) => v.id === defaultVoice)?.name ?? defaultVoice;

  function stop() {
    request.current++; // a sample still loading doesn't start after Stop
    audio.current?.pause();
    setPlaying(null);
    setLoading(null);
  }
  useEffect(() => () => void audio.current?.pause(), []);

  async function listen(voiceId: string) {
    if (playing === voiceId || loading === voiceId) return stop();
    stop(); // only one preview at a time
    const text = sample.replace(/\s+/g, " ").trim() || defaultSample;
    const mine = request.current;
    // Browsers only let sound start from a click: start the player now (a moment of silence), then
    // the same player plays the sample once it has loaded, even after the network wait (iOS Safari).
    const el = (audio.current ??= new Audio());
    el.src = SILENCE;
    el.play()?.catch(() => {});
    setError(null);
    setLoading(voiceId);
    try {
      const url = await fetchPreview(voiceId, text, pauses, language);
      if (mine !== request.current) return; // Stop, or another Listen, was pressed meanwhile
      el.src = url;
      el.onended = () => mine === request.current && setPlaying(null);
      setLoading(null);
      setPlaying(voiceId);
      await el.play();
    } catch (err) {
      if (mine !== request.current) return;
      const message = playError(err);
      console.error("Voice preview failed", err);
      setPlaying(null);
      setLoading(null);
      setError(message);
      toast.error("Couldn't play the voice sample", [message]);
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
                aria-label={`${playing === v.id || loading === v.id ? "Stop" : "Listen to"} ${v.name}`}
                aria-busy={loading === v.id}
                onClick={() => void listen(v.id)}
              >
                {loading === v.id ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Loading…
                  </span>
                ) : playing === v.id ? (
                  "■ Playing… Stop"
                ) : (
                  "▶ Listen"
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {!known && <p className="mt-1.5 text-xs text-warn">Previous voice is no longer available, using {defaultName}.</p>}
      <label className="label mt-3">Sample line to listen to</label>
      <input
        className="input"
        maxLength={SAMPLE_MAX}
        aria-label="Sample line to listen to"
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        placeholder={defaultSample}
      />
      <span className="mt-1 block text-xs text-slate-550">
        {sample.length}/{SAMPLE_MAX} · {flowLine ? "starts as this flow's opening · " : ""}only plays a sample — nothing is called or saved.
      </span>
      {error && <p className="mt-1 text-xs text-crit">{error}</p>}
    </div>
  );
}
