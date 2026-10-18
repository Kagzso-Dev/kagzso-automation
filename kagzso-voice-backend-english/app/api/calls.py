from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import rate_limit, require_api_key
from app.db import repositories as repo
from app.db.database import get_db
from app.db.models import FINAL_CALL_STATUSES, CallStatus
from app.schemas.calls import CallDetailOut, CallListItem, CallOut, OutboundCallRequest, OutboundCallResponse
from app.services import call_service

router = APIRouter(prefix="/api/calls", tags=["calls"], dependencies=[Depends(require_api_key)])


@router.post("/outbound", response_model=OutboundCallResponse, dependencies=[Depends(rate_limit(10))])
async def create_outbound_call(req: OutboundCallRequest, db: AsyncSession = Depends(get_db)) -> OutboundCallResponse:
    try:
        call = await call_service.start_outbound_call(db, req)
    except call_service.CallError as exc:
        raise HTTPException(exc.status_code, exc.message) from None
    return OutboundCallResponse(success=True, call_id=call.id, provider_call_id=call.provider_call_id)


@router.get("", response_model=List[CallListItem])
async def list_calls(
    limit: int = Query(50, ge=1, le=200),
    status: Optional[str] = Query(None, max_length=20),
    db: AsyncSession = Depends(get_db),
) -> List[CallListItem]:
    out = []
    for call, contact_name in await repo.list_calls(db, limit, status):
        item = CallListItem.model_validate(call)
        item.contact_name = contact_name
        out.append(item)
    return out


@router.get("/{call_id}", response_model=CallDetailOut)
async def get_call(call_id: str, db: AsyncSession = Depends(get_db)) -> CallDetailOut:
    call = await repo.get_call(db, call_id)
    if call is None:
        raise HTTPException(404, "Call not found")
    out = CallDetailOut.model_validate(call)
    out.latency = [
        {"turn": m.turn_index, "stt_ms": m.stt_ms, "llm_ms": m.llm_ms, "llm_first_token_ms": m.llm_first_token_ms,
         "tts_first_byte_ms": m.tts_first_byte_ms, "total_response_ms": m.total_response_ms,
         "eos_wait_ms": m.eos_wait_ms, "tts_wait_ms": m.tts_wait_ms, "reply_delay_ms": m.reply_delay_ms,
         "reply_source": m.reply_source}
        for m in await repo.list_latency_metrics(db, call_id)
    ]
    out.events = [
        {"type": e.event_type, "payload": e.payload, "at": e.created_at.isoformat()}
        for e in await repo.list_events(db, call_id)
    ]
    return out


@router.post("/{call_id}/hangup", response_model=CallOut)
async def hangup_call(call_id: str, db: AsyncSession = Depends(get_db)) -> CallOut:
    call = await repo.get_call(db, call_id)
    if call is None:
        raise HTTPException(404, "Call not found")
    if CallStatus(call.status) in FINAL_CALL_STATUSES:
        raise HTTPException(409, f"Call already {call.status}")
    if not call.provider_call_id:
        raise HTTPException(409, "Call has no provider id yet")
    ok = await call_service.get_providers().telephony(call.telephony_provider).hangup(call.provider_call_id)
    if not ok:
        raise HTTPException(502, f"{call.telephony_provider.title()} hangup failed")
    await repo.add_event(db, call.id, "api_hangup_requested")
    return CallOut.model_validate(call)
