"""Check that candidate Sarvam Bulbul voices read Nila's English lines properly.

For every voice and line: synthesize with the real call settings (8 kHz mu-law,
CALL_LANGUAGE from .env) -> transcribe back with Sarvam (en-IN) -> compare
words with the expected text. Also checks speaking rate and silence. WAVs are
saved to samples/voice_check/<voice>/ so you can listen to any voice.

    .venv\\Scripts\\python -m scripts.voice_check            # all candidates
    .venv\\Scripts\\python -m scripts.voice_check priya ritu # only these
"""
from __future__ import annotations

import asyncio
import difflib
import re
import sys
from pathlib import Path

from app.core.config import settings
from app.core.voices import VOICE_IDS
from app.services import audio_service as audio
from app.services.sarvam_tts import SarvamTTS
from app.services.tts import TTSError, apply_pronunciations
from app.services.sarvam_stt import SarvamSTT

# The offered voices (name -> speaker id) - the same list calls use.
CANDIDATES = {v: v for v in VOICE_IDS}

LINES = [
    "Hi, is this Raagul?",
    "Thank you sir. This is Nila from Kagzso AI and Automation. Could you give me just one minute? "
    "I'll quickly tell you about our company. Is that okay?",
    "Kagzso AI and Automation helps businesses simplify their daily repetitive work using AI and automation.",
    "I believe your employees spend quite a lot of time on daily repetitive work, is that right?",
    "Sure sir, thank you. You can visit kagzso.com for more details. Thank you so much for your time. Have a nice day.",
    "No problem sir. Thanks for your time. Have a nice day.",
]

MIN_SCORE = 0.85        # per-line word match needed
MIN_WPS, MAX_WPS = 1.6, 4.2  # natural phone speaking rate (words / second)
OUT = Path(__file__).resolve().parent.parent / "samples" / "voice_check"

_NUM = {"one": "1", "a.i": "ai", "a i": "ai"}


def words(text: str) -> list[str]:
    t = text.lower().replace("’", "'")
    t = re.sub(r"\b(kexo|kekso|kexso|kagzso|kagso|kaxo|keksoe|kesso|kakso|kexo's)\b", "kexo", t)
    t = re.sub(r"\ba\.?\s?i\.?\b", "ai", t)
    t = re.sub(r"\bdot com\b|\.com\b", " dot com", t)
    t = re.sub(r"\braagul|ragul|rahul|raghul\b", "raagul", t)
    t = re.sub(r"[^a-z0-9' ]", " ", t)
    return [_NUM.get(w, w) for w in t.split()]


def score(expected: str, heard: str) -> float:
    return difflib.SequenceMatcher(None, words(expected), words(heard)).ratio()


async def check_line(tts: SarvamTTS, stt: SarvamSTT, name: str, i: int, line: str, sem: asyncio.Semaphore):
    async with sem:
        for attempt in range(6):
            try:
                mulaw = await tts.synthesize(line)
                break
            except TTSError as exc:
                if exc.kind != "rate_limit" and "rate limit" not in str(exc).lower() or attempt == 5:
                    raise
                await asyncio.sleep(2 * (attempt + 1))
        pcm = audio.mulaw_to_pcm16(mulaw)
        (OUT / name).mkdir(parents=True, exist_ok=True)
        (OUT / name / f"line{i + 1}.wav").write_bytes(audio.pcm16_to_wav(pcm, 8000))
        heard = (await stt.transcribe(audio.mulaw_to_stt_wav(mulaw)))["text"] or ""
        secs = audio.mulaw_duration_seconds(len(mulaw))
        spoken = apply_pronunciations(line, settings.CALL_LANGUAGE)
        wps = len(words(spoken)) / secs if secs else 0
        return i, score(spoken, heard), wps, secs, heard


async def check_voice(name: str, voice_id: str, stt: SarvamSTT, sem: asyncio.Semaphore) -> dict:
    tts = SarvamTTS(settings, voice_id=voice_id)
    try:
        results = await asyncio.gather(*(check_line(tts, stt, name, i, l, sem) for i, l in enumerate(LINES)))
    except Exception as exc:  # voice unusable (deleted, unsupported language, ...)
        return {"name": name, "id": voice_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        await tts.aclose()
    problems = []
    for i, sc, wps, secs, heard in sorted(results):
        if sc < MIN_SCORE:
            problems.append(f"line{i + 1} words {sc:.2f}: heard {heard!r}")
        elif not MIN_WPS <= wps <= MAX_WPS:
            problems.append(f"line{i + 1} rate {wps:.1f} w/s ({secs:.1f}s)")
    avg = sum(r[1] for r in results) / len(results)
    rate = sum(r[2] for r in results) / len(results)
    return {"name": name, "id": voice_id, "ok": not problems, "avg": avg, "rate": rate, "problems": problems}


async def main(selected: list[str]) -> None:
    voices = {n: v for n, v in CANDIDATES.items() if not selected or n in selected}
    stt = SarvamSTT(settings)
    sem = asyncio.Semaphore(1)  # keep well under the Sarvam rate limit
    try:
        reports = await asyncio.gather(*(check_voice(n, v, stt, sem) for n, v in voices.items()))
    finally:
        await stt.aclose()
    print(f"language={settings.CALL_LANGUAGE} model={settings.SARVAM_TTS_MODEL} stt={settings.sarvam_language_code}\n")
    for r in sorted(reports, key=lambda r: (not r["ok"], -r.get("avg", 0))):
        if "error" in r:
            print(f"FAIL {r['name']:<8} {r['error']}")
            continue
        print(f"{'PASS' if r['ok'] else 'FAIL'} {r['name']:<8} match {r['avg']:.2f}  rate {r['rate']:.1f} w/s  {r['id']}")
        for p in r["problems"]:
            print(f"       - {p}")
    passed = [r for r in reports if r.get("ok")]
    print("\nPASSING (for SARVAM_TTS_VOICE_ROTATION):")
    print(",".join(r["id"] for r in sorted(passed, key=lambda r: list(CANDIDATES).index(r["name"]))))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
