"""Deterministic runner for guided call flows (schema_version 2, app/flows/guided.py).

The LLM proposes, the runner decides. Each customer turn has two steps:

  plan(state, customer_text, model_output) -> TurnPlan
      Reads the LLM's output (a decision line, then the reply) and decides what is said. Nothing changes yet.
  commit(state, plan, heard) -> RunnerState
      Applies the plan for what the customer actually heard (`heard` = segments heard in full; None = all).

Order of checks in plan():
  1. Do-not-call (code detector, or the decision says so): the do_not_call closing, word for word. The call ends
     even if the customer talks over it.
  2. "Are you an AI?" (code detector, or the decision): the flow's disclosure word for word, then the pending
     statement / question again. The LLM's reply is not used.
  3. No decision, a malformed one or markup in the reply: RECOVERY - the LLM's text is never spoken. The
     runner says the stage's pending mandatory statements and the configured question of the first pending
     required field, or the flow's clarify_line.
  4. Refusal, busy, end request: their closing (a stage rule naming the intent may pick another closing).
  5. Unclear: the stage's clarification (retries.line, else the LLM's reply if it stays, else clarify_line) up
     to retries.unclear times in a row, then retries.then (default close:no_response).
  6. The stage's rules, in order, on the intent and the answers collected so far (the LLM's proposal is never
     a condition). Another stage only once this one is complete: its mandatory statements heard and its
     required fields collected. A closing the rules don't reach, or a stage change they don't allow, is refused
     (recovery).
     A move the rules require that the LLM didn't propose still happens: its reply is kept only when it asks
     nothing, then the next stage's statements and first question follow.
  7. Staying: the reply (it may be empty when the system's own lines follow), then any unsaid mandatory
     statement, then - when the reply asks nothing (`asks` is null) - the configured question of the first
     pending required field. A reply that asks something counts as the turn's one question. Exact-wording
     questions are always asked by the runner, never by the LLM.

State only moves on what was heard: a statement counts as said, a question as asked, a stage as entered and a
closing as reached only when that segment was heard in full. Answers the customer gave are kept whatever
happened to the reply. Not connected to calls yet (Phase 1).
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from app.flows.guided import (INTENTS, REFUSAL_INTENTS, RUNNER_FIELDS, STANDARD_FIELDS, CollectField, GuidedFlow,
                              Stage, When, text_codes)

MAX_ANSWER_CHARS = 300
DECISION_FORMAT = (
    'First line: one JSON object, nothing else: {"intent": "<one of: ' + ", ".join(INTENTS) + '>", '
    '"captured": {"<field>": "<the customer\'s answer>" or {"value": "...", "source": "inferred"}}, '
    '"next": "stay" | "<stage id>" | "close:<closing id>", "asks": "<field your reply asks about>" or null}. '
    "Then, on the next lines, only the words to say."
)
_NEXT_RE = re.compile(r"^(stay|close:[a-z][a-z0-9_]{0,39}|[a-z][a-z0-9_]{0,39})$")
_FIELD_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_HEADER_PREFIX = re.compile(r"^\s*(?:decision\s*:\s*)?", re.I)


# ------------------------------------------------------------------ safety detectors
@dataclass(frozen=True)
class Safety:
    do_not_call: Callable[[str], bool]
    ai_question: Callable[[str], bool]


def default_safety() -> Safety:
    """The live call's own detectors (call_service), so a guided call recognises exactly what other calls do."""
    from app.services.call_service import _AI_QUESTION_RE, is_do_not_call

    return Safety(do_not_call=is_do_not_call, ai_question=lambda text: bool(_AI_QUESTION_RE.search(text or "")))


# ------------------------------------------------------------------ decision line
@dataclass(frozen=True)
class Decision:
    intent: str
    next: str
    captured: Mapping[str, Any]
    asks: Optional[str]


