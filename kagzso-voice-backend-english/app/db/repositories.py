"""Data-access functions. Every function takes an AsyncSession; callers own
the transaction (most helpers commit, since call events must persist even if
a later step fails)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    FINAL_CALL_STATUSES,
    Agent,
    Call,
    CallEvent,
    CallLatencyMetric,
    Contact,
    Followup,
    Transcript,
    utcnow,
)


# ----------------------------- agents -----------------------------
async def get_agent(db: AsyncSession, agent_id: int) -> Optional[Agent]:
    return await db.get(Agent, agent_id)


# The screening agent is Nila; it was briefly renamed Radhi, then Kayal. Any of these names finds
# it, so a VOICE_AGENT_NAME or agent_name set to one of the interim names keeps working.
_SCREENING_AGENT_NAMES = ("Nila", "Radhi", "Kayal")
AGENT_NAME_ALIASES = {name: tuple(n for n in _SCREENING_AGENT_NAMES if n != name) for name in _SCREENING_AGENT_NAMES}


async def _agent_named(db: AsyncSession, name: str) -> Optional[Agent]:
    return (await db.execute(select(Agent).where(Agent.name == name).order_by(Agent.id).limit(1))).scalar_one_or_none()


async def get_agent_by_name(db: AsyncSession, name: str) -> Optional[Agent]:
    agent = await _agent_named(db, name)
    for other in AGENT_NAME_ALIASES.get(name, ()):
        if agent is not None:
            break
        agent = await _agent_named(db, other)
    return agent


async def list_agents(db: AsyncSession) -> Sequence[Agent]:
    return (await db.execute(select(Agent).order_by(Agent.id))).scalars().all()


async def create_agent(db: AsyncSession, **fields: Any) -> Agent:
    agent = Agent(**fields)
    db.add(agent)
    await db.commit()
    await db.refresh(agent)
    return agent


async def ensure_default_agent(db: AsyncSession, defaults: Dict[str, Any]) -> Agent:
    existing = (await db.execute(select(Agent).order_by(Agent.id).limit(1))).scalar_one_or_none()
    if existing:
        return existing
    return await create_agent(db, **defaults)


async def upsert_agent_by_name(db: AsyncSession, fields: Dict[str, Any]) -> Agent:
    """Create the named agent, or bring its stored fields in line with `fields`
    (used for built-in agents whose prompt lives in the repo). A row still stored under its
    old name (AGENT_NAME_ALIASES) is updated in place and keeps that name - renaming the row
    is left to the SQL script, never done here."""
    agent = await _agent_named(db, fields["name"])
    keep_name = False
    for other in AGENT_NAME_ALIASES.get(fields["name"], ()):
        if agent is not None:
            break
        agent = await _agent_named(db, other)
        keep_name = agent is not None
    if agent is None:
        return await create_agent(db, **fields)
    changed = False
    for k, v in fields.items():
        if keep_name and k == "name":
            continue
        if getattr(agent, k) != v:
            setattr(agent, k, v)
            changed = True
    if changed:
        await db.commit()
        await db.refresh(agent)
    return agent


# ----------------------------- contacts -----------------------------
async def get_contact_by_phone(db: AsyncSession, phone: str) -> Optional[Contact]:
    return (await db.execute(select(Contact).where(Contact.phone_number == phone))).scalar_one_or_none()


async def upsert_contact(
    db: AsyncSession,
    phone: str,
    name: Optional[str],
    company: Optional[str],
    email: Optional[str] = None,
    gender: Optional[str] = None,
    business_type: Optional[str] = None,
) -> Contact:
    contact = await get_contact_by_phone(db, phone)
    if contact is None:
        contact = Contact(phone_number=phone, name=name, company_name=company, email=email,
                          gender=gender, business_type=business_type)
        db.add(contact)
    else:
        if name:
            contact.name = name
        if company:
            contact.company_name = company
        if email:
            contact.email = email
        if gender:
            contact.gender = gender
        if business_type:
            contact.business_type = business_type
    await db.commit()
    await db.refresh(contact)
    return contact


async def set_contact_dnd(db: AsyncSession, contact_id: int, dnd: bool = True) -> None:
    contact = await db.get(Contact, contact_id)
    if contact:
        contact.dnd = dnd
        contact.status = "dnd" if dnd else contact.status
        await db.commit()


# ----------------------------- calls -----------------------------
async def create_call(db: AsyncSession, **fields: Any) -> Call:
    call = Call(**fields)
    db.add(call)
    await db.commit()
    await db.refresh(call)
    return call


async def next_rotation_voice(db: AsyncSession, voices: List[str]) -> str:
    """The voice after the one the most recent rotated call used (wraps around)."""
    stmt = select(Call.voice_id).where(Call.voice_id.is_not(None)).order_by(Call.created_at.desc(), Call.id.desc()).limit(1)
    last = (await db.execute(stmt)).scalar_one_or_none()
    return voices[(voices.index(last) + 1) % len(voices)] if last in voices else voices[0]


async def free_call_voice(db: AsyncSession, primary: str, voices: List[str], since: datetime) -> str:
    """`primary` unless a live call (not finished, created after `since`) is using it; then the
    first rotation voice no live call is using. If every voice is busy, rotate as before."""
    final = [s.value for s in FINAL_CALL_STATUSES]
    stmt = select(Call.voice_id).where(Call.voice_id.is_not(None), Call.status.not_in(final), Call.created_at >= since)
    in_use = set((await db.execute(stmt)).scalars().all())
    for voice in [primary, *[v for v in voices if v != primary]]:
        if voice not in in_use:
            return voice
    return await next_rotation_voice(db, voices)


async def get_call(db: AsyncSession, call_id: str) -> Optional[Call]:
    return await db.get(Call, call_id)


async def list_calls(db: AsyncSession, limit: int = 50, status: Optional[str] = None) -> List[tuple]:
    """Most recent calls first, each paired with its contact's name."""
    stmt = select(Call, Contact.name).join(Contact, Contact.id == Call.contact_id)
    if status:
        stmt = stmt.where(Call.status == status)
    stmt = stmt.order_by(Call.created_at.desc()).limit(limit)
    return list((await db.execute(stmt)).all())


