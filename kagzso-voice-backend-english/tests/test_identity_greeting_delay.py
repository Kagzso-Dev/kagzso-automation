"""AI Greeting Delay with a Tamil AI Agent's identity opening (2026-11-27): the greeting never starts over the
customer's words. It plays at the set delay after the answer; if the customer is talking then, it waits until they
stop, and if they spoke first ("Hello?") the same delay counts again from the end of their words. Every other agent
keeps the delay exactly as before (tests/test_greeting_delay.py). Fake STT / LLM / TTS / Plivo: nothing real is called."""
from __future__ import annotations

import json
import time

import pytest

from app.core.config import settings
from app.services import call_service as cs
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_autonomous_conversation import _dial
from tests.test_identity_opening import _identity_flow, _lines
from tests.test_media_stream import _send_audio, _start_msg
from tests.test_nila_flow import _until


@pytest.fixture
def greeted_at(monkeypatch):
    """Seconds after the stream started at which the greeting started (one entry per greeting)."""
    monkeypatch.setattr(settings, "AGENT_FIXED_GREETING", False)
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)
    times: list[float] = []
    original = cs.CallSession._greet_now

    def record(self, trigger):
        if not (self._closed or self._opening_taken or self._agent_spoke):
            times.append(time.monotonic() - self._stream_started)
        return original(self, trigger)

    monkeypatch.setattr(cs.CallSession, "_greet_now", record)
    return times


def _receive_until_checkpoint(ws):
    events = []
    for _ in range(80):
        m = ws.receive_json()
        events.append(m["event"])
        if m["event"] == "checkpoint":
            return events
    raise AssertionError("no checkpoint")


def test_silence_greets_at_the_set_delay(client, auth, fakes, sync_engine, monkeypatch, greeted_at):
    call_id, token = _dial(client, auth, _identity_flow(monkeypatch), greeting_delay_sec=1)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _until(ws, "playAudio")
    assert len(greeted_at) == 1 and 0.9 <= greeted_at[0] < 1.6
    assert _lines(sync_engine, call_id)[0].startswith("Hello. Good")


def test_talking_when_the_delay_ends_waits_until_they_stop(client, auth, fakes, sync_engine, monkeypatch, greeted_at):
    fakes.stt.replies = ["Hello hello who is this"]
    call_id, token = _dial(client, auth, _identity_flow(monkeypatch), greeting_delay_sec=1)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(0.3)
        _send_audio(ws, tone_mulaw(1200))  # the customer starts talking and is still talking at 1 s
        time.sleep(1.7)
        assert greeted_at == []  # 2 s in: not greeted over their words
        _send_audio(ws, silence_mulaw(900))  # they stop
        events = _receive_until_checkpoint(ws)
    assert len(greeted_at) == 1 and 2.0 <= greeted_at[0] < 3.5  # the 1 s delay again after their words ended
    assert "clearAudio" not in events
    lines = _lines(sync_engine, call_id)
    assert len(lines) == 1 and lines[0].startswith("Hello. Good")


def test_hello_first_then_the_delay_counts_from_the_end_of_their_words(
        client, auth, fakes, sync_engine, monkeypatch, greeted_at):
    fakes.stt.replies = ["Hello?"]
    call_id, token = _dial(client, auth, _identity_flow(monkeypatch), greeting_delay_sec=2)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(1.2)
        _send_audio(ws, tone_mulaw(400))  # "Hello?" at 1.2 s ...
        time.sleep(0.4)
        _send_audio(ws, silence_mulaw(900))  # ... ends at about 1.6 s
        _receive_until_checkpoint(ws)
    # Not at 2 s (0.4 s after their words) but the full 2 s after they stopped.
    assert len(greeted_at) == 1 and 2.9 <= greeted_at[0] < 4.3


def test_a_line_that_never_goes_quiet_still_gets_the_greeting(client, auth, fakes, monkeypatch, greeted_at):
    monkeypatch.setattr(cs, "IDENTITY_GREETING_MAX_EXTRA_SEC", 1.0)
    call_id, token = _dial(client, auth, _identity_flow(monkeypatch), greeting_delay_sec=0.5)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(5000))  # talking (or noise) the whole time
        _until(ws, "playAudio")
    assert len(greeted_at) == 1 and 1.4 <= greeted_at[0] < 2.2  # 0.5 s delay + the 1 s cap

