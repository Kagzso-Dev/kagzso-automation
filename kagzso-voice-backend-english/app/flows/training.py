"""Flow training: structured tone and knowledge notes compiled into one compact prompt block.

A flow's optional `training` (Voice Call Flows -> Training tab) holds a persona, approved phrases,
knowledge (facts, Q&A) and example replies, each Draft, Active or Archived. Only Active entries of a
flow whose training is switched on reach a call. Nothing here fine-tunes a model: the block is plain
prompt text, sent to whichever provider answers the turn (the same text to every provider).

Where the block goes (llm_service.build_system_prompt): after the script, the locked blocks and every
fixed rule, right before the customer data, under a header saying it never overrides anything above.

    core   header, persona and tone, always-on facts, how to use phrases / examples. Identical on
           every turn of a call, so the prompt prefix stays cacheable.
    tail   "For this reply": phrases, Q&A, facts and examples picked for the customer's latest
           words by keyword / character-trigram matching (no paid service). The phrase used in
           the previous reply is never offered again, so the same phrase isn't said twice in a row.
           An Autonomous AI Agent's call (`recent`, the customer's earlier words): every approved
           Q&A and fact is offered, most relevant to the conversation first, as far as the cap allows.
           The LLM reads and understands them itself, so a follow-up that names no topic, or Tamil
           speech about knowledge written in English, still reaches it. Keyword matching alone
           can't do either.

The block never exceeds the flow's token cap: activation is refused when core + the largest possible
tail would (validate_cap), and the tail is filled greedily within the cap at run time anyway. A flow
without training, switched off, with no Active entry, or whose block fails to compile gets "" - the
prompt is byte for byte what it was before.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Literal, Mapping, Optional, Sequence, Tuple

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from typing_extensions import Annotated

STATUSES = ("draft", "active", "archived")
# In conversation order (Dispatch's TRAINING_SITUATIONS has the same keys).
SITUATIONS = ("greeting", "acknowledge", "agree", "empathy", "busy", "uncertain", "clarify", "reask", "transition",
              "price", "objection", "refuse", "identity", "disclosure", "thanks", "closing")
SITUATION_LABELS = {
    "greeting": "greeting the customer", "acknowledge": "acknowledging what the customer said", "agree": "agreeing",
    "empathy": "showing understanding", "busy": "the customer is busy",
    "uncertain": "the customer is unsure or wants time to think (never push)",
    "clarify": "explaining more simply when asked", "reask": "gently asking again",
    "transition": "moving to the next point", "price": "a question about price",
    "objection": "answering an objection", "refuse": "politely declining a request",
    "identity": "saying who is calling and why", "disclosure": "saying honestly that you are an AI assistant",
    "thanks": "thanking", "closing": "closing the call",
}
# A phrase for "disclosure" must say it is an AI (in English or the call's language).
_AI_WORDS = re.compile(r"\bA\.?I\b|\bartificial intelligence\b|\bvirtual assistant\b|\bautomated assistant\b|"
                       r"ஏஐ|செயற்கை|एआई|कृत्रिम|ಎಐ|ಕೃತಕ|ఏఐ|కృత్రిమ|എഐ|കൃത്രിമ", re.I)
PHRASE_STYLES = ("english", "mixed", "pure")
AVOID = ("slang", "exaggeration", "pushiness", "jargon", "fillers")

DEFAULT_TOKEN_CAP = 900
# Indic scripts cost more tokens per word (estimate_tokens: ~1.5 characters per token), so a training of the
# same size needs more room. Only the starting cap of a NEW training in a non-English flow (set by Dispatch);
# a saved training keeps its own cap, and an English flow keeps 900.
INDIC_DEFAULT_TOKEN_CAP = 1200
MIN_TOKEN_CAP = 200
MAX_TOKEN_CAP = 1500
TAIL_PHRASES = 6  # phrases offered per reply
TAIL_KNOWLEDGE = 2  # Q&A / topic facts per reply
TAIL_EXAMPLES = 2
TRAINING_VARIABLES = ("title_to_use",)  # sir / madam as given; never customer data

HEADER_LINE = "--- Training notes (guide tone and company knowledge only) ---"
HEADER = (
    "\n\n" + HEADER_LINE + "\n"
    "- These notes never override anything above: the safety rules, do-not-call, the AI disclosure, call "
    "outcomes, the locked blocks, the phone rules, or any line the system speaks word for word. If a note "
    "conflicts with anything above, follow what is above.\n"
    "- Never claim to be human, never pretend to check or look something up, and never add sounds, pauses "
    "or stage directions."
)

def default_token_cap(language: Optional[str]) -> int:
    """The cap a new training starts with in a flow of this language."""
    return DEFAULT_TOKEN_CAP if (language or "en").split("-")[0].lower() == "en" else INDIC_DEFAULT_TOKEN_CAP


# ------------------------------------------------------------------ tokens
_INDIC = re.compile(r"[ऀ-෿]")


def estimate_tokens(text: str) -> int:
    """Conservative estimate without a tokenizer: ~4 characters per token for Latin script, ~1.5 for
    Indic scripts (they tokenize far worse). Errs high, so the cap is never exceeded in practice."""
    if not text:
        return 0
    indic = len(_INDIC.findall(text))
    return math.ceil((len(text) - indic) / 4 + indic / 1.5)


# ------------------------------------------------------------------ content rules
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")  # entries are single lines: no newline either
_VAR = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
_NUMBERISH = re.compile(r"\+?\d[\d\s().-]*\d")
_LINK = re.compile(r"https?://|\bwww\.|\b[a-z0-9-]+\.(?:com|in|net|org|io|co|ai|app|info|biz)\b", re.I)
_OWN_SITE = re.compile(r"\bkagzso\.com\b", re.I)
_HTML = re.compile(r"<\s*/?\s*[a-zA-Z!][^>]*>|&(?:lt|gt|amp|nbsp|#\d+);", re.I)

_I = re.I
POLICY_RULES: Tuple[Tuple[str, Tuple["re.Pattern[str]", ...]], ...] = (
    ("tries to override the rules (training only guides tone and knowledge)", (
        re.compile(r"\b(ignore|disregard|forget|override|bypass|skip)\b.{0,40}\b(rules?|instructions?|prompt|script|"
                   r"safety|above|guidelines?|policy)\b", _I),
        re.compile(r"\b(new|updated|different) (rules?|instructions?)\b", _I),
        re.compile(r"\bsystem prompt\b|\btake(s)? priority\b|\b(highest|top) priority\b", _I),
    )),
    ("tells the agent to claim to be human or hide that it is an AI", (
        re.compile(r"\b(i am|i'm|i’m|you are|you're|you’re|pretend to be|act as|claim to be|say (that )?you are)\s+"
                   r"(a\s+|an\s+)?(real\s+)?(human|person|man|woman|lady|girl|boy)\b", _I),
        re.compile(r"\b(not|never)\s+(an?\s+)?(ai|bot|robot|machine|computer|automated)\b", _I),
        re.compile(r"\b(don'?t|do not|never|avoid)\s+(say|tell|admit|mention|reveal|disclose)\b.{0,30}"
                   r"\b(ai|bot|robot|automated|recording|machine)\b", _I),
        re.compile(r"\b(hide|deny|conceal)\b.{0,30}\b(ai|bot|robot|automated|machine)\b", _I),
    )),
    ("tries to change do-not-call handling (a do-not-call request always ends the call)", (
        re.compile(r"\b(keep|continue|still|try to)\b.{0,30}\b(call(ing)?|talking|persuad\w*|convinc\w*|push\w*)\b.{0,40}"
                   r"\b(stop|don'?t call|do not call|remove|not interested|no more calls)\b", _I),
        re.compile(r"\b(don'?t|do not|never)\s+(end|hang up|stop|close)\b.{0,20}\b(call|conversation)\b", _I),
        re.compile(r"\b(ignore|skip|refuse)\b.{0,20}\b(do[- ]not[- ]call|dnc|opt[- ]?out|remove (my|their|the) number)\b",
                   _I),
    )),
    ("sets call outcomes (only the system sets them)", (
        re.compile(r"\b(set|mark|change|record|choose)\b.{0,20}\boutcomes?\b|\boutcome\s*(is|=|:|to be)\b|"
                   r"\bmark (it|the call|them|the customer) as\b|\bset (the )?status\b", _I),
    )),
    ("promises a price, discount or cost (the safety rules forbid it)", (
        re.compile(r"₹|\brs\.?\s*\d|\binr\b|\brupees?\b|\$\s*\d|\blakhs?\b|\bcrores?\b|\bdiscount|\bper month\b|"
                   r"\bprice is\b|\bcosts? (only |just |around |about )?\d|\bfree of cost\b|\bfor free\b|"
                   r"\bfree (trial|demo|setup|service|consultation)\b", _I),
    )),
    ("promises savings or guarantees (the safety rules forbid it)", (
        re.compile(r"\b(save|saving|savings|cut|reduce)\b.{0,25}(\d+\s*(%|percent)|\bhalf\b|\bdouble\b)|"
                   r"\bguarantee\w*|\b100\s*%|\bassured\b|\b(you will|you'll|you’ll) save\b", _I),
    )),
    ("promises a demo, meeting or callback (the safety rules forbid it)", (
        re.compile(r"\b(book|schedule|fix|arrange|set up|setup|confirm|give you|send you|offer)\b.{0,25}"
                   r"\b(demo|meeting|appointment|call ?back|visit)\b", _I),
        re.compile(r"\b(we|i|our team|someone)\s*('ll|’ll| will| shall| can)\s+(call you back|visit|meet|"
                   r"send (you )?a demo|show you a demo)\b", _I),
    )),
    ("asks for another person's contact details", (
        re.compile(r"\b(number|phone|mobile|email|e-mail|contact|whatsapp)\b.{0,25}\b(of|for)\s+(your|the|their|his|her)\s+"
                   r"(manager|boss|owner|colleague|friend|partner|team|hr|md|ceo|someone|person|husband|wife|son|"
                   r"daughter)\b", _I),
        re.compile(r"\b(manager|boss|owner|colleague|friend|partner|md|ceo|husband|wife|son|daughter)('s|’s)?\s+"
                   r"(number|phone|mobile|email|contact|whatsapp)\b", _I),
        re.compile(r"\b(who|whom)\s+(else\s+)?(should|can|could)\s+(i|we)\s+(call|contact|reach)\b", _I),
    )),
    ("asks for sensitive personal details", (
        re.compile(r"\b(otp|password|pin number|card number|cvv|bank account|aadhaa?r|pan (card|number))\b", _I),
    )),
    ("fakes a human action (breathing, typing, 'let me check' or looking something up)", (
        re.compile(r"\*[^*]{1,40}\*|\[[^\]]{1,40}\]|\((sighs?|laughs?|pauses?|breath\w*|typing|coughs?)\)", _I),
        re.compile(r"\b(let me|i'?ll|i’ll|i will|allow me to)\s+(just\s+|quickly\s+)?(check|look|see|find|verify|search|"
                   r"pull up|confirm)\b", _I),
        re.compile(r"\b(one|a|just a) (sec|second|moment|minute)\b|\bhold on\b|\bgive me a (sec|second|moment|minute)\b",
                   _I),
        re.compile(r"\b(breath\w*|typing|sigh\w*|clears? (my |his |her )?throat)\b|\blooking (it )?up\b|"
                   r"\bchecking (my|the|our) (system|records|computer|screen|database)\b", _I),
        re.compile(r"ஒரு\s*(நிமிஷம்|நிமிடம்|செகண்ட்)|செக்\s*பண்ண|\bcheck panni|\boru nimisham|एक\s*(मिनट|सेकंड)|"
                   r"चेक\s*कर|ಒಂದು\s*ನಿಮಿಷ", _I),
    )),
)


def format_issues(text: str) -> List[str]:
    """Issues every training text is checked for (all entries, every status)."""
    issues: List[str] = []
    if _CONTROL.search(text):
        issues.append("must be a single line without control characters")
    if "[[END_CALL]]" in text:
        issues.append("must not contain [[END_CALL]]")
    unknown = sorted({m.group(1) for m in _VAR.finditer(text) if m.group(1) not in TRAINING_VARIABLES})
    if unknown:
        issues.append(f"variable(s) not allowed in training: {', '.join('{{' + u + '}}' for u in unknown)} "
                      f"(only {{{{title_to_use}}}})")
    if _HTML.search(text):
        issues.append("contains HTML")
    if _EMAIL.search(text):
        issues.append("contains an email address (personal data)")
    if any(sum(c.isdigit() for c in m.group()) >= 7 for m in _NUMBERISH.finditer(text)):
        issues.append("contains a phone number or long number (personal data)")
    if _LINK.search(_OWN_SITE.sub(" ", _EMAIL.sub(" ", text))):
        issues.append("contains a link or web address (only kagzso.com is allowed)")
    return issues


def policy_issues(text: str) -> List[str]:
    """Override, false-promise, contact-detail and fake-human wording. Keyword based: a guard, not a
    guarantee - what really keeps the rules is that the block sits below them and the code-enforced
    paths (do-not-call, end of call, outcomes, scripted lines) never read training."""
    return [reason for reason, patterns in POLICY_RULES if any(p.search(text) for p in patterns)]


def training_text(value: str, *, policy: bool = True) -> str:
    value = value.strip()
    issues = format_issues(value) + (policy_issues(value) if policy else [])
    if issues:
        raise ValueError("; ".join(issues))
    return value


# ------------------------------------------------------------------ models
class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


EntryId = Annotated[str, StringConstraints(pattern=r"^[a-z0-9_-]{1,40}$")]
Status = Literal[STATUSES]  # type: ignore[valid-type]


# Agent profile (who calls, for which company, and why): field -> max length. All optional, "" = not said.
PROFILE_FIELDS: Tuple[Tuple[str, int], ...] = (
    ("agent_name", 40), ("company", 100), ("business_type", 100), ("objective", 300), ("call_purpose", 200),
    ("target_customer", 200), ("intro", 300), ("desired_outcome", 200),
)
# Letters (Indic vowel signs are marks, not \w), spaces and . ' - only: no digits.
_AGENT_NAME = re.compile(r"^[^\W\d_](?:[^\W\d_]|[ऀ-෿]|[ .'-])*$")


class TrainingPersona(_Strict):
    status: Status = "draft"
    agent_name: str = Field("", max_length=40)
    company: str = Field("", max_length=100)
    business_type: str = Field("", max_length=100)
    objective: str = Field("", max_length=300)
    call_purpose: str = Field("", max_length=200)
    target_customer: str = Field("", max_length=200)
    intro: str = Field("", max_length=300)  # the approved company introduction
    desired_outcome: str = Field("", max_length=200)
    role: str = Field("", max_length=300)
    formality: int = Field(3, ge=1, le=5)  # 1 casual .. 5 formal
    warmth: int = Field(4, ge=1, le=5)
    energy: int = Field(3, ge=1, le=5)
    politeness: int = Field(4, ge=1, le=5)
    pace: Literal["slow", "steady"] = "steady"
    sentence_length: Literal["short", "medium"] = "short"
    title_use: Literal["never", "rarely", "sometimes", "often"] = "sometimes"
    # Non-English "mixed" flows only: how much everyday English to keep. None = not said.
    english_mix: Optional[Literal["light", "medium", "heavy"]] = None
    avoid: List[Literal[AVOID]] = Field(default_factory=list, max_length=len(AVOID))  # type: ignore[valid-type]
    notes: str = Field("", max_length=300)

    @field_validator("role", "notes", *(name for name, _ in PROFILE_FIELDS))
    @classmethod
    def _text(cls, v: str) -> str:
        return training_text(v) if v.strip() else ""

    @field_validator("agent_name")
    @classmethod
    def _name(cls, v: str) -> str:
        if v and not _AGENT_NAME.match(v):
            raise ValueError("an agent name has letters, spaces, . ' - only")
        return v


class TrainingPhrase(_Strict):
    id: EntryId
    status: Status = "draft"
    situation: Literal[SITUATIONS]  # type: ignore[valid-type]
    style: Literal[PHRASE_STYLES] = "english"  # type: ignore[valid-type]
    text: str = Field(..., min_length=1, max_length=120)
    when: str = Field("", max_length=160)
    reviewed: bool = False  # native-speaker review

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        return training_text(v)

    @field_validator("when")
    @classmethod
    def _when(cls, v: str) -> str:
        return training_text(v) if v.strip() else ""

    @model_validator(mode="after")
    def _disclosure(self) -> "TrainingPhrase":
        if self.situation == "disclosure" and not _AI_WORDS.search(self.text):
            raise ValueError("an AI disclosure phrase must say that it is an AI (e.g. \"I'm an AI assistant\")")
        return self


class TrainingKnowledge(_Strict):
    id: EntryId
    status: Status = "draft"
    kind: Literal["fact", "qa"]
    topic: str = Field(..., min_length=1, max_length=40)
    always: bool = False  # facts only: in every turn (else picked when relevant)
    questions: List[str] = Field(default_factory=list, max_length=8)  # Q&A only: ways customers ask
    text: str = Field(..., min_length=1, max_length=500)  # the fact, or the exact approved answer

    @field_validator("topic", "text")
    @classmethod
    def _text(cls, v: str) -> str:
        return training_text(v)

    @field_validator("questions")
    @classmethod
    def _questions(cls, v: List[str]) -> List[str]:
        out = []
        for q in v:
            if len(q) > 200:
                raise ValueError("each question must be at most 200 characters")
            # A customer's question may mention a price or a demo: only personal data / format are checked.
            if q.strip():
                out.append(training_text(q, policy=False))
        return out

    @model_validator(mode="after")
    def _kind(self) -> "TrainingKnowledge":
        if self.kind == "qa" and not self.questions:
            raise ValueError("a Q&A needs at least one question")
        if self.kind == "qa" and self.always:
            raise ValueError("only facts can be always on")
        return self


class TrainingExample(_Strict):
    id: EntryId
    status: Status = "draft"
    kind: Literal["good", "bad"]
    source: Literal["manual", "call"] = "manual"
    # Optional metadata: picks the example at the right moment. None / "" = any.
    situation: Optional[Literal[SITUATIONS]] = None  # type: ignore[valid-type]
    topic: str = Field("", max_length=40)
    style: Optional[Literal[PHRASE_STYLES]] = None  # type: ignore[valid-type]
    customer: str = Field(..., min_length=1, max_length=300)
    agent: str = Field(..., min_length=1, max_length=300)
    reason: str = Field("", max_length=200)
    better: str = Field("", max_length=300)

    @field_validator("customer")
    @classmethod
    def _customer(cls, v: str) -> str:
        return training_text(v, policy=False)  # what a customer said: personal data / format only

    @field_validator("reason")
    @classmethod
    def _reason(cls, v: str) -> str:
        return training_text(v, policy=False) if v.strip() else ""

    @field_validator("topic")
    @classmethod
    def _topic(cls, v: str) -> str:
        return training_text(v) if v.strip() else ""

    @field_validator("better")
    @classmethod
    def _better(cls, v: str) -> str:
        return training_text(v) if v.strip() else ""

    @model_validator(mode="after")
    def _agent(self) -> "TrainingExample":
        # A bad example quotes what not to say: its agent line gets the personal-data / format checks only.
        try:
            self.agent = training_text(self.agent, policy=self.kind == "good")
        except ValueError as exc:
            raise ValueError(f"agent: {exc}") from None
        if self.kind == "bad" and not (self.reason and self.better):
            raise ValueError("a bad example needs the reason and the better reply")
        return self


class FlowTraining(_Strict):
    enabled: bool = False  # the per-flow switch: off = calls use the prompt exactly as without training
    token_cap: int = Field(DEFAULT_TOKEN_CAP, ge=MIN_TOKEN_CAP, le=MAX_TOKEN_CAP)
    persona: Optional[TrainingPersona] = None
    phrases: List[TrainingPhrase] = Field(default_factory=list, max_length=120)
    knowledge: List[TrainingKnowledge] = Field(default_factory=list, max_length=120)
    examples: List[TrainingExample] = Field(default_factory=list, max_length=80)

    @model_validator(mode="after")
    def _ids(self) -> "FlowTraining":
        ids = [e.id for e in [*self.phrases, *self.knowledge, *self.examples]]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"duplicate training entry id(s): {', '.join(dupes)}")
        return self


# ------------------------------------------------------------------ runtime payload
def runtime_payload(training: Optional[FlowTraining], language: str, style: Optional[str],
                    *, ignore_switch: bool = False) -> Optional[Dict[str, Any]]:
    """Only what a call needs: the Active entries (no ids, no review flags). None = no block."""
    if training is None or not (training.enabled or ignore_switch):
        return None
    active = lambda items: [e for e in items if e.status == "active"]  # noqa: E731
    persona = training.persona if training.persona and training.persona.status == "active" else None
    if language == "en":
        styles = ("english",)
    else:
        styles = ("pure",) if style == "pure" else ("english", "mixed")
    phrases = [p for p in active(training.phrases) if p.style in styles]
    knowledge = active(training.knowledge)
    examples = [e for e in active(training.examples) if e.style is None or e.style in styles]
    if persona is None and not phrases and not knowledge and not examples:
        return None
    return {
        "cap": training.token_cap,
        "mixed": language != "en" and style != "pure",
        "persona": persona.model_dump(exclude={"status"}) if persona else None,
        "phrases": [{"situation": p.situation, "text": p.text, "when": p.when} for p in phrases],
        "facts": [{"topic": k.topic, "text": k.text, "always": k.always} for k in knowledge if k.kind == "fact"],
        "qa": [{"topic": k.topic, "questions": k.questions, "text": k.text} for k in knowledge if k.kind == "qa"],
        # situation / topic only when set: an example without them is stored exactly as before.
        "examples": [e.model_dump(include={"kind", "customer", "agent", "reason", "better"})
                     | ({"situation": e.situation} if e.situation else {}) | ({"topic": e.topic} if e.topic else {})
                     for e in examples],
    }


def runtime_json(training: Optional[FlowTraining], language: str, style: Optional[str]) -> Optional[str]:
    """The payload as stored on the call (variables["flow_training"]), or None."""
    payload = runtime_payload(training, language, style)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) if payload else None


# ------------------------------------------------------------------ compile
_FORMALITY = {1: "very casual", 2: "casual", 3: "friendly but professional", 4: "formal", 5: "very formal"}
_WARMTH = {1: "neutral", 2: "polite", 3: "warm", 4: "warm and friendly", 5: "very warm"}
_ENERGY = {1: "very calm", 2: "calm", 3: "relaxed", 4: "lively", 5: "energetic"}
_POLITENESS = {1: "plain", 2: "courteous", 3: "polite", 4: "very polite", 5: "very polite and respectful"}
_PACE = {"slow": "slow and patient", "steady": "steady and unhurried"}
_LENGTH = {"short": "short", "medium": "short to medium"}
_TITLE = {
    "never": "Do not add sir or madam to your replies.",
    "rarely": "Add sir or madam rarely, only as given by title_to_use.",
    "sometimes": "Add sir or madam now and then, only as given by title_to_use.",
    "often": "Add sir or madam in most replies, only as given by title_to_use.",
}
_MIX = {"light": "keep only very common English words in English",
        "medium": "mix everyday English words naturally, the way people talk on the phone",
        "heavy": "use English freely for most business words"}


_PROFILE_LINES = (
    ("objective", "Business objective of this call: {}"),
    ("call_purpose", "Why you are calling: {}"),
    ("target_customer", "Who you are calling: {}"),
    ("intro", "Approved company introduction (say it in your own words, once, keeping its meaning): {}"),
    ("desired_outcome", "A good outcome: {}. A clear no is respected, never pushed against."),
)


def profile_lines(p: Mapping[str, Any]) -> List[str]:
    """The agent profile (who calls, for which company, why), or [] when none of it is filled in."""
    name, company, business = p.get("agent_name") or "", p.get("company") or "", p.get("business_type") or ""
    lines: List[str] = []
    if name or company:
        who = f"Your name is {name}" if name else "You"
        lines.append(f"- {who}{', calling on behalf of ' + company if company else ''}.")
    if business:
        lines.append(f"- Business type: {business}.")
    lines += [f"- {template.format(p[key])}" for key, template in _PROFILE_LINES if p.get(key)]
    return ["Agent profile:"] + lines if lines else []


def persona_lines(p: Mapping[str, Any], mixed: bool) -> List[str]:
    lines = profile_lines(p) + ["Persona and tone:"]
    if p.get("role"):
        lines.append(f"- Role: {p['role']}")
    lines.append(f"- Manner: {_FORMALITY[p['formality']]}, {_WARMTH[p['warmth']]}, {_ENERGY[p['energy']]}, "
                 f"{_POLITENESS[p['politeness']]}.")
    lines.append(f"- Pace: {_PACE[p['pace']]}. Sentences: {_LENGTH[p['sentence_length']]}.")
    lines.append(f"- {_TITLE[p['title_use']]}")
    if mixed and p.get("english_mix"):
        lines.append(f"- English mix: {_MIX[p['english_mix']]}.")
    if p.get("avoid"):
        lines.append(f"- Avoid: {', '.join(p['avoid'])}.")
    if p.get("notes"):
        lines.append(f"- Note: {p['notes']}")
    return lines


def core_text(payload: Mapping[str, Any]) -> str:
    parts = [HEADER]
    if payload.get("persona"):
        parts.append("\n" + "\n".join(persona_lines(payload["persona"], bool(payload.get("mixed")))))
    always = [f for f in payload.get("facts", []) if f.get("always")]
    if always:
        parts.append("\nCompany facts (true; use only when relevant):\n" + "\n".join(f"- {f['text']}" for f in always))
    how = []
    if payload.get("phrases"):
        how.append("- Approved short phrases may be listed below. Use one only when it fits, vary them, and never "
                   "use the same phrase as in your previous reply.")
    if payload.get("qa"):
        how.append("- When a listed question comes up, give its approved answer and keep its meaning exactly.")
    if payload.get("examples"):
        how.append("- Examples show the style only: never copy them word for word.")
    if how:
        parts.append("\nHow to use these notes:\n" + "\n".join(how))
    return "".join(parts)


_WORD = re.compile(r"[\wऀ-ॣ०-෿']+")
_STOP = frozenset("a an the is are am was be to of and or in on at for it this that i you we me my your our do does "
                  "did can could will would should with about what how have has so just".split())


def words(text: Optional[str]) -> List[str]:
    return [w for w in _WORD.findall((text or "").lower()) if w not in _STOP]


def _trigrams(text: str) -> set:
    t = " " + " ".join(_WORD.findall(text.lower())) + " "
    return {t[i:i + 3] for i in range(len(t) - 2)} if len(t) > 3 else set()


# One shared meaningful word counts as a strong match only when the customer said little else (e.g. "Price?").
# In a longer message a single shared word ("company") is weak: below every relevance threshold.
SHORT_MESSAGE_WORDS = 3
SINGLE_WORD_WEAK = 0.25
TRIGRAM_WEIGHT = 0.7


def similarity(message: str, candidate: str) -> float:
    """0..1: share of the candidate's meaningful words in the message, or character-trigram overlap (copes
    with suffixes in Tamil / Hindi and spelling variants in Tanglish). A single shared word is a strong match
    only in a short message; trigram overlap is weighed down so one shared long word can't pass alone."""
    cw = set(words(candidate))
    mw = set(words(message))
    hits = len(cw & mw)
    if not cw or not hits:
        overlap = 0.0
    elif hits >= 2 or len(mw) <= SHORT_MESSAGE_WORDS:
        overlap = hits / len(cw)
    else:
        overlap = min(hits / len(cw), SINGLE_WORD_WEAK)
    a, b = _trigrams(message), _trigrams(candidate)
    dice = 2 * len(a & b) / (len(a) + len(b)) if a and b else 0.0
    return max(overlap, TRIGRAM_WEIGHT * dice)


