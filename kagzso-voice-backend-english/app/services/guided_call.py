"""Guided calls (schema_version 2) on the live call path, behind FLOW_GUIDED_ENABLED (off by default).

Starting a call (resolve_guided_flow): a request that sends a guided flow - or declares flow_schema 2 - runs that
exact flow version or is refused with a reason (GuidedCallError). It never falls back to Nila, Executive,
Follow-up or the requested agent. Refused when: the switch is off, the definition is missing or invalid, its
language is not this backend's CALL_LANGUAGE or not in FLOW_GUIDED_LANGUAGES, or the same flow version was
already run with different content (published versions are immutable). The definition is stored (canonical
JSON) as the system_prompt of its own agent row "guided:<flow id>@v<n>" and its sha-256 on the call, so the
answered call loads exactly that version (load_guided_flow checks the hash).

During the call (GuidedCall, used by call_service.CallSession): the greeting, identity question, silence lines,
recording notice and backend do-not-call handling work as for any flow. Every AI reply is one LLM call (or
two, FLOW_GUIDED_DECISION_MODE=separate) through the call's provider chain; nothing of it is spoken before the
runner (app/flows/runner.py) has checked the decision. The runner's plan is spoken through the normal TTS path,
and its state is committed only for what was heard (CallSession settles it). Every committed turn is saved as
call events (guided_turn, guided_state: stage, intents, collected answers); the outcome comes from the runner
when the flow reached a closing (meeting_requested is recorded as interested - the answers keep
meeting_requested true), else from the transcript classifier as for every call.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, settings as default_settings
from app.core.logging import get_logger
from app.db import repositories as repo
from app.db.models import Agent
from app.flows.guided import GuidedFlow, check_guided_flow, parse_guided_flow
from app.flows.runner import DECISION_FORMAT, FlowRunner, RunnerState, Safety, TurnPlan
from app.flows.training import runtime_json
from app.services.llm_service import build_system_prompt, render_first_message

log = get_logger("guided")

# A guided outcome as the call's outcome (only existing CallOutcome values; the answers keep the rest).
CALL_OUTCOMES = {"interested": "interested", "not_interested": "not_interested", "busy": "busy",
                 "do_not_call": "do_not_call", "wrong_person": "wrong_person",
                 "callback_requested": "callback_requested", "meeting_requested": "interested",
                 "completed": "completed"}


class GuidedCallError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def guided_requested(flow: Optional[Mapping[str, Any]], flow_schema: Optional[int]) -> bool:
    """The request asks for a guided flow: it says so (flow_schema 2) or its definition is schema_version 2."""
    return flow_schema == 2 or (isinstance(flow, Mapping) and flow.get("schema_version") == 2)


def canonical(flow: GuidedFlow) -> str:
    return json.dumps(flow.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class GuidedStart:
    agent: Agent
    flow: GuidedFlow
    variables: Dict[str, Optional[str]]
    time_limit: int
    event: Tuple[str, dict]


async def resolve_guided_flow(db: AsyncSession, flow_raw: Optional[Mapping[str, Any]], flow_id: Optional[str],
                              version: Optional[int], draft: bool, cfg: Settings = default_settings) -> GuidedStart:
    """The agent row and call variables for this exact guided flow version, or GuidedCallError (no fallback)."""
    if not cfg.FLOW_GUIDED_ENABLED:
        raise GuidedCallError(409, "guided_disabled",
                              "Guided call flows are switched off on this voice backend (FLOW_GUIDED_ENABLED)")
    if flow_raw is None or not flow_id or not version:
        raise GuidedCallError(422, "guided_flow_missing", "A guided call needs flow_id, flow_version and the flow")
    issues = check_guided_flow(flow_raw)
    if issues:
        codes = ", ".join(sorted({i.code for i in issues}))
        raise GuidedCallError(422, "guided_flow_invalid", f"The guided flow is not valid ({codes})")
    flow = parse_guided_flow(flow_raw)
    if flow.language != cfg.call_language:
        raise GuidedCallError(422, "guided_language_mismatch",
                              f"This voice backend calls in '{cfg.call_language}'; the flow is '{flow.language}'")
    if flow.language not in cfg.guided_languages:
        raise GuidedCallError(422, "guided_language_not_enabled",
                              f"Guided flows are not enabled for '{flow.language}' (FLOW_GUIDED_LANGUAGES)")
    text = canonical(flow)
    sha = digest(text)
    name = f"guided:{flow_id}@v{version}" + (f"-draft-{sha[:12]}" if draft else "")
    wanted = {"name": name, "description": f"Guided call flow '{flow.name}' v{version} sha256:{sha}"[:500],
              "system_prompt": text, "first_message": flow.greeting.text, "language": flow.language,
              "stt_provider": "sarvam", "llm_provider": "guided", "tts_provider": "sarvam",
              "voice_id": flow.voice_id, "active": True}
    agent = await repo.get_agent_by_name(db, name)
    if agent is None:
        agent = await repo.create_agent(db, **wanted)
        log.info("Guided flow agent created: %s", name)
    elif agent.system_prompt != text or agent.first_message != wanted["first_message"]:
        raise GuidedCallError(409, "guided_version_conflict",
                              f"{name} already exists with different content (published versions are immutable)")
    variables: Dict[str, Optional[str]] = {
        "flow_id": flow_id, "flow_version": str(version), "flow_draft": "true" if draft else "false",
        "flow_hash": sha, "flow_kind": "guided",
        "flow_silence_reprompt": flow.silence.reprompt, "flow_silence_closing": flow.silence.closing,
        "flow_dnc_line": flow.closings["do_not_call"].text,  # DNC_ENFORCE says the guided flow's own line
    }
    if flow.recording_notice:
        variables["flow_recording_notice"] = flow.recording_notice
    if flow.language_style == "pure":
        variables["flow_language_style"] = "pure"
    if flow.identity is not None:
        variables["flow_identity_question"] = flow.identity.question
        if flow.identity.reask:
            variables["flow_identity_reask"] = flow.identity.reask
    if flow.pauses is not None:
        variables.update({f"flow_pause_{k}": str(v) for k, v in flow.pauses.model_dump().items()})
    if training := runtime_json(flow.training, flow.language, flow.language_style):
        variables["flow_training"] = training
    time_limit = min(flow.limits.max_duration_sec, cfg.MAX_CALL_DURATION_SECONDS)
    info = {"flow_id": flow_id, "flow_version": str(version), "flow_draft": draft, "flow_hash": sha,
            "agent_id": agent.id, "time_limit": time_limit}
    return GuidedStart(agent, flow, variables, time_limit, ("flow:guided_selected", info))


def load_guided_flow(agent_prompt: str, flow_hash: Optional[str]) -> GuidedFlow:
    """The exact version a call was started with (its agent row), or ValueError."""
    if not flow_hash or digest(agent_prompt) != flow_hash:
        raise ValueError("the guided flow stored for this call does not match the version it was started with")
    return parse_guided_flow(json.loads(agent_prompt))


# ------------------------------------------------------------------ the prompt
GUIDED_INSTRUCTIONS = """# GUIDED CALL