def parse_model_output(output: Optional[str]) -> Tuple[Optional[Decision], str, Optional[str]]:
    """(decision, reply, problem): the first line is the decision, the rest the reply. A problem = no decision."""
    if not output or not output.strip():
        return None, "", "missing_decision"
    # Some models wrap the JSON in a ``` block: fence lines are never part of the decision or the reply.
    lines = [line for line in output.strip().splitlines() if not line.strip().startswith("```")]
    if not lines:
        return None, "", "missing_decision"
    header, reply = lines[0], "\n".join(lines[1:]).strip()
    try:
        data = json.loads(_HEADER_PREFIX.sub("", header, count=1).strip())
    except ValueError:
        return None, reply, "malformed_decision"
    if not isinstance(data, dict):
        return None, reply, "malformed_decision"
    intent, nxt, captured, asks = data.get("intent"), data.get("next", "stay"), data.get("captured") or {}, data.get("asks")
    if intent not in INTENTS:
        return None, reply, "invalid_intent"
    if not isinstance(nxt, str) or not _NEXT_RE.match(nxt):
        return None, reply, "invalid_next"
    if not isinstance(captured, dict):
        return None, reply, "invalid_captured"
    if asks is not None and (not isinstance(asks, str) or not _FIELD_RE.match(asks)):
        return None, reply, "invalid_asks"
    return Decision(intent, nxt, captured, asks), reply, None


# ------------------------------------------------------------------ state
@dataclass
class RunnerState:
    stage: str
    turn: int = 0
    completed: List[str] = field(default_factory=list)  # stages left, in order
    said: List[str] = field(default_factory=list)  # "<stage>.<statement id>" heard in full
    asked: Dict[str, int] = field(default_factory=dict)  # field -> times its question was heard in full
    collected: Dict[str, Dict[str, Any]] = field(default_factory=dict)  # field -> {value, source, stage, question, turn}
    intents: List[Dict[str, Any]] = field(default_factory=list)  # {turn, stage, intent, status, issues}
    retries: Dict[str, int] = field(default_factory=dict)  # stage -> unclear answers in a row
    invalid_streak: int = 0  # decisions in a row that could not be used
    ended: bool = False
    closing: Optional[str] = None
    outcome: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return copy.deepcopy(asdict(self))

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "RunnerState":
        return cls(**copy.deepcopy(dict(data)))


@dataclass(frozen=True)
class Segment:
    kind: str  # reply | statement | question | closing | disclosure | clarify (all but reply are word for word)
    text: str
    ref: Optional[str] = None
    effects: Tuple[Tuple[str, str], ...] = ()  # applied when this segment was heard in full

    @property
    def exact(self) -> bool:
        return self.kind != "reply"


@dataclass
class TurnPlan:
    segments: List[Segment]
    status: str  # opening | accepted | corrected | recovered | safety | closing | ended
    intent: Optional[str] = None
    captured: Dict[str, Dict[str, Any]] = field(default_factory=dict)  # kept whatever was heard
    issues: List[str] = field(default_factory=list)
    retry_stage: Optional[str] = None
    invalid: bool = False
    forced: Tuple[Tuple[str, str], ...] = ()  # applied even if nothing was heard (do-not-call)

    @property
    def text(self) -> str:
        return " ".join(s.text for s in self.segments)

    @property
    def closing(self) -> Optional[str]:
        effects = list(self.forced) + [e for s in self.segments for e in s.effects]
        return next((ref for kind, ref in effects if kind == "close"), None)