async def get_call_by_provider_id(db: AsyncSession, provider_id: str) -> Optional[Call]:
    stmt = select(Call).where(or_(Call.provider_call_id == provider_id, Call.provider_request_id == provider_id))
    return (await db.execute(stmt)).scalars().first()


async def list_calls_in_status(db: AsyncSession, statuses: Sequence[str]) -> Sequence[Call]:
    return (await db.execute(select(Call).where(Call.status.in_(statuses)).order_by(Call.created_at))).scalars().all()


async def update_call(db: AsyncSession, call: Call, **fields: Any) -> Call:
    for k, v in fields.items():
        setattr(call, k, v)
    await db.commit()
    return call


async def add_event(db: AsyncSession, call_id: str, event_type: str, payload: Optional[dict] = None) -> None:
    db.add(CallEvent(call_id=call_id, event_type=event_type, payload=payload, created_at=utcnow()))
    await db.commit()


async def list_events(db: AsyncSession, call_id: str) -> Sequence[CallEvent]:
    stmt = select(CallEvent).where(CallEvent.call_id == call_id).order_by(CallEvent.id)
    return (await db.execute(stmt)).scalars().all()


async def add_transcript(
    db: AsyncSession,
    call_id: str,
    speaker: str,
    text: str,
    interrupted: bool = False,
    confidence: Optional[float] = None,
) -> None:
    db.add(
        Transcript(
            call_id=call_id, speaker=speaker, text=text, interrupted=interrupted,
            confidence=confidence, timestamp=utcnow(),
        )
    )
    await db.commit()


async def list_transcripts(db: AsyncSession, call_id: str) -> List[Transcript]:
    stmt = select(Transcript).where(Transcript.call_id == call_id).order_by(Transcript.id)
    return list((await db.execute(stmt)).scalars().all())


async def add_latency_metric(db: AsyncSession, call_id: str, turn_index: int, **metrics: Optional[int | str]) -> None:
    db.add(CallLatencyMetric(call_id=call_id, turn_index=turn_index, **metrics))
    await db.commit()


async def list_latency_metrics(db: AsyncSession, call_id: str) -> Sequence[CallLatencyMetric]:
    stmt = select(CallLatencyMetric).where(CallLatencyMetric.call_id == call_id).order_by(CallLatencyMetric.id)
    return (await db.execute(stmt)).scalars().all()


async def add_followup(db: AsyncSession, contact_id: int, call_id: Optional[str], notes: Optional[str]) -> None:
    db.add(Followup(contact_id=contact_id, call_id=call_id, notes=notes))
    await db.commit()