# Customer words that point at a situation (English, Tanglish, Tamil, Hindi, Telugu, Kannada). A cue that is
# one ASCII word must match a whole word; any other cue matches anywhere in the message.
SITUATION_CUES: Dict[str, Tuple[str, ...]] = {
    "busy": ("busy", "later", "driving", "in a meeting", "call back", "callback", "not now", "bad time", "pisi",
             "பிஸி", "அப்புறம்", "அப்பறம்", "व्यस्त", "बाद में", "బిజీ", "తర్వాత", "ಬ್ಯುಸಿ", "ಆಮೇಲೆ"),
    "price": ("price", "pricing", "cost", "costs", "charges", "rate", "how much", "discount", "quotation", "fees",
              "evlo", "evvalavu", "எவ்வளவு", "விலை", "कितना", "कीमत", "ఎంత", "ధర", "ಎಷ್ಟು", "ಬೆಲೆ"),
    "refuse": ("send details", "send me", "send the details", "whatsapp me", "mail me"),
    "objection": ("already", "expensive", "costly", "budget", "we have", "existing", "another provider",
                  "employees", "staff", "don't trust", "dont trust", "eraganave", "ஏற்கனவே", "பணம் இல்ல",
                  "पहले से", "महंगा", "ಈಗಾಗಲೇ", "ఇప్పటికే"),
    "uncertain": ("not sure", "maybe", "perhaps", "think about", "think it over", "let me think", "need time",
                  "some time", "will see", "i'll see", "decide later", "don't know", "dont know", "no idea",
                  "confused", "theriyala", "theriyalai", "theriyale", "yosichu", "yosikkanum", "yosikanum",
                  "yosikiren", "yosikkiren", "yosikaren", "paakalam", "pakkalam", "pakalam", "aprom solren",
                  "apram solren", "appuram solren", "konjam time", "doubt", "தெரியல", "தெரியலை", "தெரியவில்லை",
                  "யோசிச்சு", "யோசிக்க", "யோசிக்கிறேன்", "பார்க்கலாம்", "பாக்கலாம்", "குழப்பம்",
                  "पता नहीं", "सोच", "शायद", "dekhte hain", "soch ke", "ಗೊತ್ತಿಲ್ಲ", "ಯೋಚಿಸ", "తెలియదు", "ఆలోచి"),
    "identity": ("who is this", "who are you", "who is calling", "who's calling", "which company", "your name",
                 "where are you calling from", "yaaru", "yaru", "யாரு", "யார்", "எந்த company", "kaun", "कौन",
                 "ಯಾರು", "ఎవరు"),
    "disclosure": ("robot", "bot", "are you ai", "are you an ai", "you ai", "real person", "human", "recording",
                   "recorded", "machine", "computer", "automated", "ai ah", "ai-ah", "ai ya", "ரோபோ", "மெஷின்",
                   "रोबोट", "मशीन", "ರೋಬೋಟ್", "రోబో"),
    "greeting": ("hello", "hi", "hey", "vanakkam", "வணக்கம்", "namaste", "नमस्ते", "ನಮಸ್ಕಾರ", "నమస్కారం",
                 "good morning", "good afternoon", "good evening"),
    "clarify": ("explain", "meaning", "what do you mean", "how does it work", "how it works", "details",
                "vilakkam", "விளக்கி", "விளக்கம்", "matlab", "मतलब", "समझाइए", "ಅರ್ಥ", "అర్థం"),
    "empathy": ("problem", "difficult", "tough", "struggling", "issue", "stress", "headache", "kashtam", "கஷ்டம்",
                "பிரச்சனை", "परेशानी", "दिक्कत", "ಕಷ್ಟ", "కష్టం"),
    "closing": ("not interested", "no thanks", "don't need", "dont need", "no need", "bye", "venam", "vendam",
                "wasting my time", "waste my time", "waste pannadheenga", "stop it", "leave it",
                "வேண்டாம்", "வேணாம்", "नहीं चाहिए", "వద్దు", "ಬೇಡ"),
    "thanks": ("thank", "thanks", "நன்றி", "धन्यवाद", "ధన్యవాదాలు", "ಧನ್ಯವಾದ"),
    "agree": ("yes", "yeah", "ok", "okay", "sure", "fine", "correct", "right", "interested", "interesting",
              "useful", "sounds good", "tell me more", "aama", "sari", "seri", "ஆமா", "ஆமாம்",
              "சரி", "haan", "हाँ", "हां", "అవును", "సరే", "ಹೌದು", "ಸರಿ"),
    "reask": ("what", "sorry", "pardon", "repeat", "again", "didn't get", "not clear", "enna", "என்ன", "புரியல",
              "क्या", "ఏమిటి", "ಏನು"),
}


