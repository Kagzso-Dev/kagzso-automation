"""Twilio bidirectional Media Stream WebSocket: WS /ws/twilio/media

Protocol (https://www.twilio.com/docs/voice/media-streams/websocket-messages):

  Twilio -> us
    {"event":"connected","protocol":"Call","version":"1.0.0"}
    {"event":"start","streamSid":"MZ..","start":{"streamSid","accountSid","callSid","tracks":["inbound"],
         "customParameters":{"call_id","token"},"mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000,"channels":1}}}
    {"event":"media","streamSid":"MZ..","media":{"track":"inbound","chunk","timestamp","payload":"<b64>"}}
    {"event":"mark","streamSid":"MZ..","mark":{"name":"..."}}     (our mark played, or cleared)
    {"event":"dtmf", ...}   {"event":"stop", ...}
  us -> Twilio (only these three are accepted)
    {"event":"media","streamSid":"MZ..","media":{"payload":"<b64 mulaw/8000, no header>"}}
    {"event":"mark","streamSid":"MZ..","mark":{"name":"turn-3"}}
    {"event":"clear","streamSid":"MZ.."}
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from app.core.logging import call_context, get_logger
from app.db import repositories as repo
from app.db.database import session_factory
from app.db.models import CallStatus
from app.services import audio_service as audio
from app.services import call_service, provider_registry
from app.services.session_store import get_session_store
from app.websocket.plivo_stream import _CLOSING, _authorize, _close_session

log = get_logger("twilio.stream")
router = APIRouter()


class TwilioMediaSender:
    def __init__(self, ws: WebSocket, stream_sid: str):
        self.ws = ws
        self.stream_sid = stream_sid
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
        await self._send({"event": "media", "streamSid": self.stream_sid,
                          "media": {"payload": audio.encode_base64(mulaw)}})

    async def clear(self) -> None:
        await self._send({"event": "clear", "streamSid": self.stream_sid})

    async def checkpoint(self, name: str) -> None:
        await self._send({"event": "mark", "streamSid": self.stream_sid, "mark": {"name": name}})


@router.websocket("/ws/twilio/media")
async def twilio_media(ws: WebSocket) -> None:
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
                continue
            event = msg.get("event")

            if event == "start":
                start = msg.get("start") or {}
                stream_sid = start.get("streamSid") or msg.get("streamSid") or ""
                call_sid = start.get("callSid")
                custom = start.get("customParameters") or {}
                resolved_call_id = await _authorize(custom.get("call_id"), custom.get("token"), call_sid)
                if not resolved_call_id:
                    log.warning("Rejected Twilio media stream: invalid token / unknown call")
                    await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                    return
                with call_context(resolved_call_id):
                    ctx = await call_service.load_call_context(resolved_call_id)
                    if ctx is None:
                        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
                        return
                    if call_sid:
                        ctx.provider_call_id = call_sid
                    ctx.telephony_provider = "twilio"
                    media_format = start.get("mediaFormat") or {}
                    log.info("Twilio connected (stream %s, format %s@%s)", stream_sid,
                             media_format.get("encoding"), media_format.get("sampleRate"))
                    async with session_factory()() as db:
                        call = await repo.get_call(db, resolved_call_id)
                        if call is not None:
                            await call_service.transition(
                                db, call, CallStatus.connected,
                                {"stream_id": stream_sid, "media_format": media_format},
                                stream_id=stream_sid,
                            )
                    await get_session_store().set_fields(resolved_call_id, stream_id=stream_sid,
                                                         provider_call_id=call_sid or "")
                    session = call_service.CallSession(ctx, TwilioMediaSender(ws, stream_sid),
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

            elif event == "mark" and session:
                await session.on_played((msg.get("mark") or {}).get("name") or "")
            elif event == "dtmf" and session:
                digit = (msg.get("dtmf") or {}).get("digit")
                with call_context(resolved_call_id):
                    session._event("dtmf", {"digit": digit})
            elif event == "stop":
                reason = "stream_stopped"
                with call_context(resolved_call_id):
                    log.info("Twilio stream stopped (%d media frames)", media_frames)
                break
    except WebSocketDisconnect:
        with call_context(resolved_call_id):
            log.info("Twilio stream disconnected (%d media frames)", media_frames)
    except Exception as exc:
        reason = "error"
        with call_context(resolved_call_id):
            log.exception("Twilio media stream error: %s", type(exc).__name__)
    finally:
        if session is not None:
            task = asyncio.create_task(_close_session(session, resolved_call_id, reason))
            _CLOSING.add(task)
            task.add_done_callback(_CLOSING.discard)