You are {agent} on a live outbound phone call. A configured call flow controls this call and the system keeps \
track of where the call is. You listen, understand the customer and speak naturally within the current stage. \
The system says the flow's fixed lines itself: mandatory statements, exact questions, the AI disclosure and closings.

## Every reply
FIRST LINE: one JSON object and nothing else (the decision). THEN, on the next lines: only the words to say aloud. \
The words may be empty when the system's own lines follow ("system_says_after_your_words").
{decision_format}

## The decision
- intent: what the customer just did.
- captured: answers the customer actually gave, only for fields of this call flow (see "Current position"). \
Use {{"value": "...", "source": "inferred"}} only for something you concluded that they did not say. Never capture \
phone numbers, email addresses or other contact details.
- next: "stay", or one of "allowed_next" once the stage's work is done. The system checks it.
- asks: the natural-wording field your words ask about, or null. Ask at most one question. Never ask an \
exact-wording question yourself: the system asks it word for word.

## Your words
- Short and natural: one or two sentences, in reply to what the customer actually said.
- A question or an objection: answer briefly from the approved facts and training notes only, and set asks to \
null - the system then asks the pending question again.
- Never repeat what "system_says_after_your_words" will say, and never say a closing line yourself.
- Never invent prices, savings, features, guarantees, meetings, demos or callbacks. If you don't know, say so honestly.
- Title for the customer (empty = none): "{{{{title_to_use}}}}".

