"""A Tamil AI Agent's identity opening (Dispatch identityOpening, 2026-11-27): the flow carries
autonomous.fixed_greeting and its greeting is the user's line

    "Hello. {{time_greeting}}, {{title_to_use}}. நான் <agent>, <company>-ல இருந்து பேசுறேன்.
     Am I speaking with {{customer_name}}, {{title_to_use}}?"

What the backend guarantees:
  * it is the call's first line, word for word, rendered while the phone rings, whatever AGENT_FIXED_GREETING says;
  * Good morning / afternoon / evening follows India time; sir / madam follows the GIVEN gender, sir when there is
    none (never guessed from the name);
  * a contact without a name hears it without the question (never "Hello, good day." instead);
  * the LLM is told the greeting was said and the question asked, so it never introduces itself or asks again;
  * a flow without fixed_greeting (every other agent) is exactly as before: same hash, same opening.
Fake STT / LLM / TTS / Plivo: nothing real is called."""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import pytest

from app.core.config import settings
from app.flows.loader import flow_hash, parse_flow
from app.services import call_service as cs
from app.services import llm_service as llm
from app.services.call_service import FIXED_GREETING_VARIABLE, GREETING_IDENTITY_VARIABLE, opening_line
from tests.test_autonomous_agent import _capture_systems
from tests.test_autonomous_conversation import _dial, _flow
from tests.test_call_policy import _rows
from tests.test_nila_flow import _send, _start, _until
from tests.conftest import silence_mulaw, tone_mulaw

IDENTITY_OPENING = ("Hello. {{time_greeting}}, {{title_to_use}}. நான் Thaara, Kagzso Automation-ல இருந்து பேசுறேன். "
                    "Am I speaking with {{customer_name}}, {{title_to_use}}?")
INTRO = "நான் Thaara, Kagzso Automation-ல இருந்து பேசுறேன்."


def _identity_flow(monkeypatch) -> dict:
    flow = _flow("ta", monkeypatch)
    flow["greeting"] = {"text": IDENTITY_OPENING}
    flow["autonomous"]["fixed_greeting"] = True
    return flow


def _wait(cond, limit=5.0):
    deadline = time.time() + limit
    while not cond() and time.time() < deadline:
        time.sleep(0.05)
    return cond()


def _variables(sync_engine, call_id) -> dict:
    raw = _rows(sync_engine, "select variables from calls where id = :id", call_id)[0][0]
    return json.loads(raw) if isinstance(raw, str) else raw


# ------------------------------------------------------------------ the line as spoken
_UTC = timezone.utc


@pytest.mark.parametrize("name,gender,hour_utc,expected", [
    # 03:00 UTC = 08:30 India, 08:00 UTC = 13:30, 13:00 UTC = 18:30, 20:00 UTC = 01:30 (night = evening)
    ("Kumar", "male", 3, f"Hello. Good morning, sir. {INTRO} Am I speaking with Kumar, sir?"),
    ("Priya", "female", 8, f"Hello. Good afternoon, madam. {INTRO} Am I speaking with Priya, madam?"),
    ("Kumar", "unknown", 13, f"Hello. Good evening, sir. {INTRO} Am I speaking with Kumar, sir?"),
    ("Kumar", None, 20, f"Hello. Good evening, sir. {INTRO} Am I speaking with Kumar, sir?"),
    ("Priya", "unspecified", 3, f"Hello. Good morning, sir. {INTRO} Am I speaking with Priya, sir?"),  # never guessed
    (None, "female", 3, f"Hello. Good morning, madam. {INTRO}"),  # no name: no question
    ("", None, 8, f"Hello. Good afternoon, sir. {INTRO}"),
])
def test_the_line_follows_india_time_the_given_gender_and_the_name(name, gender, hour_utc, expected):
    variables = llm.build_call_variables(name, gender, "+919999999999", now=datetime(2026, 11, 27, hour_utc, tzinfo=_UTC))
    variables[FIXED_GREETING_VARIABLE] = "true"
    assert opening_line(IDENTITY_OPENING, variables) == expected


def test_any_other_greeting_without_a_name_is_as_before():
    no_name = llm.build_call_variables(None, "male", "+919999999999")
    assert opening_line(IDENTITY_OPENING, no_name) == cs.NO_NAME_GREETING  # not an agent's fixed greeting
    nila = "Hi {{customer_name}} {{title}}, this is Nila."
    assert opening_line(nila, {**no_name, FIXED_GREETING_VARIABLE: "true"}) == cs.NO_NAME_GREETING  # nothing else left
    old_tamil = "வணக்கம் {{title}}. நான் Thaara, Kagzso Technology Services-ல இருந்து பேசறேன்."
    assert opening_line(old_tamil, {**no_name, FIXED_GREETING_VARIABLE: "true"}) == old_tamil.replace("{{title}}", "sir")


