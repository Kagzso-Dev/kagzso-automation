"""Text-only guided conversation simulator: mocked customer turns and mocked LLM outputs through the real runner.

No audio, no provider, no database, no call. A conversation is a list of turns:

    {"customer": "We run a hotel.",
     "decision": {"intent": "answered", "captured": {"business_type": "hotel"}, "next": "stay", "asks": null},
     "reply": "A hotel, that helps.",          # the LLM's words after its decision line
     "model_raw": "...",                        # instead of decision + reply: the LLM's exact output (malformed tests)
     "heard": 1}                                # segments of the agent's PREVIOUS turn heard before the customer
                                                # spoke (None = all: an interruption cuts the rest)

Order per turn: the agent's previous plan is committed for what was heard, then the customer speaks, then the
runner plans the agent's next turn. scripts/guided_simulate.py prints a conversation file's transcript.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

from app.flows.guided import GuidedFlow
from app.flows.runner import FlowRunner, RunnerState, Safety, TurnPlan

SAMPLE_VARIABLES = {"customer_name": "Ragul", "gender": "male", "time_greeting": "Good morning"}


@dataclass
class SimTurn:
    customer: str
    model: Optional[str] = None
    heard: Optional[int] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "SimTurn":
        if "model_raw" in data:
            model = data["model_raw"]
        elif "decision" in data:
            model = json.dumps(data["decision"], ensure_ascii=False) + "\n" + str(data.get("reply", ""))
        else:
            model = None
        return cls(customer=data["customer"], model=model, heard=data.get("heard"))


@dataclass
class SimLine:
    speaker: str  # agent | customer
    text: str
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SimResult:
    lines: List[SimLine]
    plans: List[TurnPlan]
    states: List[Dict[str, Any]]  # the state after each commit (opening first)
    final: RunnerState
    answers: Dict[str, Any]

    def transcript(self) -> str:
        out = []
        for line in self.lines:
            if line.speaker == "customer":
                out.append(f"CUSTOMER: {line.text}")
                continue
            parts = []
            for seg, heard in zip(line.meta["segments"], line.meta["heard"]):
                tag = "" if seg["kind"] == "reply" else f"[{seg['kind']}] "
                parts.append(f"{tag}{seg['text']}" + ("" if heard else " (cut off)"))
            status = line.meta.get("status")
            note = f"   <{status}{': ' + ', '.join(line.meta['issues']) if line.meta.get('issues') else ''}>"
            out.append("AGENT: " + " | ".join(parts) + (note if status not in ("accepted", "opening") or line.meta.get("issues") else ""))
        return "\n".join(out)


def _renderer(variables: Mapping[str, Any]):
    from app.services.llm_service import render_first_message

    return lambda text: render_first_message(text, variables)


def _agent_line(plan: TurnPlan, heard: Optional[int]) -> SimLine:
    count = len(plan.segments) if heard is None else max(0, min(heard, len(plan.segments)))
    return SimLine("agent", plan.text, {
        "status": plan.status, "issues": list(plan.issues),
        "segments": [{"kind": s.kind, "text": s.text, "ref": s.ref} for s in plan.segments],
        "heard": [i < count for i in range(len(plan.segments))]})


def simulate(flow: GuidedFlow, turns: Sequence[SimTurn], *, team_followup: bool = False,
             safety: Optional[Safety] = None, variables: Optional[Mapping[str, Any]] = None) -> SimResult:
    runner = FlowRunner(flow, team_followup=team_followup, safety=safety,
                        render=_renderer(variables if variables is not None else SAMPLE_VARIABLES))
    state = runner.initial_state()
    pending = runner.opening(state)
    lines: List[SimLine] = []
    plans: List[TurnPlan] = [pending]
    states: List[Dict[str, Any]] = []
    for turn in turns:
        lines.append(_agent_line(pending, turn.heard))
        state = runner.commit(state, pending, turn.heard)
        states.append(state.to_dict())
        if state.ended:
            break
        lines.append(SimLine("customer", turn.customer))
        pending = runner.plan(state, turn.customer, turn.model)
        plans.append(pending)
    else:
        lines.append(_agent_line(pending, None))
        state = runner.commit(state, pending, None)
        states.append(state.to_dict())
    return SimResult(lines, plans, states, state, runner.answers(state))


def simulate_file(path: str, flow_path: Optional[str] = None) -> SimResult:
    """A conversation file (tests/fixtures/guided/conversations/*.json) through its flow."""
    from pathlib import Path

    from app.flows.guided import parse_guided_flow

    conv = json.loads(Path(path).read_text(encoding="utf-8"))
    base = Path(__file__).resolve().parent
    flow_file = Path(flow_path) if flow_path else base / "guided_examples" / conv.get("flow", "business_executive.en.json")
    flow = parse_guided_flow(json.loads(flow_file.read_text(encoding="utf-8")))
    return simulate(flow, [SimTurn.from_dict(t) for t in conv["turns"]], team_followup=bool(conv.get("team_followup")),
                    variables=conv.get("variables"))
