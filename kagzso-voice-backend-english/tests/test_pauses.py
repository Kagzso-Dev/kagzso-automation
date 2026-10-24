"""Pause markers {{short_delay}} / {{medium_delay}} / {{long_delay}} in lines the system speaks
word for word: the line is split at the markers, the parts are synthesized separately and real
silence of the flow's length is queued between them. Markers are never sent to TTS, spoken,
or written to the transcript or history."""
import asyncio
import base64
import json
import time

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.flows import loader
from app.flows.schema import FlowPauses
from app.services import call_service
from app.services.llm_service import (
    DEFAULT_PAUSES_MS,
    clean_spoken_text,
    pauses_from_variables,
    render_first_message,
    render_prompt,
    split_pauses,
)
from tests.conftest import FakeTTS, silence_mulaw, tone_mulaw
from tests.test_flows import nila_copy
from tests.test_nila_flow import _call, _send, _start

PAUSES = {"short_ms": 300, "medium_ms": 700, "long_ms": 1200}
FRAME = 160  # bytes of 8 kHz mu-law per 20 ms


# ------------------------------------------------------------------ splitting
def test_a_line_is_split_at_its_markers():
    assert split_pauses("Hi sir, {{short_delay}} Good afternoon.", PAUSES) == [("Hi sir,", 300, 300), ("Good afternoon.", 0, 0)]
    assert split_pauses("One {{medium_delay}} two {{long_delay}} three", PAUSES) == [
        ("One", 700, 700), ("two", 1200, 1200), ("three", 0, 0)]
    assert split_pauses("No markers here.", PAUSES) == [("No markers here.", 0, 0)]


def test_consecutive_markers_add_up_and_the_line_is_capped_at_5000_ms():
    assert split_pauses("A {{short_delay}}{{long_delay}} B", PAUSES) == [("A", 1500, 1500), ("B", 0, 0)]
    long = {"short_ms": 300, "medium_ms": 700, "long_ms": 3000}
    assert split_pauses("A {{long_delay}} {{long_delay}} B {{long_delay}} C", long) == [
        ("A", 6000, 5000), ("B", 3000, 0), ("C", 0, 0)]


def test_markers_at_the_start_or_end_are_ignored():
    assert split_pauses("{{long_delay}} Hello there. {{short_delay}}", PAUSES) == [("Hello there.", 0, 0)]
    assert split_pauses("{{long_delay}}{{short_delay}}", PAUSES) == []


def test_pauses_are_rounded_to_the_20_ms_frame():
    assert split_pauses("A {{short_delay}} B", {"short_ms": 310})[0][2] == 320
    assert split_pauses("A {{short_delay}} B", {"short_ms": 0})[0][2] == 0


def test_markers_never_reach_speech_text_or_the_agent_prompt():
    assert clean_spoken_text("Hello {{short_delay}} there {{ long_delay }}.") == "Hello there ."
    for stray in ("[short_delay]", "(medium delay)", "{long_delay}", "short_delay"):
        assert "delay" not in clean_spoken_text(f"Okay {stray} sir.")
    assert clean_spoken_text("Sorry for the long delay.") == "Sorry for the long delay."  # plain prose stays
    assert "delay" not in render_prompt("Say: Hi {{short_delay}} sir.", {})
    assert render_first_message("Hi {{title_to_use}}, {{short_delay}} {{time_greeting}}.", {"gender": "male"}).startswith(
        "Hi sir, {{short_delay}} Good")


# ------------------------------------------------------------------ flow settings
def test_validation_rejects_out_of_range_or_fractional_values():
    for bad in ({"short_ms": -1}, {"medium_ms": 3001}, {"long_ms": 1.5}, {"short_ms": 300, "extra": 1}):
        flow = nila_copy(pauses=bad)
        with pytest.raises(loader.FlowError):
            loader.parse_flow(flow)
    assert loader.parse_flow(nila_copy(pauses={"short_ms": 0, "medium_ms": 3000, "long_ms": 1200})).pauses.medium_ms == 3000


def test_old_flows_get_the_defaults_and_keep_their_hash():
    flow = loader.parse_flow(nila_copy())
    assert flow.pauses is None
    assert pauses_from_variables({}) == DEFAULT_PAUSES_MS == FlowPauses().model_dump()
    assert '"pauses"' not in json.dumps(flow.model_dump(mode="json") | {}) or flow.pauses is None
    with_pauses = loader.parse_flow(nila_copy(pauses=PAUSES))
    assert loader.flow_hash(flow) != loader.flow_hash(with_pauses)
    data = flow.model_dump(mode="json")
    data.pop("pauses")
    data.pop("recording_notice")  # also new and optional: left out when empty
    data.pop("identity")  # likewise (flow's own identity question)
    import hashlib
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert loader.flow_hash(flow) == hashlib.sha256(canonical.encode("utf-8")).hexdigest()  # same as before pauses


def test_pause_lengths_come_from_the_call_variables_and_are_clamped():
    assert pauses_from_variables({"flow_pause_short_ms": "500", "flow_pause_long_ms": "99999"}) == {
        "short_ms": 500, "medium_ms": 700, "long_ms": 3000}


# ------------------------------------------------------------------ audio
def test_silence_length_equals_the_setting_within_one_frame():
    tts = FakeTTS()
    one = len(tts.chunk) * 3  # FakeTTS.synthesize returns three chunks
    out = asyncio.run(call_service.synthesize_line(tts, "Hi sir, {{short_delay}} Good afternoon.", {"short_ms": 300}))
    assert abs((len(out) - 2 * one) - 300 * 8) <= FRAME
    assert out[one:one + 300 * 8] == b"\xff" * 300 * 8
    assert [t for t, _ in tts.synthesized] == ["Hi sir,", "Good afternoon."]


