"""Compare Sarvam speech-to-text options on a set of short customer clips (no calls are placed).

    # 1. A synthetic set: Sarvam TTS voices saying the company questions and short answers, sent through
    #    8 kHz mu-law (like a phone line) at normal / quiet / very quiet level, plus a fast speaker.
    .venv/bin/python scripts/stt_eval.py make-synthetic eval_clips

    # 2. Your own clips: put mono WAV files (any rate; 8 kHz phone audio is fine) in a folder with a
    #    refs.json like {"clip1.wav": "what does kexo do", ...} holding what was really said.

    # 3. Compare the options (prints word error rate, key-term accuracy and STT time per option).
    .venv/bin/python scripts/stt_eval.py run eval_clips

    # Customer voice focus: phantom-turn and missed-answer rate per VOICE_FOCUS_LEVEL. Noise clips are
    # free; --tts adds short answers and lone fillers in CALL_LANGUAGE (KAGZSO_ENV_FILE=.env.ta for Tamil).
    # Your own clips work too: name them noise_*, filler_* (must make no turn) or answer_* (must make one).
    .venv/bin/python scripts/stt_eval.py make-focus-set focus_clips [--tts]
    .venv/bin/python scripts/stt_eval.py focus focus_clips [--stt]

Uses SARVAM_API_KEY from .env (never printed). Cost: about Rs 0.49 per minute of clips per option.
WER = (substitutions + deletions + insertions) / words in the reference, after lower-casing and
removing punctuation ("Kagzso" counts as "Kexo"). Key-term accuracy = of the references that
contain Kexo/Kagzso, UiPath, automation or WhatsApp, the share where the transcript has that term.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import itertools
import json
import sys
import time
import unicodedata
import wave
from pathlib import Path
from statistics import mean
from typing import Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import Settings  # noqa: E402
from app.services import audio_service as audio  # noqa: E402
from app.services.sarvam_stt import SarvamSTT, STTError  # noqa: E402

KEYTERMS = "Kexo,Kagzso,Kexo AI and Automation,UiPath,automation,WhatsApp,kagzso.com,Power Platform"
KEY_TERMS = {"kexo": ("kexo", "kagzso", "kexo's"), "uipath": ("uipath", "ui path"), "automation": ("automation", "automate"),
             "whatsapp": ("whatsapp", "whats app")}
PHRASES = [
    "Who are you?", "What does Kexo do?", "How much does it cost?", "What is your website?",
    "We already use software.", "Do you work with UiPath?", "Can you automate our WhatsApp messages?",
    "Tell me about Kexo AI and Automation.", "Yes.", "No.", "Okay.", "Not interested.",
]
LEVELS = {"normal": 1.0, "quiet": 10 ** (-14 / 20), "very_quiet": 10 ** (-22 / 20)}
OPTIONS: List[Tuple[str, Dict[str, object]]] = [
    ("today: saaras:v3", {"SARVAM_STT_MODEL": "saaras:v3", "STT_KEYTERMS": "", "STT_NORMALIZE_AUDIO": False}),
    ("v3 + normalised audio", {"SARVAM_STT_MODEL": "saaras:v3", "STT_KEYTERMS": "", "STT_NORMALIZE_AUDIO": True}),
    ("saaras:v4", {"SARVAM_STT_MODEL": "saaras:v4", "STT_KEYTERMS": "", "STT_NORMALIZE_AUDIO": False}),
    ("v4 + keyterms", {"SARVAM_STT_MODEL": "saaras:v4", "STT_KEYTERMS": KEYTERMS, "STT_NORMALIZE_AUDIO": False}),
    ("v4 + keyterms + normalised", {"SARVAM_STT_MODEL": "saaras:v4", "STT_KEYTERMS": KEYTERMS, "STT_NORMALIZE_AUDIO": True}),
]


def words(text: str) -> List[str]:
    t = text.lower().replace("kagzso", "kexo").replace("kexo's", "kexo")
    # Letters, digits, apostrophes and combining marks (Tamil / Hindi vowel signs stay in the word).
    return "".join(c if c == "'" or unicodedata.category(c)[0] in "LMN" else " " for c in t).split()


def wer(ref: str, hyp: str) -> Tuple[int, int]:
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return d[len(h)], len(r)


def key_terms(ref: str, hyp: str) -> Tuple[int, int]:
    r, h = " " + " ".join(words(ref)) + " ", " " + " ".join(words(hyp)) + " "
    expected = [k for k, forms in KEY_TERMS.items() if any(f" {f} " in r for f in forms)]
    found = [k for k in expected if any(f" {f} " in h for f in KEY_TERMS[k])]
    return len(found), len(expected)


def read_pcm8k(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        pcm, rate, ch = w.readframes(w.getnframes()), w.getframerate(), w.getnchannels()
    if ch == 2:  # a call recording: the customer is the left channel
        import numpy as np

        pcm = np.frombuffer(pcm, dtype="<i2")[0::2].tobytes()
    return audio.resample_pcm16(pcm, rate, audio.TELEPHONY_SAMPLE_RATE)


def write_pcm8k(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(audio.TELEPHONY_SAMPLE_RATE)
        w.writeframes(pcm)


async def make_synthetic(out: Path) -> None:
    from app.core.voices import VOICE_IDS
    from app.services.tts import create_tts_provider

    import numpy as np

    out.mkdir(parents=True, exist_ok=True)
    cfg = Settings()
    refs: Dict[str, str] = {}
    voices = list(VOICE_IDS)[:2]
    jobs = [(v, p, 1.0) for v in voices for p in PHRASES] + [(voices[0], p, 1.3) for p in PHRASES]  # + a fast speaker
    for n, (voice, phrase, pace) in enumerate(jobs):
        tts = create_tts_provider("sarvam", cfg, voice_id=voice)
        mulaw = await tts.synthesize(phrase, pace=pace) if pace != 1.0 else await tts.synthesize(phrase)
        await tts.aclose()
        pcm = np.frombuffer(audio.mulaw_to_pcm16(mulaw), dtype="<i2").astype(np.float32)
        levels = LEVELS if pace == 1.0 else {"normal": 1.0}
        for level, scale in levels.items():
            # Quieter on the line: scale, then mu-law encode again (the phone line's quantisation).
            line = audio.mulaw_to_pcm16(audio.pcm16_to_mulaw((pcm * scale).astype("<i2").tobytes()))
            name = f"{n:03d}_{voice}_{'fast' if pace != 1.0 else 'normal_speed'}_{level}.wav"
            write_pcm8k(out / name, line)
            refs[name] = phrase
    (out / "refs.json").write_text(json.dumps(refs, indent=1), encoding="utf-8")
    print(f"{len(refs)} clips written to {out} (refs.json holds what each one says)")


async def run(folder: Path) -> None:
    refs: Dict[str, str] = json.loads((folder / "refs.json").read_text(encoding="utf-8"))
    clips = [(name, read_pcm8k(folder / name), ref) for name, ref in refs.items() if (folder / name).is_file()]
    print(f"{len(clips)} clips\n")
    print("| Option | WER | WER normal | WER quiet | WER very quiet | Key terms | Short answers | Errors | Avg STT ms |")
    print("|---|---|---|---|---|---|---|---|---|")
    for label, overrides in OPTIONS:
        cfg = Settings(**overrides, STT_FALLBACK_MODEL="", STT_TIMING_LOG=False)
        stt = SarvamSTT(cfg)
        sem = asyncio.Semaphore(1)  # one request at a time: Sarvam rate-limits bursts
        errors_, words_, kt_found, kt_total, short_ok, short_total, times, failed = 0, 0, 0, 0, 0, 0, [], 0
        by_level: Dict[str, List[int]] = {"normal": [0, 0], "quiet": [0, 0], "very_quiet": [0, 0]}

        async def one(name: str, pcm: bytes, ref: str):
            if cfg.STT_NORMALIZE_AUDIO:
                pcm = audio.normalize_for_stt(pcm, cfg.STT_NORMALIZE_TARGET_RMS, cfg.STT_NORMALIZE_MAX_GAIN_DB)
            async with sem:
                for attempt in range(4):
                    t = time.monotonic()
                    try:
                        hyp = (await stt.transcribe(audio.telephony_pcm_to_stt_wav(pcm)))["text"]
                    except STTError as exc:
                        if exc.kind == "rate_limit" and attempt < 3:
                            await asyncio.sleep(2.0 * (attempt + 1))  # back off, then try the clip again
                            continue
                        return name, ref, None, exc.kind, 0.0
                    ms = (time.monotonic() - t) * 1000
                    await asyncio.sleep(0.3)  # spacing between requests (not counted in the STT time)
                    return name, ref, hyp, None, ms
                return name, ref, None, "rate_limit", 0.0

        for name, ref, hyp, err, ms in await asyncio.gather(*(one(*c) for c in clips)):
            if hyp is None:
                failed += 1
                hyp = ""
            else:
                times.append(ms)
            e, n = wer(ref, hyp)
            errors_, words_ = errors_ + e, words_ + n
            level = "very_quiet" if "very_quiet" in name else "quiet" if name.endswith("_quiet.wav") else "normal"
            by_level[level][0] += e
            by_level[level][1] += n
            f, k = key_terms(ref, hyp)
            kt_found, kt_total = kt_found + f, kt_total + k
            if len(words(ref)) <= 2:
                short_total += 1
                short_ok += words(ref) == words(hyp)
        await stt.aclose()
        lv = " | ".join(f"{100 * e / n:.1f}%" if n else "-" for e, n in by_level.values())
        print(f"| {label} | {100 * errors_ / max(1, words_):.1f}% | {lv} | {kt_found}/{kt_total} | {short_ok}/{short_total} | "
              f"{failed} | {mean(times):.0f} |" if times else f"| {label} | - | - | - | - | - | - | {failed} | - |")


# ------------------------------------------------------------------ customer voice focus (VOICE_FOCUS_LEVEL)
# Clip names say what a clip should do: noise_* and filler_* must make no turn, answer_* must make one.
FOCUS_ANSWERS = ["ஆமா", "சரி", "இல்ல", "ஆமா, சொல்லுங்க", "Yes", "Okay", "No"]
FOCUS_FILLERS = ["ம்", "ஆ", "ஹ்ம்"]
FOCUS_BACKGROUND = {"quietline": 30, "noisyroom": 200}  # RMS of the line's own noise around each clip


def _noise(ms: int, level: float, seed: int, smooth: int = 1):
    """Gaussian noise at RMS `level`; `smooth` > 1 makes it duller (breath, rumble)."""
    import numpy as np

    x = np.random.default_rng(seed).standard_normal(8 * ms)
    if smooth > 1:
        x = np.convolve(x, np.ones(smooth) / smooth, "same")
    return x / (float(np.sqrt(np.mean(x ** 2))) or 1.0) * level


def _with_background(sound, background: float, seed: int):
    """1.5 s of the line's own noise (so the floor is learned), the sound over it, then 1 s more."""
    import numpy as np

    lead, tail = _noise(1500, background, seed), _noise(1000, background, seed + 1)
    sound = sound[: len(sound) - len(sound) % 8]  # whole milliseconds
    mid = sound + _noise(len(sound) // 8, background, seed + 2)
    return np.clip(np.concatenate((lead, mid, tail)), -32768, 32767).astype("<i2").tobytes()


async def make_focus_set(out: Path, tts: bool) -> None:
    """Noise clips (free); with --tts also short answers and lone fillers in this backend's language
    (CALL_LANGUAGE) from Sarvam TTS, at normal / quiet / very quiet level on a quiet line and in a noisy room."""
    import numpy as np

    out.mkdir(parents=True, exist_ok=True)
    refs: Dict[str, str] = {}
    hann = lambda n: np.hanning(n)  # noqa: E731 - soft onset and decay
    noises = {
        "steady_hiss": lambda s: _noise(2000, 60, s),
        "steady_hum": lambda s: _noise(2000, 300, s, smooth=6),
        "breath_soft": lambda s: _noise(450, 150, s, smooth=4) * hann(8 * 450),
        "breath_loud": lambda s: _noise(500, 600, s, smooth=4) * hann(8 * 500),
        "cough": lambda s: _noise(250, 2500, s, smooth=2) * hann(8 * 250),
        "knock": lambda s: _noise(60, 6000, s) * np.exp(-np.arange(8 * 60) / 80),
    }
    for (kind, make), (bg, level) in itertools.product(noises.items(), FOCUS_BACKGROUND.items()):
        for seed in range(3):
            name = f"noise_{kind}_bg-{bg}_{seed}.wav"
            write_pcm8k(out / name, audio.mulaw_to_pcm16(audio.pcm16_to_mulaw(_with_background(make(seed * 7 + 1), level, seed))))
            refs[name] = ""
    if tts:
        from app.core.voices import VOICE_IDS
        from app.services.tts import create_tts_provider

        cfg = Settings()
        for voice in list(VOICE_IDS)[:2]:
            engine = create_tts_provider("sarvam", cfg, voice_id=voice)
            for kind, phrases in (("answer", FOCUS_ANSWERS), ("filler", FOCUS_FILLERS)):
                for n, phrase in enumerate(phrases):
                    speech = np.frombuffer(audio.mulaw_to_pcm16(await engine.synthesize(phrase)), dtype="<i2").astype(np.float64)
                    for (level, scale), (bg, noise) in itertools.product(LEVELS.items(), FOCUS_BACKGROUND.items()):
                        name = f"{kind}_{n:02d}_{voice}_lvl-{level.replace('_', '')}_bg-{bg}.wav"
                        pcm = _with_background(speech * scale, noise, n)
                        write_pcm8k(out / name, audio.mulaw_to_pcm16(audio.pcm16_to_mulaw(pcm)))
                        refs[name] = phrase
            await engine.aclose()
    (out / "refs.json").write_text(json.dumps(refs, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(refs)} clips written to {out}")


def _utterances(pcm: bytes, cfg: Settings) -> Tuple[List, float]:
    """The utterances a call would hear in this clip (same noise reduction, floor and detector as
    CallSession), with the average ms the endpointer spent per 20 ms frame."""
    from app.services.call_service import QUIET_VOICE_MIN_RMS
    from app.services.noise_suppression import InputCleaner

    cleaner = InputCleaner(cfg.NOISE_SUPPRESSION_STRENGTH) if cfg.NOISE_SUPPRESSION_ENABLED else None
    gate = audio.NoiseFloorGate(min(cfg.VAD_MIN_RMS, QUIET_VOICE_MIN_RMS) if cleaner else cfg.VAD_MIN_RMS,
                                cfg.VAD_FLOOR_MULTIPLIER, cfg.VAD_FLOOR_MAX_RMS)
    ep = audio.SpeechEndpointer(
        audio.make_webrtc_classifier(cfg.VAD_AGGRESSIVENESS, 0 if cleaner else cfg.VAD_MIN_RMS),
        start_ms=cfg.VAD_SPEECH_START_MS, end_silence_ms=cfg.VAD_SPEECH_END_SILENCE_MS,
        min_utterance_ms=min(cfg.VAD_MIN_UTTERANCE_MS, cfg.VAD_SPEECH_START_MS) if cleaner else cfg.VAD_MIN_UTTERANCE_MS,
        max_utterance_ms=cfg.MAX_UTTERANCE_SECONDS * 1000, noise_gate=gate, measure_pitch=True)
    found, spent, frames = [], 0.0, 0
    for chunk in audio.chunk_bytes(pcm + b"\x00\x00" * 8 * 1000, audio.PCM_FRAME_BYTES):
        raw = None
        if cleaner is not None:
            chunk, raw = cleaner.feed(chunk)
            gate.scale = 1.0 if cleaner.bypassed else max(cleaner.gain, 1e-3)
        t = time.perf_counter()
        events = ep.process(chunk, raw)
        spent, frames = spent + time.perf_counter() - t, frames + 1
        found += [e for e in events if e.event == audio.VadEvent.SPEECH_END and e.audio]
    return found, 1000 * spent / max(1, frames)


async def focus(folder: Path, with_stt: bool) -> None:
    from app.services import voice_focus as vf
    from app.services.call_service import is_noise_text

    cfg = Settings()
    refs: Dict[str, str] = json.loads((folder / "refs.json").read_text(encoding="utf-8"))
    clips = [(name, read_pcm8k(folder / name)) for name in refs if (folder / name).is_file()]
    stt = SarvamSTT(Settings(STT_FALLBACK_MODEL="", STT_TIMING_LOG=False)) if with_stt else None
    cache_file = folder / "stt_cache.json"  # transcripts already paid for: re-runs use them
    cache: Dict[str, str] = json.loads(cache_file.read_text(encoding="utf-8")) if cache_file.is_file() else {}
    rows, frame_ms, gate_us, failed = [], [], [], 0
    for name, pcm in clips:
        utts, ms = _utterances(pcm, cfg)
        frame_ms.append(ms)
        heard = []
        for i, u in enumerate(utts):
            a = vf.TurnAudio(u.duration_ms, u.voiced_ms, u.speech_rms, u.floor_rms, u.peak, u.max_gain, u.pitched_ms,
                             expects_short=True)  # right after the agent asked something: the lenient case
            key = f"{name}#{i}#{len(u.audio)}"
            text = cache.get(key) if stt else None
            for attempt in range(4 if stt and text is None else 0):
                try:
                    text = cache[key] = (await stt.transcribe(audio.telephony_pcm_to_stt_wav(u.audio)))["text"]
                    await asyncio.sleep(0.3)  # spacing between requests: Sarvam rate-limits bursts
                    break
                except STTError as exc:
                    if exc.kind != "rate_limit" or attempt == 3:
                        text = ""  # counted as "no words", like a failed request in a call (not cached)
                        failed += 1
                        break
                    await asyncio.sleep(2.0 * (attempt + 1))
            heard.append((a, text))
        rows.append((name, heard))
        print(f"{name}: " + ("; ".join(f"{vf.describe(a).split(', agent')[0]}{'' if t is None else f' -> {t!r}'}"
                                         for a, t in heard) or "no utterance"))
    if stt:
        cache_file.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    def turn(level: str, a, text) -> bool:
        if text is not None and (not text or is_noise_text(text)):
            return False  # today's STT checks
        if level == "off":
            return True
        t0 = time.perf_counter()
        ok = vf.check_audio(vf.LEVELS[level], a) is None and not (text is not None and vf.is_lone_filler(text))
        gate_us.append((time.perf_counter() - t0) * 1e6)
        return ok

    print(f"\n{len(clips)} clips{' (with STT)' if stt else ' (acoustic gates only: fillers are judged on audio alone)'}"
          f"{f', {failed} STT requests failed (re-run to retry them)' if failed else ''}\n")
    print("| Level | Phantom turns from noise | Fillers making a turn | Missed real answers | normal | quiet | very quiet | noisy room |")
    print("|---|---|---|---|---|---|---|---|")
    for level in ("off", "balanced", "strict"):
        made = {name: any(turn(level, a, t) for a, t in heard) for name, heard in rows}
        def rate(pred, want):
            names = [n for n in made if pred(n)]
            bad = sum(made[n] != want for n in names)
            return f"{bad}/{len(names)}" if names else "-"
        print(f"| {level} | {rate(lambda n: n.startswith('noise_'), False)} | {rate(lambda n: n.startswith('filler_'), False)} | "
              f"{rate(lambda n: n.startswith('answer_'), True)} | "
              + " | ".join(rate(lambda n, s=s: n.startswith("answer_") and s in n, True)
                           for s in ("lvl-normal", "lvl-quiet", "lvl-veryquiet", "bg-noisyroom"))
              + " |")
    print(f"\nEndpointer: {mean(frame_ms):.3f} ms per 20 ms frame (measurements included); "
          f"gate decision: {mean(gate_us) if gate_us else 0:.1f} us per utterance. Neither waits for anything.")
    if stt:
        await stt.aclose()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("make-synthetic").add_argument("folder", type=Path)
    sub.add_parser("run").add_argument("folder", type=Path)
    p = sub.add_parser("make-focus-set")
    p.add_argument("folder", type=Path)
    p.add_argument("--tts", action="store_true", help="also synthesise answers and fillers with Sarvam TTS (paid)")
    p = sub.add_parser("focus")
    p.add_argument("folder", type=Path)
    p.add_argument("--stt", action="store_true", help="also transcribe each utterance with Sarvam STT (paid)")
    args = ap.parse_args()
    if args.cmd == "make-synthetic":
        asyncio.run(make_synthetic(args.folder))
    elif args.cmd == "run":
        asyncio.run(run(args.folder))
    elif args.cmd == "make-focus-set":
        asyncio.run(make_focus_set(args.folder, args.tts))
    else:
        asyncio.run(focus(args.folder, args.stt))


if __name__ == "__main__":
    main()
