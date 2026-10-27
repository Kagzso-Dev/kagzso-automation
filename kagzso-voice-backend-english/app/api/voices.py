"""Voice "Listen" previews (X-API-Key protected).

    POST /api/voices/preview   {voice_id, text, pauses?} -> audio/wav of that voice saying the line
                               ({{short_delay}} etc. in the line become real silence)

Text-to-speech only: nothing is dialled and no call or contact row is written.
The voice list itself is served with the flow catalog (GET /api/flows/builtin).
"""
from __future__ import annotations

import asyncio
import io
import logging
import wave
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import settings
from app.core.security import require_api_key
from app.core.voices import VOICE_IDS, offered_voice
from app.flows.schema import FlowPauses
from app.services.call_service import get_providers
from app.services.llm_service import has_pause_markers, split_pauses
from app.services.tts import TTSError

log = logging.getLogger("voice.api")

router = APIRouter(prefix="/api/voices", tags=["voices"], dependencies=[Depends(require_api_key)])


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voice_id: str = Field(..., max_length=64)
    text: str = Field(..., min_length=1, max_length=200)
    pauses: Optional[FlowPauses] = None  # the flow's pause lengths; None = the defaults


async def _preview_with_pauses(tts, text: str, pauses: FlowPauses) -> bytes:
    """The parts synthesized separately, joined by real silence of the flow's pause lengths."""
    parts = split_pauses(text, pauses.model_dump())
    wavs = await asyncio.gather(*(tts.synthesize_preview(p) for p, _, _ in parts))
    pcm, rate = b"", None
    for (_, requested, inserted), data in zip(parts, wavs):
        with wave.open(io.BytesIO(data)) as w:
            rate = rate or w.getframerate()
            pcm += w.readframes(w.getnframes())
        if inserted:
            pcm += b"\x00\x00" * (rate * inserted // 1000)
            log.info("Preview pause inserted: requested %d ms, actual %d ms", requested, inserted)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate or 22050)
        w.writeframes(pcm)
    return out.getvalue()


@router.post("/preview")
async def preview_voice(body: PreviewRequest) -> Response:
    voice = offered_voice(body.voice_id)
    if not voice:
        raise HTTPException(422, f"Unknown voice - choose one of: {', '.join(VOICE_IDS)}")
    text = " ".join(body.text.split())
    if not text:
        raise HTTPException(422, "Enter a sample line")
    if not settings.tts_configured():
        raise HTTPException(503, "Text-to-speech is not configured (SARVAM_API_KEY)")
    # Shares the providers' HTTP client (never closed here - live calls use it too).
    tts = get_providers().tts_for_voice(voice)
    if not hasattr(tts, "synthesize_preview"):
        raise HTTPException(503, "Voice previews need the Sarvam text-to-speech provider")
    async def synthesize() -> bytes:
        parts = split_pauses(text, (body.pauses or FlowPauses()).model_dump()) if has_pause_markers(text) else []
        if len(parts) > 1:
            return await _preview_with_pauses(tts, text, body.pauses or FlowPauses())
        # no markers (or only at the start / end): the line as before, markers never spoken
        return await tts.synthesize_preview(parts[0][0] if parts else text)

    try:
        try:
            wav = await synthesize()
        except TTSError as exc:
            # A dropped or slow connection to Sarvam is usually gone a moment later: try once more.
            if exc.kind != "timeout" and "connection error" not in str(exc):
                raise
            log.warning("Voice preview: %s - trying once more", exc)
            wav = await synthesize()
    except TTSError as exc:
        code = {"auth": 502, "rate_limit": 429, "timeout": 504, "not_configured": 503}.get(exc.kind, 502)
        raise HTTPException(code, f"Voice preview failed: {exc}") from None
    return Response(content=wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})
