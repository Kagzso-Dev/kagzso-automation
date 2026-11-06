from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

import phonenumbers
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator


def normalize_e164(value: str) -> str:
    """Validate and normalize a phone number to E.164 (+<country><number>)."""
    raw = (value or "").strip()
    if not raw.startswith("+"):
        raise ValueError("phone_number must be in E.164 format, e.g. +919876543210")
    try:
        parsed = phonenumbers.parse(raw, None)
    except phonenumbers.NumberParseException as exc:
        raise ValueError(f"invalid phone number: {exc}") from None
    if not phonenumbers.is_valid_number(parsed):
        raise ValueError("phone number is not a valid, dialable number")
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


def normalize_gender(value: Optional[str]) -> Optional[str]:
    """male / female pass through; anything else that was supplied becomes 'unknown'.
    Gender is never guessed - only the provided field is used."""
    if value is None or not str(value).strip():
        return None
    v = str(value).strip().lower()
    return {"m": "male", "male": "male", "f": "female", "female": "female"}.get(v, "unknown")


class VoiceTuning(BaseModel):
    """Voice response tuning from Dispatch (Settings → Voice response tuning; the same limits are in
    packages/shared/src/aiCallVoiceTuning.ts). Used only on a backend whose language has rules in
    app/services/turn_tuning.py: everywhere else it is ignored."""
    model_config = ConfigDict(extra="forbid")

    preset: str = Field("custom", max_length=16)
    finished_silence_ms: int = Field(..., ge=300, le=2000)
    end_of_speech_silence_ms: int = Field(..., ge=300, le=2000)
    extra_wait_if_incomplete_ms: int = Field(..., ge=0, le=2000)
    hard_cap_ms: int = Field(..., ge=0, le=5000)  # 0 = no cap
    min_words_before_reply: int = Field(1, ge=1, le=5)


class OutboundCallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phone_number: str = Field(..., examples=["+919876543210"])
    # The prompt calls this customer_name; both spellings are accepted.
    contact_name: Optional[str] = Field(None, max_length=100)
    customer_name: Optional[str] = Field(None, max_length=100)
    gender: Optional[str] = Field(None, max_length=20, examples=["male", "female", "unknown"])
    company_name: Optional[str] = Field(None, max_length=150)
    business_type: Optional[str] = Field(None, max_length=100, examples=["Restaurant"])
    email: Optional[EmailStr] = None
    # Either agent_id, or agent_name of an existing agent (e.g. the built-in "Follow-up").
    agent_id: Optional[int] = Field(None, ge=1)
    agent_name: Optional[str] = Field(None, min_length=1, max_length=100)
    # Follow-up calls from Dispatch: the reason for the call, rendered into the prompt.
    follow_up_detail: Optional[str] = Field(None, max_length=500)
    # The contact's own business from Dispatch, sent with every call. Kept on the call, never on the contact row, so a
    # change in Dispatch always counts. An autonomous agent's flow uses it as customer_business, every other call as
    # business_type, and an agent published before autonomous.contact_business ignores it.
    customer_business: Optional[str] = Field(None, max_length=200)
    # Dispatch "AI Greeting Delay": seconds after the answer before the agent greets (0 = at once).
    # Absent = the configured timing (FIRST_SPEECH_WAIT_SECONDS / GREETING_DELAY_MS), exactly as before.
    greeting_delay_sec: Optional[float] = Field(None, ge=0, le=10)
    # Dispatch's ids, echoed back on status callbacks (STATUS_CALLBACK_URL).
    run_id: Optional[str] = Field(None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    log_id: Optional[str] = Field(None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    # Call flow from Dispatch's "Call Flows" page. The definition is validated in
    # app/flows; if it is missing or invalid the call uses agent_id / agent_name.
    flow_id: Optional[str] = Field(None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    flow_version: Optional[int] = Field(None, ge=1, le=100000)
    flow_draft: bool = False  # unpublished draft (test calls only)
    flow: Optional[Dict[str, Any]] = None
    # 2 = a guided flow is requested (app/services/guided_call.py): run exactly that version or refuse the call,
    # never another flow or agent. A definition with schema_version 2 counts as a request too. None = as before.
    flow_schema: Optional[int] = Field(None, ge=1, le=2)
    # Absent = the call uses this backend's own settings, exactly as before.
    voice_tuning: Optional[VoiceTuning] = None

    @model_validator(mode="after")
    def _agent(self) -> "OutboundCallRequest":
        if self.agent_id is None and not self.agent_name:
            raise ValueError("agent_id or agent_name is required")
        if (self.flow_id is None) != (self.flow_version is None):
            raise ValueError("flow_id and flow_version must be sent together")
        if self.flow is not None and self.flow_id is None:
            raise ValueError("flow requires flow_id and flow_version")
        return self

    @field_validator("phone_number")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_e164(v)

    @field_validator("gender")
    @classmethod
    def _gender(cls, v: Optional[str]) -> Optional[str]:
        return normalize_gender(v)

    @property
    def name(self) -> Optional[str]:
        return self.customer_name or self.contact_name


class OutboundCallResponse(BaseModel):
    success: bool
    call_id: str
    provider_call_id: Optional[str]


class TranscriptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    speaker: str
    text: str
    interrupted: bool
    timestamp: datetime


class CallOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider_call_id: Optional[str]
    agent_id: int
    contact_id: int
    from_number: str
    to_number: str
    status: str
    direction: str
    started_at: Optional[datetime]
    answered_at: Optional[datetime]
    ended_at: Optional[datetime]
    duration_seconds: Optional[int]
    outcome: Optional[str]
    summary: Optional[str]
    hangup_cause: Optional[str]
    recording_url: Optional[str]
    created_at: datetime


class CallListItem(CallOut):
    contact_name: Optional[str] = None


class CallDetailOut(CallOut):
    transcripts: List[TranscriptOut] = []
    latency: List[dict] = []
    events: List[dict] = []
    # The business the customer said they run, on a call that had none on file.
    learned_business: Optional[str] = None


class TestTextRequest(BaseModel):
    text: str = Field("Hello! This is a quick test from Kagzso.", min_length=1, max_length=500)
