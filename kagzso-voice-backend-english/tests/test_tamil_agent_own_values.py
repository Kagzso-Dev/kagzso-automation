"""A Tamil autonomous AI Agent's call takes everything from the agent (2026-11-28): its own compiled flow is the only
flow the call reads. Another Call Flow ("ABC Hospital - Thaara") called earlier for the same contact leaves nothing
behind: no greeting text, name, company, fact, number, voice, speed or call length of it reaches the agent's call.

    greeting   the agent's identity opening, word for word, with its own name and company ("Calling on behalf of")
    voice      the agent's saved voice (ritu) on the call and in the log; speed = the agent's own (0.96)
    length     the agent's maximum is the phone system's time limit
    prompt     the agent's own blocks and knowledge; none of the other flow's text
    silence    written by the agent's LLM (AGENT_SILENCE_REPROMPT_INSTRUCTION), never the flow's fixed lines

The other flow's own call (an ordinary Tamil flow) is unchanged: no agent setting reaches it.
Fake STT / LLM / TTS / Plivo: nothing real is called."""
from __future__ import annotations

import copy
import json
import logging
import time

import pytest

from app.core.config import settings
from app.services import call_service as cs
from app.services import llm_service as llm
from app.services.call_service import FIXED_GREETING_VARIABLE, IDENTITY_OPENING_VARIABLE
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_autonomous_agent import _capture_systems
from tests.test_autonomous_conversation import _dial, _flow
from tests.test_call_policy import _rows
from tests.test_nila_flow import _send, _start, _until

KAYAL_OPENING = ("Hello. {{time_greeting}}, {{title_to_use}}. நான் Kayal, Kagzso Technology-ல இருந்து பேசுறேன். "
                 "Am I speaking with {{customer_name}}, {{title_to_use}}?")
# What only the other flow says: none of it may reach the agent's call.
ABC_GREETING = "வணக்கம் sir. நான் Thaara, ABC Hospital-ல இருந்து பேசறேன்."
ABC_FACTS = ("# ABC HOSPITAL FACTS\n\n* ABC Hospital has 200 beds and a 24-hour pharmacy.\n"
             "* Call ABC Hospital on +91 90000 55555.\n\n---\n\n")
ABC_SILENCE = {"reprompt": "ABC Hospital-ல இருந்து பேசறேன், கேக்குதா?", "closing": "ABC Hospital சார்பா நன்றி."}
ABC_MARKS = ("ABC Hospital", "Thaara", "200 beds", "pharmacy", "90000 55555", "anushka")


def _kayal_flow(monkeypatch) -> dict:
    """The Tamil agent as Dispatch compiles it (tests/fixtures/autonomous/ta.json) for Kayal of Kagzso Technology, with
    the identity opening, the voice Ritu and the speed 0.96."""
    flow = _flow("ta", monkeypatch)
    raw = json.dumps(flow, ensure_ascii=False)
    raw = raw.replace("Kagzso Technology Services", "Kagzso Technology").replace("Thaara", "Kayal")
    raw = raw.replace("ABC Hospital - Kayal", "Kagzso Technology")  # the agent's list name
    flow = json.loads(raw)
    flow["greeting"] = {"text": KAYAL_OPENING}
    flow["voice_id"] = "ritu"
    flow["autonomous"].update(fixed_greeting=True, voice_pace=0.96)
    return flow


def _abc_flow(agent_flow: dict) -> dict:
    """An ordinary Tamil Call Flow (no `autonomous`): its own greeting, facts with a number, silence lines, voice and
    length."""
    flow = copy.deepcopy(agent_flow)
    for key in ("autonomous", "training"):
        flow.pop(key, None)
    flow["name"] = "ABC Hospital - Thaara"
    flow["greeting"] = {"text": ABC_GREETING}
    flow["silence"] = ABC_SILENCE
    flow["voice_id"] = "anushka"
    flow["limits"] = {"max_duration_sec": 300}
    flow["blocks"] = [b for b in flow["blocks"] if b.get("id") != "ai_instructions"]
    flow["blocks"].insert(1, {"id": "abc_facts", "group": "main_script", "text": ABC_FACTS})
    return flow


def _wait(cond, limit=5.0):
    deadline = time.time() + limit
    while not cond() and time.time() < deadline:
        time.sleep(0.05)
    return cond()


def _variables(sync_engine, call_id) -> dict:
    raw = _rows(sync_engine, "select variables from calls where id = :id", call_id)[0][0]
    return json.loads(raw) if isinstance(raw, str) else raw


def _call_row(sync_engine, call_id):
    return _rows(sync_engine, "select c.voice_id, a.system_prompt, a.first_message from calls c join agents a "
                              "on a.id = c.agent_id where c.id = :id", call_id)[0]


@pytest.fixture
def ringing(monkeypatch):
    monkeypatch.setattr(settings, "AGENT_FIXED_GREETING", False)  # the agent's flow decides, not the backend's switch
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)


