"""Call flow definition (schema_version 1).

A flow is the editable form of an agent's prompt: an ordered list of blocks that
are joined end to end into the system prompt, plus the fixed greeting line, the
silence lines and a duration limit. Dispatch stores and versions flows; this
module is the authoritative validator.

Locked blocks carry only a key. Their text comes from builtin/locked_blocks.json
(runtime customer data, customer data safety), so an editor can reorder the rest of
the script but can never change or drop them. Do-not-call, wrong person, outcome
rules, callback and safety rules 21-31 are editable text now (see UNLOCKED_KEYS);
the fixed rules appended in llm_service always apply on top of any flow.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.config import settings

BUILTIN_DIR = Path(__file__).resolve().parent / "builtin"
LOCKED_BLOCKS: Dict[str, str] = json.loads((BUILTIN_DIR / "locked_blocks.json").read_text(encoding="utf-8"))

FLOW_BASES = ("nila", "followup")
# Variables a flow may use. phone_number is deliberately absent: it is never spoken.
FLOW_VARIABLES = ("customer_name", "name", "honorific", "title", "gender", "addressed_name",
                  "follow_up_detail", "company_name", "business_type", "title_to_use", "time_greeting",
                  # pause markers: silence inside a line the system speaks (see FlowPauses)
                  "short_delay", "medium_delay", "long_delay")
BLOCK_GROUPS = ("greeting", "main_script", "questions", "objections", "closing", "tone", "rules")
MAX_BLOCK_CHARS = 8000
MAX_PROMPT_CHARS = 50000  # same ceiling as AgentCreate.system_prompt

_VAR_RE = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_FORBIDDEN = ("[[END_CALL]]",)  # the hang-up marker belongs to the fixed rules, never to a script


# Safety blocks that are editable text now. Published and older versions still carry them as
# {id, locked: key}: those keep loading and render byte for byte from LOCKED_BLOCKS, but they are
# optional (at most once) instead of required. The system's own rules (VOICE_RULES / SAFETY_RULES in
# llm_service) are appended after every flow and stay out of reach of any edit.
UNLOCKED_KEYS = ("nila_callback_request", "nila_do_not_call", "nila_outcome_rules", "nila_rules_safety",
                 "nila_wrong_person")


def required_locked_keys(base: str) -> List[str]:
    return sorted(k for k in LOCKED_BLOCKS if k.startswith(f"{base}_") and k not in UNLOCKED_KEYS)


def optional_locked_keys(base: str) -> List[str]:
    return sorted(k for k in UNLOCKED_KEYS if k.startswith(f"{base}_"))


def check_text(value: str, *, multiline: bool) -> str:
    if _CONTROL_RE.search(value):
        raise ValueError("contains control characters")
    if not multiline and ("\n" in value or "\r" in value):
        raise ValueError("must be a single line")
    for token in _FORBIDDEN:
        if token in value:
            raise ValueError(f"must not contain {token}")
    unknown = sorted({m.group(1) for m in _VAR_RE.finditer(value) if m.group(1) not in FLOW_VARIABLES})
    if unknown:
        raise ValueError(f"unknown variable(s): {', '.join('{{' + u + '}}' for u in unknown)}; "
                         f"allowed: {', '.join(FLOW_VARIABLES)}")
    return value


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FlowGreeting(_Strict):
    text: str = Field(..., min_length=1, max_length=300)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        return check_text(v, multiline=False)


_NAME_VAR_RE = re.compile(r"\{\{\s*(customer_name|name)\s*\}\}")


class FlowIdentity(_Strict):
    """The system-spoken identity question after a time-of-day opening ("Hi sir, Good morning."),
    and its re-ask. None / absent = the built-in lines (IDENTITY_QUESTION / IDENTITY_REASK)."""
    question: str = Field(..., min_length=1, max_length=200)
    reask: Optional[str] = Field(None, max_length=200)

    @field_validator("question", "reask")
    @classmethod
    def _text(cls, v: Optional[str]) -> Optional[str]:
        v = (v or "").strip()
        if not v:
            return None
        check_text(v, multiline=False)
        if not _NAME_VAR_RE.search(v):
            raise ValueError("must contain {{customer_name}} (it is skipped when the customer has no name)")
        return v

    @model_validator(mode="after")
    def _question(self) -> "FlowIdentity":
        if not self.question:
            raise ValueError("question is required (leave identity out to use the built-in line)")
        return self


class TextBlock(_Strict):
    id: str = Field(..., pattern=r"^[a-z0-9_]{1,40}$")
    group: Literal[BLOCK_GROUPS]  # type: ignore[valid-type]
    text: str = Field(..., min_length=1, max_length=MAX_BLOCK_CHARS)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        return check_text(v, multiline=True)


class LockedBlock(_Strict):
    id: str = Field(..., pattern=r"^[a-z0-9_]{1,40}$")
    locked: str = Field(..., max_length=60)

    @field_validator("locked")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in LOCKED_BLOCKS:
            raise ValueError(f"unknown locked block '{v}'")
        return v


class FlowSilence(_Strict):
    reprompt: str = Field(..., min_length=1, max_length=200)
    closing: str = Field(..., min_length=1, max_length=200)

    @field_validator("reprompt", "closing")
    @classmethod
    def _text(cls, v: str) -> str:
        return check_text(v, multiline=False)


class FlowLimits(_Strict):
    # Clamped to the server's MAX_CALL_DURATION_SECONDS when the call is placed.
    max_duration_sec: int = Field(..., ge=30, le=600)


class FlowPauses(_Strict):
    """Length of {{short_delay}} / {{medium_delay}} / {{long_delay}} in ms. A flow without it uses these defaults."""
    short_ms: int = Field(300, ge=0, le=3000)
    medium_ms: int = Field(700, ge=0, le=3000)
    long_ms: int = Field(1200, ge=0, le=3000)


class FlowTransfer(_Strict):
    # Stored only: live transfer is not implemented, so it cannot be switched on yet.
    enabled: Literal[False] = False
    number: Optional[str] = Field(None, pattern=r"^\+[1-9]\d{7,14}$")


class CallFlow(_Strict):
    schema_version: Literal[1]
    base: Literal[FLOW_BASES]  # type: ignore[valid-type]
    name: str = Field(..., min_length=1, max_length=100)
    # One backend per language: only flows in this backend's CALL_LANGUAGE (settings.call_language).
    language: str = Field(..., max_length=8)
    voice_id: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_-]{1,100}$")
    greeting: FlowGreeting
    blocks: List[Union[LockedBlock, TextBlock]] = Field(..., min_length=1, max_length=80)
    silence: FlowSilence
    limits: FlowLimits
    transfer: FlowTransfer = Field(default_factory=FlowTransfer)
    pauses: Optional[FlowPauses] = None  # None = DEFAULT pause lengths (flows saved before pauses existed)
    # Spoken word for word right after the greeting while CALL_RECORDING_ENABLED; None = no notice.
    recording_notice: Optional[str] = Field(None, max_length=300)
    # Identity question / re-ask spoken by the system; None = the built-in lines.
    identity: Optional[FlowIdentity] = None

    @field_validator("language")
    @classmethod
    def _language(cls, v: str) -> str:
        own = settings.call_language
        if v != own:
            raise ValueError(f"this voice backend calls in '{own}' (CALL_LANGUAGE); "
                             f"a '{v}' flow belongs to that language's voice backend")
        return v

    @field_validator("recording_notice")
    @classmethod
    def _notice(cls, v: Optional[str]) -> Optional[str]:
        v = (v or "").strip()
        return check_text(v, multiline=False) if v else None

    @model_validator(mode="after")
    def _blocks(self) -> "CallFlow":
        ids = [b.id for b in self.blocks]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"duplicate block id(s): {', '.join(dupes)}")
        locked = [b.locked for b in self.blocks if isinstance(b, LockedBlock)]
        required = required_locked_keys(self.base)
        optional = optional_locked_keys(self.base)
        missing = sorted(set(required) - set(locked))
        extra = sorted(set(locked) - set(required) - set(optional))
        twice = sorted({k for k in locked if locked.count(k) > 1})
        if missing or extra or twice:
            parts = ([f"missing {', '.join(missing)}"] if missing else []) + \
                    ([f"not allowed for base '{self.base}': {', '.join(extra)}"] if extra else []) + \
                    (["each locked block must appear exactly once"] if twice else [])
            raise ValueError("locked blocks: " + "; ".join(parts))
        if len(render_blocks(self)) > MAX_PROMPT_CHARS:
            raise ValueError(f"the script is longer than {MAX_PROMPT_CHARS} characters")
        return self


def render_blocks(flow: CallFlow) -> str:
    """The agent system prompt: blocks joined end to end (locked text from code)."""
    return "".join(LOCKED_BLOCKS[b.locked] if isinstance(b, LockedBlock) else b.text for b in flow.blocks)
