"""Dispatch's "AI Greeting Delay": the agent greets exactly this many seconds after the customer
answers - only the delay starts the greeting (the customer's first words don't start, move or cut
it; a do-not-call / AI question still gets the script). Once per call; a hang-up during the wait
cancels it. Calls without the setting keep the configured timing exactly. Fakes only (GREETING_DELAY_MS is 60 s in tests, so any greeting
that plays on its own here comes from the delay)."""
import json
import time
import xml.etree.ElementTree as ET
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import text

from app.db.models import utcnow
from app.services.call_service import greeting_delay_of
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_media_stream import _send_audio, _start_msg
from tests.test_flows import nila_copy
from tests.test_nila_flow import PHONE, _nila_id, _send, _start, _until


def _outbound(client, auth, agent_id, **extra):
    body = {"phone_number": PHONE, "customer_name": "Ragul", "agent_id": agent_id, **extra}
    r = client.post("/api/calls/outbound", headers=auth, json=body)
    assert r.status_code == 200, r.text
    call_id = r.json()["call_id"]
    xml = client.post(f"/api/webhooks/plivo/answer?call_id={call_id}", data={"CallUUID": "uuid-g", "CallStatus": "in-progress"}).text
    token = parse_qs(urlparse(ET.fromstring(xml.split("?>", 1)[1]).find("Stream").text).query)["token"][0]
    return call_id, token


KINDS = ["no-fixed-greeting", "fixed-question", "time-of-day"]


def _call_kind(client, auth, kind, **extra):
    """no-fixed-greeting = the default agent (the AI writes its opening); fixed-question = a flow
    greeting "Hello, am I speaking with ...?"; time-of-day = Nila's "Hi sir, Good morning."."""
    if kind == "no-fixed-greeting":
        return _outbound(client, auth, 1, **extra)
    if kind == "time-of-day":
        return _outbound(client, auth, _nila_id(client, auth), **extra)
    flow = nila_copy(greeting={"text": "Hello, am I speaking with {{customer_name}}?"})
    return _outbound(client, auth, 1, flow_id="flow_gd", flow_version=1, flow_draft=True, flow=flow, **extra)


def _answered_ago(sync_engine, call_id, seconds):
    with sync_engine.begin() as c:
        c.execute(text("update calls set answered_at = :t where id = :id"), {"t": utcnow() - timedelta(seconds=seconds), "id": call_id})


def _greeting_after(ws):
    """Seconds from the stream start until the first agent audio, with no customer speech."""
    t = time.monotonic()
    ws.send_text(json.dumps(_start_msg()))
    _until(ws, "playAudio")
    return time.monotonic() - t


def _agent_lines(sync_engine, call_id):
    time.sleep(0.4)
    with sync_engine.connect() as c:
        return c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent' order by id"),
                         {"id": call_id}).scalars().all()


# ------------------------------------------------------------------ the value
def test_the_value_is_validated_and_absent_means_the_configured_timing(client, auth):
    assert greeting_delay_of({}) is None and greeting_delay_of({"greeting_delay_sec": ""}) is None
    assert greeting_delay_of({"greeting_delay_sec": "2.0"}) == 2.0 and greeting_delay_of({"greeting_delay_sec": "0"}) == 0
    assert greeting_delay_of({"greeting_delay_sec": "11"}) is None
    for bad in (-1, 10.5, "soon"):
        r = client.post("/api/calls/outbound", headers=auth,
                        json={"phone_number": PHONE, "customer_name": "Ragul", "agent_id": 1, "greeting_delay_sec": bad})
        assert r.status_code == 422


# ------------------------------------------------------------------ timing, counted from the answer
@pytest.mark.parametrize("kind", KINDS)
def test_zero_seconds_greets_at_once(client, auth, fakes, kind):
    call_id, token = _call_kind(client, auth, kind, greeting_delay_sec=0)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        assert _greeting_after(ws) < 0.6


@pytest.mark.parametrize("kind", KINDS)
def test_two_seconds_waits_two_seconds_after_the_answer(client, auth, fakes, kind):
    call_id, token = _call_kind(client, auth, kind, greeting_delay_sec=2)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        waited = _greeting_after(ws)
    assert 1.8 <= waited < 2.8


