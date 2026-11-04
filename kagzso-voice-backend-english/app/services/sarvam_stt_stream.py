"""Sarvam AI streaming speech-to-text (websocket), one session per customer utterance.

Verified against https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws
    wss://api.sarvam.ai/speech-to-text/ws?model=..&language-code=..&mode=..&sample_rate=16000
                                          &input_audio_codec=pcm_s16le&flush_signal=true
    header : Api-Subscription-Key: <key>
    client : {"audio": {"data": <b64>, "sample_rate": "16000", "encoding": "audio/wav"}}
             {"type": "flush"}   (finalize the transcription of the buffered audio)
    server : {"type": "data", "data": {"transcript", "language_code", "language_probability", ...}}
             {"type": "error", "data": {"error", "code"}}   {"type": "events", ...} (VAD, unused)

Turn-taking is unchanged: our own VAD still decides when the customer has finished.
Audio is sent while they speak, so at end of speech only the flush remains. Any problem
(connect, error, no transcript in time) raises STTError and the caller uses the REST request.
"""
from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any, Awaitable, Callable, List, Optional
from urllib.parse import urlencode

from app.core.config import Settings
from app.core.logging import get_logger
from app.services import audio_service as audio
from app.services.sarvam_stt import STTError, STTResult, STTStream

log = get_logger("stt.sarvam.stream")

SEND_CHUNK_BYTES = 1600  # 100 ms of PCM16 @ 8 kHz per websocket message
FINAL_GRACE_SECONDS = 0.15  # after the first post-flush transcript, wait this long for more

Connector = Callable[[str, dict], Awaitable[Any]]


async def _default_connect(url: str, headers: dict) -> Any:
    from websockets.asyncio.client import connect

    return await asyncio.wait_for(connect(url, additional_headers=headers, max_size=None, open_timeout=5), timeout=6)


class SarvamSTTStream(STTStream):
    def __init__(self, cfg: Settings, connect: Optional[Connector] = None):
        self.cfg = cfg
        self._connect = connect or _default_connect
        self._queue: "asyncio.Queue[Optional[bytes]]" = asyncio.Queue()
        self._buf = b""
        self._ratecv_state = None
        self._ws: Any = None
        self._transcripts: List[str] = []
        self._language: Optional[str] = None
        self._confidence: Optional[float] = None
        self._flush_sent = False
        self._after_flush = asyncio.Event()  # a transcript arrived after the flush
        self._error: Optional[STTError] = None
        self._task = asyncio.create_task(self._run())

    # ------------------------------------------------------------------ public
    def feed(self, pcm8k: bytes) -> None:
        self._buf += pcm8k
        while len(self._buf) >= SEND_CHUNK_BYTES:
            self._queue.put_nowait(self._buf[:SEND_CHUNK_BYTES])
            self._buf = self._buf[SEND_CHUNK_BYTES:]

    async def finish(self, timeout: float) -> STTResult:
        if self._buf:
            self._queue.put_nowait(self._buf)
            self._buf = b""
        self._queue.put_nowait(None)  # -> flush
        t0 = time.monotonic()
        try:
            await asyncio.wait_for(self._after_flush.wait(), timeout)
        except asyncio.TimeoutError:
            raise self._error or STTError("timeout", f"no streamed transcript within {timeout:g}s") from None
        if self._error is not None:
            raise self._error
        # Sarvam may split one utterance into several segments: collect what follows shortly.
        seen = len(self._transcripts)
        while True:
            await asyncio.sleep(FINAL_GRACE_SECONDS)
            if len(self._transcripts) == seen:
                break
            seen = len(self._transcripts)
        log.info("Streamed STT final after flush: %dms", int((time.monotonic() - t0) * 1000))
        return STTResult(text=" ".join(t for t in self._transcripts if t).strip(),
                         language=self._language, confidence=self._confidence)

    async def aclose(self) -> None:
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass

    # ------------------------------------------------------------------ internals
    def _url(self) -> str:
        params = {
            "model": self.cfg.SARVAM_STT_MODEL,
            "language-code": self.cfg.sarvam_language_code,
            "sample_rate": str(audio.STT_SAMPLE_RATE),
            "input_audio_codec": "pcm_s16le",
            "flush_signal": "true",
        }
        if self.cfg.SARVAM_STT_MODEL.startswith("saaras:v3"):  # mode is a saaras:v3 setting (as the REST request)
            params["mode"] = self.cfg.SARVAM_STT_MODE
        return f"{self.cfg.SARVAM_STT_WS_URL}?{urlencode(params)}"

    def _to_stt_pcm(self, pcm8k: bytes) -> bytes:
        import audioop

        out, self._ratecv_state = audioop.ratecv(pcm8k, audio.SAMPLE_WIDTH, 1, audio.TELEPHONY_SAMPLE_RATE,
                                                 audio.STT_SAMPLE_RATE, self._ratecv_state)
        return out

    async def _run(self) -> None:
        key = self.cfg.SARVAM_API_KEY.get_secret_value()
        try:
            self._ws = await self._connect(self._url(), {"Api-Subscription-Key": key})
        except Exception as exc:
            self._fail(STTError("provider", f"Sarvam STT websocket connect failed: {type(exc).__name__}"))
            return
        reader = asyncio.create_task(self._read())
        try:
            while True:
                item = await self._queue.get()
                if item is None:
                    self._flush_sent = True
                    await self._ws.send(json.dumps({"type": "flush"}))
                    break
                payload = base64.b64encode(self._to_stt_pcm(item)).decode("ascii")
                await self._ws.send(json.dumps({"audio": {"data": payload, "sample_rate": str(audio.STT_SAMPLE_RATE),
                                                          "encoding": "audio/wav"}}))
            await reader
        except asyncio.CancelledError:
            reader.cancel()
            raise
        except Exception as exc:
            reader.cancel()
            self._fail(STTError("provider", f"Sarvam STT websocket error: {type(exc).__name__}"))

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                data = msg.get("data") or {}
                if msg.get("type") == "data":
                    self._transcripts.append((data.get("transcript") or "").strip())
                    self._language = data.get("language_code") or self._language
                    self._confidence = data.get("language_probability", self._confidence)
                    if self._flush_sent:
                        self._after_flush.set()
                elif msg.get("type") == "error":
                    code = str(data.get("code") or "")
                    kind = "auth" if code in ("401", "403") else "rate_limit" if code == "429" else "provider"
                    self._fail(STTError(kind, f"Sarvam STT stream error: {str(data.get('error') or '')[:200]}"))
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fail(STTError("provider", f"Sarvam STT websocket closed: {type(exc).__name__}"))

    def _fail(self, err: STTError) -> None:
        if self._error is None:
            self._error = err
        self._after_flush.set()
