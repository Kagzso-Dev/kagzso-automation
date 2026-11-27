"""A Tamil AI Agent's identity opening (Dispatch identityOpening, 2026-11-27): the flow carries
autonomous.fixed_greeting and its greeting is the user's line

    "Hello. {{time_greeting}}, {{title_to_use}}. நான் <agent>, <company>-ல இருந்து பேசுறேன்.
     Am I speaking with {{customer_name}}, {{title_to_use}}?"

What the backend guarantees:
  * it is the call's first line, word for word and exactly once, rendered while the phone rings, whatever
    AGENT_FIXED_GREETING says; the LLM never writes an opening of its own;
  * Good morning / afternoon / evening follows India time; Sir / Madam follows the GIVEN gender, Sir when there is
    none (never guessed from the name, whatever CALL_DEFAULT_TITLE says);
  * a contact without a name hears it without the question (never "Hello, good day." instead);
  * the LLM is told the greeting was said and the question asked, so it never introduces itself or asks again; the
    wrong-person, privacy and do-not-call rules stay;
  * every other greeting (AGENT_FIXED_GREETING included) and every flow without fixed_greeting is exactly as before.
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
from app.services.call_service import (FIXED_GREETING_VARIABLE, GREETING_IDENTITY_VARIABLE, IDENTITY_OPENING_VARIABLE,
                                       opening_line)
from tests.test_autonomous_agent import _capture_systems
from tests.test_autonomous_conversation import _dial, _flow
from tests.test_call_policy import _agent_lines, _rows
from tests.test_nila_flow import _send, _start, _until
from tests.conftest import silence_mulaw, tone_mulaw

IDENTITY_OPENING = ("Hello. {{time_greeting}}, {{title_to_use}}. நான் Thaara, Kagzso Automation-ல இருந்து பேசுறேன். "
                    "Am I speaking with {{customer_name}}, {{title_to_use}}?")
INTRO = "நான் Thaara, Kagzso Automation-ல இருந்து பேசுறேன்."
REPLY = "ரொம்ப நன்றி சார். இப்போ கொஞ்சம் பேச முடியுமா?"


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


def _lines(sync_engine, call_id, count=1, limit=3.0):
    """The agent's saved lines, once the call's teardown has written them."""
    _wait(lambda: len(_agent_lines(sync_engine, call_id)) >= count, limit)
    return _agent_lines(sync_engine, call_id)


def _variables(sync_engine, call_id) -> dict:
    raw = _rows(sync_engine, "select variables from calls where id = :id", call_id)[0][0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _opening(name, gender, now=None):
    variables = llm.build_call_variables(name, gender, "+919999999999", now=now)
    variables[FIXED_GREETING_VARIABLE] = variables[IDENTITY_OPENING_VARIABLE] = "true"
    return opening_line(IDENTITY_OPENING, variables)


# ------------------------------------------------------------------ the line as spoken
def _utc(hour, minute=0):
    return datetime(2026, 11, 27, hour, minute, tzinfo=timezone.utc)  # India = UTC + 5:30


@pytest.mark.parametrize("now,time_greeting", [
    (_utc(23, 30), "Good morning"),     # 05:00 India
    (_utc(3), "Good morning"),          # 08:30
    (_utc(6, 29), "Good morning"),      # 11:59
    (_utc(6, 30), "Good afternoon"),    # 12:00
    (_utc(11, 29), "Good afternoon"),   # 16:59
    (_utc(11, 30), "Good evening"),     # 17:00
    (_utc(20), "Good evening"),         # 01:30 (night)
    (_utc(23, 29), "Good evening"),     # 04:59
], ids=["05:00", "08:30", "11:59", "12:00", "16:59", "17:00", "01:30", "04:59"])
def test_india_time_decides_the_time_of_day(now, time_greeting):
    assert _opening("Kumar", "male", now) == f"Hello. {time_greeting}, Sir. {INTRO} Am I speaking with Kumar, Sir?"


@pytest.mark.parametrize("name,gender,expected", [
    ("Kumar", "male", f"Hello. Good morning, Sir. {INTRO} Am I speaking with Kumar, Sir?"),
    ("Priya", "female", f"Hello. Good morning, Madam. {INTRO} Am I speaking with Priya, Madam?"),
    ("Kumar", "unknown", f"Hello. Good morning, Sir. {INTRO} Am I speaking with Kumar, Sir?"),
    ("Kumar", None, f"Hello. Good morning, Sir. {INTRO} Am I speaking with Kumar, Sir?"),
    ("Priya", "unspecified", f"Hello. Good morning, Sir. {INTRO} Am I speaking with Priya, Sir?"),  # never guessed
    (None, "female", f"Hello. Good morning, Madam. {INTRO}"),  # no name: no question
    ("", None, f"Hello. Good morning, Sir. {INTRO}"),
    ("  ", "male", f"Hello. Good morning, Sir. {INTRO}"),
])
def test_the_given_gender_and_the_customer_name(name, gender, expected):
    assert _opening(name, gender, _utc(3)) == expected


def test_unknown_is_sir_whatever_call_default_title_says(monkeypatch):
    monkeypatch.setattr(settings, "CALL_DEFAULT_TITLE", "")
    assert _opening("Kumar", None).endswith("Am I speaking with Kumar, Sir?")


def test_any_other_greeting_is_as_before_even_when_agent_fixed_greeting_makes_it_fixed():
    no_name = llm.build_call_variables(None, "male", "+919999999999")
    named = llm.build_call_variables("Kumar", "male", "+919999999999")
    env_fixed = {FIXED_GREETING_VARIABLE: "true"}  # AGENT_FIXED_GREETING: not the identity opening
    assert opening_line(IDENTITY_OPENING, no_name) == cs.NO_NAME_GREETING
    assert opening_line(IDENTITY_OPENING, {**no_name, **env_fixed}) == cs.NO_NAME_GREETING
    assert opening_line(IDENTITY_OPENING, {**named, **env_fixed}).endswith("Kumar, sir?")  # rendered as ever
    nila = "Hi {{customer_name}} {{title}}, this is Nila."
    assert opening_line(nila, {**no_name, **env_fixed}) == cs.NO_NAME_GREETING
    old_tamil = "வணக்கம் {{title}}. நான் Thaara, Kagzso Technology Services-ல இருந்து பேசறேன்."
    assert opening_line(old_tamil, {**no_name, **env_fixed}) == old_tamil.replace("{{title}}", "sir")


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


def _answer_once(client, call_id, token, said):
    """The customer picks up, hears the greeting, then says `said` once; the call then ends."""
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        cp = _until(ws, "checkpoint")  # the greeting
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        time.sleep(0.5)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # the LLM's reply
        ws.send_text(json.dumps({"event": "stop"}))


def test_the_call_opens_with_it_once_and_the_llm_carries_on(client, auth, fakes, sync_engine, monkeypatch, ringing):
    flow = _identity_flow(monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = REPLY
    call_id, token = _dial(client, auth, flow, customer_name="Kumar")  # gender male
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    rendered = fakes.tts.synthesized[-1][0]
    assert rendered.startswith("Hello. Good ") and rendered.endswith(f", Sir. {INTRO} Am I speaking with Kumar, Sir?")
    variables = _variables(sync_engine, call_id)
    assert variables[FIXED_GREETING_VARIABLE] == variables[IDENTITY_OPENING_VARIABLE] == "true"
    assert variables[GREETING_IDENTITY_VARIABLE] == "true"
    fakes.stt.replies = ["ஆமாம், நான்தான் பேசுறேன்."]
    _answer_once(client, call_id, token, "ஆமாம், நான்தான் பேசுறேன்.")
    assert len(fakes.llm.seen_messages) == 1  # only the customer's reply went to the LLM: it never wrote an opening
    history = fakes.llm.seen_messages[0]
    assert [m["content"] for m in history if m["role"] == "assistant"] == [rendered]  # it knows what was said
    assert history[-1]["content"] == "ஆமாம், நான்தான் பேசுறேன்."
    assert not any("has just picked up the phone" in m["content"] for m in history)  # never asked to open
    assert _lines(sync_engine, call_id, count=2) == [rendered, REPLY]  # the greeting once, then the LLM in Tamil
    system = systems[-1]
    assert llm.GREETING_IDENTITY_RULES in system and llm.AGENT_FIXED_GREETING_RULE in system
    assert llm.AGENT_OPEN_IDENTITY_RULES not in system  # "never ask to confirm" would contradict the greeting
    # Wrong person, privacy before confirmation and do-not-call stay exactly as the agent's rules were.
    for kept in ("If the person says they are not the customer or that this is the wrong number",
                 "Until the person has shown that they are the customer, speak about the company in general terms only",
                 "If the customer is not available, thank the person politely and end the call",
                 "A request not to be called again always ends the call"):
        assert kept in system


def test_a_contact_without_a_name_hears_it_without_the_question(client, auth, fakes, sync_engine, monkeypatch, ringing):
    flow = _identity_flow(monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = "சரி சார்."
    call_id, token = _dial(client, auth, flow, customer_name=None)
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    rendered = fakes.tts.synthesized[-1][0]
    assert rendered.startswith("Hello. Good ") and rendered.endswith(f", Sir. {INTRO}") and "?" not in rendered
    variables = _variables(sync_engine, call_id)
    assert variables[IDENTITY_OPENING_VARIABLE] == "true" and GREETING_IDENTITY_VARIABLE not in variables
    fakes.stt.replies = ["சொல்லுங்க"]
    _answer_once(client, call_id, token, "சொல்லுங்க")
    assert _lines(sync_engine, call_id, count=2) == [rendered, "சரி சார்."]
    system = systems[-1]
    assert llm.NO_NAME_RULE in system and llm.GREETING_IDENTITY_RULES not in system


def test_an_agent_without_it_still_opens_in_the_llms_words(client, auth, fakes, sync_engine, monkeypatch, ringing):
    flow = _flow("ta", monkeypatch)  # every other agent: no fixed_greeting
    call_id, _ = _dial(client, auth, flow, customer_name="Kumar")
    variables = _variables(sync_engine, call_id)
    assert not {FIXED_GREETING_VARIABLE, IDENTITY_OPENING_VARIABLE, GREETING_IDENTITY_VARIABLE} & set(variables)
    time.sleep(0.3)
    assert not cs.has_greeting_audio(call_id)  # nothing rendered while ringing: the LLM opens, as before


def test_the_preview_shows_the_line_and_the_prompt_a_call_gets(client, auth, monkeypatch):
    flow = _identity_flow(monkeypatch)
    r = client.post("/api/flows/preview", headers=auth,
                    json={"flow": flow, "sample": {"customer_name": "Kumar", "gender": "female"}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["greeting"].endswith(f", Madam. {INTRO} Am I speaking with Kumar, Madam?")
    assert llm.GREETING_IDENTITY_RULES in body["system_prompt"]