def test_the_agent_call_uses_only_the_agent_after_another_flow_called_the_same_contact(
        client, auth, fakes, sync_engine, monkeypatch, ringing, caplog):
    agent_flow = _kayal_flow(monkeypatch)
    abc_flow = _abc_flow(agent_flow)
    caplog.set_level(logging.INFO)

    # 1. The same contact is called first with the ABC Hospital flow (an ordinary Tamil flow): exactly as before.
    abc_id, _ = _dial(client, auth, abc_flow, flow_id="abc_thaara", customer_name="Ragul")
    abc_vars = _variables(sync_engine, abc_id)
    assert abc_vars["flow_id"] == "abc_thaara"
    for agent_only in ("flow_agent_voice", "flow_voice_pace", "flow_natural_lines", "flow_instructions_lead",
                       FIXED_GREETING_VARIABLE, IDENTITY_OPENING_VARIABLE):
        assert agent_only not in abc_vars  # no agent setting reaches an ordinary flow's call
    assert abc_vars["flow_silence_reprompt"] == ABC_SILENCE["reprompt"]
    assert fakes.plivo.time_limits[-1] == min(300, settings.MAX_CALL_DURATION_SECONDS)  # its own length, as before

    # 2. Then the Tamil agent calls the same contact.
    systems = _capture_systems(fakes)
    fakes.tts.synthesized.clear()
    caplog.clear()
    fakes.llm.reply = "சரி Ragul sir."
    call_id, token = _dial(client, auth, agent_flow, flow_id="kagzso_kayal", customer_name="Ragul")
    assert _wait(lambda: cs.has_greeting_audio(call_id))

    # Greeting: the agent's identity opening, its own name and company, once, rendered while it rang.
    greeting = fakes.tts.synthesized[-1][0]
    assert greeting.startswith("Hello. Good ")
    assert greeting.endswith(", Sir. நான் Kayal, Kagzso Technology-ல இருந்து பேசுறேன். Am I speaking with Ragul, Sir?")

    # Voice, speed and length: the agent's own, saved on the call.
    variables = _variables(sync_engine, call_id)
    voice_id, system_prompt, first_message = _call_row(sync_engine, call_id)
    assert variables["flow_id"] == "kagzso_kayal"
    assert voice_id == variables["flow_agent_voice"] == "ritu"
    assert variables["flow_voice_pace"] == "0.96" and cs.agent_voice_pace(variables) == 0.96
    assert variables["flow_voice_profile"] == cs.AGENT_VOICE_PROFILE
    assert variables["flow_max_sec"] == "105" and fakes.plivo.time_limits[-1] == 105
    assert variables[FIXED_GREETING_VARIABLE] == variables[IDENTITY_OPENING_VARIABLE] == "true"
    assert any("Call voice: ritu (the agent's saved voice) - every line of this call" in r.getMessage()
               for r in caplog.records)

    # Silence lines: the agent's LLM writes them (natural lines, see the next test).
    assert variables["flow_natural_lines"] == "true"
    # The ABC flow's own call did carry its number in its prompt: the check below is not vacuous.
    assert "+91 90000 55555" in _call_row(sync_engine, abc_id)[1]

    # One customer turn, so the reply's whole system prompt is seen.
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        cp = _until(ws, "checkpoint")  # the greeting
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        time.sleep(0.5)
        fakes.stt.replies = ["ஆமாம்"]
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    system = systems[-1]

    # Nothing of the other flow anywhere: the agent row, the call's saved values, the prompt, the spoken lines.
    spoken = " ".join(t for t, _ in fakes.tts.synthesized)
    saved = json.dumps(variables, ensure_ascii=False)
    for where, text in (("agent prompt", system_prompt), ("greeting", first_message), ("call variables", saved),
                        ("reply prompt", system), ("spoken", spoken)):
        for mark in ABC_MARKS:
            assert mark not in text, f"{mark!r} from the other flow reached the agent call's {where}"
    # ...and the agent's own: its name, company, instructions and knowledge.
    assert "You are **Kayal**, an AI calling assistant for **Kagzso Technology**" in system
    assert "# AI CONVERSATION INSTRUCTIONS (FROM THE ADMIN)" in system
    assert "Kagzso automates billing follow-ups and payment reminders for hospitals." in system  # approved knowledge
    assert llm.AGENT_FIXED_GREETING_RULE in system  # the greeting is said: no second opening from the LLM
    # The only number: the agent's own "Company callback number", said only when the customer asks.
    assert "+91 98000 12345 (say the number slowly, digit by digit, and only when they ask how to reach the company)" in system


def test_silence_on_an_agent_call_is_the_agents_own_words(client, auth, fakes, sync_engine, monkeypatch, ringing):
    """The customer says nothing after the greeting: the re-prompt is the agent's LLM line, never the flow's fixed
    reprompt text."""
    agent_flow = _kayal_flow(monkeypatch)
    agent_flow["silence"] = ABC_SILENCE  # even if a fixed line were in the agent's flow, the LLM writes the re-prompt
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 0.6)
    fakes.llm.reply = "Ragul sir, கேக்குதா?"
    call_id, token = _dial(client, auth, agent_flow, flow_id="kagzso_kayal_silence", customer_name="Ragul")
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        cp = _until(ws, "checkpoint")  # the greeting
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        cp = _until(ws, "checkpoint")  # the re-prompt, after the silence
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.llm.seen_messages and fakes.llm.seen_messages[-1][-1]["content"] == cs.AGENT_SILENCE_REPROMPT_INSTRUCTION
    spoken = [t for t, _ in fakes.tts.synthesized]
    assert ABC_SILENCE["reprompt"] not in " ".join(spoken)
