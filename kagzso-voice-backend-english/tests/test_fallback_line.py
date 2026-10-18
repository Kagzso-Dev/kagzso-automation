"""When no reply can be produced, the agent says "couldn't hear you clearly" once; a second
fallback in a row closes the call politely (script "UNCLEAR AUDIO": one clarification only).
The fallback line is recorded like any reply so the next LLM turn knows it was said."""
import json
import time

from sqlalchemy import text

from app.services import llm_service as llm
from app.services.call_service import OUTCOME_SYSTEM
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until

UNCLEAR = "Sorry, I couldn't hear you clearly. Could you please repeat that?"
CLOSING = "No problem. Thank you for your time. Have a nice day."


def _rows(sync_engine, sql, call_id):
    with sync_engine.connect() as c:
        return c.execute(text(sql), {"id": call_id}).all()


def _failing_llm(fakes, monkeypatch, fail_times):
    state = {"left": fail_times}
    real = fakes.llm._stream

    async def stream(system_text, messages, model=None):
        if system_text != OUTCOME_SYSTEM:
            fakes.llm.seen_messages.append(messages)
            if state["left"] > 0:
                state["left"] -= 1
                raise llm.LLMError("provider", "Gemini error (503): overloaded")
            fakes.llm.seen_messages.pop()  # real() records it again
        async for d in real(system_text, messages, model):
            yield d

    monkeypatch.setattr(fakes.llm, "_stream", stream)


IDENTITY = "Am I speaking with Karthick, sir?"


def _talk(ws, times):
    _start(ws)
    _send(ws, tone_mulaw(400) + silence_mulaw(900))
    last = _until(ws, "checkpoint")  # greeting
    for _ in range(times):
        time.sleep(0.5)  # let playback finish so the words aren't talking over the agent
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        last = _until(ws, "checkpoint")
    ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": last["name"]}))
    time.sleep(0.8)  # hang-up happens once the last line has played


def test_fallback_line_is_recorded_and_said_once_then_call_closes(client, auth, fakes, sync_engine, monkeypatch):
    _failing_llm(fakes, monkeypatch, fail_times=2)
    call_id, token = _call(client, auth, customer_name="Karthick", gender="male")
    fakes.stt.replies = ["Hello?", "Hello", "Yes, I'm Karthick", "Yes, I'm Karthick"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _talk(ws, times=3)
    agent = [r[0] for r in _rows(sync_engine, "select text from transcripts where call_id = :id and speaker = 'agent' order by id", call_id)]
    assert agent == ["Hi sir, Good morning.", IDENTITY, UNCLEAR, CLOSING]
    # The second attempt saw the first one in history, not a pile-up of unanswered words.
    second = fakes.llm.seen_messages[1]
    assert second[-3:] == [{"role": "user", "content": "Yes, I'm Karthick"}, {"role": "assistant", "content": UNCLEAR},
                           {"role": "user", "content": "Yes, I'm Karthick"}]
    events = [r[0] for r in _rows(sync_engine, "select event_type from call_events where call_id = :id order by id", call_id)]
    assert events.count("fallback_line") == 2 and "agent_hangup" in events


def test_real_reply_resets_the_fallback_count(client, auth, fakes, sync_engine, monkeypatch):
    _failing_llm(fakes, monkeypatch, fail_times=1)
    fakes.llm.reply = "Thank you sir. This is Thaara from Kagzso AI and Automation. Is that okay?"
    call_id, token = _call(client, auth, customer_name="Karthick", gender="male")
    fakes.stt.replies = ["Hello?", "Hello", "Yes, I'm Karthick", "Yes, I'm Karthick", "Sure, go ahead"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _talk(ws, times=4)
    agent = [r[0] for r in _rows(sync_engine, "select text from transcripts where call_id = :id and speaker = 'agent' order by id", call_id)]
    assert agent[:4] == ["Hi sir, Good morning.", IDENTITY, UNCLEAR, fakes.llm.reply]
    assert CLOSING not in agent
