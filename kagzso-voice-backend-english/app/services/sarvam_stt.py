"""Sarvam AI speech-to-text (REST).

Verified against https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
    POST https://api.sarvam.ai/speech-to-text   (multipart/form-data)
    header : api-subscription-key: <key>
    fields : file, model (saaras:v3 | saaras:v4), language_code (BCP-47 or "unknown"),
             mode (saaras:v3 only: transcribe | translate | verbatim | translit | codemix)
    200    : {"request_id", "transcript", "language_code", "language_probability"}

The service is isolated behind `STTProvider` so it can be swapped later.
"""
from __future__ import annotations

import asyncio
import json
import time
from abc import ABC, abstractmethod
from typing import Optional, TypedDict

import httpx

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger

log = get_logger("stt.sarvam")


class STTResult(TypedDict):
    text: str
    language: Optional[str]
    confidence: Optional[float]


class STTError(Exception):
    """Base STT error. `kind` is one of: auth, rate_limit, timeout, invalid_audio, provider, not_configured."""

    def __init__(self, kind: str, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code


class STTProvider(ABC):
    name: str = "base"

    @abstractmethod
    async def transcribe(self, audio_data: bytes, filename: str = "audio.wav", content_type: str = "audio/wav") -> STTResult:
        """Transcribe a complete audio file (WAV recommended, 16 kHz)."""

    async def prewarm(self) -> None:
        """Open the connection ahead of the next turn (default: nothing to do)."""
        return None

    def open_stream(self) -> Optional["STTStream"]:
        """A streaming session for one utterance, or None if streaming is unavailable."""
        return None

    async def aclose(self) -> None:  # pragma: no cover - default no-op
        return None


class STTStream(ABC):
    """One utterance streamed while the customer speaks; `finish` returns its transcript."""

    @abstractmethod
    def feed(self, pcm8k: bytes) -> None:
        """Queue PCM16 8 kHz audio (never blocks the media loop)."""

    @abstractmethod
    async def finish(self, timeout: float) -> STTResult:
        """End of speech: flush and return the final transcript (STTError on failure)."""

    @abstractmethod
    async def aclose(self) -> None: ...


def _error_from_response(resp: httpx.Response) -> STTError:
    code = resp.status_code
    detail = ""
    try:
        body = resp.json()
        err = body.get("error", body) if isinstance(body, dict) else {}
        detail = str(err.get("message") or err.get("code") or "")[:200] if isinstance(err, dict) else ""
    except Exception:
        detail = resp.text[:200]
    if code in (401, 403):
        return STTError("auth", f"Sarvam authentication failed ({code})", code)
    if code == 429:
        return STTError("rate_limit", "Sarvam rate limit exceeded", code)
    if code in (400, 413, 415, 422):
        return STTError("invalid_audio", f"Sarvam rejected the request ({code}): {detail}", code)
    if code == 504:
        return STTError("timeout", "Sarvam gateway timeout", code)
    return STTError("provider", f"Sarvam provider error ({code}): {detail}", code)


class SarvamSTT(STTProvider):
    name = "sarvam"

    def __init__(self, cfg: Optional[Settings] = None, client: Optional[httpx.AsyncClient] = None):
        self.cfg = cfg or default_settings
        self._client = client or httpx.AsyncClient(
            base_url=self.cfg.SARVAM_BASE_URL,
            timeout=httpx.Timeout(self.cfg.SARVAM_TIMEOUT_SECONDS, connect=5.0),
            limits=self.cfg.http_limits(),
        )

    async def prewarm(self) -> None:
        # No API key is sent: any response leaves a warm TLS connection in the pool.
        try:
            await self._client.head("/", timeout=3.0)
        except Exception:
            pass

    def open_stream(self) -> Optional[STTStream]:
        if not self.cfg.STT_STREAMING or not self.cfg.SARVAM_API_KEY.get_secret_value():
            return None
        from app.services.sarvam_stt_stream import SarvamSTTStream

        return SarvamSTTStream(self.cfg)

    async def transcribe(self, audio_data: bytes, filename: str = "audio.wav", content_type: str = "audio/wav") -> STTResult:
        key = self.cfg.SARVAM_API_KEY.get_secret_value()
        if not key:
            raise STTError("not_configured", "SARVAM_API_KEY is not set")
        if not audio_data or len(audio_data) < 100:
            raise STTError("invalid_audio", "audio is empty or too short")

        model = self.cfg.SARVAM_STT_MODEL
        try:
            return await self._request(key, model, audio_data, filename, content_type, attempts=2)
        except STTError as exc:
            fallback = (self.cfg.STT_FALLBACK_MODEL or "").strip()
            if not fallback or fallback == model or exc.kind in ("auth", "not_configured"):
                raise
            log.warning("Sarvam STT %s failed (%s) - trying %s once", model, exc.kind, fallback)
            return await self._request(key, fallback, audio_data, filename, content_type, attempts=1, fallback=True)

    def _form(self, model: str) -> dict:
        data = {"model": model, "language_code": self.cfg.sarvam_language_code}
        if model.startswith("saaras:v3"):
            data["mode"] = self.cfg.SARVAM_STT_MODE
        terms = self.cfg.stt_keyterms if model.startswith("saaras:v4") else []
        if terms:
            data["keyterms"] = json.dumps(terms)  # company names etc. (saaras:v4 only)
        return data

    async def _request(self, key: str, model: str, audio_data: bytes, filename: str, content_type: str,
                       attempts: int, fallback: bool = False) -> STTResult:
        data = self._form(model)
        started = time.monotonic()
        last_exc: Optional[STTError] = None
        for attempt in range(attempts):  # one quick retry on transient failures
            try:
                resp = await self._client.post(
                    "/speech-to-text",
                    headers={"api-subscription-key": key},
                    data=data,
                    files={"file": (filename, audio_data, content_type)},
                )
            except httpx.TimeoutException:
                last_exc = STTError("timeout", "Sarvam request timed out")
            except httpx.HTTPError as exc:
                last_exc = STTError("provider", f"Sarvam connection error: {type(exc).__name__}")
            else:
                if resp.status_code == 200:
                    result = self._parse(resp)
                    if self.cfg.STT_TIMING_LOG:
                        log.info("Sarvam STT %s: %dms%s%s", model, int((time.monotonic() - started) * 1000),
                                 " (keyterms)" if "keyterms" in data else "", " (fallback model)" if fallback else "")
                    return result
                last_exc = _error_from_response(resp)
                if last_exc.kind not in ("rate_limit", "provider", "timeout"):
                    break
            if attempt + 1 < attempts:
                log.warning("Sarvam STT %s, retrying once", last_exc.kind)
                await asyncio.sleep(0.25)
        assert last_exc is not None
        raise last_exc

    @staticmethod
    def _parse(resp: httpx.Response) -> STTResult:
        try:
            body = resp.json()
        except ValueError:
            raise STTError("provider", "Sarvam returned non-JSON response") from None
        return STTResult(
            text=(body.get("transcript") or "").strip(),
            language=body.get("language_code"),
            confidence=body.get("language_probability"),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def create_stt_provider(name: str = "sarvam", cfg: Optional[Settings] = None) -> STTProvider:
    if name.lower() == "sarvam":
        return SarvamSTT(cfg)
    raise ValueError(f"Unsupported STT provider: {name}")