# A one-word cue right after one of these (or right before a Tamil / Hindi / Kannada / Telugu "not") is
# negated: "not sure" is not agreement, "no problem" is not empathy, "not busy" is not busy.
NEGATE_BEFORE = frozenset({"not", "no", "never", "don't", "dont", "isn't", "isnt", "wasn't", "wasnt", "nor", "nothing"})
NEGATE_AFTER = frozenset({"illa", "illai", "ille", "இல்ல", "இல்லை", "nahi", "nahin", "नहीं", "ಇಲ್ಲ", "లేదు"})
# A refusal ends the conversation: these situations would keep it going, so they are not offered with it.
REFUSAL_SUPPRESSES = frozenset({"objection", "agree", "clarify", "transition", "price", "reask", "uncertain"})
# Ties (same number of cues) go to the earlier situation here; the rest keep SITUATION_CUES order.
TIE_ORDER = ("closing", "busy", "uncertain", "disclosure", "identity", "price", "objection", "clarify", "empathy")


def _cue_hits(cue: str, text: str, tokens: List[str]) -> bool:
    if " " in cue or not cue.isascii():
        if " " not in cue and cue in tokens:  # a whole Indic word: negation applies
            return any(not _negated(tokens, i) for i, t in enumerate(tokens) if t == cue)
        return cue in text  # a phrase, or an Indic stem inside a longer word
    return any(not _negated(tokens, i) for i, t in enumerate(tokens) if t == cue)


