"""Customer voice focus: which customer utterances count as a turn (VOICE_FOCUS_LEVEL).

Breath, line noise, a lone "ம்" / "uh", speech heard while the agent talks and the agent's own
echo must never become a turn; a short, quiet but real "ஆமா" / "Yes" must. Every gate is decided
on numbers the endpointer already has (voiced time, speech level against the learned noise floor)
or on the transcript text, so no gate adds delay to a reply.

    off       today's behaviour, nothing measured
    balanced  moderate thresholds, soft voices still heard (default)
    strict    higher thresholds for noisy places; quiet speakers are missed more often and the
              agent asks them to speak up more often

VOICE_FOCUS_MODE=log measures every turn and logs what would be dropped, but drops nothing;
enforce applies the gates.
"""
from __future__ import annotations

import math
import unicodedata
from dataclasses import dataclass, replace
from typing import List, Optional

from app.core.config import Settings


@dataclass(frozen=True)
class FocusThresholds:
    min_voiced_ms: int  # gate 1: real speech
    min_snr_db: float
    short_voiced_ms: int  # gate 3: a short answer right after the agent asked something
    short_snr_db: float
    barge_voiced_ms: int  # gate 5: speech while the agent is talking
    barge_snr_db: float
    agent_end_guard_ms: int  # gate 6: speech starting this soon after the agent stopped
    min_pitched_ms: int  # gate 1: speech with a voice's pitch (breath, coughs and clatter have none)


# Measured on Tamil TTS answers and synthetic noise through the call's own audio path
# (scripts/stt_eval.py focus): every answer had 120 ms or more of pitched speech, noise had none.
LEVELS = {
    "balanced": FocusThresholds(280, 6.0, 200, 4.0, 400, 10.0, 150, 60),
    "strict": FocusThresholds(360, 10.0, 240, 6.0, 600, 14.0, 300, 100),
}

_OVERRIDES = {
    "min_voiced_ms": "VOICE_FOCUS_MIN_VOICED_MS",
    "min_snr_db": "VOICE_FOCUS_MIN_SNR_DB",
    "short_voiced_ms": "VOICE_FOCUS_SHORT_VOICED_MS",
    "short_snr_db": "VOICE_FOCUS_SHORT_SNR_DB",
    "barge_voiced_ms": "VOICE_FOCUS_BARGE_VOICED_MS",
    "barge_snr_db": "VOICE_FOCUS_BARGE_SNR_DB",
    "agent_end_guard_ms": "VOICE_FOCUS_AGENT_END_GUARD_MS",
    "min_pitched_ms": "VOICE_FOCUS_MIN_PITCHED_MS",
}


def thresholds_for(cfg: Settings) -> Optional[FocusThresholds]:
    """The active level's thresholds with any VOICE_FOCUS_<NAME> override; None when off."""
    base = LEVELS.get(cfg.VOICE_FOCUS_LEVEL)
    if base is None:
        return None
    changes = {field: getattr(cfg, key) for field, key in _OVERRIDES.items() if getattr(cfg, key) is not None}
    return replace(base, **changes) if changes else base


# ------------------------------------------------------------------ text
def words(text: str) -> List[str]:
    """Lower-cased words, split on spaces, punctuation and symbols only. Unlike a letters-and-digits
    split, Indic vowel signs and the virama stay inside the word: "சரிங்க" is one word, not three."""
    out = []
    for c in text.lower():
        cat = unicodedata.category(c)
        out.append(" " if c.isspace() or cat[0] in "PSZC" else c)
    return "".join(out).split()


# Sounds that are never an answer on their own. Real short answers ("ஆமா", "சரி", "yes", "okay",
# "no", "இல்ல", "हाँ", "haan") are NOT here.
LONE_FILLERS = frozenset({
    # English (and romanised)
    "uh", "uhh", "um", "umm", "hmm", "hm", "hmmm", "mm", "mmm", "mhm", "mmhmm", "huh", "ah", "ahh", "aah",
    "aa", "er", "erm", "eh", "oh", "ooh", "oo",
    # Tamil
    "ம்", "ம்ம்", "ம்ம்ம்", "ம", "ஹ்ம்", "ஹ்ம்ம்", "ஹம்", "ஹம்ம்", "ஹூம்", "உம்", "உம்ம்", "ஆ", "ஆஆ", "அ", "ஊ", "உ",
    "ஏ", "ஓ",  # Sarvam writes a hum as ம் / உம் / ஹம்
    # Hindi (not "हम" - that is "we")
    "हम्म", "हम्म्म", "ह्म्म", "हं", "म्म", "अ", "आ", "उ", "ऊ", "उम्म", "ओ",
    # Telugu
    "మ్", "మ్మ్", "హ్మ్", "అ", "ఆ", "ఉ", "ఊ", "ఓ",
    # Kannada
    "ಮ್", "ಮ್ಮ್", "ಹ್ಮ್", "ಹ್ಮ್ಮ್", "ಅ", "ಆ", "ಉ", "ಊ", "ಓ",
})


