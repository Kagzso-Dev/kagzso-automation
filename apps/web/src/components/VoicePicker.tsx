import { useEffect, useRef, useState } from "react";
import { getAccessToken } from "../lib/api";
import type { VoiceOption } from "../lib/callFlows";

/**
 * Voice choice for a call flow, with a Listen button per voice. Listening only
 * plays a sample (POST /api/voices/preview — text-to-speech, never a call); it
 * never changes the chosen voice. Picking a voice changes the form, which is
 * saved by the editor's own Save button.
 */

export const DEFAULT_SAMPLE = "Hello, am I speaking with Ragul?";

/** Previews already fetched this session: voice + text → object URL. */
const played = new Map<string, string>();

async function fetchPreview(voiceId: string, text: string): Promise<string> {
  const key = `${voiceId}\u0000${text}`;
  const hit = played.get(key);
  if (hit) return hit;
  const token = getAccessToken();
  const res = await fetch("/api/voices/preview", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ voice_id: voiceId, text }),
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
}: {
  voices: VoiceOption[];
  defaultVoice: string;
  /** The flow's voice_id (null = the default voice). */
  value: string | null | undefined;
  onChange: (voiceId: string) => void;
}) {
  const [sample, setSample] = useState(DEFAULT_SAMPLE);
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
    const text = sample.replace(/\s+/g, " ").trim() || DEFAULT_SAMPLE;
    const mine = ++request.current;
    setError(null);
    setLoading(voiceId);
    try {
      const url = await fetchPreview(voiceId, text);
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
      <ul role="radiogroup" aria-label="Voice" className="space-y-1.5">
        {voices.map((v) => {
          const on = v.id === selected;
          return (
            <li
              key={v.id}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm ${on ? "border-accent bg-tint" : "border-line"}`}
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <input type="radio" name="flow-voice" checked={on} onChange={() => onChange(v.id)} />
                <span className="font-medium">{v.name}</span>
                <span className="truncate text-xs text-slate-550">
                  {[v.language, v.gender].filter(Boolean).join(" · ")}
                  {v.id === defaultVoice ? " · default" : ""}
                </span>
              </label>
              <button
                type="button"
                className="btn-ghost shrink-0 px-2.5 py-1 text-xs"
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
      <label className="label mt-2">Sample line to listen to</label>
      <input className="input" maxLength={200} value={sample} onChange={(e) => setSample(e.target.value)} placeholder={DEFAULT_SAMPLE} />
      <span className="text-xs text-slate-550">{sample.length}/200 · only plays a sample — nothing is called or saved.</span>
      {error && <p className="mt-1 text-xs text-crit">{error}</p>}
    </div>
  );
}