def _negated(tokens: List[str], i: int) -> bool:
    return (i > 0 and tokens[i - 1] in NEGATE_BEFORE) or (i + 1 < len(tokens) and tokens[i + 1] in NEGATE_AFTER)


_DNC_EXTRA = re.compile(r"\b(?:my\s+)?number\s*(?:-?\s*(?:ai|ah|a)\s+)?(?:remove|delete)\b|\bnumber\s*-?ஐ\s*remove",
                        re.IGNORECASE)


def is_do_not_call_request(message: Optional[str]) -> bool:
    """The customer asks never to be called again. Uses the same detector as DNC_ENFORCE
    (call_service.is_do_not_call, which leaves "don't call me now / later" to busy), plus "number remove"
    phrasings it doesn't cover. Only picks which training lines a reply is offered: enforcement is unchanged."""
    text = message or ""
    if not text.strip():
        return False
    from app.services.call_service import is_do_not_call  # lazy: call_service imports the flow modules

    return is_do_not_call(text) or bool(_DNC_EXTRA.search(text))


def matched_situations(message: Optional[str]) -> List[str]:
    """Situations the customer's words point at, most cues first ([] = none). A do-not-call request is
    only "closing"; a refusal ("closing") comes first and drops the situations that would keep talking."""
    if is_do_not_call_request(message):
        return ["closing"]
    text = " " + " ".join((message or "").lower().replace("\u2019", "'").split()) + " "
    tokens = _WORD.findall(text)
    scores: Dict[str, int] = {}
    for situation, cues in SITUATION_CUES.items():
        hits = sum(_cue_hits(cue, text, tokens) for cue in cues)
        if hits:
            scores[situation] = hits
    order = list(SITUATION_CUES)
    rank = {s: (TIE_ORDER.index(s) if s in TIE_ORDER else len(TIE_ORDER) + order.index(s)) for s in scores}
    ranked = sorted(scores, key=lambda s: (-scores[s], rank[s]))
    if "closing" in ranked:
        ranked = ["closing"] + [s for s in ranked if s != "closing" and s not in REFUSAL_SUPPRESSES]
    return ranked


