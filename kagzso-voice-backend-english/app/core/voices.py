"""The voices Kagzso offers - the single list the API, the Call Flows editor (via
GET /api/flows/builtin) and every call use.

Sarvam Bulbul v3 speakers. By default Roopa, Ritu, Simran and Ishita, Roopa first (today's
English list; Bulbul speakers speak every language, so another language's backend offers them
too). SARVAM_TTS_VOICES replaces the list for this backend (one backend per language). Any other
voice id (an old flow, or SARVAM_TTS_SPEAKER naming a voice that is not offered) plays as DEFAULT_VOICE.
Nothing is removed from the Sarvam account; it just isn't offered here.

Bulbul v4 Flash personas (SARVAM_TTS_V4_VOICES, 2026-11-27) come after the stock voices. Each is spoken with
bulbul:v4-flash whatever SARVAM_TTS_MODEL says (voice_model: the model goes with the voice), and a failed request
falls back to a stock voice (provider_registry.with_clone_fallback). Every other voice keeps SARVAM_TTS_MODEL.

Cloned voices (SARVAM_TTS_VOICE_<LANG>_FEMALE / _MALE_1 / _MALE_2, "svc-<uuid>") come first, each with its gender.
The female one is DEFAULT_VOICE. The stock list is unchanged; a failed cloned voice falls back to a stock voice of
its gender (app/services/provider_registry.with_clone_fallback).

One voice per call, never picked at random or in turn: an AI agent's call speaks in the agent's saved voice, else
DEFAULT_VOICE (the language's default), chosen once when the call is placed (call_service.start_outbound_call).
"""
from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Tuple

from app.core.config import CLONED_VOICE_SLOTS, LANGUAGE_NAMES, Settings, cloned_voice_id, settings

log = logging.getLogger("voices")

BUILTIN_VOICES: List[Dict[str, str]] = [
    {"id": "roopa", "name": "Roopa", "gender": "female"},
    {"id": "ritu", "name": "Ritu", "gender": "female"},
    {"id": "simran", "name": "Simran", "gender": "female"},
    {"id": "ishita", "name": "Ishita", "gender": "female"},
]
BUILTIN_DEFAULT = "roopa"

# Genders Sarvam's own documentation states for Bulbul v3 speakers (checked 2026-11-04). Used only for a voice that
# SARVAM_TTS_VOICES lists WITHOUT ":male" / ":female"; a tag there always wins. Any other voice stays without a
# gender (never guessed from its name), so it can't be picked as a male / female AI Agent voice until it is tagged.
#   shubh (male), ishita (female): docs.sarvam.ai .../text-to-speech/voices ("shubh (male) and ishita (female)")
#   ratan, rohan (male), ritu (female): docs.sarvam.ai .../text-to-speech/bulbul-v3-best-practices,
#     "Speaker selection by language", Tamil row: Recommended male "ratan, rohan", Recommended female "ishita, ritu"
DOCUMENTED_GENDERS: Dict[str, str] = {
    "shubh": "male", "ratan": "male", "rohan": "male",
    "ishita": "female", "ritu": "female",
}

_VOICE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def offered_voices(voices_env: str, speaker: str, language: str) -> Tuple[List[Dict[str, str]], str]:
    """(voices, default voice) for a backend speaking `language`. `voices_env` is SARVAM_TTS_VOICES
    ("kavitha:female,mani:male"; an untagged id gets its DOCUMENTED_GENDERS gender, if any); empty or nothing
    usable = the built-in four with Roopa as default.
    With a list of its own, the default is SARVAM_TTS_SPEAKER when listed, else the first voice."""
    label = f"{LANGUAGE_NAMES.get(language, LANGUAGE_NAMES['en'])} (India)"
    voices: List[Dict[str, str]] = []
    for item in (voices_env or "").split(","):
        voice_id, _, gender = item.strip().partition(":")
        voice_id, gender = voice_id.strip().lower(), gender.strip().lower()
        gender = gender or DOCUMENTED_GENDERS.get(voice_id, "")
        if not _VOICE_ID_RE.match(voice_id) or any(v["id"] == voice_id for v in voices):
            continue
        voices.append({"id": voice_id, "name": voice_id.capitalize(),
                       **({"gender": gender} if gender in ("male", "female") else {}), "language": label})
    if not voices:
        return [{**v, "language": label} for v in BUILTIN_VOICES], BUILTIN_DEFAULT
    wanted = (speaker or "").strip().lower()
    return voices, wanted if any(v["id"] == wanted for v in voices) else voices[0]["id"]


