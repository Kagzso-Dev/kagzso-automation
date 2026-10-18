"""Voice "Listen" previews (X-API-Key protected).

    POST /api/voices/preview   {voice_id, text} -> audio/wav of that voice saying the line

Text-to-speech only: nothing is dialled and no call or contact row is written.
The voice list itself is served with the flow catalog (GET /api/flows/builtin).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import settings
from app.core.security import require_api_key
from app.core.voices import VOICE_IDS, offered_voice
from app.services.call_service import get_providers
from app.services.tts import TTSError

router = APIRouter(prefix="/api/voices", tags=["voices"], dependencies=[Depends(require_api_key)])


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voice_id: str = Field(..., max_length=64)
    text: str = Field(..., min_length=1, max_length=200)


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
    try:
        wav = await tts.synthesize_preview(text)
    except TTSError as exc:
        code = {"auth": 502, "rate_limit": 429, "timeout": 504, "not_configured": 503}.get(exc.kind, 502)
        raise HTTPException(code, f"Voice preview failed: {exc}") from None
    return Response(content=wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})
