"""Call orchestration + real-time conversation engine.

Pipeline per customer turn (all async, nothing blocks the WebSocket loop):

    Plivo media (mu-law 8k) -> VAD endpointer -> [utterance]
        -> Sarvam STT -> LLM (streamed) -> sentence chunker
        -> Sarvam TTS (streamed, mu-law 8k) -> Plivo playAudio

Barge-in: when the VAD detects customer speech while the agent is generating
or playing audio, the in-flight turn is cancelled (LLM + TTS), Plivo's queued
audio is cleared with `clearAudio`, and the new utterance is processed.

Latency markers (per turn):
    T0 customer stopped speaking   T1 end of speech detected (after the VAD silence)
    T2 STT completed   T3 LLM started   T4 LLM completed   T5 TTS started   T6 first TTS audio
"""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Protocol, Set, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, settings as default_settings
from app.core.logging import call_context, get_logger
from app.core.voices import offered_voice
from app.db import repositories as repo
from app.db.database import session_factory
from app.db.models import FINAL_CALL_STATUSES, LOCKED_OUTCOMES, Call, CallOutcome, CallStatus, utcnow
from app.flows.loader import FlowError, resolve_flow_agent
from app.schemas.calls import OutboundCallRequest
from app.services import audio_service as audio
from app.services import status_callback
from app.services import recording
from app.services.noise_suppression import InputCleaner
from app.services.public_url import check_public_url
from app.services.sarvam_tts import SarvamTTS
from app.services.tts import TTSError, TTSProvider, create_tts_provider
from app.services.llm_service import (
    OUTCOME_SYSTEM,
    LLMError,
    LLMProvider,
    SentenceChunker,
    build_call_variables,
    clean_spoken_text,
    has_pause_markers,
    pauses_from_variables,
    split_pauses,
    create_llm_provider,
    extract_end_call,
    parse_outcome,
    parse_reached,
    render_first_message,
    safe_variables,
)
from app.services.plivo_service import PlivoError, PlivoService, get_plivo_service
from app.services.twilio_service import TwilioService, get_twilio_service
from app.services.sarvam_stt import SarvamSTT, STTError, STTProvider, STTStream, create_stt_provider
from app.services.session_store import SessionStore, get_session_store

log = get_logger("voice.pipeline")

# Noise reduction: lowest speech level while listening (about -55 dBFS, measured before the
# auto-gain; the adaptive floor raises it on noisy lines), and how often the per-chunk timing is
# logged (every 5 s).
QUIET_VOICE_MIN_RMS = 60
NOISE_LOG_EVERY_FRAMES = 250

GREETING_INSTRUCTION = (
    "(The customer has picked up the phone but has not said anything yet. "
    "Greet them warmly, introduce yourself in one sentence, and ask if now is a good time.)"
)
FALLBACK_REPLIES = {
    "en": "Sorry, I couldn't hear you clearly. Could you please repeat that?",
    "ta": "Sorry, clear-ஆ கேக்கல. கொஞ்சம் repeat பண்ணுங்க please.",
    "hi": "Sorry, आपकी आवाज़ clear नहीं आई। Please एक बार फिर से बोलिए।",
    "kn": "Sorry, ನಿಮ್ಮ ಮಾತು clear ಆಗಿ ಕೇಳಿಸ್ಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಇನ್ನೊಮ್ಮೆ ಹೇಳ್ತೀರಾ?",
}
# Silence handling (script "SILENCE"): one re-prompt, then a polite close. A call flow's own
# silence lines replace these; they are only used by calls without a flow.
SILENCE_REPROMPTS = {
    "en": "Hello, can you hear me?",
    "ta": "Hello, கேக்குதா? Hear பண்றீங்களா?",
    "hi": "Hello, क्या आपको मेरी आवाज़ आ रही है?",
    "kn": "Hello, ನನ್ನ ಮಾತು ಕೇಳಿಸ್ತಿದೆಯಾ?",
}
SILENCE_CLOSINGS = {
    "en": "No problem. Thank you for your time. Have a nice day.",
    "ta": "No problem. Thank you for your time. Have a nice day.",
    "hi": "कोई बात नहीं। आपके समय के लिए धन्यवाद। Have a nice day.",
    "kn": "ಪರವಾಗಿಲ್ಲ. ನಿಮ್ಮ ಸಮಯಕ್ಕೆ ಧನ್ಯವಾದಗಳು. Have a nice day.",
}


_VOICE_ROTATION_LOCK = asyncio.Lock()

# Short line checks / backchannels ("Hello?", "Yes", "Hmm", "Can you hear me?") said while the agent
# is talking or preparing a reply: the agent's reply already answers them, so they never interrupt.
_FILLER_WORDS = {
    "hello", "helo", "hallo", "hi", "hey", "yes", "yeah", "ya", "yep", "yup", "ok", "okay", "ha", "haan", "han",
    "hmm", "hm", "mm", "mhm", "uh", "um", "ah", "oh", "sir", "madam", "can", "you", "hear", "me", "are", "there",
}


def is_filler(text: str) -> bool:
    words = [w for w in "".join(c if c.isalnum() or c.isspace() else " " for c in text.lower()).split()]
    return 0 < len(words) <= 7 and all(w in _FILLER_WORDS for w in words)


# A bare "Hello?" in answer to "Hi, is this <name>?" is not a yes - the customer is
# just checking the line. The identity question is asked once more before moving on.
_GREETING_ONLY_WORDS = {"hello", "helo", "hallo", "halo", "hi", "hey", "hmm", "hm"}
IDENTITY_REASK = "Sorry, am I speaking with {name}?"
# Openings like "Hi {{title_to_use}}, {{time_greeting}}." don't ask for the customer: the system
# asks this GREETING_WAIT_SECONDS after the opening, or at once when the customer says anything
# (then IDENTITY_REASK at most once).
IDENTITY_QUESTION = "Am I speaking with {name}, {title}?"

# Said to the opening, these still go to the script instead of the identity question:
# do-not-call (always highest priority) and "are you a bot / a real person?" (honest AI answer).
_DO_NOT_CALL_RE = re.compile(
    r"\b(stop|quit)\s+(calling|ringing|call(ing)?\s+me)"
    r"|\b(don'?t|do\s+not|never|no\s+more)\s+(call|calls|calling|contact|phone|ring)"
    r"|\bremove\s+(my|this)\s+(number|name|contact)"
    r"|\b(take|delete)\s+(me|my\s+number)\s+off|\bunsubscribe\b|\bdo\s+not\s+disturb\b"
    r"|\b(call|phone)\s+(panna(dh|th)?ee?nga|pannadhinga|panna\s+vendam|pannatheenga)"
    r"|\b(call|phone)\s+mat\s+(karo|karna|kariye|kijiye)",
    re.IGNORECASE,
)
_AI_QUESTION_RE = re.compile(
    r"\b(bot|robot|robo|a\.?i\.?|artificial|machine|computer|recording|recorded|automated|human"
    r"|real\s+person|actual\s+person)\b",
    re.IGNORECASE,
)


def identity_silence_action(now: float, last_activity: float, playback_until: float, wait: float,
                            repeats: int, reprompts: int) -> Optional[str]:
    """Silence after the identity question, counted from the end of the agent's audio
    (max of the last activity / playback ack and the estimated playback end):
    "repeat" the question once, then "reprompt" (the silence line) once, else None
    (keep waiting, or hand over to the normal silence flow)."""
    if now - max(last_activity, playback_until) < wait:
        return None
    if repeats == 0:
        return "repeat"
    if reprompts == 0:
        return "reprompt"
    return None


def greeting_delay_of(variables: Mapping[str, Any]) -> Optional[float]:
    """The call's "AI Greeting Delay" in seconds (0-10), or None = the configured timing."""
    raw = variables.get("greeting_delay_sec")
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0 <= value <= 10 else None


def first_speech_greeting_due(now: float, started: float, wait: float, hold_max: float,
                              in_speech: bool, transcribing: bool) -> Optional[str]:
    """When the first-speech wait (started = stream start) should give way to the greeting:
    None (keep waiting), "silence" (the wait ended quietly) or "hold_limit" (the customer is
    still talking FIRST_SPEECH_HOLD_MAX_SECONDS after the wait - greet anyway). While their
    words are being transcribed, that turn plays the greeting instead."""
    if now < started + wait or transcribing:
        return None
    if in_speech:
        return "hold_limit" if now >= started + wait + hold_max else None
    return "silence"


# What an answering machine / carrier announcement says (English + common Hindi / Tamil wording).
_VOICEMAIL_RE = re.compile(
    r"leave (a |your )?(message|msg)|after the (tone|beep)|at the (tone|beep)|voice ?mail|mail ?box"
    r"|not available|unavailable|can(no|')?t take your call|record your message|is busy right now"
    r"|switched off|not reachable|out of (coverage|service)|number you have (dialled|dialed|called)"
    r"|the subscriber|please try (again )?later|vyast hai|uplabdh nahi|band hai|thodi der baad"
    r"|தொடர்பு கொள்ள முடியாது|அணைக்கப்பட்டுள்ளது",
    re.IGNORECASE,
)
MACHINE_LONG_WORDS = 12  # one utterance this long right after answering is a recorded greeting
MACHINE_LONG_SPEECH_MS = 6000  # or this long without a pause


def machine_evidence(texts: List[str], speaking_ms: int = 0) -> Optional[str]:
    """What the customer audio says about Plivo's "machine" verdict: "machine", "human" or None."""
    if any(_VOICEMAIL_RE.search(t) for t in texts):
        return "machine"
    if any(len(_words(t)) > MACHINE_LONG_WORDS for t in texts) or speaking_ms > MACHINE_LONG_SPEECH_MS:
        return "machine"
    return "human" if any(_words(t) for t in texts) else None


def needs_script_at_opening(text: str) -> bool:
    """A reply to the opening that the script must answer itself: do-not-call or an AI question."""
    text = text.replace("\u2019", "'")
    return bool(_DO_NOT_CALL_RE.search(text) or _AI_QUESTION_RE.search(text))


def is_greeting_only(text: str) -> bool:
    words = "".join(c if c.isalnum() or c.isspace() else " " for c in text.lower()).split()
    return 0 < len(words) <= 3 and all(w in _GREETING_ONLY_WORDS for w in words)


def _words(text: str) -> List[str]:
    return "".join(c if c.isalnum() or c.isspace() else " " for c in text.lower()).split()


# Sounds STT writes for breathing / line noise. "hmm", "mm", "yes", "okay" etc. are NOT here:
# they can be the customer's answer.
_NOISE_ONLY_WORDS = {"uh", "uhh", "um", "umm", "er", "erm", "ah", "eh"}


def is_noise_text(text: str) -> bool:
    """Only punctuation or non-word sounds - nothing a customer would answer with."""
    return all(w in _NOISE_ONLY_WORDS for w in _words(text))


ECHO_MIN_WORDS = 3


def is_echo(text: str, agent_text: str) -> bool:
    """The transcript is the agent's own line coming back: 3+ words, every one taken in order
    from `agent_text` and close together. A reply with any word of its own ("yes", "no",
    a name) is never echo, and neither is anything shorter than 3 words."""
    words, ref = _words(text), _words(agent_text)
    if len(words) < ECHO_MIN_WORDS or not ref:
        return False
    max_span = 2 * len(words) + 2
    for start, first in enumerate(ref):
        if first != words[0]:
            continue
        j, i = 1, start + 1
        while j < len(words) and i < len(ref) and i - start < max_span:
            if ref[i] == words[j]:
                j += 1
            i += 1
        if j == len(words):
            return True
    return False


def _lang(language: Optional[str]) -> str:
    return (language or default_settings.CALL_LANGUAGE or "en").split("-")[0].lower()


def fallback_reply(language: Optional[str] = None) -> str:
    return FALLBACK_REPLIES.get(_lang(language), FALLBACK_REPLIES["en"])


def silence_reprompt(language: Optional[str] = None) -> str:
    return SILENCE_REPROMPTS.get(_lang(language), SILENCE_REPROMPTS["en"])


def silence_closing(language: Optional[str] = None) -> str:
    return SILENCE_CLOSINGS.get(_lang(language), SILENCE_CLOSINGS["en"])


_NAME_ALIAS_RE = re.compile(r"\{\{\s*name\s*\}\}")


_TIME_GREETING_RE = re.compile(r"\{\{\s*time_greeting\s*\}\}")


# Spoken instead of a greeting that names the customer when the customer has no name.
NO_NAME_GREETING = "Hello, good day."


def greets_by_name(first_message: str) -> bool:
    """The opening line itself speaks the customer's name ({{customer_name}} / {{name}})."""
    return "customer_name" in first_message or bool(_NAME_ALIAS_RE.search(first_message))


def opening_line(first_message: str, variables: Mapping[str, Any]) -> str:
    """The greeting as spoken: rendered as before, or NO_NAME_GREETING when it names the customer
    and the customer has no name (never "Hello , ..." or a blank)."""
    if greets_by_name(first_message) and not safe_variables(variables)["customer_name"]:
        return NO_NAME_GREETING
    return render_first_message(first_message, variables)


def identity_lines(variables: Mapping[str, Any], question: Optional[str] = None,
                   reask: Optional[str] = None) -> Tuple[Optional[str], Optional[str]]:
    """The identity question and its re-ask as spoken: a call flow's own lines (templates) when it
    has them, else IDENTITY_QUESTION / IDENTITY_REASK. (None, None) when the customer has no name."""
    safe = safe_variables(variables)
    name = safe["customer_name"]
    if not name:
        return None, None
    q = (render_first_message(question, variables) if question
         else render_first_message(IDENTITY_QUESTION.format(name=name, title=safe["title_to_use"]), {}))
    r = render_first_message(reask, variables) if reask else IDENTITY_REASK.format(name=name)
    return q or None, r or None


