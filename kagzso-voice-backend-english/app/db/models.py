"""ORM models. MySQL is the source of truth for all call data."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base

# BIGINT on MySQL, INTEGER on SQLite (so autoincrement works in tests).
BigIntPK = BigInteger().with_variant(Integer, "sqlite")


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def new_call_id() -> str:
    return uuid.uuid4().hex


class CallStatus(str, enum.Enum):
    created = "created"
    initiating = "initiating"
    ringing = "ringing"
    answered = "answered"
    connected = "connected"
    speaking = "speaking"
    listening = "listening"
    processing = "processing"
    completed = "completed"
    failed = "failed"
    busy = "busy"
    no_answer = "no_answer"
    cancelled = "cancelled"


FINAL_CALL_STATUSES = {CallStatus.completed, CallStatus.failed, CallStatus.busy, CallStatus.no_answer, CallStatus.cancelled}


class CallOutcome(str, enum.Enum):
    interested = "interested"
    not_interested = "not_interested"
    callback_requested = "callback_requested"
    do_not_call = "do_not_call"
    wrong_person = "wrong_person"
    busy = "busy"
    voicemail = "voicemail"
    no_answer = "no_answer"
    call_failed = "call_failed"
    completed = "completed"
    unknown = "unknown"


# Outcomes decided by hard signals (Plivo / machine detection) that the
# transcript-based classifier must never overwrite.
LOCKED_OUTCOMES = {CallOutcome.voicemail.value, CallOutcome.do_not_call.value}


class Gender(str, enum.Enum):
    male = "male"
    female = "female"
    unknown = "unknown"


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    system_prompt: Mapped[str] = mapped_column(Text)
    # Fixed opening line spoken verbatim (no LLM), e.g. "Hi {{customer_name}} {{title}}, ...".
    first_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    language: Mapped[str] = mapped_column(String(16), default="en")
    stt_provider: Mapped[str] = mapped_column(String(32), default="sarvam")
    llm_provider: Mapped[str] = mapped_column(String(32), default="gemini")
    tts_provider: Mapped[str] = mapped_column(String(32), default="sarvam")
    voice_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Contact(Base):
    __tablename__ = "contacts"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    name: Mapped[Optional[str]] = mapped_column(String(150), nullable=True)
    phone_number: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    company_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    gender: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # male | female | unknown
    business_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="new")
    dnd: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Call(Base):
    __tablename__ = "calls"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_call_id)
    # Plivo returns a request_uuid when the call is fired; the CallUUID is only
    # known once the call rings/answers. provider_call_id holds the CallUUID
    # when known (request_uuid until then).
    provider_call_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    provider_request_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    stream_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    telephony_provider: Mapped[str] = mapped_column(String(16), default="plivo")  # plivo | twilio
    voice_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # set when voice rotation is on
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id"))
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id"))
    from_number: Mapped[str] = mapped_column(String(20))
    to_number: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default=CallStatus.created.value, index=True)
    direction: Mapped[str] = mapped_column(String(10), default="outbound")
    variables: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    answered_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    duration_seconds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    outcome: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    hangup_cause: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    recording_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    agent: Mapped[Agent] = relationship(lazy="joined")
    contact: Mapped[Contact] = relationship(lazy="joined")
    transcripts: Mapped[List["Transcript"]] = relationship(
        back_populates="call", order_by="Transcript.id", lazy="selectin"
    )


class CallEvent(Base):
    __tablename__ = "call_events"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    call_id: Mapped[str] = mapped_column(ForeignKey("calls.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(50))
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Transcript(Base):
    __tablename__ = "transcripts"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    call_id: Mapped[str] = mapped_column(ForeignKey("calls.id"), index=True)
    speaker: Mapped[str] = mapped_column(String(10))  # customer | agent
    text: Mapped[str] = mapped_column(Text)
    interrupted: Mapped[bool] = mapped_column(Boolean, default=False)
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    call: Mapped[Call] = relationship(back_populates="transcripts")


class CallLatencyMetric(Base):
    """One row per conversational turn. All values in milliseconds."""

    __tablename__ = "call_latency_metrics"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    call_id: Mapped[str] = mapped_column(ForeignKey("calls.id"), index=True)
    turn_index: Mapped[int] = mapped_column(Integer)
    stt_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # T2 - T1
    llm_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # T4 - T3
    llm_first_token_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    tts_first_byte_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # T6 - T5
    total_response_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # T6 - T1
    # LATENCY_DETAIL_METRICS (migration 0005): null on older rows or when switched off.
    eos_wait_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # T1 - T0: end-of-speech silence
    tts_wait_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # first sentence waiting for TTS
    reply_delay_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # T6 - T0: the pause the customer hears
    reply_source: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)  # llm | scripted | prerendered
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Followup(Base):
    __tablename__ = "followups"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    call_id: Mapped[Optional[str]] = mapped_column(ForeignKey("calls.id"), nullable=True, index=True)
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id"), index=True)
    scheduled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


Index("ix_call_events_call_type", CallEvent.call_id, CallEvent.event_type)