V4_MODEL = "bulbul:v4-flash"
# The Bulbul v4 Flash personas Sarvam lists per language: (voice id, speaker, style). Source: docs.sarvam.ai
# api/api-guides-tutorials/text-to-speech/voices, "Tamil (ta-IN) (4 voices)" (checked 2026-11-27). The docs state no
# gender for them, and no female Tamil persona exists, so none is given a gender here.
V4_PERSONAS: Dict[str, Tuple[Tuple[str, str, str], ...]] = {
    "ta": (("aravind_ta_ads", "Aravind", "Ads"), ("aravind_ta_suspense", "Aravind", "Suspense"),
           ("gokul_ta_narration", "Gokul", "Narration"), ("vijay_ta_narration", "Vijay", "Narration")),
}
_V4_PERSONA_RE = re.compile(r"^[a-z]+(?:_[a-z0-9]+){1,3}$")  # name_language_style (as provider_registry._PERSONA_RE)


def v4_voice_entries(voices_env: str, language: str, taken: Tuple[str, ...] = ()) -> List[Dict[str, object]]:
    """The Bulbul v4 Flash voices a backend speaking `language` offers (SARVAM_TTS_V4_VOICES): "auto" = V4_PERSONAS of
    the language, ""/"off" = none, else "id[:gender],..." (a v3 name such as "ishita" is not a persona: ignored). An id
    already offered (`taken`) is skipped. A gender only from a tag, never guessed."""
    raw = (voices_env or "").strip()
    if raw.lower() in ("", "off", "none"):
        return []
    items = [p[0] for p in V4_PERSONAS.get(language, ())] if raw.lower() == "auto" else raw.split(",")
    known = {pid: (speaker, style) for personas in V4_PERSONAS.values() for pid, speaker, style in personas}
    label = f"{LANGUAGE_NAMES.get(language, LANGUAGE_NAMES['en'])} (India)"
    out: List[Dict[str, object]] = []
    for item in items:
        voice_id, _, gender = item.strip().partition(":")
        voice_id, gender = voice_id.strip().lower(), gender.strip().lower()
        if not voice_id:
            continue
        if not _V4_PERSONA_RE.match(voice_id):
            log.warning("SARVAM_TTS_V4_VOICES: %r is not a Bulbul v4 persona id (name_language_style) - ignored", voice_id)
            continue
        if voice_id in taken or any(v["id"] == voice_id for v in out):
            continue
        parts = voice_id.split("_")
        speaker, style = known.get(voice_id) or (parts[0].capitalize(), " ".join(parts[2:] or parts[1:]).capitalize())
        out.append({"id": voice_id, "name": f"{speaker} ({style})",
                    **({"gender": gender} if gender in ("male", "female") else {}),
                    "language": label, "model": V4_MODEL, "style": style.lower()})
    return out


def cloned_voice_entries(cfg: Settings) -> List[Dict[str, object]]:
    """This backend's cloned voices as voice-list entries ("cloned": True; the picker labels them "Custom"), female
    first, then male, named by SARVAM_TTS_VOICE_*_NAME. A setting that is set but holds no cloned voice id is reported
    and ignored."""
    for _, setting in CLONED_VOICE_SLOTS.get(cfg.call_language, ()):
        raw = getattr(cfg, setting)
        if (raw or "").strip() and cloned_voice_id(raw) is None:
            log.warning("%s is not a Sarvam cloned voice id (svc-...) - ignored", setting)
    label = f"{LANGUAGE_NAMES.get(cfg.call_language, LANGUAGE_NAMES['en'])} (India)"
    out: List[Dict[str, object]] = []
    for gender in ("female", "male"):
        clones = [(slot, v) for slot, v, g in cfg.cloned_voices if g == gender]
        out += [{"id": v, "name": cfg.cloned_voice_name(slot), "gender": gender, "language": label,
                 "cloned": True} for slot, v in clones]
    return out