# ------------------------------------------------------------------ runner
class FlowRunner:
    def __init__(self, flow: GuidedFlow, *, team_followup: bool = False, safety: Optional[Safety] = None,
                 render: Optional[Callable[[str], str]] = None):
        self.flow = flow
        self.team_followup = team_followup
        self.safety = safety or default_safety()
        self.render = render or (lambda text: text)

    def initial_state(self) -> RunnerState:
        return RunnerState(stage=self.flow.start)

    def opening(self, state: RunnerState) -> TurnPlan:
        """What the agent says to start the first stage (after the system's greeting and identity lines)."""
        segments = self._entry(state, state.stage, {})
        return TurnPlan(segments, "opening")

    # -------------------------------------------------------------- plan
    def plan(self, state: RunnerState, customer_text: Optional[str], model_output: Optional[str]) -> TurnPlan:
        if state.ended:
            return TurnPlan([], "ended")
        stage = self.flow.stage(state.stage)
        text = customer_text or ""
        if self.safety.do_not_call(text):
            return self._close("do_not_call", "safety", "do_not_call", {}, ["do_not_call_detected"], forced=True)
        decision, reply, problem = parse_model_output(model_output)
        if decision is not None and decision.intent == "do_not_call":
            return self._close("do_not_call", "safety", "do_not_call", {}, ["do_not_call_from_model"], forced=True)
        issues: List[str] = []
        captured = self._captures(state, decision, issues) if decision is not None else {}
        if self.safety.ai_question(text) or (decision is not None and decision.intent == "ai_question"):
            segments = [Segment("disclosure", self.render(self.flow.disclosures.ai))]
            segments += self._resume(state, stage, captured)
            return TurnPlan(segments, "safety", "ai_question", captured, issues)
        if decision is None:
            return self._recover(state, stage, None, {}, [problem or "missing_decision"], invalid=True)
        if "[[" in reply or reply.lstrip().startswith("{"):
            return self._recover(state, stage, decision.intent, captured, issues + ["reply_markup"], invalid=True)
        known = {**state.collected, **captured}
        intent = decision.intent

        if intent in REFUSAL_INTENTS:
            target = self._rule_target(stage, intent, known)
            closing = target[6:] if target and target.startswith("close:") else intent
            return self._close(closing, "closing", intent, captured, issues)

        if intent == "unclear":
            limit = stage.retries.unclear if stage.retries is not None else 1
            if state.retries.get(stage.id, 0) >= limit:
                then = stage.retries.then if stage.retries is not None and stage.retries.then else "close:no_response"
                return self._close(then[6:], "closing", intent, captured, issues + ["retry_limit"])
            if stage.retries is not None and stage.retries.line:
                segment = Segment("clarify", self.render(stage.retries.line))
            elif reply and decision.next == "stay" and decision.asks is None:
                segment = Segment("reply", reply)
            else:
                segment = Segment("clarify", self.render(self.flow.clarify_line))
            status = "accepted" if segment.kind == "reply" else "recovered"
            return TurnPlan([segment], status, intent, captured, issues, retry_stage=stage.id)

        target = self._rule_target(stage, intent, known) or "stay"
        if target != "stay" and not target.startswith("close:") and self._incomplete(state, stage, known):
            # Another stage only once this one's mandatory statements were heard and its required fields
            # collected, whatever a rule or the LLM says (closings - refusal, busy, do-not-call - stay open).
            issues.append("stage_incomplete")
            target = "stay"
        proposed = decision.next
        if target.startswith("close:"):
            if proposed != target:
                issues.append("closing_not_proposed")
            return self._close(target[6:], "closing", intent, captured, issues)
        if proposed.startswith("close:"):
            return self._recover(state, stage, intent, captured, issues + ["unauthorized_closing"])
        if target == "stay":
            if proposed != "stay":
                return self._recover(state, stage, intent, captured, issues + ["unauthorized_transition"])
            return self._stay(state, stage, decision, reply, captured, issues)
        # The rules move the call to another stage.
        status = "accepted" if proposed == target else "corrected"
        if proposed != target:
            issues.append("transition_not_proposed")
        keep_reply = bool(reply) and decision.asks is None
        if reply and not keep_reply:
            issues.append("bridge_asked")
        # The stage counts as entered once its first statement / question (or, without one, the reply) is heard.
        enter = (("enter", target),)
        entry = self._entry(state, target, known)
        if entry:
            entry[0] = Segment(entry[0].kind, entry[0].text, entry[0].ref, enter + entry[0].effects)
            segments = ([Segment("reply", reply)] if keep_reply else []) + entry
        elif keep_reply:
            segments = [Segment("reply", reply, None, enter)]
        else:
            return TurnPlan([], status, intent, captured, issues, forced=enter)
        return TurnPlan(segments, status, intent, captured, issues)

    # -------------------------------------------------------------- commit
    def commit(self, state: RunnerState, plan: TurnPlan, heard: Optional[int] = None) -> RunnerState:
        s = RunnerState.from_dict(state.to_dict())
        if plan.status == "ended":
            return s
        if plan.status != "opening":
            s.turn += 1
            s.intents.append({"turn": s.turn, "stage": state.stage, "intent": plan.intent, "status": plan.status,
                              "issues": list(plan.issues)})
        for name, record in plan.captured.items():
            s.collected[name] = {**record, "turn": s.turn}
        if plan.retry_stage:
            s.retries[plan.retry_stage] = s.retries.get(plan.retry_stage, 0) + 1
        elif plan.status != "opening":
            s.retries[state.stage] = 0  # a clear answer: the next unclear one starts counting again
        s.invalid_streak = s.invalid_streak + 1 if plan.invalid else 0
        count = len(plan.segments) if heard is None else max(0, min(heard, len(plan.segments)))
        for kind, ref in list(plan.forced) + [e for seg in plan.segments[:count] for e in seg.effects]:
            if kind == "said" and ref not in s.said:
                s.said.append(ref)
            elif kind == "asked":
                s.asked[ref] = s.asked.get(ref, 0) + 1
            elif kind == "enter" and s.stage != ref:
                if s.stage not in s.completed:
                    s.completed.append(s.stage)
                s.stage = ref
            elif kind == "close" and not s.ended:
                s.ended, s.closing, s.outcome = True, ref, self.flow.closings[ref].outcome
        return s

    # -------------------------------------------------------------- answers and prompt state
    def answers(self, state: RunnerState) -> Dict[str, Any]:
        """Every answer field (standard + the flow's own): {value, source, stage, question, turn} or None.
        meeting_requested / call_outcome stay None until the call has ended."""
        fields = list(STANDARD_FIELDS) + [c.field for s in self.flow.stages for c in s.collect
                                          if c.field not in STANDARD_FIELDS]
        out: Dict[str, Any] = {name: copy.deepcopy(state.collected.get(name)) for name in fields}
        out[RUNNER_FIELDS[0]] = (state.outcome == "meeting_requested") if state.ended else None  # meeting_requested
        out[RUNNER_FIELDS[1]] = state.outcome if state.ended else None  # call_outcome
        return out

    def prompt_state(self, state: RunnerState) -> Dict[str, Any]:
        """What the LLM is told about the call's position each turn (Phase 2 builds the prompt from it)."""
        stage = self.flow.stage(state.stage)
        pending = self._pending(stage, state.collected)
        then = [s.text for s in self._statements(state, stage)]
        if pending and pending[0].wording == "exact":
            then.append(self.render(pending[0].question))
        return {
            "stage": stage.id, "objective": stage.objective, "guidance": stage.guidance,
            # Said by the system right after the LLM's words when the call stays here (never repeat them).
            "system_says_after_your_words": then,
            "pending_required": [{"field": c.field, "question": c.question, "wording": c.wording} for c in pending],
            "optional": [{"field": c.field, "question": c.question} for c in stage.collect
                         if not c.required and c.field not in state.collected],
            "collected": {k: v["value"] for k, v in state.collected.items()},
            "allowed_next": sorted({"stay"} | {t.go for t in stage.next}),
            "knowledge_topics": list(stage.knowledge),
            "decision_format": DECISION_FORMAT,
        }

    # -------------------------------------------------------------- helpers
    def _pending(self, stage: Stage, known: Mapping[str, Any]) -> List[CollectField]:
        return [c for c in stage.collect if c.required and c.field not in known]

    def _incomplete(self, state: RunnerState, stage: Stage, known: Mapping[str, Any]) -> bool:
        return bool(self._pending(stage, known)) or any(f"{stage.id}.{st.id}" not in state.said for st in stage.mandatory)

    def _matches(self, when: When, intent: str, stage: Stage, known: Mapping[str, Any]) -> bool:
        if when.intent and intent not in when.intent:
            return False
        if when.all_required and self._pending(stage, known):
            return False
        if when.field_set and when.field_set not in known:
            return False
        if when.field_missing and when.field_missing in known:
            return False
        return True

    def _rule_target(self, stage: Stage, intent: str, known: Mapping[str, Any]) -> Optional[str]:
        return next((t.go for t in stage.next if self._matches(t.when, intent, stage, known)), None)

    def _statements(self, state: RunnerState, stage: Stage) -> List[Segment]:
        return [Segment("statement", self.render(st.text), f"{stage.id}.{st.id}", (("said", f"{stage.id}.{st.id}"),))
                for st in stage.mandatory if f"{stage.id}.{st.id}" not in state.said]

    def _question(self, c: CollectField) -> Segment:
        return Segment("question", self.render(c.question), c.field, (("asked", c.field),))

    def _entry(self, state: RunnerState, stage_id: str, known: Mapping[str, Any]) -> List[Segment]:
        stage = self.flow.stage(stage_id)
        pending = self._pending(stage, {**state.collected, **known})
        return self._statements(state, stage) + ([self._question(pending[0])] if pending else [])

    def _resume(self, state: RunnerState, stage: Stage, captured: Mapping[str, Any]) -> List[Segment]:
        return self._entry(state, stage.id, captured)

    def _recover(self, state: RunnerState, stage: Stage, intent: Optional[str], captured: Dict[str, Dict[str, Any]],
                 issues: List[str], invalid: bool = True) -> TurnPlan:
        segments = self._resume(state, stage, captured) or [Segment("clarify", self.render(self.flow.clarify_line))]
        return TurnPlan(segments, "recovered", intent, captured, issues, invalid=invalid)

    def _stay(self, state: RunnerState, stage: Stage, decision: Decision, reply: str,
              captured: Dict[str, Dict[str, Any]], issues: List[str]) -> TurnPlan:
        known = {**state.collected, **captured}
        if decision.asks is not None:
            asked = next((c for c in stage.collect if c.field == decision.asks), None)
            if asked is None or asked.field in known:
                return self._recover(state, stage, decision.intent, captured, issues + ["asks_unknown_field"])
            if asked.wording == "exact":
                return self._recover(state, stage, decision.intent, captured, issues + ["asked_exact_field"])
        if not reply and decision.asks is not None:
            return self._recover(state, stage, decision.intent, captured, issues + ["empty_reply"])
        effects = (("asked", decision.asks),) if decision.asks else ()
        segments = ([Segment("reply", reply, None, effects)] if reply else []) + self._statements(state, stage)
        pending = self._pending(stage, known)
        if pending and decision.asks is None:
            segments.append(self._question(pending[0]))  # back to the pending required question
        if not segments:  # no words and nothing of the system's to say
            return self._recover(state, stage, decision.intent, captured, issues + ["empty_reply"])
        # A reply that asks something (an optional field) is the turn's one question: the required field stays
        # pending - asked next turn, and the stage can't be left without it.
        return TurnPlan(segments, "accepted", decision.intent, captured, issues)

    def _close(self, closing: str, status: str, intent: Optional[str], captured: Dict[str, Dict[str, Any]],
               issues: List[str], forced: bool = False) -> TurnPlan:
        c = self.flow.closings[closing]
        text = self.render(c.text)
        if self.team_followup and c.team_followup_text:
            text = f"{text} {self.render(c.team_followup_text)}"
        effect = (("close", closing),)
        segment = Segment("closing", text, closing, () if forced else effect)
        return TurnPlan([segment], status, intent, captured, issues, forced=effect if forced else ())

    def _captures(self, state: RunnerState, decision: Decision, issues: List[str]) -> Dict[str, Dict[str, Any]]:
        """Answers in the decision, checked: only fields the flow collects, a short single line, no personal data;
        a value the customer gave is never replaced by an inferred one."""
        out: Dict[str, Dict[str, Any]] = {}
        for name, raw in decision.captured.items():
            owner = self.flow.field_owner(name) if isinstance(name, str) else None
            if owner is None:
                issues.append(f"undeclared_field:{name}")
                continue
            value, source = (raw.get("value"), raw.get("source", "customer")) if isinstance(raw, dict) else (raw, "customer")
            if not isinstance(value, str) or not value.strip() or source not in ("customer", "inferred"):
                issues.append(f"invalid_value:{name}")
                continue
            value = " ".join(value.split())[:MAX_ANSWER_CHARS]
            if "personal_data" in text_codes(value, spoken=False):
                issues.append(f"personal_data_dropped:{name}")
                continue
            existing = state.collected.get(name)
            if existing is not None and existing["source"] == "customer" and source == "inferred":
                issues.append(f"kept_customer_value:{name}")
                continue
            question = next(c.question for c in owner.collect if c.field == name)
            out[name] = {"value": value, "source": source, "stage": owner.id, "question": question,
                         "heard_in_stage": state.stage}
        return out