# ------------------------------------------------------------------ the flow
def test_the_flow_accepts_the_switch_and_without_it_keeps_its_hash(monkeypatch):
    plain = _flow("ta", monkeypatch)
    before = flow_hash(parse_flow(plain))
    assert parse_flow(plain).autonomous.fixed_greeting is False
    assert flow_hash(parse_flow({**plain, "autonomous": {**plain["autonomous"], "fixed_greeting": False}})) == before
    on = _identity_flow(monkeypatch)
    assert parse_flow(on).autonomous.fixed_greeting is True
    assert flow_hash(parse_flow(on)) != before


# ------------------------------------------------------------------ a call
@pytest.fixture
def ringing(monkeypatch):
    monkeypatch.setattr(settings, "AGENT_FIXED_GREETING", False)  # the flow decides, not the backend's switch
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)


def test_the_call_opens_with_it_word_for_word_and_the_llm_carries_on(client, auth, fakes, sync_engine, monkeypatch,
                                                                     ringing):
    flow = _identity_flow(monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = "ரொம்ப நன்றி சார். இப்போ கொஞ்சம் பேச முடியுமா?"
    call_id, token = _dial(client, auth, flow, customer_name="Kumar")  # gender male
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    rendered = fakes.tts.synthesized[-1][0]
    assert rendered.startswith("Hello. Good ") and rendered.endswith(f", sir. {INTRO} Am I speaking with Kumar, sir?")
    variables = _variables(sync_engine, call_id)
    assert variables[FIXED_GREETING_VARIABLE] == "true" and variables[GREETING_IDENTITY_VARIABLE] == "true"
    fakes.stt.replies = ["ஆமாம், நான்தான் பேசுறேன்."]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        cp = _until(ws, "checkpoint")  # the greeting, with no LLM
        assert fakes.llm.seen_messages == []
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        time.sleep(0.5)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # "yes, it's me"
        _until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    assert len(fakes.llm.seen_messages) == 1
    history = [m["content"] for m in fakes.llm.seen_messages[0]]
    assert rendered in history  # it knows what was said
    system = systems[-1]
    assert llm.GREETING_IDENTITY_RULES in system and llm.AGENT_FIXED_GREETING_RULE in system
    assert llm.AGENT_OPEN_IDENTITY_RULES not in system  # "never ask to confirm" would contradict the greeting


def test_a_contact_without_a_name_hears_it_without_the_question(client, auth, fakes, sync_engine, monkeypatch, ringing):
    flow = _identity_flow(monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = "சரி சார்."
    call_id, token = _dial(client, auth, flow, customer_name=None)
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    rendered = fakes.tts.synthesized[-1][0]
    assert rendered.startswith("Hello. Good ") and rendered.endswith(f", sir. {INTRO}") and "?" not in rendered
    variables = _variables(sync_engine, call_id)
    assert variables[FIXED_GREETING_VARIABLE] == "true" and GREETING_IDENTITY_VARIABLE not in variables
    fakes.stt.replies = ["சொல்லுங்க"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        cp = _until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        time.sleep(0.5)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    system = systems[-1]
    assert llm.NO_NAME_RULE in system and llm.GREETING_IDENTITY_RULES not in system


def test_an_agent_without_it_still_opens_in_the_llms_words(client, auth, fakes, sync_engine, monkeypatch, ringing):
    flow = _flow("ta", monkeypatch)  # every other agent: no fixed_greeting
    call_id, _ = _dial(client, auth, flow, customer_name="Kumar")
    variables = _variables(sync_engine, call_id)
    assert FIXED_GREETING_VARIABLE not in variables and GREETING_IDENTITY_VARIABLE not in variables
    time.sleep(0.3)
    assert not cs.has_greeting_audio(call_id)  # nothing rendered while ringing: the LLM opens, as before


def test_the_preview_shows_the_line_and_the_prompt_a_call_gets(client, auth, monkeypatch):
    flow = _identity_flow(monkeypatch)
    r = client.post("/api/flows/preview", headers=auth,
                    json={"flow": flow, "sample": {"customer_name": "Kumar", "gender": "female"}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["greeting"].endswith(f", madam. {INTRO} Am I speaking with Kumar, madam?")
    assert llm.GREETING_IDENTITY_RULES in body["system_prompt"]
