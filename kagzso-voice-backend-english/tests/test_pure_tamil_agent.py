"""A Tamil AI Agent with "Speak only Tamil" (Dispatch pureLanguage, 2026-11-27): its flow is published with the pure
language style, which the backend already has for Call Flows. Its calls get the Tamil-only reply rule (Tamil script,
English only for names, the company name and words like WhatsApp; never a whole reply in English), even when
AGENT_FOLLOW_CUSTOMER_LANGUAGE would let a mixed agent follow the customer into English. Every other agent is as before.
Fake STT / LLM / TTS / Plivo: nothing real is called."""
from __future__ import annotations

import json

import pytest

from app.core.config import settings
from app.flows.loader import parse_flow
from tests.test_autonomous_agent import _capture_systems
from tests.test_autonomous_conversation import _dial, _flow
from tests.test_call_policy import _rows
from tests.test_identity_opening import IDENTITY_OPENING, _answer_once

PURE_LINE = "One call, one language: keep every reply in Tamil even if the customer answers in English"
FOLLOW_LINE = "Follow the customer's language"
MIXED_LINE = "Write every English word you use in English (Latin) letters"


def _variables(sync_engine, call_id) -> dict:
    raw = _rows(sync_engine, "select variables from calls where id = :id", call_id)[0][0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _system(client, auth, fakes, sync_engine, flow):
    systems = _capture_systems(fakes)
    fakes.llm.reply = "சரி சார்."
    fakes.stt.replies = ["I am busy, tell me quickly"]
    call_id, token = _dial(client, auth, flow, customer_name="Kumar")
    _answer_once(client, call_id, token, "I am busy, tell me quickly")
    return systems[-1], _variables(sync_engine, call_id)


@pytest.fixture
def ringing(monkeypatch):
    monkeypatch.setattr(settings, "AGENT_FIXED_GREETING", False)
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)
    monkeypatch.setattr(settings, "AGENT_FOLLOW_CUSTOMER_LANGUAGE", True)  # the follow-English switch, on


def test_the_agent_flow_with_the_pure_style_is_accepted(monkeypatch):
    flow = {**_flow("ta", monkeypatch), "language_style": "pure"}
    assert parse_flow(flow).language_style == "pure"


def test_speak_only_tamil_keeps_every_reply_in_tamil_even_when_the_customer_speaks_english(
        client, auth, fakes, sync_engine, monkeypatch, ringing):
    flow = _flow("ta", monkeypatch)
    flow.update(language_style="pure", greeting={"text": IDENTITY_OPENING})
    flow["autonomous"]["fixed_greeting"] = True
    system, variables = _system(client, auth, fakes, sync_engine, flow)
    assert variables["flow_language_style"] == "pure"
    assert PURE_LINE in system
    assert FOLLOW_LINE not in system and MIXED_LINE not in system
    assert "Write Tamil words in Tamil script. NEVER transliterate English words into Tamil script." in system


def test_an_agent_without_it_is_as_before(client, auth, fakes, sync_engine, monkeypatch, ringing):
    system, variables = _system(client, auth, fakes, sync_engine, _flow("ta", monkeypatch))
    assert "flow_language_style" not in variables
    assert PURE_LINE not in system
    assert MIXED_LINE in system and FOLLOW_LINE in system  # mixed, following the customer: exactly as before
