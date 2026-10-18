"""The voices Kagzso offers - the single list the API, the Call Flows editor (via
GET /api/flows/builtin) and every call use.

Sarvam Bulbul v3 speakers. Any other voice id (an old flow, SARVAM_TTS_SPEAKER or
SARVAM_TTS_VOICE_ROTATION naming a voice that is no longer offered) plays as
DEFAULT_VOICE. Nothing is removed from the Sarvam account; it just isn't offered here.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

DEFAULT_VOICE = "roopa"

VOICES: List[Dict[str, str]] = [
    {"id": "roopa", "name": "Roopa", "gender": "female", "language": "English (India)"},
    {"id": "ritu", "name": "Ritu", "gender": "female", "language": "English (India)"},
    {"id": "simran", "name": "Simran", "gender": "female", "language": "English (India)"},
    {"id": "ishita", "name": "Ishita", "gender": "female", "language": "English (India)"},
]

VOICE_IDS: Tuple[str, ...] = tuple(v["id"] for v in VOICES)


def offered_voice(voice_id: Optional[str]) -> Optional[str]:
    """The offered voice this id names (case-insensitive), else None."""
    v = (voice_id or "").strip().lower()
    return v if v in VOICE_IDS else None


def voice_or_default(voice_id: Optional[str]) -> str:
    """The voice a call actually uses for this id: itself when offered, else DEFAULT_VOICE."""
    return offered_voice(voice_id) or DEFAULT_VOICE