## This call flow: {name}
{stages}
"""


def guided_static_prompt(flow: GuidedFlow) -> str:
    """The part of the prompt that is the same on every turn of the call."""
    persona = flow.training.persona if flow.training is not None and flow.training.persona is not None else None
    agent = persona.agent_name if persona is not None and persona.agent_name else "the calling assistant"
    stages = "\n".join(f"- {s.id}: {s.objective}" for s in flow.stages)
    return GUIDED_INSTRUCTIONS.format(agent=agent, decision_format=DECISION_FORMAT, name=flow.name, stages=stages)


# ------------------------------------------------------------------ one call
class GuidedCall:
    """A call's runner and state. CallSession asks for the system prompt, hands over the model output, speaks
    the plan, then settles it with what was heard."""

    def __init__(self, flow: GuidedFlow, variables: Mapping[str, Any], cfg: Settings = default_settings,
                 safety: Optional[Safety] = None):
        self.flow, self.variables, self.cfg = flow, variables, cfg
        self.runner = FlowRunner(flow, team_followup=cfg.TEAM_FOLLOWUP_ENABLED, safety=safety,
                                 render=lambda text: render_first_message(text, variables))
        self.state: RunnerState = self.runner.initial_state()
        self.static_prompt = guided_static_prompt(flow)

    def system_text(self, history: Iterable[Mapping[str, str]], user_text: Optional[str]) -> str:
        position = {k: v for k, v in self.runner.prompt_state(self.state).items() if k != "decision_format"}
        last_reply = next((m.get("content") for m in reversed(list(history)) if m.get("role") == "assistant"), None)
        block = "\n\n--- Current position (updated every turn) ---\n" + json.dumps(position, ensure_ascii=False)
        return build_system_prompt(self.static_prompt, self.variables, self.flow.language, user_text, last_reply,
                                   guided=True, position=block)

    @staticmethod
    def decision_only(system_text: str) -> str:
        return system_text + "\n\nFor this turn write ONLY the first line (the decision JSON) and nothing else."

    @staticmethod
    def words_only(system_text: str, decision_line: str) -> str:
        return (system_text + "\n\nThe decision for this turn is already made: " + decision_line
                + "\nWrite ONLY the words to say aloud for it (no JSON, no decision line).")

    def plan(self, user_text: Optional[str], model_output: Optional[str]) -> TurnPlan:
        return self.runner.plan(self.state, user_text, model_output)

    def do_not_call_plan(self) -> TurnPlan:
        """The backend detected a do-not-call request (DNC_ENFORCE): the flow's closing, the call ends."""
        return self.runner.plan(self.state, None, json.dumps({"intent": "do_not_call", "next": "close:do_not_call"}))

    def settle(self, plan: TurnPlan, heard: Optional[int]) -> List[Tuple[str, dict]]:
        """Commit the plan for what was heard; the call events to save."""
        before = self.state
        self.state = self.runner.commit(before, plan, heard)
        count = len(plan.segments) if heard is None else max(0, min(heard, len(plan.segments)))
        turn = {"turn": self.state.turn, "stage_before": before.stage, "stage": self.state.stage,
                "status": plan.status, "intent": plan.intent, "issues": list(plan.issues),
                "segments": [s.kind for s in plan.segments], "heard": count,
                "captured": sorted(plan.captured), "ended": self.state.ended, "outcome": self.state.outcome}
        if plan.status in ("recovered",) or plan.issues:
            log.info("Guided turn %s: %s %s", self.state.turn, plan.status, ", ".join(plan.issues))
        return [("guided_turn", turn), ("guided_state", self.snapshot())]

    def snapshot(self) -> Dict[str, Any]:
        return {"state": self.state.to_dict(), "answers": self.runner.answers(self.state)}


def outcome_from_events(events: Iterable[Any]) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """(call outcome, answers) from a call's last guided_state event; (None, answers) if the flow did not reach
    a closing, (None, None) for a call without guided events."""
    last = None
    for e in events:
        if getattr(e, "event_type", None) == "guided_state":
            last = e
    if last is None or not isinstance(last.payload, dict):
        return None, None
    state, answers = last.payload.get("state") or {}, last.payload.get("answers")
    if not state.get("ended") or not state.get("outcome"):
        return None, answers
    return CALL_OUTCOMES.get(state["outcome"]), answers
