"""Can Plivo / Twilio reach this server at PUBLIC_BASE_URL?

Being *set* is not enough: a stopped ngrok tunnel, a stale URL or one that points at another
server means a call rings and then goes silent, and nothing says why. So this server calls
itself through the URL - GET <PUBLIC_BASE_URL>/health/self/<token>, the token random per
process - and only *this* server can answer it. Results are cached (a minute when reachable,
15 s when not) so /ready stays cheap.
"""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger

log = get_logger("public_url")

INSTANCE_TOKEN = secrets.token_hex(16)
PROBE_TIMEOUT_SECONDS = 5.0
OK_TTL_SECONDS = 60.0
FAIL_TTL_SECONDS = 15.0


@dataclass(frozen=True)
class PublicUrlCheck:
    reachable: Optional[bool]  # None = not checked (PUBLIC_URL_CHECK off, or no https URL)
    reason: Optional[str]  # why it is unreachable: a few words (it goes into hangup_cause), safe to show
    checked_at: float


_cache: Optional[PublicUrlCheck] = None


def is_own_token(token: str) -> bool:
    return secrets.compare_digest(token, INSTANCE_TOKEN)


async def _probe(url: str, transport: Optional[httpx.AsyncBaseTransport] = None) -> Optional[str]:
    """None when this server answered through the URL; otherwise a short reason. (transport: tests.)"""
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS, follow_redirects=False, transport=transport) as client:
            # ngrok shows browsers a warning page first; this header skips it.
            res = await client.get(url, headers={"ngrok-skip-browser-warning": "1"})
    except httpx.TimeoutException:
        return f"no answer within {PROBE_TIMEOUT_SECONDS:.0f}s"
    except httpx.HTTPError as exc:
        return f"can't connect ({type(exc).__name__})"
    if res.status_code == 200:
        try:
            if res.json().get("self") is True:
                return None
        except ValueError:
            pass
        return "answered by another server"
    ngrok_error = res.headers.get("ngrok-error-code")
    if ngrok_error == "ERR_NGROK_3200":
        return "ngrok tunnel offline"
    if ngrok_error:
        return f"ngrok {ngrok_error[:30]}"
    return f"HTTP {res.status_code}"


async def check_public_url(cfg: Settings = default_settings, *, force: bool = False) -> PublicUrlCheck:
    """Is PUBLIC_BASE_URL reaching this server? Cached; force=True checks again now."""
    global _cache
    if not cfg.PUBLIC_URL_CHECK or not cfg.PUBLIC_BASE_URL.startswith("https://"):
        return PublicUrlCheck(None, None, time.monotonic())
    if _cache is not None and not force:
        ttl = OK_TTL_SECONDS if _cache.reachable else FAIL_TTL_SECONDS
        if time.monotonic() - _cache.checked_at < ttl:
            return _cache
    reason = await _probe(f"{cfg.PUBLIC_BASE_URL}/health/self/{INSTANCE_TOKEN}")
    if reason and (_cache is None or _cache.reachable is not False):
        log.warning("PUBLIC_BASE_URL does not reach this server: %s", reason)  # once per outage, not per check
    _cache = PublicUrlCheck(reason is None, reason, time.monotonic())
    return _cache


def reset_public_url_cache() -> None:
    """Forget the last result (tests)."""
    global _cache
    _cache = None