def identity_after_greeting(first_message: Optional[str]) -> bool:
    """The opening is a time-of-day greeting that doesn't name the customer, so the
    identity question (IDENTITY_QUESTION) follows the customer's first reply."""
    first = first_message or ""
    return (bool(_TIME_GREETING_RE.search(first)) and "customer_name" not in first
            and not _NAME_ALIAS_RE.search(first))


_QUESTION_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_WORDS_RE = re.compile(r"[a-z0-9']+")


def _question_words(text: str) -> List[str]:
    return _WORDS_RE.findall(text.lower())


def asked_questions(lines: List[str]) -> List[List[str]]:
    """The questions (sentences ending in "?") in the agent's lines, as word lists."""
    out = []
    for line in lines:
        for sentence in _QUESTION_SPLIT_RE.split(line or ""):
            if sentence.strip().endswith("?"):
                out.append(_question_words(sentence))
    return out


def is_repeated_question(sentence: str, asked: List[List[str]], min_words: int = 4, overlap: float = 0.8) -> bool:
    """`sentence` is a question the agent already asked: most words of the shorter of the two
    questions appear in the other ("Do you have just one minute?" ~ "Do you have just a minute
    to hear more?"). Short questions ("Is that okay?") never count."""
    if not sentence.strip().endswith("?"):
        return False
    new = set(_question_words(sentence))
    if len(new) < min_words:
        return False
    for prev in asked:
        old = set(prev)
        shorter = new if len(new) <= len(old) else old
        if len(shorter) >= min_words and len(new & old) / len(shorter) >= overlap:
            return True
    return False


def _ms(a: Optional[float], b: Optional[float]) -> Optional[int]:
    return int((b - a) * 1000) if a is not None and b is not None else None


def latency_summary(rows: List[Dict[str, Any]], slow_speaker: bool = False) -> str:
    """One log line per call: avg / max per step over its AI-reply turns (numbers only)."""
    llm = [r for r in rows if r.get("reply_source") == "llm"]

    def stat(key: str, of: List[Dict[str, Any]]) -> str:
        vals = [r[key] for r in of if r.get(key) is not None]
        return f"{sum(vals) // len(vals)}/{max(vals)}" if vals else "-"

    return (
        f"Call latency summary (avg/max ms over {len(llm)} AI replies, {len(rows)} turns"
        f"{', slow-speaker wait on' if slow_speaker else ''}): "
        f"reply_delay={stat('reply_delay_ms', llm)} eos_wait={stat('eos_wait_ms', llm)} stt={stat('stt_ms', llm)} "
        f"llm_first_token={stat('llm_first_token_ms', llm)} llm_full={stat('llm_ms', llm)} "
        f"tts_wait={stat('tts_wait_ms', llm)} tts_first_audio={stat('tts_first_byte_ms', llm)} "
        f"| all turns reply_delay={stat('reply_delay_ms', rows)}"
    )


# ===========================================================================
# Provider container (overridable in tests)
# ===========================================================================
@dataclass
class Providers:
    stt: STTProvider
    llm: LLMProvider
    tts: TTSProvider
    plivo: PlivoService
    twilio: Optional[TwilioService] = None

    def telephony(self, name: Optional[str] = None):
        """Phone provider by name (default: TELEPHONY_PROVIDER)."""
        name = (name or default_settings.telephony_provider).lower()
        if name == "twilio":
            if self.twilio is None:
                self.twilio = get_twilio_service()
            return self.twilio
        return self.plivo

    def tts_for_voice(self, voice_id: Optional[str]) -> TTSProvider:
        if voice_id and isinstance(self.tts, SarvamTTS):
            voiced = SarvamTTS(self.tts.cfg, voice_id=voice_id, client=self.tts._client)
            return voiced if voiced.voice_id != self.tts.voice_id else self.tts
        return self.tts

    async def aclose(self) -> None:
        for p in (self.stt, self.llm, self.tts, self.twilio):
            if p is None:
                continue
            try:
                await p.aclose()
            except Exception:
                pass


_providers: Optional[Providers] = None


def get_providers() -> Providers:
    global _providers
    if _providers is None:
        _providers = Providers(
            stt=create_stt_provider("sarvam"),
            llm=create_llm_provider(),
            tts=create_tts_provider("sarvam"),
            plivo=get_plivo_service(),
            twilio=get_twilio_service(),
        )
    return _providers


def set_providers(p: Optional[Providers]) -> None:
    global _providers
    _providers = p


def stt_for_call(stt: STTProvider, variables: Mapping[str, Optional[str]], cfg: Settings = default_settings) -> STTProvider:
    """The speech recogniser for one call: the shared one, except a "Pure" language-style flow while
    SARVAM_STT_MODE_PURE is set - then its own copy with that mode (same connection pool)."""
    mode = (cfg.SARVAM_STT_MODE_PURE or "").strip()
    if not mode or variables.get("flow_language_style") != "pure" or not isinstance(stt, SarvamSTT) or mode == cfg.SARVAM_STT_MODE:
        return stt
    return SarvamSTT(cfg.model_copy(update={"SARVAM_STT_MODE": mode}), client=stt._client)


# ===========================================================================
# Status transitions
# ===========================================================================
async def transition(
    db: AsyncSession, call: Call, status: CallStatus, payload: Optional[dict] = None, **fields: Any
) -> None:
    """Update call status (never regress from a final state) and persist an event."""
    current = CallStatus(call.status)
    if current in FINAL_CALL_STATUSES and status not in FINAL_CALL_STATUSES:
        if fields:
            await repo.update_call(db, call, **fields)
        return
    if current == CallStatus.completed and status in FINAL_CALL_STATUSES and status != CallStatus.completed:
        status = CallStatus.completed  # a conversation happened; keep "completed"
    await repo.update_call(db, call, status=status.value, **fields)
    if status in FINAL_CALL_STATUSES:
        _GREETING_AUDIO.pop(call.id, None)  # unanswered calls never use it
    await repo.add_event(db, call.id, f"status:{status.value}", payload)
    await get_session_store().set_fields(call.id, status=status.value)
    log.info("Call status -> %s", status.value)
    status_callback.notify(call)


# ===========================================================================
# Pre-rendered greeting
# ===========================================================================
# The fixed first sentence is synthesized while the phone is still ringing and
# played the moment the call is answered. Without this, the customer hears
# silence for the greeting delay plus a full TTS round-trip, and often hangs up.
# call_id -> (text, pace, pause lengths, audio)
_GREETING_AUDIO: Dict[str, Tuple[str, Optional[float], Tuple[Tuple[str, int], ...], bytes]] = {}
_PRERENDER_TASKS: Set[asyncio.Task] = set()


def pause_key(pauses: Optional[Mapping[str, int]]) -> Tuple[Tuple[str, int], ...]:
    """Part of the pre-rendered audio's cache key: the same line with other pause lengths sounds different."""
    return tuple(sorted((pauses or {}).items()))