def test_the_maximum_counts_from_the_answer_not_the_stream_start(client, auth, fakes, sync_engine):
    # 10 s (the maximum), answered 9 s before the media stream connected: about 1 s is left.
    call_id, token = _outbound(client, auth, 1, greeting_delay_sec=10)
    _answered_ago(sync_engine, call_id, 9)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        waited = _greeting_after(ws)
    assert 0.7 <= waited < 1.8


def test_without_the_setting_the_configured_timing_is_unchanged(client, auth, fakes):
    call_id, token = _outbound(client, auth, 1)  # GREETING_DELAY_MS is 60 s in tests
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(2.5)
        _send_audio(ws, silence_mulaw(100))
    assert fakes.tts.streams == [] and all("Ragul" not in t for t, _ in fakes.tts.synthesized)


# ------------------------------------------------------------------ hang-up, duplicates
def test_a_hang_up_during_the_delay_cancels_the_greeting(client, auth, fakes, sync_engine):
    call_id, token = _outbound(client, auth, 1, greeting_delay_sec=1)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(0.3)  # the customer hangs up 0.3 s into the 1 s delay
    time.sleep(1.5)  # well past the delay
    assert fakes.tts.streams == []
    assert _agent_lines(sync_engine, call_id) == []


def test_speaking_first_greets_once_and_the_delay_never_greets_again(client, auth, fakes, sync_engine):
    call_id, token = _outbound(client, auth, _nila_id(client, auth), greeting_delay_sec=1.5)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # "Hello?" during the delay: greeted at once
        _until(ws, "checkpoint")
        time.sleep(2.0)  # past the delay: it must not greet a second time
        _send(ws, silence_mulaw(100))
    lines = _agent_lines(sync_engine, call_id)
    assert len(lines) == 1 and lines[0].startswith("Hi sir")
    assert sum(len(s.texts) for s in fakes.tts.streams) == 1


# ------------------------------------------------------------------ only the set delay starts the greeting
@pytest.mark.parametrize("kind", ["fixed-question", "time-of-day"])
def test_speaking_first_does_not_start_the_greeting_early(client, auth, fakes, kind):
    call_id, token = _call_kind(client, auth, kind, greeting_delay_sec=2)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        t = time.monotonic()
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))  # "Hello?" right after answering
        _until(ws, "playAudio")
        waited = time.monotonic() - t
    assert 1.8 <= waited < 2.8  # still exactly the 2 s delay


def test_talking_when_the_delay_ends_does_not_move_or_cut_the_greeting(client, auth, fakes, sync_engine):
    call_id, token = _call_kind(client, auth, "fixed-question", greeting_delay_sec=1)
    fakes.stt.replies = ["Hello hello who is this"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        t = time.monotonic()
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(0.6)
        _send_audio(ws, tone_mulaw(1200))  # still talking when the 1 s delay ends
        _until(ws, "playAudio")
        waited = time.monotonic() - t
        _send_audio(ws, silence_mulaw(900))  # they stop: no barge-in on the greeting
        msgs = []
        for _ in range(60):
            m = ws.receive_json()
            msgs.append(m["event"])
            if m["event"] == "checkpoint":
                break
    assert 0.9 <= waited < 1.8 and "clearAudio" not in msgs
    lines = _agent_lines(sync_engine, call_id)
    assert lines and lines[0] == "Hello, am I speaking with Ragul?"


def test_a_click_on_pickup_does_not_change_the_delay(client, auth, fakes):
    call_id, token = _call_kind(client, auth, "fixed-question", greeting_delay_sec=2)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        t = time.monotonic()
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(120) + silence_mulaw(900))
        _until(ws, "playAudio")
        assert time.monotonic() - t >= 1.7


def test_do_not_call_said_first_gets_the_script_not_the_greeting(client, auth, fakes, sync_engine):
    call_id, token = _call_kind(client, auth, "time-of-day", greeting_delay_sec=3)
    fakes.stt.replies = ["Don't call me again"]
    fakes.llm.reply = "Understood. I respect your request. Thank you."
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(600) + silence_mulaw(900))
        deadline = time.time() + 5
        while time.time() < deadline and not any("respect your request" in l for l in _agent_lines(sync_engine, call_id)):
            _send(ws, silence_mulaw(200))
    assert any("respect your request" in l for l in _agent_lines(sync_engine, call_id))
    with sync_engine.connect() as c:
        events = c.execute(text("select event_type from call_events where call_id = :id"), {"id": call_id}).scalars().all()
    assert "greeting_skipped" in events
