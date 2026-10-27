"""Call flows for Dispatch's "Call Flows" editor (X-API-Key protected).

    GET  /api/flows/builtin   built-in flows (the defaults to copy), locked block text, allowed variables
    POST /api/flows/preview   validate a flow and render it exactly as a call would (greeting, prompt, silence lines)
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import settings
from app.core.security import rate_limit, require_api_key
from app.core.voices import DEFAULT_VOICE, VOICES
from app.flows.loader import BUILTIN_FLOWS, FlowError, parse_flow
from app.flows.schema import BLOCK_GROUPS, FLOW_VARIABLES, LOCKED_BLOCKS, MAX_BLOCK_CHARS, MAX_PROMPT_CHARS, render_blocks
from app.schemas.calls import normalize_gender
from app.services.call_service import identity_after_greeting, identity_lines
from app.services.llm_service import build_call_variables, build_system_prompt, render_first_message

router = APIRouter(prefix="/api/flows", tags=["flows"], dependencies=[Depends(require_api_key)])


def _catalog_flow(flow: Any) -> Dict[str, Any]:
    """A built-in flow as JSON. Optional settings it doesn't use are left out (not null), so a copy
    made from it validates in Dispatch exactly like flows saved before those settings existed."""
    data = flow.model_dump(mode="json")
    for optional in ("pauses", "recording_notice", "identity"):
        if data.get(optional) is None:
            data.pop(optional, None)
    return data


@router.get("/builtin")
async def builtin_flows() -> Dict[str, Any]:
    return {
        # The only language this backend calls in (CALL_LANGUAGE); every flow it accepts has it.
        "language": settings.call_language,
        "flows": {base: _catalog_flow(flow) for base, flow in BUILTIN_FLOWS.items()},
        "locked_blocks": LOCKED_BLOCKS,
        # The editor warns when calls are recorded and a flow has no recording notice.
        "recording_enabled": settings.CALL_RECORDING_ENABLED,
        "variables": list(FLOW_VARIABLES),
        "groups": list(BLOCK_GROUPS),
        "limits": {"max_duration_sec": settings.MAX_CALL_DURATION_SECONDS, "max_block_chars": MAX_BLOCK_CHARS,
                   "max_prompt_chars": MAX_PROMPT_CHARS},
        # The voices a flow may pick (app/core/voices.py - the only list); any other voice plays as default_voice.
        "voices": VOICES,
        "default_voice": DEFAULT_VOICE,
    }


class SampleCustomer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    customer_name: Optional[str] = Field(None, max_length=100)
    gender: Optional[str] = Field(None, max_length=20)
    company_name: Optional[str] = Field(None, max_length=150)
    business_type: Optional[str] = Field(None, max_length=100)
    follow_up_detail: Optional[str] = Field(None, max_length=500)


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    flow: Dict[str, Any]
    sample: SampleCustomer = Field(default_factory=SampleCustomer)


class PreviewResponse(BaseModel):
    valid: bool
    errors: List[str] = []
    greeting: Optional[str] = None
    system_prompt: Optional[str] = None
    script_chars: Optional[int] = None
    silence_reprompt: Optional[str] = None
    silence_closing: Optional[str] = None
    max_duration_sec: Optional[int] = None
    # System-spoken after a time-of-day opening; None when the opening names the customer or
    # the sample customer has no name (the question is skipped then).
    identity_question: Optional[str] = None
    identity_reask: Optional[str] = None


@router.post("/preview", response_model=PreviewResponse, dependencies=[Depends(rate_limit(120))])
async def preview_flow(body: PreviewRequest) -> PreviewResponse:
    try:
        flow = parse_flow(body.flow)
    except FlowError as exc:
        return PreviewResponse(valid=False, errors=exc.errors)
    s = body.sample
    variables = build_call_variables(s.customer_name, normalize_gender(s.gender), "+910000000000",
                                     follow_up_detail=s.follow_up_detail, company_name=s.company_name,
                                     business_type=s.business_type)
    if flow.language_style == "pure":  # the prompt shown follows the flow's style, as in a call
        variables["flow_language_style"] = "pure"
    script = render_blocks(flow)
    question, reask = (identity_lines(variables, flow.identity.question if flow.identity else None,
                                      flow.identity.reask if flow.identity else None)
                       if identity_after_greeting(flow.greeting.text) else (None, None))
    return PreviewResponse(
        valid=True,
        greeting=render_first_message(flow.greeting.text, variables),
        system_prompt=build_system_prompt(script, variables),
        script_chars=len(script),
        silence_reprompt=render_first_message(flow.silence.reprompt, variables),
        silence_closing=render_first_message(flow.silence.closing, variables),
        max_duration_sec=min(flow.limits.max_duration_sec, settings.MAX_CALL_DURATION_SECONDS),
        identity_question=question,
        identity_reask=reask,
    )
