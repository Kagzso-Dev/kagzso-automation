"""Start of a call with a time-of-day opening (the default Nila flow): the agent listens for
FIRST_SPEECH_WAIT_SECONDS; the customer's first words start the greeting at once (and are not
answered or carried on), silence starts it when the wait ends. Only the greeting is spoken at
GREETING_TTS_SPEED."""
import json
import re
import time

import pytest
from sqlalchemy import text

from app.core.config import Settings, settings
from app.services import call_service, llm_service as llm
from app.services.call_service import first_speech_greeting_due, take_greeting_audio
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until

GREETING = "Hi sir, Good morning."
IDENTITY = "Am I speaking with Ragul, sir?"
HOLD = call_service.CallSession.FIRST_SPEECH_HOLD_MAX_SECONDS


# ------------------------------------------------------------------ fake clock: when the greeting is due
def test_silence_greets_when_the_wait_ends():
    assert first_speech_greeting_due(12.99, 10.0, 3.0, HOLD, False, False) is None
    assert first_speech_greeting_due(13.0, 10.0, 3.0, HOLD, False, False) == "silence"


def test_never_starts_on_top_of_the_customer():
    assert first_speech_greeting_due(13.5, 10.0, 3.0, HOLD, True, False) is None  # still talking
    assert first_speech_greeting_due(13.5, 10.0, 3.0, HOLD, False, True) is None  # words being transcribed
    assert first_speech_greeting_due(13.0 + HOLD, 10.0, 3.0, HOLD, True, False) == "hold_limit"
    assert HOLD == 2.0


def test_wait_is_counted_from_the_stream_start_and_configurable():
    assert first_speech_greeting_due(12.0, 10.0, 2.0, HOLD, False, False) == "silence"
    assert first_speech_greeting_due(13.9, 10.0, 4.0, HOLD, False, False) is None


def test_config_defaults_and_ranges():
    assert Settings.model_fields["FIRST_SPEECH_WAIT_SECONDS"].default == 3.0
    assert Settings.model_fields["GREETING_TTS_SPEED"].default == 0.95
    assert Settings(FIRST_SPEECH_WAIT_SECONDS=10).FIRST_SPEECH_WAIT_SECONDS == 4.0
    assert Settings(FIRST_SPEECH_WAIT_SECONDS=1).FIRST_SPEECH_WAIT_SECONDS == 2.0
    assert Settings(GREETING_TTS_SPEED=3).GREETING_TTS_SPEED == 2.0
    assert Settings(GREETING_TTS_SPEED=0.95).GREETING_TTS_SPEED == 0.95


def test_prerendered_greeting_cache_key_includes_the_speed():
    call_service._GREETING_AUDIO["c1"] = ("Hi sir, Good morning.", 0.95, b"audio")
    assert take_greeting_audio("c1", "Hi sir, Good morning.", None) is None  # other speed: not used
    call_service._GREETING_AUDIO["c1"] = ("Hi sir, Good morning.", 0.95, b"audio")
    assert take_greeting_audio("c1", "Hi sir, Good morning.", 0.95) == b"audio"


# ------------------------------------------------------------------ end to end
def _events(sync_engine, call_id, kind):
    """Events are written in the background: wait briefly for them."""
    deadline = time.time() + 5
    while True:
        with sync_engine.connect() as c:
            rows = c.execute(text("select payload from call_events where call_id = :id and event_type = :k "
                                  "order by id"), {"id": call_id, "k": kind}).scalars().all()
        if rows or time.time() > deadline:
            return [json.loads(r) if isinstance(r, str) else r for r in rows]
        time.sleep(0.05)


def _lines(fakes):
    return [" ".join(s.texts) for s in fakes.tts.streams]


def test_words_in_the_first_wait_play_the_greeting_at_once(client, auth, fakes, sync_engine):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        t0 = time.monotonic()
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "playAudio")
        took = time.monotonic() - t0
    assert took < settings.FIRST_SPEECH_WAIT_SECONDS  # did not wait for the 3 s
    assert _lines(fakes) == [GREETING]
    assert _events(sync_engine, call_id, "greeting_started")[0]["trigger"] == "speech"
    assert fakes.llm.seen_messages == []  # not answered


def test_silence_plays_the_greeting_when_the_wait_ends(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "FIRST_SPEECH_WAIT_SECONDS", 0.5)
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        t0 = time.monotonic()
        _until(ws, "playAudio")
        took = time.monotonic() - t0
    assert 0.5 <= took < 1.5
    assert _lines(fakes) == [GREETING]
    event = _events(sync_engine, call_id, "greeting_started")[0]
    assert event["trigger"] == "silence" and event["ms_after_stream_start"] >= 500


