"""Plivo bidirectional audio-stream WebSocket: WS /ws/plivo/media

Protocol (https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-reference):

  Plivo -> us
    {"event":"start","sequenceNumber":1,"start":{"callId","streamId","accountId","tracks":["inbound"],
                                                 "mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000}}}
    {"event":"media","streamId",...,"media":{"track":"inbound","timestamp","chunk","payload":"<b64>"}}
    {"event":"dtmf", ...}   {"event":"playedStream","name"}   {"event":"clearedAudio"}   {"event":"stop"}
  us -> Plivo
    {"event":"playAudio","media":{"contentType":"audio/x-mulaw","sampleRate":8000,"payload":"<b64>"}}
    {"event":"clearAudio","streamId"}      {"event":"checkpoint","streamId","name"}
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from app.core.logging import call_context, get_logger
from app.core.security import verify_stream_token
from app.db import repositories as repo
from app.db.database import session_factory
from app.db.models import CallStatus
from app.services import audio_service as audio
from app.services import call_service, provider_registry
from app.services.session_store import get_session_store

log = get_logger("plivo.stream")
router = APIRouter()


class PlivoMediaSender:
    def __init__(self, ws: WebSocket, stream_id: str):
        self.ws = ws
        self.stream_id = stream_id
        self._lock = asyncio.Lock()
        self.closed = False

    async def _send(self, msg: dict) -> None:
        if self.closed:
            return
        async with self._lock:
            try:
                await self.ws.send_text(json.dumps(msg))
            except Exception:
                self.closed = True

    async def send_audio(self, mulaw: bytes) -> None:
        await self._send({
            "event": "playAudio",
            "media": {"contentType": "audio/x-mulaw", "sampleRate": 8000, "payload": audio.encode_base64(mulaw)},
        })

    async def clear(self) -> None:
        await self._send({"event": "clearAudio", "streamId": self.stream_id})

    async def checkpoint(self, name: str) -> None:
        await self._send({"event": "checkpoint", "streamId": self.stream_id, "name": name})


async def _authorize(call_id: Optional[str], token: Optional[str], plivo_call_uuid: Optional[str]) -> Optional[str]:
    """Accept the stream if the signed token matches, or (fallback) if Plivo's
    callId matches a call we just answered and that has no stream yet."""
    if call_id and verify_stream_token(call_id, token):
        return call_id
    if plivo_call_uuid:
        async with session_factory()() as db:
            call = await repo.get_call_by_provider_id(db, plivo_call_uuid)
            if call and call.status == CallStatus.answered.value and not call.stream_id:
                return call.id
    return None


@router.websocket("/ws/plivo/media")
async def plivo_media(ws: WebSocket, call_id: Optional[str] = Query(None), token: Optional[str] = Query(None)) -> None:
    await ws.accept()
    session: Optional[call_service.CallSession] = None
    resolved_call_id: Optional[str] = None
    reason = "disconnect"
    media_frames = 0
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                log.warning("Ignoring non-JSON stream message")
                continue
            event = msg.get("event")

            if event == "start":
                start = msg.get("start") or {}
                stream_id = start.get("streamId") or msg.get("streamId") or ""
                plivo_call_uuid = start.get("callId")
                resolved_call_id = await _authorize(call_id, token, plivo_call_uuid)
                if not resolved_call_id:
                    log.warning("Rejected media stream: invalid token / unknown call")
                    await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                    return
                with call_context(resolved_call_id):
                    ctx = await call_service.load_call_context(resolved_call_id)
                    if ctx is None:
                        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                        return
                    if plivo_call_uuid:
                        ctx.provider_call_id = plivo_call_uuid
                    media_format = start.get("mediaFormat") or {}
                    log.info("Plivo connected (stream %s, format %s@%s)", stream_id,
                             media_format.get("encoding"), media_format.get("sampleRate"))
                    async with session_factory()() as db:
                        call = await repo.get_call(db, resolved_call_id)
                        if call is not None:
                            await call_service.transition(
                                db, call, CallStatus.connected,
                                {"stream_id": stream_id, "media_format": media_format},
                                stream_id=stream_id,
                            )
                    await get_session_store().set_fields(resolved_call_id, stream_id=stream_id,
                                                         provider_call_id=ctx.provider_call_id or "")
                    # One provider snapshot for the whole call (admin AI provider settings, else .env).
                    session = call_service.CallSession(ctx, PlivoMediaSender(ws, stream_id),
                                                       providers=await provider_registry.providers_for_call())
                    await session.start()

            elif event == "media":
                if session is None:
                    continue
                media = msg.get("media") or {}
                if media.get("track", "inbound") != "inbound" or not media.get("payload"):
                    continue
                try:
                    chunk = audio.decode_base64(media["payload"])
                except (ValueError, TypeError):
                    continue
                media_frames += 1
                with call_context(resolved_call_id):
                    await session.on_media(chunk)

            elif event == "playedStream" and session:
                await session.on_played(msg.get("name") or "")
            elif event == "clearedAudio" and session:
                await session.on_cleared()
            elif event == "dtmf" and session:
                digit = (msg.get("dtmf") or {}).get("digit")
                with call_context(resolved_call_id):
                    log.info("DTMF received: %s", digit)
                    session._event("dtmf", {"digit": digit})
            elif event == "stop":
                reason = "stream_stopped"
                with call_context(resolved_call_id):
                    log.info("Plivo stream stopped (%d media frames)", media_frames)
                break
    except WebSocketDisconnect:
        with call_context(resolved_call_id):
            log.info("Plivo stream disconnected (%d media frames)", media_frames)
    except Exception as exc:
        reason = "error"
        with call_context(resolved_call_id):
            log.exception("Media stream error: %s", type(exc).__name__)
    finally:
        if session is not None:
            # Detach teardown (flush DB writes, classify outcome, mark DND) from the
            # socket task: the server may cancel the handler once the socket closes.
            task = asyncio.create_task(_close_session(session, resolved_call_id, reason))
            _CLOSING.add(task)
            task.add_done_callback(_CLOSING.discard)


_CLOSING: "set[asyncio.Task]" = set()


async def _close_session(session: call_service.CallSession, call_id: Optional[str], reason: str) -> None:
    with call_context(call_id):
        try:
            await session.close(reason)
        except Exception as exc:
            log.exception("Session teardown failed: %s", type(exc).__name__)