def silence_mulaw(ms: int) -> bytes:
    """`ms` of 8 kHz mu-law silence, in whole 20 ms frames (160 bytes each)."""
    return b"\xff" * (max(0, ms) // 20 * 160)


async def synthesize_line(tts: TTSProvider, text: str, pauses: Optional[Mapping[str, int]] = None,
                          pace: Optional[float] = None) -> bytes:
    """One-shot audio for a line the system speaks. Pause markers become silence between parts
    synthesized separately (same voice and speed); a line without markers is synthesized as before."""
    if not has_pause_markers(text):
        return await (tts.synthesize(text) if pace is None else tts.synthesize(text, pace=pace))
    parts = split_pauses(text, pauses or {})
    if len(parts) < 2:  # markers only at the start or the end: ignored
        line = parts[0][0] if parts else ""
        return await (tts.synthesize(line) if pace is None else tts.synthesize(line, pace=pace)) if line else b""
    audios = await asyncio.gather(*(tts.synthesize(p) if pace is None else tts.synthesize(p, pace=pace)
                                    for p, _, _ in parts))
    out = b""
    for (_, requested, inserted), mulaw in zip(parts, audios):
        out += mulaw
        if inserted:
            out += silence_mulaw(inserted)
            log.info("Pause inserted: requested %d ms, actual %d ms", requested, inserted)
    return out


async def prerender_greeting(call_id: str, text: str, voice_id: Optional[str], pace: Optional[float] = None,
                             pauses: Optional[Mapping[str, int]] = None) -> None:
    tts = get_providers().tts_for_voice(voice_id)
    try:
        mulaw = await asyncio.wait_for(synthesize_line(tts, text, pauses, pace), timeout=15)
    except Exception as exc:  # live TTS still works; never fail the call over this
        log.warning("Greeting pre-render failed (%s) - it will be streamed live", type(exc).__name__)
        return
    if mulaw:
        _GREETING_AUDIO[call_id] = (text, pace, pause_key(pauses), mulaw)
        log.info("Greeting pre-rendered (%.1fs of audio)", audio.mulaw_duration_seconds(len(mulaw)))


def schedule_greeting_prerender(call_id: str, text: str, voice_id: Optional[str],
                                pace: Optional[float] = None, pauses: Optional[Mapping[str, int]] = None) -> None:
    task = asyncio.get_running_loop().create_task(prerender_greeting(call_id, text, voice_id, pace, pauses))
    _PRERENDER_TASKS.add(task)
    task.add_done_callback(_PRERENDER_TASKS.discard)


def has_greeting_audio(call_id: str) -> bool:
    return call_id in _GREETING_AUDIO


def take_greeting_audio(call_id: str, text: str, pace: Optional[float] = None,
                        pauses: Optional[Mapping[str, int]] = None) -> Optional[bytes]:
    """The pre-rendered greeting, if it matches the text, speed and pause lengths about to be spoken (used once)."""
    entry = _GREETING_AUDIO.pop(call_id, None)
    return entry[3] if entry and entry[0] == text and entry[1] == pace and entry[2] == pause_key(pauses) else None


def greeting_pace(first_message: Optional[str], cfg: Settings = default_settings) -> Optional[float]:
    """GREETING_TTS_SPEED for a time-of-day opening's greeting; None (configured speed) otherwise."""
    return cfg.GREETING_TTS_SPEED if identity_after_greeting(first_message) else None


class CallError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


# ===========================================================================
# Outbound call
# ===========================================================================
async def start_outbound_call(db: AsyncSession, req: OutboundCallRequest, cfg: Settings = default_settings) -> Call:
    providers = get_providers()
    if not cfg.telephony_configured() or not cfg.PUBLIC_BASE_URL:
        raise CallError(503, f"{cfg.telephony_provider.title()} is not configured on the server (credentials / PUBLIC_BASE_URL)")

    if req.agent_id is not None:
        agent = await repo.get_agent(db, req.agent_id)
    else:
        agent = await repo.get_agent_by_name(db, req.agent_name or "")
    if agent is None:
        raise CallError(404, "Agent not found")
    if not agent.active:
        raise CallError(400, "Agent is not active")

    # A call flow from Dispatch replaces the agent; a missing / invalid flow falls back
    # to the agent requested above, so the call still goes out exactly as before.
    flow_vars: Dict[str, Optional[str]] = {}
    flow_event: Optional[Tuple[str, dict]] = None
    time_limit: Optional[int] = None
    flow_voice: Optional[str] = None  # the voice picked in the call flow (wins over SARVAM_TTS_SPEAKER)
    if req.flow_id is not None:
        try:
            resolved = await resolve_flow_agent(db, req.flow_id, req.flow_version or 0, req.flow_draft, req.flow)
        except FlowError as exc:
            log.warning("Call flow %s v%s not used (%s) - falling back to agent '%s'",
                        req.flow_id, req.flow_version, exc.reason, agent.name)
            flow_vars = {"flow_id": req.flow_id, "flow_version": str(req.flow_version), "flow_fallback": exc.reason}
            flow_event = ("flow:fallback", {**flow_vars, "agent_id": agent.id, "errors": exc.errors[:5]})
        else:
            agent = resolved.agent
            flow_voice = offered_voice(resolved.flow.voice_id)
            flow_vars = {**resolved.info, "flow_silence_reprompt": resolved.flow.silence.reprompt,
                         "flow_silence_closing": resolved.flow.silence.closing}
            if resolved.flow.recording_notice:
                flow_vars["flow_recording_notice"] = resolved.flow.recording_notice
            if resolved.flow.language_style == "pure":  # else "mixed": the AI speaks as before
                flow_vars["flow_language_style"] = "pure"
            if resolved.flow.identity is not None:  # else the built-in identity lines
                flow_vars["flow_identity_question"] = resolved.flow.identity.question
                if resolved.flow.identity.reask:
                    flow_vars["flow_identity_reask"] = resolved.flow.identity.reask
            if resolved.flow.pauses is not None:  # else the default pause lengths
                flow_vars.update({f"flow_pause_{k}": str(v) for k, v in resolved.flow.pauses.model_dump().items()})
            time_limit = min(resolved.flow.limits.max_duration_sec, cfg.MAX_CALL_DURATION_SECONDS)
            flow_event = ("flow:selected", {**resolved.info, "agent_id": agent.id, "time_limit": time_limit})

    existing = await repo.get_contact_by_phone(db, req.phone_number)
    if existing is not None and existing.dnd:
        raise CallError(409, "Contact is marked Do-Not-Disturb; call not placed")
    # A missing name never blocks a call: a greeting that names the customer becomes the neutral
    # NO_NAME_GREETING (opening_line) and the identity question is skipped.
    contact = await repo.upsert_contact(
        db, req.phone_number, req.name, req.company_name, req.email,
        gender=req.gender, business_type=req.business_type,
    )

    name = contact.name or req.name
    # Only an explicitly provided gender is used; never inferred.
    variables = build_call_variables(
        name,
        contact.gender,
        req.phone_number,
        follow_up_detail=req.follow_up_detail,
        company_name=contact.company_name or req.company_name,
        business_type=contact.business_type or req.business_type,
        run_id=req.run_id,
        log_id=req.log_id,
    )
    variables.update(flow_vars)
    if req.greeting_delay_sec is not None:
        variables["greeting_delay_sec"] = str(req.greeting_delay_sec)
    rotation = cfg.voice_rotation
    async with _VOICE_ROTATION_LOCK:  # pick + insert together so concurrent calls get different voices
        if not rotation:
            voice_id = None
        elif cfg.voice_rotation_mode == "concurrent":
            # Ignore calls stuck in a live status (e.g. a missed hangup webhook) after the max duration.
            since = utcnow() - timedelta(seconds=cfg.MAX_CALL_DURATION_SECONDS + 300)
            # A flow's own voice is the first choice; a rotation voice only while it is busy.
            voice_id = await repo.free_call_voice(db, flow_voice or cfg.tts_speaker, rotation, since)
        else:
            voice_id = await repo.next_rotation_voice(db, rotation)
        call = await repo.create_call(
            db,
            voice_id=voice_id,
            agent_id=agent.id,
            contact_id=contact.id,
            from_number=cfg.telephony_from_number,
            telephony_provider=cfg.telephony_provider,
            to_number=req.phone_number,
            status=CallStatus.created.value,
            direction="outbound",
            variables=variables,
        )
    with call_context(call.id):
        await repo.add_event(db, call.id, "status:created", {"agent_id": agent.id, "voice_id": voice_id})
        if flow_event:
            await repo.add_event(db, call.id, *flow_event)
        if voice_id:
            log.info("Voice rotation: using voice %s", voice_id)
        await get_session_store().set_fields(call.id, status="created", agent_id=agent.id, processing_state="idle")
        await transition(db, call, CallStatus.initiating, started_at=utcnow())
        try:
            result = await providers.telephony(call.telephony_provider).make_outbound_call(
                call.id, req.phone_number, time_limit=time_limit)
        except PlivoError as exc:
            await transition(db, call, CallStatus.failed, {"error": exc.kind}, outcome=CallOutcome.call_failed.value, ended_at=utcnow())
            raise CallError(502 if exc.kind != "not_configured" else 503,
                            f"{call.telephony_provider.title()} call failed: {exc}") from None
        await repo.update_call(db, call, provider_request_id=result.request_uuid, provider_call_id=result.request_uuid)
        await repo.add_event(db, call.id, f"{call.telephony_provider}:call_fired", {"request_uuid": result.request_uuid})
        await get_session_store().set_fields(call.id, provider_request_id=result.request_uuid)
        log.info("Plivo outbound call fired")
        watch_for_provider_callback(call.id, cfg.NO_PROVIDER_CALLBACK_SECONDS)
        if cfg.GREETING_PRERENDER and agent.first_message:
            greeting = opening_line(agent.first_message, variables)
            if greeting:
                schedule_greeting_prerender(call.id, greeting, call.voice_id or agent.voice_id,
                                            greeting_pace(agent.first_message, cfg), pauses_from_variables(variables))
    return call


# ===========================================================================
# No word from the telephony provider
# ===========================================================================
# Plivo calls ring_url within seconds of dialling and always sends the hang-up (ring timeout
# 45 s); Twilio's status callback is the same. Hearing nothing at all for
# NO_PROVIDER_CALLBACK_SECONDS means the provider can't reach PUBLIC_BASE_URL (e.g. the ngrok
# tunnel is down): the call is failed then, with a reason Dispatch shows, instead of staying
# "initiating" until Dispatch gives up on it (AI_CALLS_CALL_TIMEOUT_SEC, 15 min).
_WAITING_FOR_PROVIDER = (CallStatus.created.value, CallStatus.initiating.value)
_PROVIDER_WATCHES: Set["asyncio.Task[None]"] = set()  # strong refs: an unreferenced task can be collected


def watch_for_provider_callback(call_id: str, delay_seconds: float) -> None:
    """Fail the call if the provider has not reported on it after delay_seconds (<= 0: off)."""
    if delay_seconds <= 0:
        return
    task = asyncio.create_task(_fail_if_still_waiting(call_id, delay_seconds))
    _PROVIDER_WATCHES.add(task)
    task.add_done_callback(_PROVIDER_WATCHES.discard)


async def _fail_if_still_waiting(call_id: str, delay_seconds: float) -> None:
    await asyncio.sleep(delay_seconds)
    with call_context(call_id):
        try:
            async with session_factory()() as db:
                call = await repo.get_call(db, call_id)
                if call is not None and call.status in _WAITING_FOR_PROVIDER:
                    why = (await check_public_url(force=True)).reason
                    await fail_unreported_call(db, call, why)
        except Exception as exc:
            log.warning("No-callback check failed: %s", type(exc).__name__)


def no_callback_cause(provider: str, why: Optional[str], seconds: int) -> str:
    """hangup_cause (max 100 chars) for a call the provider never reported on."""
    if why:
        return f"No word from {provider}: PUBLIC_BASE_URL unreachable ({why}). Start ngrok or fix it"[:100]
    return f"No word from {provider} within {seconds}s of dialling. Check the {provider} console"[:100]


async def fail_unreported_call(db: AsyncSession, call: Call, why: Optional[str], *, at_startup: bool = False,
                               cfg: Settings = default_settings) -> None:
    provider = (call.telephony_provider or "plivo").title()
    if at_startup:
        cause = f"No word from {provider} before the voice backend restarted"[:100]
        log.warning("No word from %s for this call before the restart - marking it failed", provider)
    else:
        cause = no_callback_cause(provider, why, cfg.NO_PROVIDER_CALLBACK_SECONDS)
        log.warning("No word from %s for this call - marking it failed (%s)", provider, why or "the public URL answers")
    await transition(db, call, CallStatus.failed, {"error": "no_provider_callback", "public_url": why, "at_startup": at_startup},
                     outcome=CallOutcome.call_failed.value, ended_at=utcnow(), hangup_cause=cause)
    await get_session_store().delete(call.id)  # it never became a conversation: not an active call


async def recheck_unreported_calls(cfg: Settings = default_settings) -> int:
    """At start-up: calls a restart left waiting for the provider. Fails those that waited too long,
    watches the rest for their remaining time. Returns how many were failed."""
    limit = cfg.NO_PROVIDER_CALLBACK_SECONDS
    if limit <= 0:
        return 0
    failed = 0
    async with session_factory()() as db:
        for call in await repo.list_calls_in_status(db, _WAITING_FOR_PROVIDER):
            since = call.started_at or call.created_at
            waited = (utcnow() - since).total_seconds() if since else limit
            with call_context(call.id):
                if waited >= limit:
                    await fail_unreported_call(db, call, None, at_startup=True, cfg=cfg)
                    failed += 1
                else:
                    watch_for_provider_callback(call.id, limit - waited)
    return failed


# ===========================================================================
# Webhooks
# ===========================================================================
SAFE_WEBHOOK_KEYS = (
    "Event", "CallStatus", "CallUUID", "RequestUUID", "Direction", "HangupCause", "HangupCauseName",
    "HangupCauseCode", "HangupSource", "Duration", "BillDuration", "AnswerTime", "StartTime", "EndTime",
    "StreamID", "StreamId", "Status", "Error", "Machine",
)


def safe_params(params: Mapping[str, str]) -> Dict[str, str]:
    return {k: str(params[k])[:200] for k in SAFE_WEBHOOK_KEYS if k in params}


async def find_call(db: AsyncSession, call_id: Optional[str], params: Mapping[str, str]) -> Optional[Call]:
    if call_id:
        call = await repo.get_call(db, call_id)
        if call:
            return call
    for key in ("CallUUID", "RequestUUID"):
        if params.get(key):
            call = await repo.get_call_by_provider_id(db, params[key])
            if call:
                return call
    return None


async def handle_answer(db: AsyncSession, call_id: Optional[str], params: Mapping[str, str]) -> str:
    call = await find_call(db, call_id, params)
    plivo = get_providers().telephony(call.telephony_provider if call else None)
    if call is None:
        log.warning("Answer webhook for unknown call - hanging up")
        return plivo.hangup_xml()
    with call_context(call.id):
        if CallStatus(call.status) in FINAL_CALL_STATUSES:
            return plivo.hangup_xml()
        fields: Dict[str, Any] = {"answered_at": utcnow()}
        if params.get("CallUUID"):
            fields["provider_call_id"] = params["CallUUID"]
        await transition(db, call, CallStatus.answered, safe_params(params), **fields)
        await get_session_store().set_fields(call.id, provider_call_id=params.get("CallUUID", ""))
        return plivo.build_stream_xml(call.id)


def _parse_plivo_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:19], fmt)
        except ValueError:
            continue
    return None


def map_hangup_status(params: Mapping[str, str], answered: bool) -> CallStatus:
    status = (params.get("CallStatus") or "").lower()
    cause = f"{params.get('HangupCauseName', '')} {params.get('HangupCause', '')}".lower()
    if answered or (params.get("AnswerTime") and status == "completed"):
        return CallStatus.completed
    if "busy" in status or "busy" in cause or "rejected" in cause:
        return CallStatus.busy
    if status in ("no-answer", "timeout") or "no answer" in cause or "no_answer" in cause or "timeout" in cause:
        return CallStatus.no_answer
    if "cancel" in status or "cancel" in cause:
        return CallStatus.cancelled
    return CallStatus.failed


async def handle_machine_detection(db: AsyncSession, call_id: Optional[str], params: Mapping[str, str]) -> None:
    """Plivo async AMD callback (Event=MachineDetection, Machine=true|false)."""
    call = await find_call(db, call_id, params)
    if call is None:
        return
    with call_context(call.id):
        is_machine = str(params.get("Machine", "")).lower() == "true"
        await repo.add_event(db, call.id, "plivo:machine_detection", {"machine": is_machine})
        if not is_machine:
            return
        uuid = params.get("CallUUID") or call.provider_call_id
        session = ACTIVE_SESSIONS.get(call.id)
        if session is not None and default_settings.MACHINE_DETECTION_VERIFY:
            verdict = session.machine_evidence()
            if verdict == "human":
                log.info("Plivo said answering machine, but the customer already answered like a person - call continues")
                await repo.add_event(db, call.id, "machine_detection_overruled", {"reason": "customer_words"})
                return
            if verdict is None:
                log.info("Plivo said answering machine - checking what the customer says before hanging up")
                await repo.add_event(db, call.id, "machine_detection_verifying", None)
                session.verify_machine(uuid, call.telephony_provider)
                return
        await hang_up_as_voicemail(db, call, uuid)


async def hang_up_as_voicemail(db: AsyncSession, call: Call, uuid: Optional[str]) -> None:
    log.info("Voicemail / answering machine detected - hanging up without the sales pitch")
    await repo.update_call(db, call, outcome=CallOutcome.voicemail.value)
    session = ACTIVE_SESSIONS.get(call.id)
    if session is not None:
        session.end_call_requested = True
        if session._turn_task and not session._turn_task.done():
            session._turn_task.cancel()
    if uuid:
        await get_providers().telephony(call.telephony_provider).hangup(uuid)


OUTCOME_FOR_STATUS = {
    CallStatus.busy: CallOutcome.busy,
    CallStatus.no_answer: CallOutcome.no_answer,
    CallStatus.failed: CallOutcome.call_failed,
    CallStatus.cancelled: CallOutcome.call_failed,
}


async def handle_status(db: AsyncSession, call_id: Optional[str], params: Mapping[str, str]) -> None:
    call = await find_call(db, call_id, params)
    if call is None:
        log.warning("Status webhook for unknown call")
        return
    with call_context(call.id):
        event = (params.get("Event") or "").lower()
        call_status = (params.get("CallStatus") or "").lower()
        if event == "ring" or call_status == "ringing":
            fields = {"provider_call_id": params["CallUUID"]} if params.get("CallUUID") else {}
            await transition(db, call, CallStatus.ringing, safe_params(params), **fields)
            return
        if event == "hangup" or call_status in ("completed", "busy", "failed", "no-answer", "cancel", "timeout"):
            final = map_hangup_status(params, answered=call.answered_at is not None)
            fields: Dict[str, Any] = {
                "ended_at": _parse_plivo_time(params.get("EndTime")) or utcnow(),
                "hangup_cause": (params.get("HangupCauseName") or params.get("HangupCause") or None),
            }
            if params.get("Duration", "").isdigit():
                fields["duration_seconds"] = int(params["Duration"])
            if params.get("AnswerTime") and call.answered_at is None:
                fields["answered_at"] = _parse_plivo_time(params["AnswerTime"])
            # Outcome of answered calls is owned by finalize_conversation (it races
            # with this webhook); here we only set outcomes for unanswered calls.
            if final in OUTCOME_FOR_STATUS and not call.outcome:
                fields["outcome"] = OUTCOME_FOR_STATUS[final].value
            await transition(db, call, final, safe_params(params), **fields)
            return
        await repo.add_event(db, call.id, "plivo:status", safe_params(params))


