"""Guided call flows (schema_version 2): the flow is the business process, the AI holds the conversation.

A guided flow is a set of stages. Each stage has an objective, optional mandatory statements (spoken word for
word by the system), the information it needs to collect (each a configured question asked either exactly or in
the AI's own words, required or optional), optional knowledge topics (from the flow's training) and ordered
transitions. Closings are exact lines with a recorded outcome. The runner (app/flows/runner.py) owns the call's
position; the LLM only proposes. Version-1 flows (app/flows/schema.py) are a different format and are never
read or reinterpreted here.

Validation has two layers, kept identical in packages/shared/src/guidedFlows.ts:
  structure  pydantic / zod ("schema" when anything is the wrong shape)
  semantics  check_guided_flow(): stable issue codes (ISSUE_CODES), the same on both sides
             (tests/fixtures/guided/validation_cases.json runs through both).
Not connected to calls yet (Phase 1): nothing in the call path imports this module.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Mapping, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, ValidationInfo, model_validator
from typing_extensions import Annotated

from app.flows.schema import FLOW_VARIABLES
from app.flows.training import FlowTraining

LANGUAGES = ("en", "ta", "hi", "te", "kn", "ml", "mr", "gu", "bn", "pa", "od")
# Answers a guided flow may collect. Unknown values stay null. custom_<name> fields are allowed too.
STANDARD_FIELDS = ("business_type", "current_system", "current_process", "requirements", "pain_points",
                   "interest_level", "existing_software", "preferred_follow_up")
RUNNER_FIELDS = ("meeting_requested", "call_outcome")  # set by the runner, never collected
CUSTOM_FIELD_RE = re.compile(r"^custom_[a-z0-9_]{1,32}$")
SENSITIVE_PARTS = frozenset({"phone", "mobile", "email", "mail", "otp", "password", "pin", "card", "cvv", "bank",
                             "aadhaar", "aadhar", "pan", "account", "address", "whatsapp", "contact", "number"})
# What the LLM's decision line may say the customer did. The runner treats the safety ones itself.
INTENTS = ("answered", "agreed", "interested", "uncertain", "question", "objection", "not_interested", "busy",
           "do_not_call", "ai_question", "wrong_person", "end_request", "meeting_request", "unclear", "other")
OUTCOMES = ("interested", "not_interested", "busy", "do_not_call", "wrong_person", "callback_requested",
            "meeting_requested", "completed")
# Closings every guided flow must have: the safety intents and the retry limit end the call through them.
REQUIRED_CLOSINGS = ("do_not_call", "not_interested", "busy", "end_request", "no_response")
REFUSAL_INTENTS = ("not_interested", "busy", "end_request")  # may only lead to a closing, never to more pitch

ISSUE_CODES = (
    "schema", "language_style", "identity_needs_name", "duplicate_stage", "unknown_start", "unknown_target",
    "missing_closing", "unreachable_stage", "unreachable_rule", "duplicate_field", "forbidden_field",
    "unknown_condition_field", "unknown_knowledge", "safety_override", "refusal_continues", "disclosure_not_ai",
    "end_call_marker", "unknown_variable", "personal_data", "link", "price", "promise", "team_followup_in_text",
)

ID = r"^[a-z][a-z0-9_]{0,39}$"
TARGET = r"^(close:)?[a-z][a-z0-9_]{0,39}$"

# ------------------------------------------------------------------ text checks (mirrored in guidedFlows.ts)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_VAR = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")
_EMAIL = re.compile(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")
_NUMBERISH = re.compile(r"\+?[0-9][0-9\s().-]*[0-9]")
_LINK = re.compile(r"https?://|\bwww\.|\b[a-z0-9-]+\.(?:com|in|net|org|io|co|ai|app|info|biz)\b", re.I)
_OWN_SITE = re.compile(r"\bkagzso\.com\b", re.I)
_PRICE = re.compile(r"₹|\brs\.?\s*[0-9]|\binr\b|\brupees?\b|\$\s*[0-9]|\blakhs?\b|\bcrores?\b|\bdiscount|"
                    r"\bper month\b|\bfree of cost\b|\bfor free\b", re.I)
_PROMISE = re.compile(r"\b(book|schedule|fix|arrange|set up|confirm)\b.{0,25}\b(demo|meeting|appointment|call ?back|visit)\b|"
                      r"\b(we|i|our team|someone)\s*('ll| will| shall)\s+(call you back|visit|meet)\b|"
                      r"\bguarantee|\b100\s*%", re.I)
_TEAM_FOLLOWUP = re.compile(r"\bour team\b.{0,30}\b(contact|call|reach|get in touch)\b", re.I)
_AI_WORDS = re.compile(r"\bA\.?I\b|artificial intelligence|virtual assistant|automated assistant|ஏஐ|एआई|ಎಐ|ఏఐ|എഐ",
                       re.I)


def text_codes(text: str, *, spoken: bool) -> List[str]:
    """Issue codes for one text. `spoken`: said to the customer (also checked for prices and promises)."""
    codes: List[str] = []
    if "[[END_CALL]]" in text:
        codes.append("end_call_marker")
    if any(m.group(1) not in FLOW_VARIABLES for m in _VAR.finditer(text)):
        codes.append("unknown_variable")
    if _EMAIL.search(text) or any(sum(c.isdigit() for c in m.group()) >= 7 for m in _NUMBERISH.finditer(text)):
        codes.append("personal_data")
    if _LINK.search(_OWN_SITE.sub(" ", _EMAIL.sub(" ", text))):
        codes.append("link")
    if spoken and _PRICE.search(text):
        codes.append("price")
    if spoken and _PROMISE.search(text):
        codes.append("promise")
    return codes


def _line(max_len: int, min_len: int = 1):
    return Field(..., min_length=min_len, max_length=max_len, pattern=r"^[^\x00-\x1f\x7f]*$")


# ------------------------------------------------------------------ structure
class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GuidedGreeting(_Strict):
    text: str = _line(300)


class GuidedIdentity(_Strict):
    question: str = _line(200)
    reask: Optional[str] = Field(None, max_length=200, pattern=r"^[^\x00-\x1f\x7f]*$")


class GuidedSilence(_Strict):
    reprompt: str = _line(200)
    closing: str = _line(200)


class GuidedLimits(_Strict):
    max_duration_sec: int = Field(..., ge=30, le=600)


class GuidedPauses(_Strict):
    short_ms: int = Field(300, ge=0, le=3000)
    medium_ms: int = Field(700, ge=0, le=3000)
    long_ms: int = Field(1200, ge=0, le=3000)


class Disclosures(_Strict):
    ai: str = _line(300)  # the honest "I am an AI assistant" line, said word for word when asked


class Statement(_Strict):
    id: str = Field(..., pattern=ID)
    text: str = _line(500)


class CollectField(_Strict):
    field: str = Field(..., pattern=ID)
    question: str = _line(300)  # exact: said as written; natural: the reference the AI may rephrase
    wording: Literal["exact", "natural"] = "natural"
    required: bool = True


class When(_Strict):
    intent: Optional[List[Literal[INTENTS]]] = Field(None, min_length=1, max_length=len(INTENTS))  # type: ignore[valid-type]
    all_required: Optional[bool] = None
    field_set: Optional[str] = Field(None, pattern=ID)
    field_missing: Optional[str] = Field(None, pattern=ID)

    @property
    def is_default(self) -> bool:
        return not self.intent and not self.all_required and not self.field_set and not self.field_missing


class Transition(_Strict):
    when: When = Field(default_factory=When)
    go: str = Field(..., pattern=TARGET)


class Retries(_Strict):
    unclear: int = Field(1, ge=0, le=3)  # clarifications before `then`
    line: Optional[str] = Field(None, min_length=1, max_length=300, pattern=r"^[^\x00-\x1f\x7f]*$")
    then: Optional[str] = Field(None, pattern=r"^close:[a-z][a-z0-9_]{0,39}$")


class Stage(_Strict):
    id: str = Field(..., pattern=ID)
    objective: str = _line(300)
    guidance: str = Field("", max_length=800)
    mandatory: List[Statement] = Field(default_factory=list, max_length=4)
    collect: List[CollectField] = Field(default_factory=list, max_length=8)
    knowledge: List[str] = Field(default_factory=list, max_length=10)
    next: List[Transition] = Field(..., min_length=1, max_length=12)
    retries: Optional[Retries] = None


class Closing(_Strict):
    text: str = _line(500)
    outcome: Literal[OUTCOMES]  # type: ignore[valid-type]
    team_followup_text: Optional[str] = Field(None, min_length=1, max_length=300, pattern=r"^[^\x00-\x1f\x7f]*$")


@dataclass(frozen=True)
class Issue:
    code: str
    path: str
    message: str


class GuidedFlow(_Strict):
    schema_version: Literal[2]
    kind: Literal["guided"]
    name: str = _line(100)
    language: Literal[LANGUAGES]  # type: ignore[valid-type]
    language_style: Optional[Literal["mixed", "pure"]] = None
    voice_id: Optional[str] = Field(None, pattern=r"^[A-Za-z0-9_-]{1,100}$")
    greeting: GuidedGreeting
    identity: Optional[GuidedIdentity] = None
    silence: GuidedSilence
    limits: GuidedLimits
    pauses: Optional[GuidedPauses] = None
    recording_notice: Optional[str] = Field(None, min_length=1, max_length=300, pattern=r"^[^\x00-\x1f\x7f]*$")
    disclosures: Disclosures
    clarify_line: str = _line(300)
    start: str = Field(..., pattern=ID)
    stages: List[Stage] = Field(..., min_length=1, max_length=30)
    closings: Dict[Annotated[str, StringConstraints(pattern=ID)], Closing] = Field(..., min_length=1, max_length=20)
    training: Optional[FlowTraining] = None

    @model_validator(mode="after")
    def _semantics(self, info: ValidationInfo) -> "GuidedFlow":
        issues = semantic_issues(self)
        sink = (info.context or {}).get("issues") if info is not None else None
        if sink is not None:  # check_guided_flow: collect them instead of failing
            sink.extend(issues)
        elif issues:
            raise ValueError("; ".join(f"{i.code} at {i.path}: {i.message}" for i in issues))
        return self

    # -------------------------------------------------------------- lookups used by the runner
    def stage(self, stage_id: str) -> Stage:
        return next(s for s in self.stages if s.id == stage_id)

    def field_owner(self, field: str) -> Optional[Stage]:
        return next((s for s in self.stages if any(c.field == field for c in s.collect)), None)


# ------------------------------------------------------------------ semantics
def _field_allowed(name: str) -> bool:
    if name in RUNNER_FIELDS:
        return False
    if name in STANDARD_FIELDS:
        return True
    return bool(CUSTOM_FIELD_RE.match(name)) and not (set(name.split("_")[1:]) & SENSITIVE_PARTS)


def semantic_issues(flow: GuidedFlow) -> List[Issue]:
    out: List[Issue] = []

    def add(code: str, path: str, message: str) -> None:
        out.append(Issue(code, path, message))

    def texts(text: Optional[str], path: str, spoken: bool = True) -> None:
        if text:
            for code in text_codes(text, spoken=spoken):
                add(code, path, f"text check failed: {code}")

    if flow.language == "en" and flow.language_style is not None:
        add("language_style", "language_style", "an English flow has no language style")
    if flow.identity is not None and not re.search(r"\{\{\s*(customer_name|name)\s*\}\}", flow.identity.question):
        add("identity_needs_name", "identity.question", "must contain {{customer_name}}")

    stage_ids = [s.id for s in flow.stages]
    for sid in sorted({i for i in stage_ids if stage_ids.count(i) > 1}):
        add("duplicate_stage", "stages", f"stage id '{sid}' is used twice")
    stages = set(stage_ids)
    if flow.start not in stages:
        add("unknown_start", "start", f"no stage '{flow.start}'")
    for name in REQUIRED_CLOSINGS:
        if name not in flow.closings:
            add("missing_closing", "closings", f"closing '{name}' is required")

    def target_ok(target: str) -> bool:
        return target[6:] in flow.closings if target.startswith("close:") else target in stages

    collected: Dict[str, str] = {}
    topics = {k.topic for k in flow.training.knowledge} if flow.training is not None else set()
    for si, stage in enumerate(flow.stages):
        p = f"stages.{si}"
        texts(stage.objective, f"{p}.objective", spoken=False)
        texts(stage.guidance, f"{p}.guidance", spoken=False)
        for mi, st in enumerate(stage.mandatory):
            texts(st.text, f"{p}.mandatory.{mi}.text")
            if _TEAM_FOLLOWUP.search(st.text):
                add("team_followup_in_text", f"{p}.mandatory.{mi}.text", "say it in a closing's team_followup_text")
        for ci, c in enumerate(stage.collect):
            if not _field_allowed(c.field):
                add("forbidden_field", f"{p}.collect.{ci}.field", f"'{c.field}' can't be collected")
            if c.field in collected:
                add("duplicate_field", f"{p}.collect.{ci}.field", f"'{c.field}' is already collected in '{collected[c.field]}'")
            collected.setdefault(c.field, stage.id)
            texts(c.question, f"{p}.collect.{ci}.question")
        for ki, topic in enumerate(stage.knowledge):
            if topic not in topics:
                add("unknown_knowledge", f"{p}.knowledge.{ki}", f"no training knowledge topic '{topic}'")
        if stage.retries is not None:
            texts(stage.retries.line, f"{p}.retries.line")
            if stage.retries.then and not target_ok(stage.retries.then):
                add("unknown_target", f"{p}.retries.then", f"'{stage.retries.then}' does not exist")
        for ti, tr in enumerate(stage.next):
            tp = f"{p}.next.{ti}"
            if not target_ok(tr.go):
                add("unknown_target", f"{tp}.go", f"'{tr.go}' does not exist")
            if tr.when.is_default and ti != len(stage.next) - 1:
                add("unreachable_rule", tp, "a rule without conditions must be the last one")
            intents = set(tr.when.intent or [])
            if "do_not_call" in intents and tr.go != "close:do_not_call":
                add("safety_override", f"{tp}.go", "do_not_call always ends the call with close:do_not_call")
            if intents & set(REFUSAL_INTENTS) and not tr.go.startswith("close:"):
                add("refusal_continues", f"{tp}.go", "a refusal, busy or end request may only lead to a closing")
    for si, stage in enumerate(flow.stages):  # conditions may name a field collected in any stage
        for ti, tr in enumerate(stage.next):
            for key in ("field_set", "field_missing"):
                name = getattr(tr.when, key)
                if name and name not in collected:
                    add("unknown_condition_field", f"stages.{si}.next.{ti}.when.{key}", f"no stage collects '{name}'")

    if flow.start in stages:  # every stage must be reachable from the start
        seen, todo = {flow.start}, [flow.start]
        while todo:
            current = todo.pop()
            for tr in next(s for s in flow.stages if s.id == current).next:
                if tr.go in stages and tr.go not in seen:
                    seen.add(tr.go)
                    todo.append(tr.go)
        for sid in stage_ids:
            if sid not in seen:
                add("unreachable_stage", "stages", f"stage '{sid}' can't be reached from '{flow.start}'")

    if not _AI_WORDS.search(flow.disclosures.ai):
        add("disclosure_not_ai", "disclosures.ai", "must say honestly that the agent is an AI assistant")
    for path, text in (("greeting.text", flow.greeting.text), ("disclosures.ai", flow.disclosures.ai),
                       ("clarify_line", flow.clarify_line), ("silence.reprompt", flow.silence.reprompt),
                       ("silence.closing", flow.silence.closing), ("recording_notice", flow.recording_notice),
                       ("identity.question", flow.identity.question if flow.identity else None),
                       ("identity.reask", flow.identity.reask if flow.identity else None)):
        texts(text, path)
    for name, closing in flow.closings.items():
        texts(closing.text, f"closings.{name}.text")
        texts(closing.team_followup_text, f"closings.{name}.team_followup_text")
        if _TEAM_FOLLOWUP.search(closing.text):
            add("team_followup_in_text", f"closings.{name}.text", "say it in team_followup_text")
    return out


def check_guided_flow(raw: Mapping[str, Any]) -> List[Issue]:
    """Every issue of a guided flow definition: [Issue("schema", ...)] when its shape is wrong, else the semantic
    issues ([] = valid). The same codes as guidedFlowIssues() in packages/shared/src/guidedFlows.ts."""
    sink: List[Issue] = []
    try:
        GuidedFlow.model_validate(raw, context={"issues": sink})
    except ValidationError as exc:
        first = exc.errors()[0]
        return [Issue("schema", ".".join(str(p) for p in first.get("loc", ())), str(first.get("msg")))]
    return sink


def parse_guided_flow(raw: Mapping[str, Any]) -> GuidedFlow:
    """A valid guided flow, or ValueError naming every issue."""
    issues = check_guided_flow(raw)
    if issues:
        raise ValueError("; ".join(f"{i.code} at {i.path}: {i.message}" for i in issues))
    return GuidedFlow.model_validate(raw, context={"issues": []})
