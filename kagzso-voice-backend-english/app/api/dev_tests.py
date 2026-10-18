"""Development-only provider checks: POST /api/test/{llm,sarvam,tts,plivo}

Protected by X-API-Key and disabled (404) when APP_ENV=production. They make
one real, minimal request to each provider and report success + latency.
Credentials are never echoed back.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException

from app.core.config import settings
from app.core.security import rate_limit, require_api_key, require_dev_environment
from app.schemas.calls import TestTextRequest
from app.services import audio_service as audio
from app.services.call_service import get_providers
from app.services.tts import TTSError
from app.services.llm_service import DEFAULT_AGENT_PROMPT, LLMError
from app.services.plivo_service import PlivoError
from app.services.sarvam_stt import STTError

router = APIRouter(
    prefix="/api/test",
    tags=["dev-tests"],
    dependencies=[Depends(require_dev_environment), Depends(require_api_key), Depends(rate_limit(20))],
)

_SAMPLE_VARS = {"contact_name": "Arun", "company_name": "ABC Restaurant", "phone_number": "+910000000000"}


def _fail(provider: str, exc: Exception) -> HTTPException:
    kind = getattr(exc, "kind", "error")
    code = {"not_configured": 503, "auth": 401, "rate_limit": 429, "timeout": 504}.get(kind, 502)
    return HTTPException(code, {"provider": provider, "ok": False, "error": kind, "message": str(exc)[:300]})


@router.post("/llm")
async def test_llm(body: TestTextRequest = TestTextRequest(text="Hello?")) -> dict:
    t0 = time.monotonic()
    try:
        reply = await get_providers().llm.generate_response(DEFAULT_AGENT_PROMPT, [], body.text, _SAMPLE_VARS)
    except LLMError as exc:
        raise _fail("llm", exc) from None
    return {"provider": settings.LLM_PROVIDER, "model": settings.LLM_MODEL, "ok": True,
            "latency_ms": int((time.monotonic() - t0) * 1000), "reply": reply}


@router.post("/tts")
async def test_tts(body: TestTextRequest = TestTextRequest()) -> dict:
    tts = get_providers().tts
    t0 = time.monotonic()
    first_byte_ms = None
    total = 0
    try:
        async for chunk in tts.stream_synthesize(body.text):
            if first_byte_ms is None:
                first_byte_ms = int((time.monotonic() - t0) * 1000)
            total += len(chunk)
    except TTSError as exc:
        raise _fail("sarvam_tts", exc) from None
    return {"provider": "sarvam", "model": settings.SARVAM_TTS_MODEL, "speaker": settings.tts_speaker, "ok": total > 0,
            "first_audio_ms": first_byte_ms, "total_ms": int((time.monotonic() - t0) * 1000),
            "audio_bytes": total, "audio_seconds": round(audio.mulaw_duration_seconds(total), 2),
            "format": "pcm_mulaw 8000Hz (Plivo-ready)"}


@router.post("/sarvam")
async def test_sarvam(body: TestTextRequest = TestTextRequest()) -> dict:
    """Round trip: Sarvam TTS speaks `text` (if configured) -> telephony audio -> Sarvam STT.
    Without TTS, sends 1 s of silence just to verify authentication."""
    providers = get_providers()
    source = "silence"
    if settings.tts_configured():
        try:
            mulaw = await providers.tts.synthesize(body.text)
            source = "sarvam_tts"
        except TTSError:
            mulaw = audio.pcm16_to_mulaw(b"\x00\x00" * 8000)
    else:
        mulaw = audio.pcm16_to_mulaw(b"\x00\x00" * 8000)
    t0 = time.monotonic()
    try:
        result = await providers.stt.transcribe(audio.mulaw_to_stt_wav(mulaw))
    except STTError as exc:
        raise _fail("sarvam", exc) from None
    return {"provider": "sarvam", "model": settings.SARVAM_STT_MODEL, "ok": True, "audio_source": source,
            "latency_ms": int((time.monotonic() - t0) * 1000), "expected": body.text if source != "silence" else "",
            "result": result}


@router.post("/twilio")
async def test_twilio() -> dict:
    """Verifies Account SID / Auth Token by fetching the account. Does NOT place a call."""
    t0 = time.monotonic()
    try:
        info = await get_providers().telephony("twilio").verify_credentials()
    except PlivoError as exc:
        raise _fail("twilio", exc) from None
    return {
        "provider": "twilio", "ok": True, "latency_ms": int((time.monotonic() - t0) * 1000),
        "account_type": info.get("account_type"), "account_status": info.get("account_status"),
        "from_number_configured": bool(settings.TWILIO_FROM_NUMBER),
        "active_for_new_calls": settings.telephony_provider == "twilio",
        "public_base_url_https": settings.PUBLIC_BASE_URL.startswith("https://"),
    }


@router.post("/plivo")
async def test_plivo() -> dict:
    """Verifies Auth ID/Token by fetching account details. Does NOT place a call."""
    plivo = get_providers().plivo
    t0 = time.monotonic()
    try:
        info = await plivo.verify_credentials()
    except PlivoError as exc:
        raise _fail("plivo", exc) from None
    return {
        "provider": "plivo", "ok": True, "latency_ms": int((time.monotonic() - t0) * 1000),
        "account_type": info.get("account_type"),
        "from_number_configured": bool(settings.PLIVO_FROM_NUMBER),
        "public_base_url_https": settings.PUBLIC_BASE_URL.startswith("https://"),
        "answer_url_example": f"{settings.PUBLIC_BASE_URL}/api/webhooks/plivo/answer" if settings.PUBLIC_BASE_URL else None,
    }
