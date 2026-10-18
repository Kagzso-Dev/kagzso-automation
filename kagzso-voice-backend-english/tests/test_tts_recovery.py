"""When the live TTS stream fails before any audio plays (e.g. Sarvam TTS times out),
the agent says the same reply through one-shot synthesis instead of going silent."""
import json
import time

from sqlalchemy import text

from app.services.tts import TTSError
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until


def _agent_lines(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent' order by id"),
                         {"id": call_id}).scalars().all()


def _events(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select event_type from call_events where call_id = :id order by id"),
                         {"id": call_id}).scalars().all()


def _fail_streams_after(fakes, monkeypatch, ok_count):
    real_open = fakes.tts.open_stream
    opened = {"n": 0}

    async def flaky_open():
        opened["n"] += 1
        if opened["n"] > ok_count:
            raise TTSError("timeout", "Sarvam TTS stopped sending audio")
        return await real_open()

    monkeypatch.setattr(fakes.tts, "open_stream", flaky_open)


def test_scripted_greeting_recovered_when_stream_fails(client, auth, fakes, sync_engine, monkeypatch):
    _fail_streams_after(fakes, monkeypatch, ok_count=0)
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "playAudio")
        _until(ws, "checkpoint")
        time.sleep(0.3)
    assert _agent_lines(sync_engine, call_id) == ["Hi sir, Good morning."]
    events = _events(sync_engine, call_id)
    assert "pipeline_error" in events and "tts_recovered" in events


def test_llm_reply_recovered_when_stream_fails(client, auth, fakes, sync_engine, monkeypatch):
    _fail_streams_after(fakes, monkeypatch, ok_count=2)  # greeting + identity question stream fine, the reply fails
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello?", "Yes", "Yes, please tell me about it"]  # not a filler word
    fakes.llm.reply = "Thank you sir. This is Thaara from Kagzso AI and Automation. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")  # greeting
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")  # identity question
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        time.sleep(0.1)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "playAudio")
        _until(ws, "checkpoint")
        time.sleep(0.3)
    lines = _agent_lines(sync_engine, call_id)
    assert lines[0] == "Hi sir, Good morning."
    assert lines[1] == "Am I speaking with Ragul, sir?"
    assert lines[2] == "Thank you sir. This is Thaara from Kagzso AI and Automation. Is that okay?"
    assert "tts_recovered" in _events(sync_engine, call_id)