def situations_for(message: Optional[str]) -> List[str]:
    """Situations the customer's words point at (best two first), then acknowledge as the fallback;
    none matched = acknowledge, then transition."""
    ranked = matched_situations(message)[:2]
    if not ranked:
        return ["acknowledge", "transition"]
    return ranked + ([] if "acknowledge" in ranked else ["acknowledge"])


def _norm(text: str) -> str:
    return " ".join(_WORD.findall(text.lower()))


def phrase_line(p: Mapping[str, Any]) -> str:
    when = f" ({p['when']})" if p.get("when") else ""
    return f'- {SITUATION_LABELS[p["situation"]].capitalize()}: "{p["text"]}"{when}'


def qa_line(qa: Mapping[str, Any]) -> str:
    return f'- If asked about {qa["topic"]} (e.g. "{qa["questions"][0]}"), answer: "{qa["text"]}"'


def fact_line(fact: Mapping[str, Any]) -> str:
    return f"- Fact ({fact['topic']}): {fact['text']}"


def example_line(e: Mapping[str, Any]) -> str:
    if e["kind"] == "good":
        return f'- Good example. Customer: "{e["customer"]}" Agent: "{e["agent"]}"'
    return f'- Avoid. Customer: "{e["customer"]}" Agent: "{e["agent"]}" ({e["reason"]}). Better: "{e["better"]}"'


