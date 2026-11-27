"""Sarvam AI text-to-speech (Bulbul).

Verified against https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert and
https://docs.sarvam.ai/api-reference-docs/text-to-speech/stream:

* REST  : POST https://api.sarvam.ai/text-to-speech
          header   api-subscription-key: <key>
          request  {text, language_code, model, speaker, pace, temperature,
                    speech_sample_rate, output_audio_codec}
          200      {"request_id", "audios": [<b64 audio>]}
* WS    : wss://api.sarvam.ai/text-to-speech/ws?model=<model>&send_completion_event=true
          header   Api-Subscription-Key: <key>
          client   {"type": "config", "data": {...}} first, then {"type": "text", "data": {"text"}},
                   {"type": "flush"}
          server   {"type": "audio", "data": {"audio": <b64>}} ...
                   {"type": "event", "data": {"event_type": "final"}} | {"type": "error", "data": {"message"}}

We ask for 16-bit linear PCM @ 8000 Hz (the docs list mulaw but say only MP3 is
guaranteed on the stream) and convert it to mu-law here - what Plivo plays.

Cloned voices (Instant Voice Cloning, beta; voice id "svc-<uuid>") are NOT Bulbul speakers: the
/text-to-speech `speaker` field is a closed list of stock names. Verified 2026-11-18 against
https://docs.sarvam.ai/api-reference/voice-cloning/clone, /clone-ws and /get-voice, and one real request:

* REST  : POST https://api.sarvam.ai/voices/clone   (multipart/form-data only)
          fields   voice_id, text (max 1000 chars), language_code, pace (0.5-2.0),
                   speech_sample_rate (8000 ok), output_audio_codec (wav | linear16 | mulaw ...)
          200      {"audio_b64": <b64 audio>, "request_id", "audio_duration"}  - no model, no temperature
* WS    : wss://api.sarvam.ai/voices/clone/ws?send_completion_event=true  (same messages as above)
          config   {voice_id, target_language_code (not language_code), pace, speech_sample_rate (a string),
                    output_audio_codec, min_buffer_size}
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import wave
from typing import AsyncIterator, List, Optional
from urllib.parse import urlencode

import httpx

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger
from app.core.voices import is_cloned_voice, is_v4_voice, offered_voice, voice_model
from app.services import audio_service as audio
from app.services.tts import TTSError, TTSProvider, TTSStream, apply_pronunciations

log = get_logger("tts.sarvam")

SAMPLE_RATE = 8000
PREVIEW_SAMPLE_RATE = 22050  # "Listen" previews play in a browser, not on a phone line
CLONE_PATH = "/voices/clone"
CLONE_MAX_CHARS = 1000  # POST /voices/clone rejects longer text (400)


def _split_text(text: str, limit: int = CLONE_MAX_CHARS) -> list:
    """Text in parts of at most `limit` characters, cut after a sentence end or else a space where possible."""
    parts = []
    while len(text) > limit:
        window = text[:limit]
        cut = max(window.rfind(p) for p in (". ", "? ", "! ", "। ", "\n"))
        cut = cut + 1 if cut > 0 else window.rfind(" ")
        cut = cut if cut > 0 else limit
        parts.append(text[:cut].strip())
        text = text[cut:].strip()
    return [p for p in parts + [text.strip()] if p]


def _http_error(status: int, detail: str) -> TTSError:
    if status in (401, 403):
        return TTSError("auth", f"Sarvam TTS authentication failed ({status})", status)
    if status == 429:
        return TTSError("rate_limit", "Sarvam TTS rate limit exceeded", status)
    if status in (400, 404, 422):
        return TTSError("invalid_request", f"Sarvam TTS rejected the request ({status}): {detail[:200]}", status)
    return TTSError("provider", f"Sarvam TTS provider error ({status}): {detail[:200]}", status)


def wav_to_mulaw(data: bytes) -> bytes:
    """WAV (16-bit mono, any rate) or raw 16-bit PCM @ 8 kHz -> mu-law 8 kHz."""
    if data[:4] != b"RIFF":
        return audio.pcm16_to_mulaw(data[: len(data) - len(data) % 2])
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise TTSError("provider", "Sarvam TTS returned unexpected audio (need 16-bit mono)")
        rate = w.getframerate()
        pcm = w.readframes(w.getnframes())
    if rate != SAMPLE_RATE:
        pcm = audio.resample_pcm16(pcm, rate, SAMPLE_RATE)
    return audio.pcm16_to_mulaw(pcm)


def _strip_wav_header(data: bytes) -> bytes:
    """A streamed chunk may start with a WAV header; return the PCM after its data chunk."""
    if data[:4] != b"RIFF":
        return data
    idx = data.find(b"data", 12)
    return data[idx + 8:] if idx >= 0 else b""


class SarvamTTS(TTSProvider):
    name = "sarvam"

    def __init__(self, cfg: Optional[Settings] = None, voice_id: Optional[str] = None,
                 client: Optional[httpx.AsyncClient] = None, exact_voice: bool = False):
        self.cfg = cfg or default_settings
        # Only offered voices (app/core/voices.py); anything else - a voice no longer offered,
        # or an old voice UUID on an older agent / call flow - plays as the main voice.
        # exact_voice: the admin page's speaker for another model (bulbul:v4-flash personas), used as given.
        self.voice_id = voice_id if exact_voice and voice_id else offered_voice(voice_id) or self.cfg.tts_speaker
        # A cloned voice (svc-...): Sarvam's /voices/clone API instead of Bulbul's /text-to-speech.
        self.cloned = is_cloned_voice(self.voice_id)
        self._client = client or httpx.AsyncClient(base_url=self.cfg.SARVAM_BASE_URL,
                                                   timeout=httpx.Timeout(20.0, connect=5.0),
                                                   limits=self.cfg.http_limits())

    @property
    def model(self) -> str:
        """The Bulbul model of this voice: bulbul:v4-flash for an offered v4 persona (SARVAM_TTS_V4_VOICES), else
        SARVAM_TTS_MODEL - the model always goes with its speaker."""
        return voice_model(self.voice_id, self.cfg.SARVAM_TTS_MODEL)

    @property
    def v4_persona(self) -> bool:
        return not self.cloned and is_v4_voice(self.voice_id)

    def _check(self) -> str:
        key = self.cfg.SARVAM_API_KEY.get_secret_value()
        if not key or not self.voice_id:
            raise TTSError("not_configured", "SARVAM_API_KEY / SARVAM_TTS_SPEAKER not set")
        return key

    def _pace(self, pace: Optional[float]) -> float:
        return self.cfg.SARVAM_TTS_PACE if pace is None else pace

    def _voice_settings(self, pace: Optional[float] = None) -> dict:
        if self.cloned:
            # Sarvam's clone API takes the pace (0.5-2.0) but has no model, speaker or temperature field.
            language = self.cfg.sarvam_language_code
            return {"voice_id": self.voice_id, "pace": self._pace(pace),
                    **({"language_code": language} if language != "unknown" else {})}
        return {
            "model": self.model,
            "language_code": self.cfg.sarvam_language_code,
            "speaker": self.voice_id,
            # bulbul:v3 accepts 0.5-2.0, per request (REST) or per config message (stream)
            "pace": self._pace(pace),
            "temperature": self.cfg.SARVAM_TTS_TEMPERATURE,
        }

    def _spoken(self, text: str) -> str:
        return apply_pronunciations(text, self.cfg.CALL_LANGUAGE)

    async def _clone_wavs(self, key: str, text: str, pace: Optional[float], rate: int) -> list:
        """POST /voices/clone (multipart form; the docs accept nothing else) for each part of at most 1000
        characters -> the WAV of each part, in order."""
        wavs = []
        for part in _split_text(self._spoken(text)):
            fields = {**self._voice_settings(pace), "text": part, "speech_sample_rate": rate, "output_audio_codec": "wav"}
            form = {name: (None, str(value)) for name, value in fields.items()}  # (None, value) = a plain form field
            try:
                resp = await self._client.post(CLONE_PATH, headers={"api-subscription-key": key}, files=form)
            except httpx.TimeoutException:
                raise TTSError("timeout", "Sarvam voice clone request timed out") from None
            except httpx.HTTPError as exc:
                raise TTSError("provider", f"Sarvam voice clone connection error: {type(exc).__name__}") from None
            if resp.status_code != 200:
                raise _http_error(resp.status_code, resp.text)
            try:
                data = resp.json()
                wavs.append(base64.b64decode(data.get("audio_b64") or data.get("audio") or ""))
            except ValueError as exc:
                raise TTSError("provider", f"Sarvam voice clone returned unreadable audio: {type(exc).__name__}") from None
            if not wavs[-1]:
                raise TTSError("provider", "Sarvam voice clone returned no audio")
        return wavs

    async def synthesize(self, text: str, pace: Optional[float] = None) -> bytes:
        key = self._check()
        if self.cloned:
            wavs = await self._clone_wavs(key, text, pace, SAMPLE_RATE)
            try:
                return b"".join(wav_to_mulaw(w) for w in wavs)
            except wave.Error as exc:
                raise TTSError("provider", f"Sarvam voice clone returned unreadable audio: {type(exc).__name__}") from None
        body = {**self._voice_settings(pace), "text": self._spoken(text),
                "speech_sample_rate": SAMPLE_RATE, "output_audio_codec": "wav"}
        try:
            resp = await self._client.post("/text-to-speech", headers={"api-subscription-key": key}, json=body)
        except httpx.TimeoutException:
            raise TTSError("timeout", "Sarvam TTS request timed out") from None
        except httpx.HTTPError as exc:
            raise TTSError("provider", f"Sarvam TTS connection error: {type(exc).__name__}") from None
        if resp.status_code != 200:
            raise _http_error(resp.status_code, resp.text)
        try:
            audios = resp.json().get("audios") or []
            return b"".join(wav_to_mulaw(base64.b64decode(a)) for a in audios)
        except (ValueError, wave.Error) as exc:
            raise TTSError("provider", f"Sarvam TTS returned unreadable audio: {type(exc).__name__}") from None

    async def synthesize_preview(self, text: str) -> bytes:
        """One short line as a browser-playable 16-bit mono WAV (the "Listen" preview; no call)."""
        key = self._check()
        if self.cloned:
            wavs = await self._clone_wavs(key, text, None, PREVIEW_SAMPLE_RATE)
        else:
            body = {**self._voice_settings(), "text": self._spoken(text),
                    "speech_sample_rate": PREVIEW_SAMPLE_RATE, "output_audio_codec": "wav"}
            try:
                resp = await self._client.post("/text-to-speech", headers={"api-subscription-key": key}, json=body)
            except httpx.TimeoutException:
                raise TTSError("timeout", "Sarvam TTS request timed out") from None
            except httpx.HTTPError as exc:
                raise TTSError("provider", f"Sarvam TTS connection error: {type(exc).__name__}") from None
            if resp.status_code != 200:
                raise _http_error(resp.status_code, resp.text)
            try:
                wavs = [base64.b64decode(a) for a in resp.json().get("audios") or []]
            except ValueError as exc:
                raise TTSError("provider", f"Sarvam TTS returned unreadable audio: {type(exc).__name__}") from None
        try:
            pcm, rate = b"", PREVIEW_SAMPLE_RATE
            for data in wavs:
                with wave.open(io.BytesIO(data)) as w:
                    if w.getsampwidth() != 2 or w.getnchannels() != 1:
                        raise TTSError("provider", "Sarvam TTS returned unexpected audio (need 16-bit mono)")
                    rate = w.getframerate()
                    pcm += w.readframes(w.getnframes())
        except (ValueError, wave.Error) as exc:
            raise TTSError("provider", f"Sarvam TTS returned unreadable audio: {type(exc).__name__}") from None
        if not pcm:
            raise TTSError("provider", "Sarvam TTS returned no audio")
        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(pcm)
        return out.getvalue()

    async def open_stream(self, pace: Optional[float] = None) -> TTSStream:
        key = self._check()
        if self.cloned and (self.cfg.SARVAM_TTS_CLONE_STREAM or "rest").strip().lower() != "websocket":
            return CloneSentenceStream(self, pace)
        stream = SarvamStream(self, key, pace)
        await stream.connect()
        return stream

    async def aclose(self) -> None:
        await self._client.aclose()


class CloneSentenceStream(TTSStream):
    """A cloned voice's live reply through Sarvam's REST clone API (SARVAM_TTS_CLONE_STREAM=rest, the default).

    Measured 2026-11-19 (Tamil, 8 kHz): Sarvam's clone socket dropped a reply that had a second flush (every agent
    reply flushes its first sentence) after 2.7 of its 4 s, and once sent no audio for 10 s; the REST request
    answered every time (1.1 s for a 13-character sentence). Here each sentence the call sends is synthesized at once,
    sentences in parallel, and played in order: the first sentence plays as soon as its audio arrives while the rest
    are being made. One request per sentence (Sarvam's limit: 60 a minute per account)."""

    speaks_each_text = True  # each text is spoken on its own: no buffer to fill, no flush needed (_ClonedStream)

    def __init__(self, tts: "SarvamTTS", pace: Optional[float] = None):
        self.tts = tts
        self._pace = pace
        self._jobs: "asyncio.Queue[Optional[asyncio.Future]]" = asyncio.Queue()
        self._pending: List[asyncio.Future] = []
        self._closed = False
        self._ended = False

    async def send_text(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if self._closed:
            raise TTSError("provider", "Sarvam voice clone stream is closed")
        job = asyncio.ensure_future(self.tts.synthesize(text) if self._pace is None
                                    else self.tts.synthesize(text, pace=self._pace))
        self._pending.append(job)
        await self._jobs.put(job)

    async def flush(self) -> None:
        return None  # every sentence is already being spoken on its own

    async def end_input(self) -> None:
        if not self._ended:
            self._ended = True
            await self._jobs.put(None)

    async def set_pace(self, pace: float) -> None:
        self._pace = pace  # for the sentences sent from now on

    async def audio(self) -> AsyncIterator[bytes]:
        while True:
            job = await self._jobs.get()
            if job is None:
                return
            mulaw = await job  # a Sarvam error reaches the call (and _ClonedStream's stock fallback)
            if mulaw:
                yield mulaw

    def is_open(self) -> bool:
        return not self._closed and not self._ended

    async def cancel(self) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        self._closed = True
        for job in self._pending:
            if not job.done():
                job.cancel()
        if not self._ended:
            self._ended = True
            self._jobs.put_nowait(None)


class SarvamStream(TTSStream):
    END_TIMEOUT_SECONDS = 10.0
    FINAL_GRACE_SECONDS = 0.4

    def __init__(self, tts: SarvamTTS, key: str, pace: Optional[float] = None):
        self.tts = tts
        self._key = key
        self._pace = pace
        self._ws = None
        self._closed = False
        self._input_ended = False
        self._odd = b""  # a PCM sample split across two chunks
        self._got_audio = False

    async def connect(self) -> None:
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus

        cfg = self.tts.cfg
        if self.tts.cloned:  # Sarvam's voice-clone socket: same messages, no model
            url = f"{cfg.SARVAM_TTS_CLONE_WS_URL}?{urlencode({'send_completion_event': 'true'})}"
        else:
            url = f"{cfg.SARVAM_TTS_WS_URL}?{urlencode({'model': self.tts.model, 'send_completion_event': 'true'})}"
        try:
            self._ws = await asyncio.wait_for(
                connect(url, additional_headers={"Api-Subscription-Key": self._key}, max_size=None, open_timeout=5),
                timeout=6,
            )
        except InvalidStatus as exc:
            raise _http_error(exc.response.status_code, "websocket handshake rejected") from None
        except (asyncio.TimeoutError, OSError) as exc:
            raise TTSError("timeout" if isinstance(exc, asyncio.TimeoutError) else "provider",
                           f"Sarvam TTS websocket connect failed: {type(exc).__name__}") from None
        await self._send_config()

    async def _send_config(self) -> None:
        voice = self.tts._voice_settings(self._pace)
        if self.tts.cloned and "language_code" in voice:  # the clone socket names it target_language_code
            voice["target_language_code"] = voice.pop("language_code")
        await self._send({"type": "config", "data": {
            **voice,
            "speech_sample_rate": str(SAMPLE_RATE),
            "output_audio_codec": "linear16",
            # We push whole sentences; SARVAM_TTS_MIN_BUFFER_CHARS (default 30) = start speaking
            # the first one as soon as possible.
            "min_buffer_size": min(200, max(30, self.tts.cfg.SARVAM_TTS_MIN_BUFFER_CHARS)),
        }})

    async def set_pace(self, pace: float) -> None:
        """Sarvam accepts a new config message at any time on the stream."""
        if pace != self._pace:
            self._pace = pace
            await self._send_config()

    async def _send(self, payload: dict) -> None:
        if self._ws is None or self._closed:
            raise TTSError("provider", "Sarvam TTS stream is closed")
        await self._ws.send(json.dumps(payload))

    async def send_text(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        # trailing space keeps word spacing between streamed sentences
        await self._send({"type": "text", "data": {"text": self.tts._spoken(text) + " "}})

    async def end_input(self) -> None:
        self._input_ended = True
        await self._send({"type": "flush"})

    async def flush(self) -> None:
        # Same message as end_input, but more text follows: audio() keeps reading after its "final".
        await self._send({"type": "flush"})

    def is_open(self) -> bool:
        if self._ws is None or self._closed:
            return False
        from websockets.protocol import State

        return getattr(self._ws, "state", None) is State.OPEN

    def _to_mulaw(self, raw: bytes) -> bytes:
        pcm = self._odd + _strip_wav_header(raw)
        cut = len(pcm) - len(pcm) % 2
        self._odd = pcm[cut:]
        return audio.pcm16_to_mulaw(pcm[:cut]) if cut else b""

    async def audio(self) -> AsyncIterator[bytes]:
        assert self._ws is not None
        from websockets.exceptions import ConnectionClosed

        final_seen = False
        while True:
            try:
                timeout = self.FINAL_GRACE_SECONDS if final_seen else self.END_TIMEOUT_SECONDS
                raw = await asyncio.wait_for(self._ws.recv(), timeout=timeout)
            except asyncio.TimeoutError:
                if final_seen:
                    return
                raise TTSError("timeout", "Sarvam TTS stopped sending audio") from None
            except ConnectionClosed:
                if self.tts.cloned and not self._got_audio and not self._closed:
                    # Closed by Sarvam before any audio (e.g. a voice id it refuses): an error, so the call says the
                    # line through one-shot synthesis (and the stock fallback voice) instead of staying silent.
                    raise TTSError("provider", "Sarvam voice clone stream closed before any audio") from None
                return
            msg = json.loads(raw)
            mtype = msg.get("type")
            data = msg.get("data") or {}
            if mtype == "audio" and data.get("audio"):
                final_seen = False
                self._got_audio = True
                chunk = self._to_mulaw(base64.b64decode(data["audio"]))
                if chunk:
                    yield chunk
            elif mtype == "event" and data.get("event_type") == "final":
                # "final" may follow each buffered chunk, not only our flush: once input has
                # ended, stop only if no more audio arrives shortly after it.
                final_seen = self._input_ended
            elif mtype == "error":
                status = int(data.get("code") or 500) if str(data.get("code") or "").isdigit() else 500
                raise _http_error(status, str(data.get("message") or ""))

    async def cancel(self) -> None:
        # Sarvam has no per-utterance cancel; closing the socket stops generation.
        await self.aclose()

    async def aclose(self) -> None:
        if self._ws is not None and not self._closed:
            self._closed = True
            try:
                await self._ws.close()
            except Exception:
                pass