# What the LLM receives, once, for a lone filler sound after the agent asked something.
FILLER_NOTE = "[only a short sound, not an answer: {text}]"


def is_lone_filler(text: str) -> bool:
    """Only filler sounds ("ம்", "ம் ம்", "uh", "mm-hmm"), nothing a customer answers with."""
    w = words(text.replace("-", ""))
    return 0 < len(w) <= 3 and all(x in LONE_FILLERS for x in w)


# ------------------------------------------------------------------ audio
@dataclass
class TurnAudio:
    """What the endpointer measured for one utterance (levels are 16-bit PCM RMS, gain divided out)."""
    duration_ms: int
    voiced_ms: int
    speech_rms: int
    floor_rms: Optional[int]  # None: no noise floor learned (adaptive floor off)
    peak: int
    max_gain: float
    pitched_ms: Optional[int] = None  # None: not measured
    agent_speaking: bool = False  # started while the agent was talking (barge-in path)
    after_agent_ms: Optional[int] = None  # started this long after the agent's audio ended
    expects_short: bool = False  # the agent's last line asked something (or nothing said yet)
    answering_question: bool = False  # said over a question that is still playing (identity question)

    @property
    def snr_db(self) -> Optional[float]:
        if self.floor_rms is None:
            return None
        return round(20 * math.log10(max(self.speech_rms, 1) / max(self.floor_rms, 1)), 1)


def check_audio(t: FocusThresholds, a: TurnAudio) -> Optional[str]:
    """The reason this utterance is not real customer speech, or None (it counts)."""
    if a.agent_speaking and not a.answering_question:
        voiced, snr, reason = t.barge_voiced_ms, t.barge_snr_db, "agent_speaking"
    else:
        short = a.expects_short or a.answering_question
        voiced = t.short_voiced_ms if short else t.min_voiced_ms
        snr, reason = (t.short_snr_db if short else t.min_snr_db), None
        if a.after_agent_ms is not None and a.after_agent_ms < t.agent_end_guard_ms:
            # Right after the agent stopped, its echo tail can still arrive: a real answer that
            # starts here counts when it is clearly above the floor (it is never cut off).
            snr, reason = max(snr, t.barge_snr_db), "agent_echo_window"
    if a.voiced_ms < voiced:
        return reason or "too_short"
    if a.snr_db is not None and a.snr_db < snr:
        return reason or "too_quiet"
    if a.pitched_ms is not None and a.pitched_ms < t.min_pitched_ms:
        return "no_voice_pitch"  # breath, a cough, clatter: loud enough, but not a voice
    return None


def asks_question(line: str) -> bool:
    """The agent's line ends by asking something (its last sentence ends with "?")."""
    return line.strip().rstrip(".… ").endswith("?")  # an interrupted line ends "... ?..."


def describe(a: TurnAudio) -> str:
    snr = "n/a" if a.snr_db is None else f"{a.snr_db:.1f} dB"
    pitched = "" if a.pitched_ms is None else f", pitched {a.pitched_ms} ms"
    return (f"{a.duration_ms} ms, voiced {a.voiced_ms} ms{pitched}, speech {a.speech_rms} rms, floor "
            f"{'n/a' if a.floor_rms is None else a.floor_rms} rms, SNR {snr}, peak {a.peak}, gain {a.max_gain:.1f}x, "
            f"agent speaking {'yes' if a.agent_speaking else 'no'}, "
            f"after agent {'n/a' if a.after_agent_ms is None else str(a.after_agent_ms) + ' ms'}, "
            f"short answer expected {'yes' if a.expects_short else 'no'}")