# ===========================================================================
# Conversation engine
# ===========================================================================
class AudioSender(Protocol):
    async def send_audio(self, mulaw: bytes) -> None: ...
    async def clear(self) -> None: ...
    async def checkpoint(self, name: str) -> None: ...


@dataclass
class CallContextData:
    call_id: str
    agent_prompt: str
    variables: Dict[str, Optional[str]]
    first_message: Optional[str] = None
    voice_id: Optional[str] = None
    provider_call_id: Optional[str] = None
    contact_id: Optional[int] = None
    telephony_provider: str = "plivo"
    # Call-flow silence lines (already rendered); None = the built-in lines.
    silence_reprompt: Optional[str] = None
    silence_closing: Optional[str] = None
    # Call-flow recording notice (already rendered); spoken after the greeting while recording is on.
    recording_notice: Optional[str] = None
    # Call-flow identity question / re-ask (templates, see identity_lines); None = IDENTITY_QUESTION / IDENTITY_REASK.
    identity_question: Optional[str] = None
    identity_reask: Optional[str] = None
    answered_at: Optional[datetime] = None  # UTC, from the answer webhook (timing log only)


@dataclass
class TurnMetrics:
    t1: Optional[float] = None
    t2: Optional[float] = None
    t3: Optional[float] = None
    t3_first_token: Optional[float] = None
    t4: Optional[float] = None
    t5: Optional[float] = None
    t6: Optional[float] = None
    t0: Optional[float] = None  # customer actually stopped speaking (t1 minus the VAD silence)
    tts_wait: float = 0.0  # time the first sentence waited for the TTS connection
    source: Optional[str] = None  # llm | scripted | prerendered (what produced the reply)

    def as_row(self) -> Dict[str, Optional[int]]:
        return {
            "stt_ms": _ms(self.t1, self.t2),
            "llm_ms": _ms(self.t3, self.t4),
            "llm_first_token_ms": _ms(self.t3, self.t3_first_token),
            "tts_first_byte_ms": _ms(self.t5, self.t6),
            "total_response_ms": _ms(self.t1, self.t6),
        }

    def detail_row(self) -> Dict[str, Any]:
        """LATENCY_DETAIL_METRICS columns (migration 0005): numbers and the reply source only."""
        return {
            "eos_wait_ms": _ms(self.t0, self.t1),
            "tts_wait_ms": int(self.tts_wait * 1000) if self.t3 is not None else None,
            "reply_delay_ms": _ms(self.t0 if self.t0 is not None else self.t1, self.t6),
            "reply_source": self.source,
        }

    def log_line(self, turn: int) -> str:
        """Per-turn timing for logs (no transcript text, numbers or secrets)."""
        parts = {
            "eos_wait": _ms(self.t0, self.t1),
            "stt": _ms(self.t1, self.t2),
            "tts_wait": int(self.tts_wait * 1000) if self.t3 is not None else None,
            "llm_first_token": _ms(self.t3, self.t3_first_token),
            "first_token_to_audio": _ms(self.t3_first_token, self.t6),
            "tts_first_audio": _ms(self.t5, self.t6),
            "total": _ms(self.t1, self.t6),
            "reply_delay": _ms(self.t0 if self.t0 is not None else self.t1, self.t6),
        }
        return f"Turn {turn} timing (ms): " + " ".join(f"{k}={v}" for k, v in parts.items())


@dataclass
class _TurnState:
    user_text: Optional[str]
    record_user: bool
    scripted: Optional[str] = None  # fixed text spoken verbatim instead of asking the LLM
    is_greeting: bool = False
    spoken: List[str] = field(default_factory=list)
    audio_started: bool = False


ACTIVE_SESSIONS: Dict[str, "CallSession"] = {}