def is_cloned_voice(voice_id: Optional[str]) -> bool:
    """A Sarvam Instant Voice Cloning id (svc-...): spoken through Sarvam's /voices/clone API, not Bulbul's speakers."""
    return (voice_id or "").startswith("svc-")


STOCK_VOICES, STOCK_DEFAULT_VOICE = offered_voices(settings.SARVAM_TTS_VOICES, settings.SARVAM_TTS_SPEAKER,
                                                   settings.call_language)
STOCK_VOICE_IDS: Tuple[str, ...] = tuple(v["id"] for v in STOCK_VOICES)
CLONED_VOICES = cloned_voice_entries(settings)
V4_VOICES = v4_voice_entries(settings.SARVAM_TTS_V4_VOICES, settings.call_language,
                             tuple(str(v["id"]) for v in CLONED_VOICES) + STOCK_VOICE_IDS)
V4_VOICE_IDS = frozenset(str(v["id"]) for v in V4_VOICES)
if V4_VOICES:  # the list mixes models: each stock voice says its own (a list without v4 voices is exactly as before)
    STOCK_VOICES = [{**v, "model": settings.SARVAM_TTS_MODEL} for v in STOCK_VOICES]

VOICES: List[Dict[str, object]] = CLONED_VOICES + STOCK_VOICES + V4_VOICES
# The language's default voice: the female cloned voice, else the first cloned voice, else the stock default
# (settings.tts_speaker, as one list). An AI agent with no saved voice speaks in it.
DEFAULT_VOICE: str = next((str(v["id"]) for v in CLONED_VOICES if v["gender"] == "female"),
                          next((str(v["id"]) for v in CLONED_VOICES), STOCK_DEFAULT_VOICE))

VOICE_IDS: Tuple[str, ...] = tuple(str(v["id"]) for v in VOICES)


def offered_voice(voice_id: Optional[str]) -> Optional[str]:
    """The offered voice this id names (case-insensitive), else None."""
    v = (voice_id or "").strip().lower()
    return v if v in VOICE_IDS else None


def voice_or_default(voice_id: Optional[str]) -> str:
    """The voice a call actually uses for this id: itself when offered, else DEFAULT_VOICE."""
    return offered_voice(voice_id) or DEFAULT_VOICE


def is_v4_voice(voice_id: Optional[str]) -> bool:
    """An offered Bulbul v4 Flash persona (SARVAM_TTS_V4_VOICES)."""
    return (voice_id or "").strip().lower() in V4_VOICE_IDS


def voice_model(voice_id: Optional[str], default_model: str) -> str:
    """The Bulbul model a stock voice is spoken with: bulbul:v4-flash for an offered v4 persona, else `default_model`
    (SARVAM_TTS_MODEL), so the right model and speaker always go together."""
    return V4_MODEL if is_v4_voice(voice_id) else default_model


def voice_gender(voice_id: Optional[str]) -> str:
    """The offered voice's gender ("male" / "female"), or "" when it has none."""
    v = (voice_id or "").strip().lower()
    return next((str(e.get("gender") or "") for e in VOICES if e["id"] == v), "")


def stock_voice_or_default(voice_id: Optional[str]) -> str:
    """A stock Bulbul voice: this one when offered, else the stock default (the cloned voice's fallback)."""
    v = (voice_id or "").strip().lower()
    return v if v in STOCK_VOICE_IDS else STOCK_DEFAULT_VOICE
