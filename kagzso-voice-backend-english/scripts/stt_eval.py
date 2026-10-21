"""Compare Sarvam speech-to-text options on a set of short customer clips (no calls are placed).

    # 1. A synthetic set: Sarvam TTS voices saying the company questions and short answers, sent through
    #    8 kHz mu-law (like a phone line) at normal / quiet / very quiet level, plus a fast speaker.
    .venv/bin/python scripts/stt_eval.py make-synthetic eval_clips

    # 2. Your own clips: put mono WAV files (any rate; 8 kHz phone audio is fine) in a folder with a
    #    refs.json like {"clip1.wav": "what does kexo do", ...} holding what was really said.

    # 3. Compare the options (prints word error rate, key-term accuracy and STT time per option).
    .venv/bin/python scripts/stt_eval.py run eval_clips

Uses SARVAM_API_KEY from .env (never printed). Cost: about Rs 0.49 per minute of clips per option.
WER = (substitutions + deletions + insertions) / words in the reference, after lower-casing and
removing punctuation ("Kagzso" counts as "Kexo"). Key-term accuracy = of the references that
contain Kexo/Kagzso, UiPath, automation or WhatsApp, the share where the transcript has that term.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import re
import sys
import time
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
    t = re.sub(r"[^a-z0-9' ]+", " ", text.lower().replace("kagzso", "kexo").replace("kexo's", "kexo"))
    return t.split()


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


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("make-synthetic").add_argument("folder", type=Path)
    sub.add_parser("run").add_argument("folder", type=Path)
    args = ap.parse_args()
    asyncio.run(make_synthetic(args.folder) if args.cmd == "make-synthetic" else run(args.folder))


if __name__ == "__main__":
    main()