def used_in(phrase: str, reply_norm: str) -> bool:
    """The phrase (its words, variables left out) appears in the normalized previous reply."""
    words_ = _norm(_VAR.sub(" ", phrase))
    return bool(words_) and f" {words_} " in reply_norm


QA_THRESHOLD = 0.4
ANSWERED_SHARE = 0.6  # this share of an answer's words in the previous reply = it was just given


def qa_score(message: str, qa: Mapping[str, Any]) -> float:
    return max([similarity(message, q) for q in qa["questions"]] + [similarity(message, qa["topic"])])


def just_answered(answer: str, last_norm: str) -> bool:
    """The previous reply already gave this approved answer (its meaningful words, in any order)."""
    aw = set(words(answer))
    if not aw or not last_norm:
        return False
    return len(aw & set(last_norm.split())) / len(aw) >= ANSWERED_SHARE


def repeat_line(qa: Mapping[str, Any]) -> str:
    return (f'- You just gave the approved answer about {qa["topic"]}: do not repeat it word for word. Ask what is '
            f'still unclear, or say it more simply in one sentence.')


DNC_LINE = ("- The customer asked not to be called again: say the do-not-call line and end the call. Nothing else "
            "from these notes applies.")


EARLIER_WORDS_WEIGHT = 0.8  # what the customer said earlier in the call counts a little less than their latest words


