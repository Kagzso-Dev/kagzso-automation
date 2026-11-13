"""Status callbacks to Dispatch (the email-automation-platform main API).

Calls placed with `run_id` / `log_id` (Dispatch's "AI Call" feature) report every
status change, and the outcome / summary / transcript once the conversation is
finalised, to STATUS_CALLBACK_URL. Each POST is signed:

    X-Kagzso-Timestamp: <unix seconds>
    X-Kagzso-Signature: sha256=<hex HMAC-SHA256(STATUS_CALLBACK_SECRET, "<timestamp>." + raw body)>

Delivery is fire-and-forget with a few retries: a slow or unreachable Dispatch
never blocks or breaks a live call (Dispatch also polls GET /api/calls/{id}).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from datetime import datetime
from typing import Any, Dict, Iterable, Optional, Set

import httpx

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger

log = get_logger("status_callback")

_TASKS: Set[asyncio.Task] = set()  # keep references so tasks aren't garbage-collected mid-flight
RETRY_DELAYS = (1.0, 3.0, 10.0)


def enabled(cfg: Settings = default_settings) -> bool:
    return bool(cfg.STATUS_CALLBACK_URL and cfg.STATUS_CALLBACK_SECRET.get_secret_value())


def sign(secret: str, timestamp: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def build_payload(call: Any, event: str, transcripts: Optional[Iterable[Any]] = None) -> Optional[Dict[str, Any]]:
    """Snapshot of the call for Dispatch, or None if the call didn't come from Dispatch.
    Built synchronously while the DB session is still open; never includes the phone number."""
    variables = getattr(call, "variables", None) or {}
    log_id = variables.get("log_id")
    if not log_id:
        return None
    payload: Dict[str, Any] = {
        "event": event,
        "call_id": call.id,
        "run_id": variables.get("run_id"),
        "log_id": log_id,
        "provider_call_id": call.provider_call_id,
        "status": call.status,
        "outcome": call.outcome,
        "summary": call.summary,
        "hangup_cause": call.hangup_cause,
        "duration_seconds": call.duration_seconds,
        "ended_at": _iso(call.ended_at),
    }
    if variables.get("flow_id"):  # call flow used (or fallen back from) - for audit on the Dispatch side
        payload.update({k: variables.get(k) for k in ("flow_id", "flow_version", "flow_fallback")})
    if variables.get("learned_business"):  # Dispatch fills the contact's empty Business field with it
        payload["learned_business"] = variables["learned_business"]
    from app.services.customer_questions import insights, learned  # it sends with this module: imported here, not at the top

    if questions := learned(variables):  # suggestions and counts for the agent's Knowledge tab in Dispatch
        payload["customer_questions"] = questions
    if found := insights(variables):  # sentiment and interest, for the call log and the customer's timeline in Dispatch
        payload["call_insights"] = found
    if transcripts is not None:
        payload["transcript"] = [{"speaker": t.speaker, "text": t.text} for t in transcripts]
    return payload


async def send(payload: Dict[str, Any], cfg: Settings = default_settings, client: Optional[httpx.AsyncClient] = None) -> bool:
    """POST one signed callback, retrying network errors / 5xx. Returns True on a 2xx."""
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    secret = cfg.STATUS_CALLBACK_SECRET.get_secret_value()
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=10.0)
    try:
        for attempt, delay in enumerate((0.0, *RETRY_DELAYS)):
            if delay:
                await asyncio.sleep(delay)
            ts = str(int(time.time()))
            headers = {"Content-Type": "application/json", "X-Kagzso-Timestamp": ts,
                       "X-Kagzso-Signature": sign(secret, ts, body)}
            try:
                resp = await client.post(cfg.STATUS_CALLBACK_URL, content=body, headers=headers)
            except httpx.HTTPError as exc:
                log.warning("Status callback attempt %d failed: %s", attempt + 1, type(exc).__name__)
                continue
            if resp.is_success:
                return True
            if resp.status_code < 500 and resp.status_code != 429:
                log.warning("Status callback rejected (HTTP %d) - not retrying", resp.status_code)
                return False
            log.warning("Status callback attempt %d got HTTP %d", attempt + 1, resp.status_code)
        return False
    finally:
        if own_client:
            await client.aclose()


def dispatch(payload: Dict[str, Any]) -> None:
    """Send in the background (tests replace this to capture payloads)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(send(payload))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def notify(call: Any, event: str = "status", transcripts: Optional[Iterable[Any]] = None) -> None:
    """Queue a callback for this call if it came from Dispatch and callbacks are configured.
    Never raises - a callback problem must not affect the call."""
    try:
        if not enabled():
            return
        payload = build_payload(call, event, transcripts)
        if payload is not None:
            dispatch(payload)
    except Exception as exc:
        log.warning("Status callback skipped: %s", type(exc).__name__)
