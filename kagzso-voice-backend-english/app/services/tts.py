"""Text-to-speech interface, shared error type and spoken-text fixes.

The provider (Sarvam Bulbul, app/services/sarvam_tts.py) returns mu-law 8 kHz
audio - exactly what the Plivo stream plays.
"""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from typing import AsyncIterator, Optional

from app.core.config import Settings

# ---------------------------------------------------------------------------
# Pronunciation fixes applied to text right before speech (transcripts keep the
# real spelling). "Kagzso" must be spoken as "Kexo".
# ---------------------------------------------------------------------------
BRAND_SPOKEN = {"ta": "கெக்ஸோ", "hi": "केक्सो", "kn": "ಕೆಕ್ಸೋ", "default": "Kexo"}
_BRAND_LATIN = re.compile(r"kagz?so|kexo", re.IGNORECASE)
# Tamil spellings the LLM may produce: காக்ஸோ, கேக்சோ, காக்ஸ்ஸோ, காக்ஜ்ஸோ, கெக்ஸோ ...
_BRAND_TAMIL = re.compile(r"க[ாேெ]?க்(?:ஸ்ஸ|ஸ|ச|ஜ்ஸ|ஜ்ச)[ோொ]")


def brand_spoken(language: Optional[str]) -> str:
    code = (language or "").split("-")[0].lower()
    return BRAND_SPOKEN.get(code, BRAND_SPOKEN["default"])


_BRAND_WEBSITE = re.compile(r"(?:https?://)?(?:www\.)?(?:kagz?so|kexo|கெக்ஸோ|केक्सो|ಕೆಕ್ಸೋ)\.com", re.IGNORECASE)


def apply_pronunciations(text: str, language: Optional[str]) -> str:
    spoken = brand_spoken(language)
    text = _BRAND_WEBSITE.sub(f"{spoken} dot com", text)
    return _BRAND_TAMIL.sub(spoken, _BRAND_LATIN.sub(spoken, text))


class TTSError(Exception):
    def __init__(self, kind: str, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.kind = kind  # auth | rate_limit | timeout | invalid_request | provider | not_configured
        self.status_code = status_code


class TTSStream(ABC):
    """One streamed utterance: push text incrementally, pull audio as it is generated."""

    @abstractmethod
    async def send_text(self, text: str) -> None: ...

    @abstractmethod
    async def end_input(self) -> None: ...

    @abstractmethod
    def audio(self) -> AsyncIterator[bytes]: ...

    @abstractmethod
    async def cancel(self) -> None: ...

    @abstractmethod
    async def aclose(self) -> None: ...

    async def set_pace(self, pace: float) -> None:
        """Speaking speed for the text sent from now on (providers without it ignore this)."""
        return None


class TTSProvider(ABC):
    name = "base"

    @abstractmethod
    async def synthesize(self, text: str, pace: Optional[float] = None) -> bytes:
        """Full utterance -> mu-law 8 kHz bytes. pace None = the configured speed."""

    @abstractmethod
    async def open_stream(self, pace: Optional[float] = None) -> TTSStream:
        """Open a streaming session (connect early to hide handshake latency)."""

    async def stream_synthesize(self, text: str) -> AsyncIterator[bytes]:
        stream = await self.open_stream()
        try:
            await stream.send_text(text)
            await stream.end_input()
            async for chunk in stream.audio():
                yield chunk
        finally:
            await stream.aclose()

    async def aclose(self) -> None:  # pragma: no cover
        return None


def create_tts_provider(name: str = "sarvam", cfg: Optional[Settings] = None, voice_id: Optional[str] = None) -> TTSProvider:
    if name.lower() == "sarvam":
        from app.services.sarvam_tts import SarvamTTS  # imports this module

        return SarvamTTS(cfg, voice_id=voice_id)
    raise ValueError(f"Unsupported TTS provider: {name}")