def conversation_score(score: Callable[[str], float], message: str, recent: Optional[Sequence[str]]) -> float:
    """How relevant something is to the customer's latest words, or to what they said earlier in the call."""
    return max([score(message)] + [EARLIER_WORDS_WEIGHT * score(earlier) for earlier in recent or ()])


def tail_items(payload: Mapping[str, Any], message: Optional[str], last_reply: Optional[str],
               recent: Optional[Sequence[str]] = None) -> List[Tuple[str, str]]:
    """(kind, line) candidates for this reply, most relevant first within each kind. `recent` (an Autonomous AI
    Agent's call: the customer's earlier words, may be empty) ranks all the knowledge instead of picking a few."""
    msg = message or ""
    last = f" {_norm(last_reply)} " if last_reply else ""
    if is_do_not_call_request(msg):
        # Checked before any other cue: only closing phrases, never a re-ask, a Q&A or an example.
        closing = [p for p in payload.get("phrases", []) if p["situation"] == "closing" and not used_in(p["text"], last)]
        return [("dnc", DNC_LINE)] + [("phrase", phrase_line(p)) for p in closing[:2]]
    items: List[Tuple[str, str]] = []
    everything = recent is not None
    # Q&A and topic facts. An answer given in the previous reply is not offered again word for word.
    scored: List[Tuple[float, str]] = []
    for qa in payload.get("qa", []):
        score = conversation_score(lambda text: qa_score(text, qa), msg, recent)
        if everything or score >= QA_THRESHOLD:
            scored.append((score, repeat_line(qa) if just_answered(qa["text"], last) else qa_line(qa)))
    for fact in payload.get("facts", []):
        if not fact.get("always"):
            score = conversation_score(
                lambda text: max(similarity(text, fact["topic"]), similarity(text, fact["text"])), msg, recent)
            if everything or score >= QA_THRESHOLD:
                scored.append((score, fact_line(fact)))
    ranked = sorted(scored, key=lambda s: -s[0])
    items += [("knowledge", line) for _, line in (ranked if everything else ranked[:TAIL_KNOWLEDGE])]
    # Phrases for the situation, never one used in the previous reply.
    situations = situations_for(msg)
    phrases = [p for s in situations for p in payload.get("phrases", [])
               if p["situation"] == s and not used_in(p["text"], last)]
    items += [("phrase", phrase_line(p)) for p in phrases[:TAIL_PHRASES]]
    # Examples whose customer line (or topic) is like the customer's words; one labelled with a situation
    # the words point at gets a lift.
    matched = set(situations[:2]) & set(matched_situations(msg))
    ex_scored = [(example_score(msg, e, matched), example_line(e)) for e in payload.get("examples", [])]
    items += [("example", line) for score, line in sorted(ex_scored, key=lambda s: -s[0])[:TAIL_EXAMPLES] if score >= 0.3]
    return items


