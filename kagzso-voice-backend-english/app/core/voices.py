"""The voices Kagzso offers - the single list the API, the Call Flows editor (via
GET /api/flows/builtin) and every call use.

Sarvam Bulbul v3 speakers. By default Roopa, Ritu, Simran and Ishita, Roopa first (today's
English list; Bulbul speakers speak every language, so another language's backend offers them
too). SARVAM_TTS_VOICES replaces the list for this backend (one backend per language). Any other
voice id (an old flow, SARVAM_TTS_SPEAKER or SARVAM_TTS_VOICE_ROTATION naming a voice that is not
offered) plays as DEFAULT_VOICE. Nothing is removed from the Sarvam account; it just isn't offered here.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

from app.core.config import LANGUAGE_NAMES, settings

BUILTIN_VOICES: List[Dict[str, str]] = [
    {"id": "roopa", "name": "Roopa", "gender": "female"},
    {"id": "ritu", "name": "Ritu", "gender": "female"},
    {"id": "simran", "name": "Simran", "gender": "female"},
    {"id": "ishita", "name": "Ishita", "gender": "female"},
]
BUILTIN_DEFAULT = "roopa"

_VOICE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def offered_voices(voices_env: str, speaker: str, language: str) -> Tuple[List[Dict[str, str]], str]:
    """(voices, default voice) for a backend speaking `language`. `voices_env` is SARVAM_TTS_VOICES
    ("kavitha:female,mani:male"); empty or nothing usable = the built-in four with Roopa as default.
    With a list of its own, the default is SARVAM_TTS_SPEAKER when listed, else the first voice."""
    label = f"{LANGUAGE_NAMES.get(language, LANGUAGE_NAMES['en'])} (India)"
    voices: List[Dict[str, str]] = []
    for item in (voices_env or "").split(","):
        voice_id, _, gender = item.strip().partition(":")
        voice_id, gender = voice_id.strip().lower(), gender.strip().lower()
        if not _VOICE_ID_RE.match(voice_id) or any(v["id"] == voice_id for v in voices):
            continue
        voices.append({"id": voice_id, "name": voice_id.capitalize(),
                       **({"gender": gender} if gender in ("male", "female") else {}), "language": label})
    if not voices:
        return [{**v, "language": label} for v in BUILTIN_VOICES], BUILTIN_DEFAULT
    wanted = (speaker or "").strip().lower()
    return voices, wanted if any(v["id"] == wanted for v in voices) else voices[0]["id"]


VOICES, DEFAULT_VOICE = offered_voices(settings.SARVAM_TTS_VOICES, settings.SARVAM_TTS_SPEAKER, settings.call_language)

VOICE_IDS: Tuple[str, ...] = tuple(v["id"] for v in VOICES)


def offered_voice(voice_id: Optional[str]) -> Optional[str]:
    """The offered voice this id names (case-insensitive), else None."""
    v = (voice_id or "").strip().lower()
    return v if v in VOICE_IDS else None


def voice_or_default(voice_id: Optional[str]) -> str:
    """The voice a call actually uses for this id: itself when offered, else DEFAULT_VOICE."""
    return offered_voice(voice_id) or DEFAULT_VOICE
