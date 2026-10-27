from __future__ import annotations

import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.logging import get_logger
from app.db.database import check_database
from app.services.public_url import check_public_url, is_own_token
from app.services.session_store import get_session_store

router = APIRouter(tags=["health"])
log = get_logger("health")


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/health/self/{token}")
async def health_self(token: str) -> JSONResponse:
    """Answers only this process's own random token: proves PUBLIC_BASE_URL reaches *this* server."""
    if not is_own_token(token):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    return JSONResponse({"status": "ok", "self": True})


@router.get("/ready")
async def ready() -> JSONResponse:
    """Readiness: dependencies reachable + providers configured. Never returns secret values."""

    try:
        await asyncio.wait_for(check_database(), timeout=3)
        mysql_status = "ok"
    except Exception as exc:
        log.warning("MySQL readiness check failed: %s", type(exc).__name__)
        mysql_status = "error"

    def c(ok: bool) -> str:
        return "configured" if ok else "missing"

    # Set is not enough: Plivo / Twilio must reach this server through it (see services/public_url.py).
    public = await check_public_url()
    providers = {
        "telephony": c(settings.telephony_configured()),
        "public_base_url": "unreachable" if public.reachable is False else c(settings.PUBLIC_BASE_URL.startswith("https://")),
        "sarvam": c(settings.sarvam_configured()),
        "tts": c(settings.tts_configured()),
        "llm": c(settings.llm_configured()),
    }
    is_ready = mysql_status == "ok" and all(v == "configured" for v in providers.values())
    body = {
        "status": "ready" if is_ready else "not_ready",
        "mysql": mysql_status,
        "active_calls": get_session_store().active_count(),
        "providers": providers,
        # reachable: true / false, or null when not checked (PUBLIC_URL_CHECK=false).
        "public_base_url_check": {"url": settings.PUBLIC_BASE_URL or None, "reachable": public.reachable, "reason": public.reason},
        "telephony_provider": settings.telephony_provider,
        # One backend per language: Dispatch checks this matches the language it sends here.
        "language": settings.call_language,
        "tts_provider": "sarvam",
        "llm_provider": settings.LLM_PROVIDER,
    }
    return JSONResponse(body, status_code=200 if is_ready else 503)