SITUATION_LIFT = 0.2


def example_score(message: str, e: Mapping[str, Any], matched: set) -> float:
    score = similarity(message, e["customer"])
    if e.get("topic"):
        score = max(score, similarity(message, e["topic"]))
    return score + (SITUATION_LIFT if e.get("situation") in matched else 0.0)


TAIL_TITLE = "\nFor this reply (picked for the customer's last words):\n"
KNOWLEDGE_TITLE = "\nApproved knowledge for this call, most relevant to the conversation first (use only what fits):\n"


@dataclass
class CompiledTraining:
    text: str
    core_tokens: int
    tail_tokens: int
    selected: List[str] = field(default_factory=list)  # tail lines in the block
    dropped: List[str] = field(default_factory=list)  # relevant tail lines left out: the cap was reached

    @property
    def tokens(self) -> int:
        return self.core_tokens + self.tail_tokens


def compile_training(payload: Mapping[str, Any], message: Optional[str] = None,
                     last_reply: Optional[str] = None, recent: Optional[Sequence[str]] = None) -> CompiledTraining:
    """The block for one reply: the fixed core, then the relevant tail filled within the cap."""
    core = core_text(payload)
    core_tokens = estimate_tokens(core)
    title = TAIL_TITLE if recent is None else KNOWLEDGE_TITLE
    budget = int(payload.get("cap") or DEFAULT_TOKEN_CAP) - core_tokens - estimate_tokens(title)
    chosen: List[str] = []
    dropped: List[str] = []
    for _, line in tail_items(payload, message, last_reply, recent):
        cost = estimate_tokens(line) + 1
        if cost <= budget:
            chosen.append(line)
            budget -= cost
        else:
            dropped.append(line)
    tail = title + "\n".join(chosen) if chosen else ""
    return CompiledTraining(text=core + tail, core_tokens=core_tokens, tail_tokens=estimate_tokens(tail),
                            selected=chosen, dropped=dropped)


MOCK_WITHOUT = ("(simulated - not an AI reply) Mock mode asks no AI. Without training, the AI would answer from the "
                "script alone; run a real provider test to see its actual words.")
MOCK_NO_MATCH = ("(simulated - not an AI reply) No training entry matches these words: the AI would answer from the "
                 "script and the always-on notes (agent profile, tone, facts).")
MOCK_DNC = ("(simulated - not an AI reply) Do-not-call request: the AI says the script's do-not-call line and "
            "ends the call; training offers nothing else.")


def mock_reply(payload: Mapping[str, Any], message: Optional[str], last_reply: Optional[str] = None) -> str:
    """The Training tab's free test: no provider is asked. The best-matching approved answer, else a phrase
    for the situation the words point at, else a note that nothing matches. Variables are left as written."""
    msg = message or ""
    last = f" {_norm(last_reply)} " if last_reply else ""
    if is_do_not_call_request(msg):
        return MOCK_DNC
    best: Tuple[float, Optional[Mapping[str, Any]]] = (0.0, None)
    for qa in payload.get("qa", []):
        score = qa_score(msg, qa)
        if score >= QA_THRESHOLD and score > best[0]:
            best = (score, qa)
    if best[1] is not None and not just_answered(best[1]["text"], last):
        return best[1]["text"]
    for situation in matched_situations(msg)[:2]:
        for p in payload.get("phrases", []):
            if p["situation"] == situation and not used_in(p["text"], last):
                return p["text"]
    return MOCK_NO_MATCH


def worst_case_tokens(payload: Mapping[str, Any]) -> Tuple[int, int]:
    """(core tokens, largest possible tail): the most a single reply's block can cost."""
    core = estimate_tokens(core_text(payload))

    def largest(lines: List[str], n: int) -> int:
        return sum(sorted((estimate_tokens(line) + 1 for line in lines), reverse=True)[:n])

    phrases = [phrase_line(p) for p in payload.get("phrases", [])]
    knowledge = [qa_line(q) for q in payload.get("qa", [])]
    knowledge += [fact_line(f) for f in payload.get("facts", []) if not f.get("always")]
    examples = [example_line(e) for e in payload.get("examples", [])]
    tail = largest(phrases, TAIL_PHRASES) + largest(knowledge, TAIL_KNOWLEDGE) + largest(examples, TAIL_EXAMPLES)
    return core, (tail + estimate_tokens(TAIL_TITLE) if tail else 0)


def cap_issue(training: FlowTraining, language: str, style: Optional[str]) -> Optional[str]:
    """Why the Active entries can't be active together (over the token cap), or None."""
    payload = runtime_payload(training, language, style, ignore_switch=True)
    if payload is None:
        return None
    core, tail = worst_case_tokens(payload)
    if core + tail > training.token_cap:
        return (f"Active training can reach ~{core + tail} tokens per reply (always-on part ~{core}, "
                f"largest per-reply part ~{tail}), over the cap of {training.token_cap}. "
                f"Shorten or archive entries, or raise the cap.")
    return None