class CallSession:
    SEND_CHUNK_BYTES = 4000  # 0.5 s of mu-law per playAudio message

    def __init__(
        self,
        ctx: CallContextData,
        sender: AudioSender,
        providers: Optional[Providers] = None,
        cfg: Settings = default_settings,
        classifier: Optional[audio.SpeechClassifier] = None,
        store: Optional[SessionStore] = None,
    ):
        self.ctx = ctx
        self.call_id = ctx.call_id
        self.sender = sender
        self.cfg = cfg
        self.providers = providers or get_providers()
        self.tts = self.providers.tts_for_voice(ctx.voice_id)
        self.stt = stt_for_call(self.providers.stt, ctx.variables, cfg)
        self.store = store or get_session_store()
        # Input noise reduction: speech is detected on cleaned audio with an adaptive floor and a
        # low minimum (no fixed loudness gate), so quiet voices are heard; anything that started
        # as speech is kept as an utterance (when unsure, STT decides).
        self.cleaner = InputCleaner(cfg.NOISE_SUPPRESSION_STRENGTH) if cfg.NOISE_SUPPRESSION_ENABLED else None
        self._ns_logged_frames = 0
        if self.cleaner is not None:
            self._quiet_min_rms = min(cfg.VAD_MIN_RMS, QUIET_VOICE_MIN_RMS)
            noise_gate = audio.NoiseFloorGate(self._quiet_min_rms, cfg.VAD_FLOOR_MULTIPLIER, cfg.VAD_FLOOR_MAX_RMS)
            min_utterance_ms = min(cfg.VAD_MIN_UTTERANCE_MS, cfg.VAD_SPEECH_START_MS)
            vad_min_rms = 0  # the adaptive gate does the energy check
        else:
            noise_gate = (audio.NoiseFloorGate(cfg.VAD_MIN_RMS, cfg.VAD_FLOOR_MULTIPLIER, cfg.VAD_FLOOR_MAX_RMS)
                          if cfg.VAD_ADAPTIVE_FLOOR else None)
            min_utterance_ms = cfg.VAD_MIN_UTTERANCE_MS
            vad_min_rms = cfg.VAD_MIN_RMS
        self._noise_gate = noise_gate
        self._last_speech_end: Optional[float] = None
        self._slow_speaker = False
        self._latency_rows: List[Dict[str, Any]] = []  # LATENCY_DETAIL_METRICS: this call's turn timings
        self.endpointer = audio.SpeechEndpointer(
            classifier or audio.make_webrtc_classifier(cfg.VAD_AGGRESSIVENESS, vad_min_rms),
            start_ms=cfg.VAD_SPEECH_START_MS,
            end_silence_ms=cfg.VAD_SPEECH_END_SILENCE_MS,
            min_utterance_ms=min_utterance_ms,
            max_utterance_ms=cfg.MAX_UTTERANCE_SECONDS * 1000,
            noise_gate=noise_gate,
            loud_rms=cfg.BARGE_IN_MIN_RMS,
            max_gap_ms=cfg.BARGE_IN_MAX_GAP_MS,
        )
        self.history: List[Dict[str, str]] = []
        self.state = CallStatus.connected.value
        self.turn_index = 0
        self._turn_task: Optional[asyncio.Task] = None
        self._greeting_task: Optional[asyncio.Task] = None
        self._hangup_task: Optional[asyncio.Task] = None
        self._pending_user_text = ""
        self._playback_until = 0.0
        self._playback_started = 0.0
        self._barge_candidate = False  # customer speech started while the agent was busy, not yet confirmed
        self._barge_loud_ms = 0
        self._barge_check_task: Optional[asyncio.Task] = None
        self._audio_since_clear = False
        self._checkpoint: Optional[str] = None
        self._playback_done = asyncio.Event()
        self._playback_done.set()
        self._customer_spoke = False
        self._greeted = not ctx.first_message  # agents without a fixed greeting skip this step
        self._identity_reasked = False
        self._identity_asked = False  # IDENTITY_QUESTION spoken (time-of-day openings only)
        self._identity_silence_repeats = 0  # IDENTITY_QUESTION repeated because of silence (max 1)
        self._identity_silence_over = False  # the customer spoke after the identity question
        self._silence_turn: Optional[int] = None  # turn index of a silence-triggered repeat / re-prompt
        # Time-of-day openings: listen FIRST_SPEECH_WAIT_SECONDS before greeting; the first words only
        # trigger the greeting (spoken at GREETING_TTS_SPEED).
        self._first_speech_mode = identity_after_greeting(ctx.first_message)
        self._opening_taken = False  # the greeting (or the script, for do-not-call / AI) took the opening
        self._greeting_trigger: Optional[str] = None  # speech | silence | hold_limit (timing log)
        self._stream_started: Optional[float] = None
        # "Yes" heard while the identity question was still playing: (text, confidence, t1), answered after playback.
        self._held_reply: Optional[tuple] = None
        self._fallback_streak = 0  # fallback lines in a row; the second one closes the call
        self._customer_texts: List[str] = []  # every recognised customer utterance (machine check)
        self._agent_spoke = False
        self._last_activity = time.monotonic()
        self._silence_prompts = 0
        self._silence_task: Optional[asyncio.Task] = None
        self.end_call_requested = False
        self._closed = False
        self._agent_audio_end = 0.0  # when the agent's audio last stopped (echo tail)
        self._speaking_turn: Optional[_TurnState] = None  # the line the agent is / was last saying
        self._speech_near_agent = False  # current utterance started over / right after the agent
        self._stt_stream: Optional[STTStream] = None  # streaming STT for the utterance in progress
        self._line_audio: Dict[str, bytes] = {}  # pre-rendered fixed lines (PRERENDER_FIXED_LINES)
        self.pauses = pauses_from_variables(ctx.variables)  # lengths of {{short_delay}} etc. in system lines
        self.recorder: Optional[recording.CallRecorder] = None  # CALL_RECORDING_ENABLED, from stream start
        self._notice_spoken = False
        self.greeting_delay = greeting_delay_of(ctx.variables)  # seconds after answer; None = configured timing
        self._answered_mono: Optional[float] = None  # the answer, on the monotonic clock (set at stream start)
        self._opening_speech = False  # the customer's current words began before the greeting (AI Greeting Delay)
        self._bg_tasks: Set[asyncio.Task] = set()
        self._last_prewarm = 0.0
        self._db_queue: "asyncio.Queue[Callable[[AsyncSession], Awaitable[None]]]" = asyncio.Queue()
        self._db_worker: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        ACTIVE_SESSIONS[self.call_id] = self
        self._db_worker = asyncio.create_task(self._run_db_worker())
        await self._set_state(CallStatus.listening.value)
        self._stream_started = time.monotonic()
        # The greeting delay counts from the answer (webhook time), not from when the media stream connected.
        since_answer = (utcnow() - self.ctx.answered_at).total_seconds() if self.ctx.answered_at else 0.0
        self._answered_mono = self._stream_started - max(0.0, min(since_answer, 30.0))
        self.recorder = recording.start(self.call_id, self.cfg)  # None unless recording is on
        self._greeting_task = asyncio.create_task(
            self._greet_at_delay() if self.greeting_delay is not None  # Dispatch "AI Greeting Delay"
            else self._greet_after_first_wait() if self._first_speech_mode else self._greet_if_silent())
        self._silence_task = asyncio.create_task(self._watch_silence())
        if identity_after_greeting(self.ctx.first_message):
            self._spawn(self._ask_identity_after_pause())
        self._prewarm()
        if self.cfg.PRERENDER_FIXED_LINES:
            self._spawn(self._prerender_fixed_lines())

    async def close(self, reason: str = "stream_stopped") -> None:
        if self._closed:
            return
        self._closed = True
        ACTIVE_SESSIONS.pop(self.call_id, None)
        if self._latency_rows:
            log.info(latency_summary(self._latency_rows, slow_speaker=self._slow_speaker))
        if self.cleaner is not None and self.cleaner.frames:
            frames, avg, peak = self.cleaner.stats()
            log.info("Noise suppression for this call: %d chunks, %.2f ms avg / %.2f ms max per 20 ms chunk%s",
                     frames, avg, peak, " (bypassed)" if self.cleaner.bypassed else "")
        for task in (self._greeting_task, self._silence_task, self._turn_task, self._hangup_task, self._barge_check_task,
                     *self._bg_tasks):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except BaseException:
                    pass
        stt_stream = self._take_stt_stream()
        if stt_stream is not None:
            await stt_stream.aclose()
        try:
            await asyncio.wait_for(self._db_queue.join(), timeout=10)
        except asyncio.TimeoutError:
            log.warning("Timed out flushing pending DB writes")
        if self._db_worker:
            self._db_worker.cancel()
            try:
                await self._db_worker
            except BaseException:
                pass
        if self.recorder is not None:
            await recording.finalize(self.recorder, self.cfg)  # never raises
        await finalize_conversation(self.call_id, self.providers.llm, reason)
        await self.store.delete(self.call_id)

    # ------------------------------------------------------------------ persistence
    def _persist(self, fn: Callable[[AsyncSession], Awaitable[None]]) -> None:
        """Queue an ordered DB write without blocking the audio path."""
        self._db_queue.put_nowait(fn)

    async def _run_db_worker(self) -> None:
        with call_context(self.call_id):
            while True:
                fn = await self._db_queue.get()
                try:
                    async with session_factory()() as db:
                        await fn(db)
                except Exception as exc:
                    log.error("DB write failed: %s", type(exc).__name__)
                finally:
                    self._db_queue.task_done()

    def _spawn(self, coro: Awaitable[None]) -> None:
        """Background work owned by the session (cancelled on close)."""
        task = asyncio.ensure_future(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    # ------------------------------------------------------------------ latency helpers
    PREWARM_EVERY_SECONDS = 20.0

    def _prewarm(self) -> None:
        """Open the STT / LLM connections before a turn needs them (PROVIDER_PREWARM)."""
        now = time.monotonic()
        if not self.cfg.PROVIDER_PREWARM or now - self._last_prewarm < self.PREWARM_EVERY_SECONDS:
            return
        self._last_prewarm = now
        self._spawn(self.providers.stt.prewarm())
        self._spawn(self.providers.llm.prewarm())

    def _open_stt_stream(self) -> None:
        self._drop_stt_stream()
        stream = self.stt.open_stream()
        if stream is None:
            return
        stream.feed(self.endpointer.utterance_so_far())
        self.endpointer.frame_sink = stream.feed
        self._stt_stream = stream

    def _take_stt_stream(self) -> Optional[STTStream]:
        stream, self._stt_stream = self._stt_stream, None
        self.endpointer.frame_sink = None
        return stream

    def _drop_stt_stream(self, stream: Optional[STTStream] = None) -> None:
        stream = stream or self._take_stt_stream()
        if stream is not None:
            self._spawn(stream.aclose())

    def recording_notice_text(self) -> Optional[str]:
        """The flow's recording notice, only while calls are recorded."""
        return self.ctx.recording_notice if self.cfg.CALL_RECORDING_ENABLED else None

    async def _speak_recording_notice(self, st: _TurnState) -> None:
        """Spoken word for word right after the greeting; a TTS failure only skips it."""
        self._notice_spoken = True
        line = self.recording_notice_text() or ""
        try:
            mulaw = self._line_audio.get(line) or await synthesize_line(self.tts, line, self.pauses)
        except Exception as exc:
            log.warning("Recording notice not spoken (%s)", type(exc).__name__)
            return
        st.spoken.append(clean_spoken_text(line))
        await self._play(mulaw, st)
        self._event("recording_notice", {"turn": self.turn_index})

    def _fixed_lines(self) -> List[str]:
        lang = self.cfg.CALL_LANGUAGE
        lines = [fallback_reply(lang), self.ctx.silence_reprompt or silence_reprompt(lang),
                 self.ctx.silence_closing or silence_closing(lang)]
        if self.recording_notice_text():
            lines.append(self.recording_notice_text())
        first = (self.ctx.first_message or "").strip()
        if "customer_name" in first and first.endswith("?") and self.identity_reask_text():
            lines.append(self.identity_reask_text())
        if identity_after_greeting(first) and self.identity_question_text():
            lines += [self.identity_question_text(), self.identity_reask_text()]
        return list(dict.fromkeys(line for line in lines if line))

    async def _prerender_fixed_lines(self) -> None:
        with call_context(self.call_id):
            for line in self._fixed_lines():
                try:
                    mulaw = await asyncio.wait_for(synthesize_line(self.tts, line, self.pauses), timeout=15)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # live TTS still works for that line
                    log.warning("Fixed line pre-render failed (%s) - it will be streamed live", type(exc).__name__)
                    continue
                if mulaw:
                    self._line_audio[line] = mulaw
            log.info("Fixed lines pre-rendered: %d", len(self._line_audio))

    def _event(self, event_type: str, payload: Optional[dict] = None) -> None:
        self._persist(lambda db: repo.add_event(db, self.call_id, event_type, payload))

    async def _set_state(self, state: str) -> None:
        self.state = state
        audio_state = "playing" if state == CallStatus.speaking.value else "idle"
        await self.store.set_fields(self.call_id, conversation_state=state, audio_state=audio_state,
                                    processing_state="busy" if state == CallStatus.processing.value else "idle")

    # ------------------------------------------------------------------ audio in
    @property
    def ai_busy(self) -> bool:
        turn_running = self._turn_task is not None and not self._turn_task.done()
        return turn_running or time.monotonic() < self._playback_until

    async def on_media(self, mulaw: bytes) -> None:
        if self._closed:
            return
        if self.recorder is not None:
            self.recorder.add_customer(mulaw)
        pcm = audio.mulaw_to_pcm16(mulaw)
        if self.cleaner is not None:
            pcm, raw = self._clean(pcm)
        else:
            raw = None
        for ev in self.endpointer.process(pcm, raw):
            if ev.event == audio.VadEvent.SPEECH_START:
                self._note_resume()
                if not self.cfg.NOISE_SAFE_STATE:  # otherwise done once STT hears words
                    self._customer_spoke = True
                    self._last_activity = time.monotonic()
                    self._silence_prompts = 0
                    self._identity_silence_over = self._identity_asked
                    if self._hangup_task is None:
                        self.end_call_requested = False  # customer is talking again; keep the call open
                if (self._greeting_task and not self._greeting_task.done() and not self._first_speech_mode
                        and self.greeting_delay is None):
                    self._greeting_task.cancel()
                self._speech_near_agent = self.ai_busy or self._agent_recently_spoke()
                if self.greeting_delay is not None and self.ctx.first_message and not self._agent_spoke:
                    self._opening_speech = True  # before the greeting: it never moves or cuts the greeting
                if self.ai_busy:
                    # Don't cut the agent off yet: echo, line noise or "hmm" also look like speech.
                    self._barge_candidate, self._barge_loud_ms = True, 0
                else:
                    self._open_stt_stream()
                self._prewarm()
                log.debug("Customer speech started")
            elif ev.event == audio.VadEvent.SPEECH_END:
                candidate, self._barge_candidate = self._barge_candidate, False
                stt_stream = self._take_stt_stream()
                if not ev.audio:
                    self._drop_stt_stream(stt_stream)
                    self._after_noise()
                    continue
                t0 = time.monotonic() - ev.silence_ms / 1000
                self._last_speech_end = t0
                log.info("Customer audio received (%dms)", ev.duration_ms)
                opening, self._opening_speech = self._opening_speech, False
                if opening:
                    # AI Greeting Delay: words that began before the greeting don't start, move or cut it
                    # (it plays at the delay); only a do-not-call / AI question among them gets the script.
                    self._spawn(self._check_opening_words(ev.audio, stt_stream, t0))
                elif candidate or self.ai_busy:
                    self._drop_stt_stream(stt_stream)
                    self._check_barge_in(ev.audio, t0)  # interrupt only if STT hears real words
                else:
                    self._start_turn(audio_pcm=ev.audio, stt_stream=stt_stream, t0=t0,
                                     near_agent=self._speech_near_agent)
        if self._barge_candidate and self.endpointer.in_speech:
            await self._confirm_loud_barge_in(pcm if raw is None else raw)  # barge-in rules use the original audio

    def _clean(self, pcm: bytes) -> Tuple[bytes, Optional[bytes]]:
        """Noise reduction before speech detection. While the agent is speaking (or its echo
        may still arrive) the gain is held at 1x and today's stricter minimum applies, so the
        cleaner can never make the agent hear itself. Returns (detection audio, STT audio)."""
        assert self.cleaner is not None
        agent_audio = self.ai_busy or self._agent_recently_spoke()
        self.cleaner.frozen = agent_audio
        if self._noise_gate is not None:
            self._noise_gate.set_min_rms(self.cfg.VAD_MIN_RMS if agent_audio else self._quiet_min_rms)
        clean, raw = self.cleaner.feed(pcm)
        if self._noise_gate is not None:
            self._noise_gate.scale = 1.0 if self.cleaner.bypassed else max(self.cleaner.gain, 1e-3)
        frames, avg, peak = self.cleaner.stats()
        if frames - self._ns_logged_frames >= NOISE_LOG_EVERY_FRAMES:
            self._ns_logged_frames = frames
            log.info("Noise suppression: %d chunks, %.2f ms avg / %.2f ms max per 20 ms chunk%s",
                     frames, avg, peak, " (bypassed)" if self.cleaner.bypassed else "")
        return clean, (None if self.cfg.NOISE_SUPPRESSION_STT_AUDIO == "cleaned" else raw)

    def machine_evidence(self) -> Optional[str]:
        speaking_ms = len(self.endpointer.utterance_so_far()) * 1000 // (audio.TELEPHONY_SAMPLE_RATE * audio.SAMPLE_WIDTH)
        return machine_evidence(self._customer_texts, speaking_ms)

    def verify_machine(self, uuid: Optional[str], telephony_provider: str) -> None:
        self._spawn(self._verify_machine(uuid, telephony_provider))

    async def _verify_machine(self, uuid: Optional[str], telephony_provider: str) -> None:
        """Plivo said "machine" before any words were heard: wait up to MACHINE_VERIFY_SECONDS for
        them (longer only while the customer is still talking or being transcribed). A person's
        reply keeps the call; a voicemail phrase, a monologue or no words at all hang up as before."""
        with call_context(self.call_id):
            start = time.monotonic()
            verdict: Optional[str] = None
            while not self._closed:
                await asyncio.sleep(0.1)
                verdict = self.machine_evidence()
                if verdict is not None:
                    break
                waited = time.monotonic() - start
                busy = self.endpointer.in_speech or (self._turn_task is not None and not self._turn_task.done())
                if waited >= self.cfg.MACHINE_VERIFY_SECONDS and not (busy and waited < self.cfg.MACHINE_VERIFY_SECONDS + 4):
                    break
            if self._closed:
                return
            if verdict == "human":
                log.info("Customer answered like a person - Plivo's answering-machine verdict ignored, call continues")
                self._event("machine_detection_overruled", {"reason": "customer_words"})
                return
            self._event("machine_detection_confirmed", {"reason": verdict or "no_words"})
            async with session_factory()() as db:
                call = await repo.get_call(db, self.call_id)
                if call is not None:
                    await hang_up_as_voicemail(db, call, uuid or self.ctx.provider_call_id)

    def _note_resume(self) -> None:
        """A caller who starts again within SLOW_SPEAKER_END_SILENCE_MS of their last words, before
        the agent has said anything, paused mid-sentence: give them that much end-of-speech
        silence for the rest of the call (other callers keep today's reply speed)."""
        wait_ms = self.cfg.SLOW_SPEAKER_END_SILENCE_MS
        if self._slow_speaker or wait_ms <= 0 or self._last_speech_end is None:
            return
        if self._playback_started > self._last_speech_end:
            return  # the agent spoke in between: this is a reply, not a continuation
        if (time.monotonic() - self._last_speech_end) * 1000 > wait_ms:
            return
        frames = max(1, wait_ms // audio.FRAME_MS)
        if frames > self.endpointer.end_frames:
            self._slow_speaker = True
            self.endpointer.end_frames = frames
            log.info("Caller paused mid-sentence - waiting %d ms of silence before replying from now on", wait_ms)
            self._event("slow_speaker", {"end_silence_ms": wait_ms})

    async def _confirm_loud_barge_in(self, pcm: bytes) -> None:
        """Sustained loud speech after the echo window is a real interruption: stop at once."""
        if self.cfg.BARGE_IN_CONSECUTIVE:
            loud_ms = self.endpointer.loud_run_ms  # one unbroken run of loud speech frames
        else:
            if audio.rms(pcm) >= self.cfg.BARGE_IN_MIN_RMS:
                self._barge_loud_ms += len(pcm) * 1000 // (audio.TELEPHONY_SAMPLE_RATE * audio.SAMPLE_WIDTH)
            loud_ms = self._barge_loud_ms
        playing_ms = (time.monotonic() - self._playback_started) * 1000 if self._playback_started else 0
        in_grace = time.monotonic() < self._playback_until and playing_ms < self.cfg.BARGE_IN_GRACE_MS
        if loud_ms >= self.cfg.BARGE_IN_MIN_SPEECH_MS and not in_grace:
            self._barge_candidate = False
            await self.barge_in()

    def _check_barge_in(self, audio_pcm: bytes, t0: Optional[float] = None) -> None:
        if self._barge_check_task and not self._barge_check_task.done():
            self._barge_check_task.cancel()
        self._barge_check_task = asyncio.create_task(self._run_barge_check(audio_pcm, time.monotonic(), t0))

    async def _run_barge_check(self, audio_pcm: bytes, t1: float, t0: Optional[float] = None) -> None:
        with call_context(self.call_id):
            try:
                result = await self.stt.transcribe(self._stt_wav(audio_pcm))
            except STTError as exc:
                log.warning("STT failed on possible interruption (%s) - agent keeps talking", exc.kind)
                return
            if not result["text"]:
                log.info("Noise while agent was talking - ignored, agent keeps talking")
                self._event("barge_in_ignored", {"turn": self.turn_index})
                return
            if self.cfg.STT_DROP_NOISE_TEXT and is_noise_text(result["text"]):
                log.info("Only non-word sounds while agent was talking - ignored, agent keeps talking")
                self._event("barge_in_ignored", {"turn": self.turn_index, "reason": "noise_text"})
                return
            if self.cfg.ECHO_TEXT_FILTER and self._is_agent_echo(result["text"]):
                log.info("Agent's own voice came back (echo) - ignored, agent keeps talking")
                self._event("echo_ignored", {"turn": self.turn_index})
                return
            if self.ai_busy and self._silence_line_playing():
                # A silence-triggered repeat / re-prompt never plays on top of the customer.
                log.info("Customer spoke over a silence line - stopping it")
                await self.barge_in()
                self._start_turn(transcript=(result["text"], result.get("confidence"), t1), t0=t0)
                return
            # Over a time-of-day opening or its identity question any words are held (never
            # discarded, never talked over) - except do-not-call / AI questions, which interrupt.
            held_ok = is_filler(result["text"]) or (identity_after_greeting(self.ctx.first_message)
                                                     and not needs_script_at_opening(result["text"]))
            if self.ai_busy and held_ok and self._identity_question_playing():
                # "Yes" said over "Hi, is this <name>?" is the answer, not a backchannel: keep it
                # and answer once the question has finished playing.
                log.info("Customer answered %r while the identity question was playing - answering after playback",
                         result["text"])
                self._held_reply = (result["text"], result.get("confidence"), t1)
                return
            if self.ai_busy and is_filler(result["text"]):
                self._customer_texts.append(result["text"])  # a "Hmm" / "Yes" is still a person
                log.info("Customer said %r while agent busy - not an interruption, agent continues", result["text"])
                self._event("barge_in_ignored", {"turn": self.turn_index, "text": result["text"][:60]})
                return
            if self.ai_busy:
                await self.barge_in()
            self._start_turn(transcript=(result["text"], result.get("confidence"), t1), t0=t0)

    # ------------------------------------------------------------------ noise / echo
    def _agent_recently_spoke(self) -> bool:
        return (time.monotonic() - self._agent_audio_end) * 1000 < self.cfg.ECHO_TAIL_MS

    def _is_agent_echo(self, text: str) -> bool:
        if self._answering_opening():
            return False
        lines = []
        if self._speaking_turn is not None:
            lines.append(" ".join(self._speaking_turn.spoken))
        last = self.history[-1] if self.history else None
        if last and last["role"] == "assistant":
            lines.append(last["content"])
        return any(is_echo(text, line) for line in lines)

    def _confirm_customer_speech(self) -> None:
        """STT heard real words: now the customer counts as having spoken (NOISE_SAFE_STATE)."""
        if not self.cfg.NOISE_SAFE_STATE:
            return
        self._customer_spoke = True
        self._last_activity = time.monotonic()
        self._silence_prompts = 0
        self._identity_silence_over = self._identity_asked  # cancels the identity-silence timers
        if self._hangup_task is None:
            self.end_call_requested = False  # customer is talking again; keep the call open

    def _after_noise(self) -> None:
        """What looked like speech was only noise: make sure the greeting still plays."""
        if (not self.cfg.NOISE_SAFE_STATE or self._closed or self._agent_spoke or self._customer_spoke
                or (self._greeting_task is not None and not self._greeting_task.done())):
            return
        log.info("That was only noise - the greeting will still play")
        self._greeting_task = asyncio.create_task(self._greet_if_silent(self.cfg.GREETING_PRERENDERED_DELAY_MS))

    async def barge_in(self) -> None:
        log.info("Barge-in: customer interrupted, stopping playback")
        task = self._turn_task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        if self._audio_since_clear:
            await self.sender.clear()
            self._audio_since_clear = False
            if self.recorder is not None:
                self.recorder.cut_agent()  # the cleared audio never played
        self._playback_until = 0.0
        self._agent_audio_end = time.monotonic()
        self._checkpoint = None
        self._playback_done.set()
        self._event("barge_in", {"turn": self.turn_index})
        await self._set_state(CallStatus.listening.value)

    # ------------------------------------------------------------------ playback callbacks
    async def on_played(self, name: str) -> None:
        if name and name == self._checkpoint:
            self._checkpoint = None
            self._playback_until = 0.0
            self._agent_audio_end = time.monotonic()
            self._audio_since_clear = False
            self._playback_done.set()
            self._last_activity = time.monotonic()
            if not (self._turn_task and not self._turn_task.done()):
                await self._set_state(CallStatus.listening.value)
                if self._held_reply and not self.endpointer.in_speech:
                    held, self._held_reply = self._held_reply, None
                    self._start_turn(transcript=held)

    async def on_cleared(self) -> None:
        self._playback_until = 0.0
        self._agent_audio_end = time.monotonic()
        self._playback_done.set()

    # ------------------------------------------------------------------ turns
    def greeting_text(self) -> str:
        return opening_line(self.ctx.first_message or "", self.ctx.variables)

    def identity_reask_text(self) -> Optional[str]:
        return identity_lines(self.ctx.variables, self.ctx.identity_question, self.ctx.identity_reask)[1]

    def identity_question_text(self) -> Optional[str]:
        return identity_lines(self.ctx.variables, self.ctx.identity_question, self.ctx.identity_reask)[0]

    def _last_assistant_line(self) -> Optional[str]:
        last = self.history[-1] if self.history else None
        return last["content"] if last and last["role"] == "assistant" else None

    def _at_opening(self) -> bool:
        """Time-of-day opening spoken, identity question not asked yet."""
        if self._identity_asked or not identity_after_greeting(self.ctx.first_message):
            return False
        last = self._last_assistant_line()
        return bool(last and last.startswith(self.greeting_text()))

    def _should_ask_identity(self, text: str) -> bool:
        """Anything the customer says to the time-of-day opening (any word, any language) is
        only the signal to ask IDENTITY_QUESTION now - never an identity confirmation.
        Do-not-call and AI questions go to the script instead."""
        return (self._at_opening() and not needs_script_at_opening(text)
                and self.identity_question_text() is not None)

    async def _ask_identity_after_pause(self) -> None:
        """Ask IDENTITY_QUESTION GREETING_WAIT_SECONDS after the opening finished playing, unless
        the customer is speaking (their reply asks it at once) or the script took over."""
        with call_context(self.call_id):
            while not self._closed and not self._identity_asked:
                await asyncio.sleep(0.05)
                last = self._last_assistant_line()
                if last is None:
                    continue  # opening not spoken yet
                if not last.startswith(self.greeting_text()):
                    return  # the script answered something else (do-not-call, AI question)
                if (self.ai_busy or self.endpointer.in_speech or self._held_reply is not None
                        or not self._playback_done.is_set() or self.end_call_requested):
                    continue
                if time.monotonic() - self._agent_audio_end < self.cfg.GREETING_WAIT_SECONDS:
                    continue
                question = self.identity_question_text()
                if question is None:
                    return
                log.info("Pause after the opening - asking the identity question")
                self._identity_asked = True
                self._event("identity_question", {"after": "pause"})
                self._start_turn(scripted=question)
                return

    def _should_reask_identity(self, text: str) -> bool:
        """Only once, only right after the identity question - the opening line
        ("Hi, is this {{customer_name}}?") or IDENTITY_QUESTION after a time-of-day
        opening - and only when the reply is nothing but a greeting."""
        if self._identity_reasked or self.identity_reask_text() is None or not is_greeting_only(text):
            return False
        last = self._last_assistant_line()
        if not last:
            return False
        if identity_after_greeting(self.ctx.first_message):
            return self._identity_asked and last == self.identity_question_text()
        first = (self.ctx.first_message or "").strip()
        return "customer_name" in first and first.endswith("?") and last.startswith(self.greeting_text())

    def _identity_question_playing(self) -> bool:
        """The agent's last line is the opening or an identity question (greeting, identity
        question, re-ask) and no other reply is being prepared, i.e. it is busy only because
        that line is playing. A "Yes" / "Hello" said over it is the answer, not filler."""
        first = (self.ctx.first_message or "").strip()
        new_opening = identity_after_greeting(first)
        if not new_opening and ("customer_name" not in first or not first.endswith("?")):
            return False
        if self._turn_task is not None and not self._turn_task.done():
            return False
        content = self._last_assistant_line()
        if not content:
            return False
        return (content.startswith(self.greeting_text()) or content == self.identity_reask_text()
                or (new_opening and content == self.identity_question_text()))

    def _answering_opening(self) -> bool:
        """Words right after the time-of-day opening ("Good afternoon sir") may repeat the
        opening's words but are the customer's answer, not echo."""
        return self._at_opening()

    async def _greet_if_silent(self, delay_ms: Optional[int] = None) -> None:
        if delay_ms is None:
            delay_ms = self.cfg.GREETING_DELAY_MS
            if has_greeting_audio(self.call_id):  # ready to play instantly - don't leave dead air
                delay_ms = min(delay_ms, self.cfg.GREETING_PRERENDERED_DELAY_MS)
        await asyncio.sleep(delay_ms / 1000)
        if not self._customer_spoke and not self.ai_busy and not self.endpointer.in_speech:
            log.info("Customer silent after answer - agent greets first")
            if self.ctx.first_message:
                self._start_turn(scripted=self.greeting_text())
            else:
                self._start_turn(injected=GREETING_INSTRUCTION)

    FIRST_SPEECH_HOLD_MAX_SECONDS = 2.0  # wait at most this long for the customer to stop before greeting

    def greeting_pace(self) -> Optional[float]:
        return self.cfg.GREETING_TTS_SPEED if self._first_speech_mode else None

    async def _greet_after_first_wait(self) -> None:
        """Time-of-day opening: stay silent FIRST_SPEECH_WAIT_SECONDS after the stream starts. The
        customer's first words start the greeting at once (see _run_turn); otherwise greet when the
        wait ends - but never on top of the customer: while they are speaking, wait (at most
        FIRST_SPEECH_HOLD_MAX_SECONDS) for them to stop."""
        with call_context(self.call_id):
            start = self._stream_started or time.monotonic()
            while not self._closed:
                await asyncio.sleep(0.05)
                if self._greeted or self._opening_taken:
                    return
                due = first_speech_greeting_due(
                    time.monotonic(), start, self.cfg.FIRST_SPEECH_WAIT_SECONDS, self.FIRST_SPEECH_HOLD_MAX_SECONDS,
                    self.endpointer.in_speech, self._turn_task is not None and not self._turn_task.done())
                if due is None:
                    continue
                self._opening_taken = True
                self._greeting_trigger = due
                log.info("No words in the first %.1fs - greeting", self.cfg.FIRST_SPEECH_WAIT_SECONDS)
                self._start_turn(scripted=self.greeting_text())
                return

    def _greet_now(self, trigger: str) -> None:
        """Start the greeting (once), when the AI Greeting Delay ends."""
        if self._closed or self._opening_taken or self._agent_spoke:
            return
        self._opening_taken = True
        self._greeting_trigger = trigger
        if self.ctx.first_message:
            self._start_turn(scripted=self.greeting_text())
        else:
            self._start_turn(injected=GREETING_INSTRUCTION)

    async def _greet_at_delay(self) -> None:
        """Dispatch's AI Greeting Delay: greet exactly this long after the customer answered, whatever
        happens before (the customer's first words don't start or move it). Once per call; never
        after a hang-up or after a do-not-call / AI question took the opening (_check_opening_words)."""
        with call_context(self.call_id):
            due = (self._answered_mono or time.monotonic()) + (self.greeting_delay or 0.0)
            while not self._closed:
                await asyncio.sleep(max(0.0, min(0.05, due - time.monotonic())))
                # Agents without a fixed greeting answer the customer's first words themselves.
                if self._opening_taken or self._agent_spoke or (not self.ctx.first_message and self._customer_spoke):
                    return
                if time.monotonic() < due:
                    continue
                log.info("AI greeting delay %.1fs after answer - greeting", self.greeting_delay)
                self._greet_now("delay")
                return

    async def _check_opening_words(self, audio_pcm: bytes, stt_stream: Optional[STTStream], t0: float) -> None:
        """Words the customer said before the greeting (AI Greeting Delay): recorded, not answered -
        unless they need the script (do-not-call, "are you a bot?"): then that is answered now."""
        with call_context(self.call_id):
            try:
                result = await self._transcribe(audio_pcm, stt_stream)
            except STTError as exc:
                log.warning("Opening words not transcribed (%s)", exc.kind)
                return
            text = (result.get("text") or "").strip()
            if self._closed or not text or (self.cfg.STT_DROP_NOISE_TEXT and is_noise_text(text)):
                return
            self._confirm_customer_speech()
            self._customer_texts.append(text)
            log.info("Customer said (before the greeting): %s", text[:200])
            self._persist(lambda db, t=text, c=result.get("confidence"): repo.add_transcript(db, self.call_id, "customer", t, confidence=c))
            if not needs_script_at_opening(text):
                return
            log.info("First words need the script - answering them instead of the greeting")
            self._event("greeting_skipped", {"reason": "script"})
            if self.ai_busy or (self._turn_task is not None and not self._turn_task.done()):
                await self.barge_in()  # stop the greeting that already started
            self._opening_taken = self._greeted = True
            self._start_turn(transcript=(text, result.get("confidence"), t0))

    def _log_greeting_start(self) -> None:
        now = time.monotonic()
        since_stream = now - self._stream_started if self._stream_started else None
        since_answer = None
        if self.ctx.answered_at is not None:
            answered = self.ctx.answered_at
            if answered.tzinfo is not None:
                answered = answered.astimezone(timezone.utc).replace(tzinfo=None)
            since_answer = (utcnow() - answered).total_seconds()
        log.info("Greeting started %s after answer, %s after stream start (trigger=%s, speed=%s)",
                 f"{since_answer:.2f}s" if since_answer is not None else "?",
                 f"{since_stream:.2f}s" if since_stream is not None else "?",
                 self._greeting_trigger or "speech", self.greeting_pace() or "default")
        self._event("greeting_started", {
            "ms_after_answer": int(since_answer * 1000) if since_answer is not None else None,
            "ms_after_stream_start": int(since_stream * 1000) if since_stream is not None else None,
            "trigger": self._greeting_trigger or "speech",
            "speed": self.greeting_pace(),
        })

    async def _watch_silence(self) -> None:
        """After the agent has spoken, wait SILENCE_REPROMPT_SECONDS for the customer;
        re-prompt once, then close politely and hang up."""
        with call_context(self.call_id):
            while not self._closed:
                await asyncio.sleep(0.25)
                if (not self._agent_spoke or self.ai_busy or self.endpointer.in_speech
                        or self.end_call_requested or self._closed):
                    continue
                if self._held_reply is not None:
                    # Words held while a line played, and the line's audio has ended without a
                    # playback ack: answer them now instead of asking "can you hear me?".
                    held, self._held_reply = self._held_reply, None
                    self._start_turn(transcript=held)
                    continue
                if self._identity_silence_active():
                    self._identity_silence_step()
                    continue
                idle =time.monotonic() - max(self._last_activity, self._playback_until)
                if idle < self.cfg.SILENCE_REPROMPT_SECONDS:
                    continue
                if self._silence_prompts == 0:
                    self._silence_prompts = 1
                    log.info("Customer silent for %.0fs - re-prompting", idle)
                    self._event("silence_reprompt")
                    self._start_turn(scripted=self.ctx.silence_reprompt or silence_reprompt(self.cfg.CALL_LANGUAGE))
                else:
                    log.info("Still no response - closing the call politely")
                    self._event("silence_close")
                    self.end_call_requested = True
                    self._start_turn(scripted=self.ctx.silence_closing or silence_closing(self.cfg.CALL_LANGUAGE))
                self._last_activity = time.monotonic()

    def _identity_silence_active(self) -> bool:
        """The system's identity question (time-of-day opening) was the last line, the customer
        has not spoken since, and the repeat / re-prompt have not both been used."""
        if (not identity_after_greeting(self.ctx.first_message) or not self._identity_asked
                or self._identity_silence_over or self._silence_prompts > 0):
            return False
        last = self._last_assistant_line()
        return last is not None and last == self.identity_question_text()

    def _identity_silence_step(self) -> None:
        action = identity_silence_action(time.monotonic(), self._last_activity, self._playback_until,
                                         self.cfg.IDENTITY_SILENCE_WAIT_SECONDS,
                                         self._identity_silence_repeats, self._silence_prompts)
        if action == "repeat":
            self._identity_silence_repeats = 1
            log.info("Customer silent after the identity question - asking it once more")
            self._event("identity_silence_repeat")
            line = self.identity_question_text()
        elif action == "reprompt":
            self._silence_prompts = 1  # the normal silence flow closes the call next
            log.info("Still silent after the repeated identity question - re-prompting")
            self._event("silence_reprompt")
            line = self.ctx.silence_reprompt or silence_reprompt(self.cfg.CALL_LANGUAGE)
        else:
            return
        self._start_turn(scripted=line)
        self._silence_turn = self.turn_index
        self._last_activity = time.monotonic()

    def _silence_line_playing(self) -> bool:
        return self._silence_turn is not None and self._silence_turn == self.turn_index

    def _start_turn(self, audio_pcm: Optional[bytes] = None, injected: Optional[str] = None,
                    scripted: Optional[str] = None, transcript: Optional[tuple] = None,
                    stt_stream: Optional[STTStream] = None, t0: Optional[float] = None,
                    near_agent: bool = False) -> None:
        """transcript = (text, confidence, t1) when STT already ran (confirmed barge-in).
        near_agent = the speech started over / just after the agent's audio (echo check).
        stt_stream = the streamed STT session for audio_pcm (STT_STREAMING), if any."""
        if self._turn_task and not self._turn_task.done():
            self._turn_task.cancel()
        if self._held_reply and (audio_pcm is not None or transcript is not None):
            # The customer spoke again before the held answer was used: answer both together.
            (held, conf, _), self._held_reply = self._held_reply, None
            self._persist(lambda db, t=held, c=conf: repo.add_transcript(db, self.call_id, "customer", t, confidence=c))
            self._pending_user_text = f"{self._pending_user_text} {held}".strip()
        self.turn_index += 1
        self._last_activity = time.monotonic()
        t1 = transcript[2] if transcript else time.monotonic()
        self._turn_task = asyncio.create_task(
            self._run_turn(self.turn_index, audio_pcm, injected, t1, scripted, transcript, stt_stream, t0, near_agent)
        )

    async def _transcribe(self, audio_pcm: bytes, stt_stream: Optional[STTStream]) -> dict:
        """Streamed transcript when available, else (or on any problem) the REST request."""
        if stt_stream is not None:
            try:
                result = await stt_stream.finish(self.cfg.STT_STREAM_FINAL_TIMEOUT_MS / 1000)
                if result["text"]:
                    return result
                log.info("Streamed STT returned no text - checking with the REST request")
            except STTError as exc:
                log.warning("Streamed STT failed (%s) - using the REST request", exc.kind)
            finally:
                await stt_stream.aclose()
        return await self.stt.transcribe(self._stt_wav(audio_pcm))

    def _stt_wav(self, audio_pcm: bytes) -> bytes:
        """What STT hears for an utterance: the original audio, or (STT_NORMALIZE_AUDIO) a
        level-normalised copy of it. The live call audio is never changed."""
        if self.cfg.STT_NORMALIZE_AUDIO:
            audio_pcm = audio.normalize_for_stt(audio_pcm, self.cfg.STT_NORMALIZE_TARGET_RMS,
                                                self.cfg.STT_NORMALIZE_MAX_GAIN_DB)
        return audio.telephony_pcm_to_stt_wav(audio_pcm)

    async def _run_turn(self, turn: int, audio_pcm: Optional[bytes], injected: Optional[str], t1: float,
                        scripted: Optional[str] = None, transcript: Optional[tuple] = None,
                        stt_stream: Optional[STTStream] = None, t0: Optional[float] = None,
                        near_agent: bool = False) -> None:
        with call_context(self.call_id):
            m = TurnMetrics(t1=t1, t0=t0)
            await self._set_state(CallStatus.processing.value)
            stream = None
            st = _TurnState(user_text=injected, record_user=False, scripted=scripted)
            if scripted is not None and not self._greeted and scripted == self.greeting_text():
                st.is_greeting = True
            # Open the TTS stream early to hide the handshake behind STT - unless the
            # pre-rendered greeting is about to play and no TTS is needed at all.
            tts_connect: Optional[asyncio.Task] = None
            if (not (st.is_greeting and has_greeting_audio(self.call_id)) and scripted not in self._line_audio
                    and not has_pause_markers(scripted)):  # a line with pauses is synthesized in parts
                tts_connect = asyncio.create_task(self.tts.open_stream())
            try:
                # ---------------- STT ----------------
                if transcript is not None:
                    result = {"text": transcript[0], "confidence": transcript[1]}
                    m.t2 = time.monotonic()
                elif audio_pcm is not None:
                    result = await self._transcribe(audio_pcm, stt_stream)
                    stt_stream = None
                    m.t2 = time.monotonic()
                    log.info("STT completed: %dms", _ms(m.t1, m.t2))
                if transcript is not None or audio_pcm is not None:
                    text = result["text"]
                    if not text:
                        log.info("STT returned no speech - ignoring")
                        self._after_noise()
                        return
                    if self.cfg.STT_DROP_NOISE_TEXT and is_noise_text(text):
                        log.info("STT heard only non-word sounds - ignoring")
                        self._event("noise_ignored", {"turn": turn})
                        self._after_noise()
                        return
                    if self.cfg.ECHO_TEXT_FILTER and near_agent and self._is_agent_echo(text):
                        log.info("Agent's own voice came back (echo) - ignoring")
                        self._event("echo_ignored", {"turn": turn})
                        self._after_noise()
                        return
                    self._confirm_customer_speech()
                    self._customer_texts.append(text)
                    log.info("Customer said: %s", text[:200])
                    self._persist(lambda db, t=text, c=result.get("confidence"): repo.add_transcript(db, self.call_id, "customer", t, confidence=c))
                    st.user_text = f"{self._pending_user_text} {text}".strip()
                    st.record_user = True
                    self._pending_user_text = st.user_text  # cleared once a reply is delivered
                    if not self._greeted and self._first_speech_mode and needs_script_at_opening(text):
                        # Do-not-call / "are you a bot?" before the greeting: the script answers it
                        # (safety rules keep priority) and the greeting is skipped.
                        log.info("First words need the script - greeting skipped")
                        self._opening_taken = self._greeted = True
                        self._event("greeting_skipped", {"reason": "script"})
                    elif not self._greeted:
                        # Customer spoke first ("Hello?"): answer with the fixed greeting.
                        st.scripted, st.is_greeting = self.greeting_text(), True
                        if self._first_speech_mode:
                            # Those words only start the greeting: not answered, not carried on.
                            self._opening_taken = True
                            self._greeting_trigger = "speech"
                            st.record_user = False
                            self._pending_user_text = ""
                    elif self._should_ask_identity(text):
                        st.scripted = self.identity_question_text()
                        self._identity_asked = True
                    elif self._should_reask_identity(text):
                        st.scripted = self.identity_reask_text()
                        self._identity_reasked = True

                # ---------------- LLM -> TTS (streamed) ----------------
                cached = (take_greeting_audio(self.call_id, st.scripted, self.greeting_pace(), self.pauses)
                          if st.is_greeting and st.scripted else None)
                paused = split_pauses(st.scripted, self.pauses) if has_pause_markers(st.scripted) else []
                line_audio = self._line_audio.get(st.scripted) if st.scripted is not None and not cached else None
                m.source = "prerendered" if (cached or line_audio) else "scripted" if st.scripted is not None else "llm"
                if cached or line_audio:
                    log.info("Playing pre-rendered %s", "greeting" if cached else "line")
                    m.t5 = m.t6 = time.monotonic()
                    st.spoken.append(clean_spoken_text(st.scripted))
                    await self._play(cached or line_audio, st)
                elif len(paused) > 1:
                    await self._speak_with_pauses(st, m, paused)
                else:
                    if tts_connect is None:
                        tts_connect = asyncio.create_task(self.tts.open_stream())
                    if st.scripted is not None or not self.cfg.LLM_START_BEFORE_TTS:
                        stream = await tts_connect
                        if st.is_greeting and self.greeting_pace() is not None:
                            await stream.set_pace(self.greeting_pace())  # the greeting only
                    # Otherwise the LLM starts now; its first sentence waits for the connection.
                    await self._speak_streaming(st, m, tts_connect)
                    stream = tts_connect.result()
                if st.scripted is None:
                    m.t4 = m.t4 or time.monotonic()
                    log.info("LLM completed: %dms", _ms(m.t3, m.t4) or 0)
                if st.is_greeting and self.recording_notice_text() and not self._notice_spoken:
                    await self._speak_recording_notice(st)
                self._commit_turn(st, interrupted=False)
                if m.t6:
                    log.info("Total response latency: %dms", _ms(m.t1, m.t6))
                row: Dict[str, Any] = m.as_row()
                if self.cfg.LATENCY_DETAIL_METRICS:
                    row.update(m.detail_row())
                    self._latency_rows.append(dict(row))
                log.info(m.log_line(turn))
                self._persist(lambda db, row=row: repo.add_latency_metric(db, self.call_id, turn, **row))
                await self._after_reply()
            except asyncio.CancelledError:
                if stream is None and tts_connect is not None and tts_connect.done() \
                        and not tts_connect.cancelled() and tts_connect.exception() is None:
                    stream = tts_connect.result()
                if stream is not None:
                    await stream.cancel()
                if st.audio_started:
                    self._commit_turn(st, interrupted=True)
                raise
            except (STTError, LLMError, TTSError) as exc:
                stage = "stt" if isinstance(exc, STTError) else "llm" if isinstance(exc, LLMError) else "tts"
                log.error("%s failed (%s): %s", stage.upper(), exc.kind, exc)
                self._event("pipeline_error", {"stage": stage, "kind": exc.kind, "turn": turn})
                if stage == "tts" and not st.audio_started and not self._closed:
                    await self._recover_tts_failure(st, m, turn)
                elif stage != "tts" and not st.audio_started:
                    await self._speak_fallback(st, f"{stage}_{exc.kind}")
            except Exception as exc:  # never kill the call on an unexpected bug
                log.exception("Unexpected pipeline error: %s", type(exc).__name__)
                self._event("pipeline_error", {"stage": "unknown", "kind": type(exc).__name__, "turn": turn})
            finally:
                if stt_stream is not None:  # STT never reached (turn cancelled / scripted)
                    await stt_stream.aclose()
                if stream is None and tts_connect is not None:
                    tts_connect.cancel()
                    try:
                        s = await tts_connect
                        await s.aclose()
                    except BaseException:
                        pass
                elif stream is not None:
                    await stream.aclose()
                if not self.ai_busy_after_turn():
                    await self._set_state(CallStatus.listening.value)

    def ai_busy_after_turn(self) -> bool:
        return time.monotonic() < self._playback_until

    async def _speak_streaming(self, st: _TurnState, m: TurnMetrics, connect: "asyncio.Task") -> None:
        """`connect` is the TTS open_stream task; the LLM may already be running while it connects."""

        async def tts_stream():
            return await connect

        async def produce() -> None:
            chunker = SentenceChunker()
            m.t3 = time.monotonic()
            # REPEAT_QUESTION_GUARD: questions the agent already asked in this call.
            asked = asked_questions([h["content"] for h in self.history if h["role"] == "assistant"])

            async def push(sentence: str) -> None:
                sentence, end = extract_end_call(sentence)
                if end:
                    self.end_call_requested = True
                sentence = clean_spoken_text(sentence)
                if not sentence:
                    return
                if (st.scripted is None and self.cfg.REPEAT_QUESTION_GUARD and st.spoken
                        and is_repeated_question(sentence, asked + asked_questions(st.spoken))):
                    # Something was already said in this reply; don't tack on a question asked before.
                    log.info("Skipped a question already asked in this call")
                    self._event("repeat_question_skipped", {"turn": self.turn_index})
                    return
                if m.t5 is None:
                    waited = time.monotonic()
                    stream = await tts_stream()
                    m.tts_wait = time.monotonic() - waited
                    m.t5 = time.monotonic()
                else:
                    stream = await tts_stream()
                st.spoken.append(sentence)
                await stream.send_text(sentence)

            if st.scripted is not None:
                m.t3 = None  # fixed text, no LLM involved
                for sentence in chunker.feed(st.scripted + " ") + chunker.flush():
                    await push(sentence)
            else:
                async for delta in self.providers.llm.stream_response(
                    self.ctx.agent_prompt, self.history, st.user_text, self.ctx.variables
                ):
                    if m.t3_first_token is None:
                        m.t3_first_token = time.monotonic()
                        log.info("LLM first token: %dms", _ms(m.t3, m.t3_first_token) or 0)
                    for sentence in chunker.feed(delta):
                        await push(sentence)
                for sentence in chunker.flush():
                    await push(sentence)
                m.t4 = time.monotonic()
            if not st.spoken:
                log.warning("LLM returned no speakable text - using fallback")
                text, close = self._next_fallback_line("llm_empty")
                if close:
                    self.end_call_requested = True
                await push(text)
            elif st.scripted is None:
                self._fallback_streak = 0  # a real reply got through
            await (await tts_stream()).end_input()

        async def consume() -> None:
            stream = await tts_stream()
            async for chunk in stream.audio():
                if m.t6 is None:
                    m.t6 = time.monotonic()
                    log.info("TTS first audio: %dms", _ms(m.t5, m.t6) or 0)
                await self._play(chunk, st)

        producer, consumer = asyncio.create_task(produce()), asyncio.create_task(consume())
        try:
            done, _ = await asyncio.wait({producer, consumer}, return_when=asyncio.FIRST_EXCEPTION)
            for t in done:
                if t.exception():
                    raise t.exception()  # type: ignore[misc]
            await asyncio.gather(producer, consumer)
        finally:
            for t in (producer, consumer):
                if not t.done():
                    t.cancel()
                    try:
                        await t
                    except BaseException:
                        pass

    async def _speak_with_pauses(self, st: _TurnState, m: TurnMetrics, parts: List[Tuple[str, int, int]]) -> None:
        """A system line with pause markers: its parts are synthesized in parallel (same voice and
        speed) and queued as part, silence, part. The silence is ordinary audio for Plivo, so
        barge-in clears it like speech, and the silence timers start after the whole line."""
        pace = self.greeting_pace() if st.is_greeting else None
        jobs = [asyncio.create_task(self.tts.synthesize(p) if pace is None else self.tts.synthesize(p, pace=pace))
                for p, _, _ in parts]
        try:
            m.t5 = time.monotonic()
            for (text, requested, inserted), job in zip(parts, jobs):
                mulaw = await job
                if m.t6 is None:
                    m.t6 = time.monotonic()
                    log.info("TTS first audio: %dms", _ms(m.t5, m.t6) or 0)
                st.spoken.append(text)
                await self._play(mulaw, st)
                if inserted:
                    await self._play(silence_mulaw(inserted), st)
                    log.info("Pause inserted: requested %d ms, actual %d ms", requested, inserted)
                    self._event("pause_inserted", {"turn": self.turn_index, "requested_ms": requested,
                                                   "actual_ms": inserted})
        finally:
            for job in jobs:
                if not job.done():
                    job.cancel()

    async def _play(self, mulaw: bytes, st: Optional[_TurnState] = None) -> None:
        self._agent_spoke = True
        if st is not None and not st.audio_started:
            st.audio_started = True
            self._speaking_turn = st
            self._playback_started = time.monotonic()
            if st.is_greeting:
                self._greeted = True
                self._log_greeting_start()
            await self._set_state(CallStatus.speaking.value)
        for piece in audio.chunk_bytes(mulaw, self.SEND_CHUNK_BYTES):
            await self.sender.send_audio(piece)
            if self.recorder is not None:
                self.recorder.add_agent(piece)
            self._audio_since_clear = True
            self._playback_done.clear()
            now = time.monotonic()
            self._playback_until = max(self._playback_until, now) + audio.mulaw_duration_seconds(len(piece))
            self._agent_audio_end = self._playback_until  # estimate; the checkpoint gives the real end

    def _commit_turn(self, st: _TurnState, interrupted: bool) -> None:
        reply = " ".join(st.spoken).strip()
        if st.record_user and st.user_text:
            self.history.append({"role": "user", "content": st.user_text})
            self._pending_user_text = ""
            self._bg(self.store.append_history(self.call_id, "user", st.user_text))
        if reply:
            content = reply + (" ..." if interrupted else "")
            self.history.append({"role": "assistant", "content": content})
            self._bg(self.store.append_history(self.call_id, "assistant", content))
            self._persist(lambda db: repo.add_transcript(db, self.call_id, "agent", reply, interrupted=interrupted))
            log.info("Agent said%s: %s", " (interrupted)" if interrupted else "", reply[:200])

    def _bg(self, coro: Awaitable[None]) -> None:
        asyncio.ensure_future(coro)

    async def _after_reply(self) -> None:
        if not self._audio_since_clear:
            return
        self._checkpoint = f"turn-{self.turn_index}"
        await self.sender.checkpoint(self._checkpoint)
        if self.end_call_requested and not self._hangup_task:
            self._hangup_task = asyncio.create_task(self._hangup_after_playback())

    async def _recover_tts_failure(self, st: _TurnState, m: TurnMetrics, turn: int) -> None:
        """The live TTS stream failed before any audio played (e.g. Sarvam TTS timed out).
        Say the same reply through one-shot synthesis instead of leaving the customer in
        silence; if the reply was cut off mid-generation, generate it again first."""
        try:
            if st.scripted is not None:
                text = clean_spoken_text(st.scripted)
            elif m.t4 is not None and st.spoken:  # LLM had finished - reuse its full reply
                text = " ".join(st.spoken)
            else:
                raw = await asyncio.wait_for(
                    self.providers.llm.generate_response(self.ctx.agent_prompt, self.history, st.user_text, self.ctx.variables),
                    timeout=10,
                )
                raw, end = extract_end_call(raw)
                if end:
                    self.end_call_requested = True
                text = clean_spoken_text(raw)
            if not text:
                raise ValueError("no reply text")
            pace = self.greeting_pace() if st.is_greeting else None
            mulaw = await asyncio.wait_for(
                self.tts.synthesize(text) if pace is None else self.tts.synthesize(text, pace=pace), timeout=10)
            st.spoken = [text]
            await self._play(mulaw, st)
            self._commit_turn(st, interrupted=False)
            self._event("tts_recovered", {"turn": turn})
            log.info("Recovered from TTS failure with one-shot synthesis")
            await self._after_reply()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("TTS recovery failed (%s) - using fallback line", type(exc).__name__)
            await self._speak_fallback(st, "tts_recovery_failed")

    def _next_fallback_line(self, reason: str) -> Tuple[str, bool]:
        """The "couldn't hear you" line once; a second one in a row closes the call politely
        instead (script "UNCLEAR AUDIO": only one clarification attempt). Returns (text, close)."""
        self._fallback_streak += 1
        close = self._fallback_streak > 1
        log.warning("Fallback line spoken (reason=%s, in a row=%d)%s", reason, self._fallback_streak,
                    " - closing the call" if close else "")
        self._event("fallback_line", {"turn": self.turn_index, "reason": reason, "close": close})
        if close:
            return self.ctx.silence_closing or silence_closing(self.cfg.CALL_LANGUAGE), True
        return fallback_reply(self.cfg.CALL_LANGUAGE), False

    async def _speak_fallback(self, st: _TurnState, reason: str) -> None:
        text, close = self._next_fallback_line(reason)
        try:
            pcm = self._line_audio.get(text) or await synthesize_line(self.tts, text, self.pauses)
            st.is_greeting = False
            st.spoken = [clean_spoken_text(text)]
            await self._play(pcm, st)
            # Recorded like any reply, so the LLM knows it already asked once and the
            # customer's words are kept in history instead of piling up unanswered.
            self._commit_turn(st, interrupted=False)
            if close:
                self.end_call_requested = True
            await self._after_reply()
        except Exception as exc:
            log.error("Fallback speech failed: %s", type(exc).__name__)

    async def _hangup_after_playback(self) -> None:
        with call_context(self.call_id):
            remaining = max(0.0, self._playback_until - time.monotonic())
            try:
                await asyncio.wait_for(self._playback_done.wait(), timeout=remaining + 3.0)
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(0.4)  # let the last syllable reach the handset
            log.info("Agent ended the conversation - hanging up")
            self._event("agent_hangup")
            if self.ctx.provider_call_id:
                await self.providers.telephony(self.ctx.telephony_provider).hangup(self.ctx.provider_call_id)


# ===========================================================================
# Finalisation
# ===========================================================================
OUTCOME_TIMEOUT_SECONDS = 15.0
OUTCOME_RETRY_DELAY_SECONDS = 2.0


async def classify_outcome(llm: LLMProvider, transcript: str) -> Optional[str]:
    """Raw classifier reply, or None. Runs after the call has ended (detached teardown),
    so the one retry on a transient failure never delays the live conversation."""
    for attempt in range(2):
        try:
            return await asyncio.wait_for(llm.complete_raw(OUTCOME_SYSTEM, transcript), timeout=OUTCOME_TIMEOUT_SECONDS)
        except Exception as exc:
            kind = exc.kind if isinstance(exc, LLMError) else "timeout" if isinstance(exc, asyncio.TimeoutError) else "unknown"
            retryable = kind in LLMProvider.RETRYABLE
            if attempt == 0 and retryable:
                log.warning("Outcome classification failed (%s: %s) - retrying once", type(exc).__name__, kind)
                await asyncio.sleep(OUTCOME_RETRY_DELAY_SECONDS)
                continue
            log.warning("Outcome classification failed: %s (%s)", type(exc).__name__, kind)
            return None
    return None


async def finalize_conversation(call_id: str, llm: LLMProvider, reason: str) -> None:
    """Classify the outcome and close out the call record. Idempotent."""
    with call_context(call_id):
        async with session_factory()() as db:
            call = await repo.get_call(db, call_id)
            if call is None:
                return
            transcripts = await repo.list_transcripts(db, call_id)
            outcome, summary, reached = None, None, None
            if any(t.speaker == "customer" for t in transcripts):
                text = "\n".join(f"{'Customer' if t.speaker == 'customer' else 'Agent'}: {t.text}" for t in transcripts)
                raw = await classify_outcome(llm, text[:12000])
                if raw is None:
                    outcome = CallOutcome.unknown.value
                else:
                    outcome, summary = parse_outcome(raw)
                    reached = parse_reached(raw)
            await db.refresh(call)  # pick up outcomes set meanwhile (e.g. voicemail webhook)
            fields: Dict[str, Any] = {}
            if call.outcome in LOCKED_OUTCOMES:
                outcome = call.outcome  # hard signal wins over the transcript classifier
            elif outcome and (call.outcome in (None, "completed", "unknown") or outcome != "unknown"):
                fields["outcome"] = outcome
            elif not outcome and not call.outcome and call.answered_at is not None:
                fields["outcome"] = CallOutcome.completed.value  # answered, customer never spoke
            if summary:
                fields["summary"] = summary
            if fields:
                await repo.update_call(db, call, **fields)
            if outcome == CallOutcome.do_not_call.value:
                await repo.set_contact_dnd(db, call.contact_id, True)
                log.info("Contact marked Do-Not-Call")
            elif outcome == CallOutcome.callback_requested.value:
                await repo.add_followup(db, call.contact_id, call.id, f"Callback requested. {summary or ''}".strip())
            elif outcome == CallOutcome.interested.value and default_settings.TEAM_FOLLOWUP_ENABLED:
                await repo.add_followup(db, call.contact_id, call.id, f"Interested lead. {summary or ''}".strip())
            await repo.add_event(db, call_id, "conversation_finalized", {"reason": reason, "outcome": outcome, "reached": reached})
            # If Plivo's hangup webhook hasn't arrived yet, mark the call completed now;
            # the webhook will still fill in duration / hangup cause.
            if call.answered_at is not None and CallStatus(call.status) not in FINAL_CALL_STATUSES:
                await transition(db, call, CallStatus.completed, {"reason": reason},
                                 ended_at=call.ended_at or utcnow(), outcome=call.outcome or CallOutcome.completed.value)
            log.info("Call finalized (outcome=%s)", call.outcome)
            status_callback.notify(call, "finalized", transcripts)


async def load_call_context(call_id: str) -> Optional[CallContextData]:
    async with session_factory()() as db:
        call = await repo.get_call(db, call_id)
        if call is None:
            return None
        variables = dict(call.variables or {})
        flow_lines = {key: render_first_message(variables[f"flow_silence_{key}"], variables) or None
                      for key in ("reprompt", "closing") if variables.get(f"flow_silence_{key}")}
        return CallContextData(
            call_id=call.id,
            agent_prompt=call.agent.system_prompt,
            first_message=call.agent.first_message,
            variables=variables,
            voice_id=call.voice_id or call.agent.voice_id,
            provider_call_id=call.provider_call_id,
            contact_id=call.contact_id,
            telephony_provider=call.telephony_provider or "plivo",
            silence_reprompt=flow_lines.get("reprompt"),
            silence_closing=flow_lines.get("closing"),
            recording_notice=render_first_message(variables["flow_recording_notice"], variables) or None
            if variables.get("flow_recording_notice") else None,
            identity_question=variables.get("flow_identity_question") or None,
            identity_reask=variables.get("flow_identity_reask") or None,
            answered_at=call.answered_at,
        )
