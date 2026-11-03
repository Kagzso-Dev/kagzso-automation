"""Call flows for Dispatch's "Call Flows" editor (X-API-Key protected).

    GET  /api/flows/builtin         built-in flows (the defaults to copy), locked block text, allowed variables
    POST /api/flows/preview         validate a flow and render it exactly as a call would (greeting, prompt, silence
                                    lines), plus its compiled training block and token sizes
    POST /api/flows/training-test   one customer message answered without and with the flow's Active training:
                                    "mock" (default) asks no provider (the reply is simulated from the picked
                                    entries); "real" asks one enabled LLM twice (never a phone number)
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger
from app.core.security import rate_limit, require_api_key
from app.core.voices import DEFAULT_VOICE, VOICES
from app.db.database import get_db
from app.flows.loader import BUILTIN_FLOWS, FlowError, parse_flow
from app.flows.schema import BLOCK_GROUPS, FLOW_VARIABLES, LOCKED_BLOCKS, MAX_BLOCK_CHARS, MAX_PROMPT_CHARS, render_blocks
from app.flows.training import (MOCK_WITHOUT, compile_training, estimate_tokens, mock_reply, runtime_payload,
                                worst_case_tokens)
from app.schemas.calls import normalize_gender
from app.services import provider_registry as registry
from app.services.call_service import identity_after_greeting, identity_lines
from app.services.llm_service import (LLMError, LLMProvider, build_call_variables, build_system_prompt,
                                      clean_spoken_text, extract_end_call, render_first_message, render_prompt,
                                      strip_pause_markers)

router = APIRouter(prefix="/api/flows", tags=["flows"], dependencies=[Depends(require_api_key)])
log = get_logger("flows")


def _catalog_flow(flow: Any) -> Dict[str, Any]:
    """A built-in flow as JSON. Optional settings it doesn't use are left out (not null), so a copy
    made from it validates in Dispatch exactly like flows saved before those settings existed."""
    data = flow.model_dump(mode="json")
    for optional in ("pauses", "recording_notice", "identity", "training"):
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
    # Training tab: the customer words the per-reply part of the training block is picked for.
    training_message: Optional[str] = Field(None, max_length=300)


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
    # The Active training compiled for training_message (shown even while the flow's switch is off),
    # its size, the most one reply's block can cost, and the cap. None = no Active training.
    training_block: Optional[str] = None
    training_tokens: Optional[int] = None
    training_max_tokens: Optional[int] = None
    training_cap: Optional[int] = None
    # The per-reply lines picked for training_message, and relevant ones left out by the cap.
    training_selected: Optional[List[str]] = None
    training_dropped: Optional[List[str]] = None


def _sample_variables(flow: Any, s: SampleCustomer, phone: str) -> Dict[str, Optional[str]]:
    variables = build_call_variables(s.customer_name, normalize_gender(s.gender), phone,
                                     follow_up_detail=s.follow_up_detail, company_name=s.company_name,
                                     business_type=s.business_type)
    if flow.language_style == "pure":  # the prompt shown follows the flow's style, as in a call
        variables["flow_language_style"] = "pure"
    return variables


@router.post("/preview", response_model=PreviewResponse, dependencies=[Depends(rate_limit(120))])
async def preview_flow(body: PreviewRequest) -> PreviewResponse:
    try:
        flow = parse_flow(body.flow)
    except FlowError as exc:
        return PreviewResponse(valid=False, errors=exc.errors)
    s = body.sample
    variables = _sample_variables(flow, s, "+910000000000")
    script = render_blocks(flow)
    training: Dict[str, Any] = {}
    payload = runtime_payload(flow.training, flow.language, flow.language_style, ignore_switch=True)
    if payload is not None:
        compiled = compile_training(payload, body.training_message)
        core, tail = worst_case_tokens(payload)
        training = {"training_block": render_prompt(compiled.text, variables), "training_tokens": compiled.tokens,
                    "training_max_tokens": core + tail, "training_cap": payload["cap"],
                    "training_selected": compiled.selected, "training_dropped": compiled.dropped}
        if flow.training is not None and flow.training.enabled:  # as a call would: only while switched on
            variables["flow_training"] = json.dumps(payload, ensure_ascii=False)
    question, reask = (identity_lines(variables, flow.identity.question if flow.identity else None,
                                      flow.identity.reask if flow.identity else None)
                       if identity_after_greeting(flow.greeting.text) else (None, None))
    return PreviewResponse(
        valid=True,
        greeting=render_first_message(flow.greeting.text, variables),
        system_prompt=build_system_prompt(script, variables, user_message=body.training_message),
        script_chars=len(script),
        silence_reprompt=render_first_message(flow.silence.reprompt, variables),
        silence_closing=render_first_message(flow.silence.closing, variables),
        max_duration_sec=min(flow.limits.max_duration_sec, settings.MAX_CALL_DURATION_SECONDS),
        identity_question=question,
        identity_reask=reask,
        **training,
    )


class TrainingTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    flow: Dict[str, Any]
    # "mock": no provider is asked (free). "real": provider_id answers twice (uses tokens).
    mode: Literal["mock", "real"] = "mock"  # absent = mock: a provider is only asked when "real" is said
    provider_id: Optional[str] = Field(None, pattern=r"^[a-z0-9_]{1,40}$")
    message: str = Field(..., min_length=1, max_length=300)
    sample: SampleCustomer = Field(default_factory=SampleCustomer)


async def _test_reply(link: LLMProvider, model: str, system: str, messages: List[Dict[str, str]]) -> Dict[str, Any]:
    started = time.monotonic()
    first: Optional[float] = None
    parts: List[str] = []

    async def collect() -> None:
        nonlocal first
        async for delta in link._stream(system, messages, model):
            if first is None:
                first = time.monotonic()
            parts.append(delta)

    out: Dict[str, Any] = {"prompt_tokens": estimate_tokens(system)}
    try:
        await asyncio.wait_for(collect(), timeout=25)
    except LLMError as exc:
        return {**out, "error": registry.safe_message(exc.kind, getattr(exc, "status_code", None))}
    except asyncio.TimeoutError:
        return {**out, "error": registry.safe_message("timeout")}
    text, ends = extract_end_call("".join(parts))
    return {**out, "reply": clean_spoken_text(text), "ends_call": ends,
            "first_token_ms": int((first - started) * 1000) if first else None,
            "total_ms": int((time.monotonic() - started) * 1000)}


@router.post("/training-test", dependencies=[Depends(rate_limit(10))])
async def training_test(body: TrainingTestRequest, db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """The flow's prompt without, then with, its Active training (switch on or off), for one customer
    message after the greeting. The sample customer has no phone number: none is ever sent."""
    try:
        flow = parse_flow(body.flow)
    except FlowError as exc:
        raise HTTPException(422, {"message": "The flow is not valid", "code": "invalid", "errors": exc.errors})
    payload = runtime_payload(flow.training, flow.language, flow.language_style, ignore_switch=True)
    if payload is None:
        raise HTTPException(400, {"message": "Make at least one training entry Active first", "code": "no_training"})
    if body.mode == "real" and not body.provider_id:
        raise HTTPException(400, {"message": "Pick an LLM provider for a real test", "code": "no_provider"})
    variables = _sample_variables(flow, body.sample, "")
    script = render_blocks(flow)
    message = body.message.strip()
    greeting = strip_pause_markers(render_first_message(flow.greeting.text, variables)).strip()
    history = [{"role": "assistant", "content": greeting}] if greeting else []
    messages = LLMProvider._messages(history, message)
    without = build_system_prompt(script, variables, user_message=message)
    trained = build_system_prompt(script, {**variables, "flow_training": json.dumps(payload, ensure_ascii=False)},
                                  user_message=message, last_reply=greeting or None)
    compiled = compile_training(payload, message, greeting or None)
    picked = {"selected": compiled.selected, "dropped": compiled.dropped}
    if body.mode == "mock":
        reply = render_first_message(mock_reply(payload, message, greeting or None), variables)
        log.info("Training test (mock): prompt ~%d -> ~%d tokens", estimate_tokens(without), estimate_tokens(trained))
        return {"mode": "mock", "provider_id": "mock", "model": "mock", **picked,
                "without": {"reply": MOCK_WITHOUT, "prompt_tokens": estimate_tokens(without), "first_token_ms": None},
                "with": {"reply": reply, "prompt_tokens": estimate_tokens(trained), "first_token_ms": None}}
    try:
        link, model = await registry.llm_for_test(db, body.provider_id or "")
    except registry.ProviderSettingsError as exc:
        raise HTTPException(exc.status, {"message": exc.message, "code": exc.code}) from None
    results = {"without": await _test_reply(link, model, without, messages),
               "with": await _test_reply(link, model, trained, messages)}
    # Never the message or the replies: which provider, and the sizes and timings only.
    log.info("Training test %s (%s): prompt ~%d -> ~%d tokens, first token %s -> %s ms", body.provider_id, model,
             results["without"]["prompt_tokens"], results["with"]["prompt_tokens"],
             results["without"].get("first_token_ms"), results["with"].get("first_token_ms"))
    return {"mode": "real", "provider_id": body.provider_id, "model": model, **picked, **results}
