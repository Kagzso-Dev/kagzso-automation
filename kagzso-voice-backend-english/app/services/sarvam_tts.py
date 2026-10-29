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
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import wave
from typing import AsyncIterator, Optional
from urllib.parse import urlencode

import httpx

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger
from app.core.voices import offered_voice
from app.services import audio_service as audio
from app.services.tts import TTSError, TTSProvider, TTSStream, apply_pronunciations

log = get_logger("tts.sarvam")

SAMPLE_RATE = 8000
PREVIEW_SAMPLE_RATE = 22050  # "Listen" previews play in a browser, not on a phone line


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
        self._client = client or httpx.AsyncClient(base_url=self.cfg.SARVAM_BASE_URL,
                                                   timeout=httpx.Timeout(20.0, connect=5.0),
                                                   limits=self.cfg.http_limits())

    def _check(self) -> str:
        key = self.cfg.SARVAM_API_KEY.get_secret_value()
        if not key or not self.voice_id:
            raise TTSError("not_configured", "SARVAM_API_KEY / SARVAM_TTS_SPEAKER not set")
        return key

    def _voice_settings(self, pace: Optional[float] = None) -> dict:
        return {
            "model": self.cfg.SARVAM_TTS_MODEL,
            "language_code": self.cfg.sarvam_language_code,
            "speaker": self.voice_id,
            # bulbul:v3 accepts 0.5-2.0, per request (REST) or per config message (stream)
            "pace": self.cfg.SARVAM_TTS_PACE if pace is None else pace,
            "temperature": self.cfg.SARVAM_TTS_TEMPERATURE,
        }

    def _spoken(self, text: str) -> str:
        return apply_pronunciations(text, self.cfg.CALL_LANGUAGE)

    async def synthesize(self, text: str, pace: Optional[float] = None) -> bytes:
        key = self._check()
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
            pcm, rate = b"", PREVIEW_SAMPLE_RATE
            for a in resp.json().get("audios") or []:
                with wave.open(io.BytesIO(base64.b64decode(a))) as w:
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

    async def open_stream(self, pace: Optional[float] = None) -> "SarvamStream":
        key = self._check()
        stream = SarvamStream(self, key, pace)
        await stream.connect()
        return stream

    async def aclose(self) -> None:
        await self._client.aclose()


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

    async def connect(self) -> None:
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus

        query = urlencode({"model": self.tts.cfg.SARVAM_TTS_MODEL, "send_completion_event": "true"})
        url = f"{self.tts.cfg.SARVAM_TTS_WS_URL}?{query}"
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
        await self._send({"type": "config", "data": {
            **self.tts._voice_settings(self._pace),
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
                return
            msg = json.loads(raw)
            mtype = msg.get("type")
            data = msg.get("data") or {}
            if mtype == "audio" and data.get("audio"):
                final_seen = False
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