def test_a_line_without_markers_is_synthesized_exactly_as_before():
    tts = FakeTTS()
    out = asyncio.run(call_service.synthesize_line(tts, "Hi sir, Good afternoon.", PAUSES))
    assert tts.synthesized == [("Hi sir, Good afternoon.", None)] and out == tts.chunk * 3


def test_the_cache_key_changes_with_the_pause_values():
    call_service._GREETING_AUDIO["c1"] = ("Hi {{short_delay}} sir.", None, call_service.pause_key(PAUSES), b"x")
    assert call_service.take_greeting_audio("c1", "Hi {{short_delay}} sir.", None, {**PAUSES, "short_ms": 500}) is None
    call_service._GREETING_AUDIO["c1"] = ("Hi {{short_delay}} sir.", None, call_service.pause_key(PAUSES), b"x")
    assert call_service.take_greeting_audio("c1", "Hi {{short_delay}} sir.", None, dict(PAUSES)) == b"x"


# ------------------------------------------------------------------ end to end
GREETING = "Hello {{long_delay}} am I speaking with {{customer_name}}?"


def _flow_call(client, auth, greeting=GREETING, pauses=PAUSES):
    flow = nila_copy(greeting={"text": greeting}, pauses=pauses)
    return _call(client, auth, gender="male", flow_id="flow_pause", flow_version=1, flow_draft=True, flow=flow)


def _messages_until(ws, event, limit=400):
    got = []
    for _ in range(limit):
        m = ws.receive_json()
        got.append(m)
        if m["event"] == event:
            return got
    raise AssertionError(event)


def _played(msgs):
    return b"".join(base64.b64decode(m["media"]["payload"]) for m in msgs if m["event"] == "playAudio")


def _agent_said(sync_engine, call_id, count=1, timeout=3.0):
    rows = []
    end = time.time() + timeout
    while time.time() < end:
        with sync_engine.connect() as c:
            rows = c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent' order by id"),
                             {"id": call_id}).scalars().all()
        if len(rows) >= count:
            return rows
        time.sleep(0.05)
    return rows


def test_live_greeting_with_a_pause_plays_part_silence_part(client, auth, fakes, sync_engine):
    call_id, token = _flow_call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # customer speaks first -> the greeting
        audio_bytes = _played(_messages_until(ws, "checkpoint"))
    one = len(fakes.tts.chunk) * 3
    assert abs((len(audio_bytes) - 2 * one) - 1200 * 8) <= FRAME  # long_delay = 1200 ms of silence
    assert audio_bytes[one:one + 1200 * 8] == b"\xff" * 1200 * 8
    sent = [t for t, _ in fakes.tts.synthesized] + [t for s in fakes.tts.streams for t in s.texts]
    assert sent and not any("delay" in t or "{{" in t for t in sent)  # never in TTS input
    said = _agent_said(sync_engine, call_id)
    assert said == ["Hello am I speaking with Ragul?"]  # transcript without the marker
    with sync_engine.connect() as c:
        events = c.execute(text("select payload from call_events where call_id = :id and event_type = 'pause_inserted'"),
                           {"id": call_id}).scalars().all()
    payload = events[0] if isinstance(events[0], dict) else json.loads(events[0])
    assert payload["requested_ms"] == 1200 and payload["actual_ms"] == 1200


def test_prerendered_greeting_includes_the_pause(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)
    monkeypatch.setattr(settings, "GREETING_PRERENDERED_DELAY_MS", 50)
    try:
        call_id, token = _flow_call(client, auth, pauses={"short_ms": 300, "medium_ms": 700, "long_ms": 400})
        end = time.monotonic() + 3
        while not call_service.has_greeting_audio(call_id) and time.monotonic() < end:
            time.sleep(0.02)
        assert call_service.has_greeting_audio(call_id)
        with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
            _start(ws)
            _send(ws, silence_mulaw(200))
            audio_bytes = _played(_messages_until(ws, "checkpoint"))
        one = len(fakes.tts.chunk) * 3
        assert abs((len(audio_bytes) - 2 * one) - 400 * 8) <= FRAME
        assert not any("{{" in t for t, _ in fakes.tts.synthesized)
        assert _agent_said(sync_engine, call_id) == ["Hello am I speaking with Ragul?"]
    finally:
        call_service._GREETING_AUDIO.clear()


def test_customer_speech_during_a_pause_clears_the_rest_of_the_line(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "BARGE_IN_GRACE_MS", 0)
    call_id, token = _flow_call(client, auth, greeting="Hello {{long_delay}}{{long_delay}} am I speaking with {{customer_name}}?",
                                pauses={"short_ms": 300, "medium_ms": 700, "long_ms": 2000})
    fakes.stt.replies = ["Hello?", "Wait, who is this?"]
    fakes.llm.reply = "This is Thaara from Kexo AI and Automation."
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _messages_until(ws, "checkpoint")  # the greeting is queued: part, 4 s of silence, part
        _send(ws, tone_mulaw(600) + silence_mulaw(900))  # the customer talks during the pause
        msgs = _messages_until(ws, "checkpoint")
    assert {"event": "clearAudio", "streamId": "s-k"} in msgs  # the rest of the line is dropped
    said = _agent_said(sync_engine, call_id, count=2)
    assert said[-1] == fakes.llm.reply and not any("delay" in s or "{{" in s for s in said)
