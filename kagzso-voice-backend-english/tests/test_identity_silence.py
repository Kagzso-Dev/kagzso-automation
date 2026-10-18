"""Silence after "Am I speaking with {{customer_name}}, {{title_to_use}}?":
IDENTITY_SILENCE_WAIT_SECONDS (counted from the end of the audio) -> the question once more ->
the same wait -> "Hello, can you hear me?" -> the normal silence flow closes the call.
Any customer words cancel it; a silence line never plays on top of the customer."""
import json
import time

import pytest

from app.core.config import settings
from app.services import call_service
from app.services.call_service import identity_silence_action
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until

GREETING = "Hi sir, Good morning."
IDENTITY = "Am I speaking with Ragul, sir?"
REPROMPT = "Hello, can you hear me?"
CLOSING = "No problem. Thank you for your time. Have a nice day."


# ------------------------------------------------------------------ fake clock: the timing rule
def test_repeat_after_the_wait_counted_from_the_end_of_playback():
    # The question started at t=10 (last activity) and its audio ends at t=13.
    assert identity_silence_action(14.9, 10.0, 13.0, 2.0, 0, 0) is None
    assert identity_silence_action(15.0, 10.0, 13.0, 2.0, 0, 0) == "repeat"
    # A playback ack later than the estimate restarts the count from the ack.
    assert identity_silence_action(15.0, 13.5, 13.0, 2.0, 0, 0) is None
    assert identity_silence_action(15.5, 13.5, 13.0, 2.0, 0, 0) == "repeat"


def test_silence_message_after_another_wait():
    # The repeat's audio ended at t=20.
    assert identity_silence_action(21.9, 18.0, 20.0, 2.0, 1, 0) is None
    assert identity_silence_action(22.0, 18.0, 20.0, 2.0, 1, 0) == "reprompt"


def test_repeat_happens_only_once_then_the_normal_flow_takes_over():
    assert identity_silence_action(99.0, 0.0, 0.0, 2.0, 1, 0) == "reprompt"  # never a second repeat
    assert identity_silence_action(99.0, 0.0, 0.0, 2.0, 1, 1) is None  # normal silence flow closes


def test_wait_is_configurable_and_defaults_to_two_seconds():
    assert settings.model_fields["IDENTITY_SILENCE_WAIT_SECONDS"].default == 2.0
    assert identity_silence_action(10.5, 10.0, 0.0, 0.5, 0, 0) == "repeat"


# ------------------------------------------------------------------ end to end (short waits)
@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(settings, "IDENTITY_SILENCE_WAIT_SECONDS", 0.3)
    monkeypatch.setattr(settings, "GREETING_WAIT_SECONDS", 0.2)


def _ack(ws, cp):
    ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))


def _lines(fakes):
    return [" ".join(s.texts) for s in fakes.tts.streams]


def _open(client, auth, fakes, ws_replies=("Hello?",)):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = list(ws_replies)
    return call_id, token


def _until_identity(ws):
    """Customer says Hello -> greeting; silence -> the identity question (after GREETING_WAIT_SECONDS)."""
    _start(ws)
    _send(ws, tone_mulaw(400) + silence_mulaw(900))
    _ack(ws, _until(ws, "checkpoint"))  # greeting played
    cp = _until(ws, "checkpoint")  # identity question
    _ack(ws, cp)


def test_full_silence_repeats_then_reprompts_then_closes(client, auth, fakes, quick, monkeypatch):
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 0.6)
    call_id, token = _open(client, auth, fakes)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _until_identity(ws)
        for _ in range(3):  # repeat, re-prompt, closing - each acknowledged as played
            _ack(ws, _until(ws, "checkpoint"))
        deadline = time.time() + 5
        while not fakes.plivo.hangups and time.time() < deadline:
            time.sleep(0.05)
    assert _lines(fakes) == [GREETING, IDENTITY, IDENTITY, REPROMPT, CLOSING]
    assert fakes.plivo.hangups == ["uuid-k"]
    assert fakes.llm.seen_messages == []


def test_no_hangup_before_the_sequence_has_run(client, auth, fakes, quick, monkeypatch):
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 0.2)  # shorter than the identity wait
    call_id, token = _open(client, auth, fakes)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _until_identity(ws)
        _ack(ws, _until(ws, "checkpoint"))  # the repeat, not the re-prompt or the closing
        assert _lines(fakes)[2] == IDENTITY and fakes.plivo.hangups == []
        _ack(ws, _until(ws, "checkpoint"))
        assert _lines(fakes)[3] == REPROMPT and fakes.plivo.hangups == []


def test_speech_after_the_question_cancels_the_timers(client, auth, fakes, quick, monkeypatch):
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 30)
    call_id, token = _open(client, auth, fakes, ("Hello?", "Yes, speaking"))
    fakes.llm.reply = "Thank you, sir. This is Thaara from Kexo AI and Automation. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _until_identity(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # answers before the wait is over
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(1.0)  # well past the identity wait: nothing more may play
    assert _lines(fakes) == [GREETING, IDENTITY, fakes.llm.reply]


def test_speech_after_the_repeat_cancels_the_silence_message(client, auth, fakes, quick, monkeypatch):
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 30)
    call_id, token = _open(client, auth, fakes, ("Hello?", "Yes"))
    fakes.llm.reply = "Thank you, sir. This is Thaara from Kexo AI and Automation. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _until_identity(ws)
        _ack(ws, _until(ws, "checkpoint"))  # the repeat
        time.sleep(0.1)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(1.0)
    assert _lines(fakes) == [GREETING, IDENTITY, IDENTITY, fakes.llm.reply]
    assert REPROMPT not in _lines(fakes)


def test_repeat_happens_only_once_per_call(client, auth, fakes, quick, monkeypatch):
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 30)
    call_id, token = _open(client, auth, fakes)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _until_identity(ws)
        _ack(ws, _until(ws, "checkpoint"))  # repeat
        _ack(ws, _until(ws, "checkpoint"))  # re-prompt
        time.sleep(1.0)
    assert _lines(fakes).count(IDENTITY) == 2
    assert _lines(fakes) == [GREETING, IDENTITY, IDENTITY, REPROMPT]


def test_words_over_the_repeat_stop_it(client, auth, fakes, quick, monkeypatch):
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 30)
    monkeypatch.setattr(settings, "BARGE_IN_GRACE_MS", 0)
    call_id, token = _open(client, auth, fakes, ("Hello?", "Yes it's me"))
    fakes.llm.reply = "Thank you, sir. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _until_identity(ws)
        fakes.tts.chunks_per_sentence = 60  # the repeat plays for ~6 s
        _until(ws, "playAudio")  # the repeat has started
        _send(ws, tone_mulaw(1500) + silence_mulaw(900))
        _until(ws, "clearAudio")  # the repeat is cut off, not played over the customer
        _until(ws, "checkpoint")
    assert fakes.llm.seen_messages[-1][-1] == {"role": "user", "content": "Yes it's me"}


def test_no_timer_keeps_running_after_the_call_ends(client, auth, fakes, quick):
    call_id, token = _open(client, auth, fakes)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _until_identity(ws)
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(1.0)  # longer than both identity waits
    assert _lines(fakes) == [GREETING, IDENTITY]
    assert call_id not in call_service.ACTIVE_SESSIONS