def test_first_words_are_not_carried_into_the_next_turn(client, auth, fakes):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello, who is this", "Yes", "Yes, speaking"]
    fakes.llm.reply = "Thank you, sir. This is Thaara from Kexo AI and Automation. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _ in range(3):
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            cp = _until(ws, "checkpoint")
            ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
            time.sleep(0.3)
    assert _lines(fakes) == [GREETING, IDENTITY, fakes.llm.reply]
    sent = json.dumps(fakes.llm.seen_messages)
    assert "who is this" not in sent  # the first words only started the greeting


def test_speed_applies_only_to_the_greeting(client, auth, fakes):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello", "Yes", "Yes, speaking"]
    fakes.llm.reply = "Thank you, sir. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _ in range(3):
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            cp = _until(ws, "checkpoint")
            ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
            time.sleep(0.3)
    paces = [(" ".join(s.texts), s.pace) for s in fakes.tts.streams]
    assert paces == [(GREETING, 0.95), (IDENTITY, None), (fakes.llm.reply, None)]


def test_prerendered_greeting_is_rendered_at_the_greeting_speed(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)
    _call(client, auth, gender="male")
    deadline = time.time() + 3
    while not fakes.tts.synthesized and time.time() < deadline:
        time.sleep(0.05)
    assert fakes.tts.synthesized == [(GREETING, 0.95)]


@pytest.mark.parametrize("said", ["Don't call me again", "Stop calling"])
def test_do_not_call_in_the_first_wait_ends_the_call(client, auth, fakes, said):
    fakes.stt.replies = [said]
    fakes.llm.reply = "Understood. I respect your request. Thank you. " + llm.END_CALL_TOKEN
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        deadline = time.time() + 5
        while not fakes.plivo.hangups and time.time() < deadline:
            time.sleep(0.05)
    assert _lines(fakes) == ["Understood. I respect your request. Thank you."]  # no greeting
    assert fakes.plivo.hangups == ["uuid-k"]
    assert fakes.llm.seen_messages[0][-1]["content"] == said


def test_ai_question_in_the_first_wait_gets_the_honest_answer_and_no_greeting(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "FIRST_SPEECH_WAIT_SECONDS", 0.3)
    fakes.stt.replies = ["Are you a robot?"]
    fakes.llm.reply = "I'm an AI assistant calling on behalf of Kexo AI and Automation."
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        time.sleep(1.0)  # past the wait: the timer must not greet now
    assert _lines(fakes) == [fakes.llm.reply]


def test_greeting_is_never_played_twice(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "FIRST_SPEECH_WAIT_SECONDS", 0.4)
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello", "Hello hello"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        time.sleep(0.35)  # words arrive right as the wait ends
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # more words over the greeting
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        _until(ws, "checkpoint")
        time.sleep(0.5)
    assert _lines(fakes).count(GREETING) == 1
    assert _lines(fakes)[:2] == [GREETING, IDENTITY]


def test_timing_log_has_no_phone_numbers(client, auth, fakes, sync_engine, caplog):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello"]
    with caplog.at_level("INFO"):
        with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
            _start(ws)
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            _until(ws, "checkpoint")
    line = next(r.getMessage() for r in caplog.records if r.getMessage().startswith("Greeting started"))
    assert re.search(r"after stream start \(trigger=speech, speed=0.95\)", line)
    assert not re.search(r"\d{8,}", line)
    payload = _events(sync_engine, call_id, "greeting_started")[0]
    assert set(payload) == {"ms_after_answer", "ms_after_stream_start", "trigger", "speed"}


def test_other_flows_keep_the_old_start(client, auth, fakes):
    """Follow-up calls (no time-of-day opening) still greet right away at the normal speed."""
    r = client.post("/api/calls/outbound", headers=auth,
                    json={"phone_number": "+919876543210", "customer_name": "Ragul", "gender": "male",
                          "agent_name": "Follow-up"})
    call_id = r.json()["call_id"]
    xml = client.post(f"/api/webhooks/plivo/answer?call_id={call_id}",
                      data={"CallUUID": "uuid-k", "CallStatus": "in-progress"}).text
    token = re.search(r"token=([^&<\"]+)", xml).group(1)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
    assert fakes.tts.streams[0].pace is None
    assert " ".join(fakes.tts.streams[0].texts).startswith("Hello Mr. Ragul, this is Thaara")
