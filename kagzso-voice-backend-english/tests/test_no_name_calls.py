"""The customer's name never blocks or breaks a call:
- no name: the call is placed; a greeting that names the customer becomes "Hello, good day.",
  the identity question is skipped, and nothing like "None" / "null" / "undefined" is spoken;
- someone else answers or it's unclear who: the agent says "No problem, thanks for picking up."
  and carries on (prompt rule), and the outcome follows their answer to the introduction;
- a saved, confirmed name: exactly as before."""
import time
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, urlparse

from sqlalchemy import text

from app.services import llm_service as llm
from app.services.call_service import NO_NAME_GREETING, opening_line
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_flows import nila_copy
from tests.test_nila_flow import PHONE, _nila_id, _send, _start, _until

BAD = ("none", "null", "undefined", "{{", "}}")


def _place(client, auth, **body):
    r = client.post("/api/calls/outbound", headers=auth, json={"phone_number": PHONE, **body})
    assert r.status_code == 200, r.text
    call_id = r.json()["call_id"]
    xml = client.post(f"/api/webhooks/plivo/answer?call_id={call_id}", data={"CallUUID": "uuid-n", "CallStatus": "in-progress"}).text
    token = parse_qs(urlparse(ET.fromstring(xml.split("?>", 1)[1]).find("Stream").text).query)["token"][0]
    return call_id, token


def _agent_lines(sync_engine, call_id):
    time.sleep(0.4)
    with sync_engine.connect() as c:
        return c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent' order by id"),
                         {"id": call_id}).scalars().all()


def test_the_opening_line_without_and_with_a_name():
    for greeting in ("Hello, am I speaking with {{customer_name}}?", "Hi {{name}}?"):
        for missing in ({}, {"customer_name": ""}, {"customer_name": "   "}, {"customer_name": None}):
            assert opening_line(greeting, {"gender": "male", **missing}) == NO_NAME_GREETING
        assert opening_line(greeting, {"customer_name": "Ragul"}) in ("Hello, am I speaking with Ragul?", "Hi Ragul?")
    # Greetings that don't name the customer are untouched.
    assert opening_line("Hi {{title_to_use}}, {{time_greeting}}.", {"gender": "male"}).startswith("Hi sir, Good ")
    # A name at the start of any system line leaves no stray comma or blank.
    assert llm.render_first_message("{{name}}, are you still there?", {}) == "are you still there?"


def test_a_name_greeting_without_a_name_plays_hello_good_day(client, auth, fakes, sync_engine):
    flow = nila_copy(greeting={"text": "Hello, am I speaking with {{customer_name}}?"})
    call_id, token = _place(client, auth, agent_id=1, flow_id="flow_nn", flow_version=1, flow_draft=True, flow=flow)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
    lines = _agent_lines(sync_engine, call_id)
    assert lines[0] == NO_NAME_GREETING
    assert not any(b in " ".join(lines).lower() for b in BAD)


def test_time_of_day_greeting_without_a_name_skips_the_identity_question(client, auth, fakes, sync_engine):
    call_id, token = _place(client, auth, agent_id=_nila_id(client, auth), gender="male")
    fakes.stt.replies = ["Hello?", "Yes, tell me"]
    fakes.llm.reply = "Thank you, sir. This is Thaara from Kexo AI and Automation. Do you have a minute?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # "Hi sir, Good morning."
        time.sleep(1.5)  # past the pause after which the identity question would come
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # the agent carries on
    lines = _agent_lines(sync_engine, call_id)
    assert lines[0].startswith("Hi sir, Good")
    assert not any("speaking with" in l.lower() for l in lines)  # no identity question without a name
    assert lines[-1] == fakes.llm.reply
    assert not any(b in " ".join(lines).lower() for b in BAD)


def test_the_prompt_tells_the_agent_to_carry_on_with_whoever_answered():
    named = llm.build_system_prompt(llm.NILA_AGENT["system_prompt"], {"customer_name": "Ragul", "gender": "male"}, "en")
    nameless = llm.build_system_prompt(llm.NILA_AGENT["system_prompt"], {"gender": "male"}, "en")
    for prompt in (named, nameless):
        assert "No problem, thanks for picking up." in prompt and "do not end the call" in prompt
        assert prompt.index(llm.IDENTITY_RULES) > prompt.index(llm.SAFETY_RULES)  # after the flow and the safety rules
    assert llm.NO_NAME_RULE in nameless and llm.NO_NAME_RULE not in named
    assert '"customer_name": null' in nameless  # the data block says "unknown", never "None"
    # Asking not to be called again still ends the call.
    assert "not to be called again" in llm.SAFETY_RULES and llm.END_CALL_TOKEN in llm.SAFETY_RULES


def test_the_outcome_follows_their_answer_to_the_introduction():
    assert "If they heard it, classify their answer to it instead" in llm.OUTCOME_SYSTEM
    assert "whoever picked up" in llm.OUTCOME_SYSTEM


def test_a_saved_confirmed_name_is_unchanged(client, auth, fakes, sync_engine):
    flow = nila_copy(greeting={"text": "Hello, am I speaking with {{customer_name}}?"})
    call_id, token = _place(client, auth, agent_id=1, customer_name="Ragul", flow_id="flow_nm", flow_version=1,
                            flow_draft=True, flow=flow)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
    assert _agent_lines(sync_engine, call_id)[0] == "Hello, am I speaking with Ragul?"
