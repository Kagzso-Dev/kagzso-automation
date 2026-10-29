"""Natural call rhythm (RHYTHM_GAP, THINKING_ACK pool, RHYTHM_SENTENCE_PAUSES, BARGE_EARLY_STOP): fakes only -
no call, no real STT / TTS / LLM / Plivo. The gap and rotation rules are checked with a seeded random source;
the call tests stream audio over the websocket. Every switch off = today's behaviour."""
import asyncio
import base64
import json
import random
import re
import time

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import audio_service as audio
from app.services import call_service
from app.services import llm_service as llm
from app.services import reply_speed as rs
from app.services import voice_focus as vf
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_media_stream import _recv_until, _send_audio, _setup_call, _start_msg
from tests.test_tamil_flow import PERMISSION, TO_PERMISSION, _converse

THREE = "We automate repetitive work for small businesses. It saves your team hours every week. Shall I explain more?"


def _events(sync_engine, call_id, kind):
    with sync_engine.connect() as c:
        rows = c.execute(text("select payload from call_events where call_id = :id and event_type = :t"),
                         {"id": call_id, "t": kind}).scalars().all()
    return [json.loads(p) if isinstance(p, str) else (p or {}) for p in rows]


def _timings(caplog):
    out = []
    for r in caplog.records:
        msg = r.getMessage()
        if "timing (ms)" in msg:
            out.append(dict(kv.split("=", 1) for kv in msg.split(": ", 1)[1].split()))
    return out


def _eos_waits(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select eos_wait_ms from call_latency_metrics where call_id = :id"),
                         {"id": call_id}).scalars().all()


def _wait_for(predicate, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline and not predicate():
        time.sleep(0.05)


def _ack(ws, cp):
    ws.send_text(json.dumps({"event": "playedStream", "streamId": "stream-1", "name": cp["name"]}))


def _realtime(ws, mulaw):
    for c in audio.chunk_bytes(mulaw, 160):
        ws.send_text(json.dumps({"event": "media", "media": {"track": "inbound", "payload": base64.b64encode(c).decode()}}))
        time.sleep(0.02)


def _slow_llm(fakes, monkeypatch, delay):
    real = fakes.llm._stream

    async def stream(system_text, messages, model=None):
        if system_text != llm.OUTCOME_SYSTEM:
            await asyncio.sleep(delay)
        async for d in real(system_text, messages, model):
            yield d
    monkeypatch.setattr(fakes.llm, "_stream", stream)


def _turns(client, auth, fakes, replies, wait=0.5):
    """The customer says each reply (400 ms + 900 ms silence); every answer is acknowledged as played."""
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = replies
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(0.3)  # fixed lines (acknowledgements) pre-rendered
        for _ in replies:
            _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
            _ack(ws, _recv_until(ws, "checkpoint")[-1])
            time.sleep(wait)
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.2)
    return call_id


@pytest.fixture
def acks(monkeypatch):
    monkeypatch.setattr(settings, "THINKING_ACK", True)
    monkeypatch.setattr(settings, "THINKING_ACK_AFTER_SECONDS", 0.1)
    monkeypatch.setattr(settings, "PRERENDER_FIXED_LINES", True)


# ================================================================== 1. gap before a reply (seeded random source)
def test_gap_varies_within_the_range_and_never_below_the_minimum():
    rng = random.Random(7)
    short = [rs.reply_gap_ms(2, 8, 900, 1200, 0.15, 600, rng) for _ in range(2000)]
    long_ = [rs.reply_gap_ms(12, 8, 900, 1200, 0.15, 600, rng) for _ in range(2000)]
    assert 765 <= min(short) and max(short) <= 1035 and len(set(short)) > 100  # varied, never mechanical
    assert 1020 <= min(long_) and max(long_) <= 1380
    assert sum(long_) / len(long_) > sum(short) / len(short) + 200  # longer after a long answer
    low = [rs.reply_gap_ms(1, 8, 500, 500, 0.5, 600, rng) for _ in range(500)]
    assert min(low) == 600  # the safe minimum always holds


def test_fast_reply_waits_for_the_gap(client, auth, fakes, caplog, monkeypatch):
    monkeypatch.setattr(settings, "RHYTHM_GAP", True)
    caplog.set_level("INFO")
    _turns(client, auth, fakes, ["Hello?", "Yes"])
    for t in _timings(caplog):
        target = int(t["gap_target"])
        assert 765 <= target <= 1035
        assert target - 20 <= int(t["gap"]) <= target + 250  # the reply came no sooner than the gap


def test_gap_never_adds_delay_to_a_slow_reply(client, auth, fakes, caplog, monkeypatch):
    _slow_llm(fakes, monkeypatch, 0.6)  # ready ~1300 ms after the customer stopped: later than any gap
    caplog.set_level("INFO")
    _turns(client, auth, fakes, ["Hello?"])
    before = int(_timings(caplog)[-1]["reply_delay"])
    caplog.clear()
    monkeypatch.setattr(settings, "RHYTHM_GAP", True)
    _turns(client, auth, fakes, ["Hello?"])
    after = _timings(caplog)[-1]
    assert int(after["gap"]) <= before + 150  # the reply delay does not increase


def test_gap_off_keeps_todays_timing(client, auth, fakes, caplog):
    caplog.set_level("INFO")
    _turns(client, auth, fakes, ["Hello?"])
    t = _timings(caplog)[-1]
    assert "gap_target" not in t and "gap" not in t and abs(int(t["reply_delay"]) - 700) < 60


def test_slow_speaker_is_not_cut_with_the_gap_on(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "RHYTHM_GAP", True)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Yes"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        _ack(ws, _recv_until(ws, "checkpoint")[-1])
        time.sleep(0.5)
        s = call_service.ACTIVE_SESSIONS[call_id]
        s._slow_speaker, s.endpointer.end_frames = True, settings.SLOW_SPEAKER_END_SILENCE_MS // audio.FRAME_MS
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(1900))
        _recv_until(ws, "checkpoint")
    _wait_for(lambda: len(_eos_waits(sync_engine, call_id)) == 2)
    with sync_engine.connect() as c:
        waits = c.execute(text("select eos_wait_ms from call_latency_metrics where call_id = :id order by turn_index"),
                          {"id": call_id}).scalars().all()
    assert waits[-1] >= settings.SLOW_SPEAKER_END_SILENCE_MS - audio.FRAME_MS


# ================================================================== 2. acknowledgements
def test_rotation_never_plays_the_same_acknowledgement_twice_in_a_row():
    last, seen = None, []
    for _ in range(40):
        i = rs.next_ack([0, 1, 2, 3], last)
        assert i != last
        seen.append(i)
        last = i
    assert set(seen) == {0, 1, 2, 3}


@pytest.mark.parametrize("lang", ["en", "ta", "hi", "kn"])
def test_acknowledgements_are_short_and_honest(lang):
    for line in rs.ack_templates(lang):
        words = vf.words(line.replace("{{title_to_use}}", ""))
        assert 1 <= len(words) <= 3
        assert not re.search(r"check|moment|wait|hold|look|hmm|umm|breath|typing", line, re.IGNORECASE)


def test_custom_pool_from_config():
    assert rs.ack_templates("ta", "சரிங்க {{title_to_use}}. | ஓ, புரியுது.") == ["சரிங்க {{title_to_use}}.", "ஓ, புரியுது."]


def test_duplicate_opening_is_removed_after_the_acknowledgement():
    assert rs.strip_leading("சரிங்க sir, நாங்க help பண்றோம்.", "சரிங்க sir.") == "நாங்க help பண்றோம்."
    assert rs.strip_leading("Okay sir. Shall I explain?", "Okay sir.") == "Shall I explain?"
    assert rs.strip_leading("Sure, here it is.", "Okay sir.") == "Sure, here it is."  # different words: unchanged


def test_never_two_in_a_row_never_the_same_one_never_a_turn(client, auth, fakes, sync_engine, acks, monkeypatch):
    _slow_llm(fakes, monkeypatch, 0.4)
    said = ["Hello, who is this?", "Yes, tell me more", "Okay, go on please", "Sure, sounds good"]
    call_id = _turns(client, auth, fakes, said)
    played = _events(sync_engine, call_id, "thinking_ack")
    assert [e["turn"] for e in played] == [1, 3]  # never two replies in a row
    assert played[0]["ack"] != played[1]["ack"]  # never the same one twice in a row
    with sync_engine.connect() as c:
        rows = c.execute(text("select speaker, text from transcripts where call_id = :id order by id"),
                         {"id": call_id}).all()
    assert [t for s, t in rows if s == "customer"] == said  # never a customer turn
    pool = [llm.render_first_message(t, {"gender": "unknown"}) for t in rs.ack_templates("en")]
    agent = [t for s, t in rows if s == "agent"]
    assert len(agent) == 4 and not any(t in pool for t in agent)  # never instead of the reply
    assert all(m["content"] not in pool for msgs in fakes.llm.seen_messages for m in msgs)


def test_never_after_a_one_word_answer(client, auth, fakes, sync_engine, acks, monkeypatch):
    _slow_llm(fakes, monkeypatch, 0.4)
    call_id = _turns(client, auth, fakes, ["Hello?", "Yes", "ஆமா"])
    assert _events(sync_engine, call_id, "thinking_ack") == []


def test_no_acknowledgement_when_the_reply_is_ready_in_time(client, auth, fakes, sync_engine, acks, monkeypatch):
    monkeypatch.setattr(settings, "THINKING_ACK_AFTER_SECONDS", 0.5)
    _slow_llm(fakes, monkeypatch, 0.05)
    call_id = _turns(client, auth, fakes, ["Hello, who is this?", "Yes, tell me more"])
    assert _events(sync_engine, call_id, "thinking_ack") == []


def test_dead_air_gets_one_acknowledgement_even_after_the_first_word(client, auth, fakes, sync_engine, acks,
                                                                     monkeypatch):
    monkeypatch.setattr(settings, "THINKING_ACK_AFTER_SECONDS", 5.0)
    monkeypatch.setattr(settings, "THINKING_ACK_DEAD_AIR_SECONDS", 1.0)  # 700 ms end-of-speech wait included
    fakes.tts.delay = 0.5  # the AI answered at once, but no audio for a while
    call_id = _turns(client, auth, fakes, ["Hello, who is this?"])
    assert [e["turn"] for e in _events(sync_engine, call_id, "thinking_ack")] == [1]


def test_acknowledgement_is_dropped_when_the_customer_speaks(client, auth, fakes, sync_engine, acks, monkeypatch):
    monkeypatch.setattr(settings, "THINKING_ACK_AFTER_SECONDS", 0.6)
    _slow_llm(fakes, monkeypatch, 1.2)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello, who is this?", "Sorry, one more thing please"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(0.3)
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        time.sleep(0.1)
        _realtime(ws, tone_mulaw(900))  # still talking when the acknowledgement would be due
        _send_audio(ws, silence_mulaw(900))
        _recv_until(ws, "checkpoint")
    assert [e for e in _events(sync_engine, call_id, "thinking_ack") if e["turn"] == 1] == []


def test_acknowledgement_playing_is_stopped_when_the_customer_really_speaks(client, auth, fakes, sync_engine, acks,
                                                                           monkeypatch):
    _slow_llm(fakes, monkeypatch, 3.0)
    long_ack = audio.pcm16_to_mulaw(b"\x10\x00" * 8 * 2500)  # 2.5 s, so it is still playing

    async def synthesize(text_, pace=None):
        return long_ack
    monkeypatch.setattr(fakes.tts, "synthesize", synthesize)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello, who is this?", "Wait, who gave you my number?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(0.3)
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        _recv_until(ws, "playAudio")  # the acknowledgement started
        _realtime(ws, tone_mulaw(1000))  # past the echo window
        msgs = _recv_until(ws, "clearAudio")
        assert msgs[-1]["event"] == "clearAudio"  # stopped while the customer was still talking
        _send_audio(ws, silence_mulaw(900))
        _recv_until(ws, "checkpoint")
    assert len(_events(sync_engine, call_id, "ack_cancelled")) == 1
    assert fakes.llm.seen_messages[-1][-1]["content"].endswith("Wait, who gave you my number?")


def test_acknowledgements_off_never_play(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "PRERENDER_FIXED_LINES", True)
    _slow_llm(fakes, monkeypatch, 0.4)
    call_id = _turns(client, auth, fakes, ["Hello, who is this?", "Yes, tell me more"])
    assert _events(sync_engine, call_id, "thinking_ack") == []


# ================================================================== 3. pacing: pauses between the sentences of key lines
def test_key_line_sentences_get_the_flows_short_pause(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "ta")
    monkeypatch.setattr(settings, "KEY_LINES_SCRIPTED", True)
    monkeypatch.setattr(settings, "RHYTHM_SENTENCE_PAUSES", True)
    call_id, _ = _converse(client, auth, fakes, TO_PERMISSION + [("ஆமா, யாரு?", True)])
    parts = [t for t, _ in fakes.tts.synthesized]
    assert " ".join(parts[-4:]) == PERMISSION and len(parts) >= 4  # same voice and speed, sentence by sentence
    assert [e["actual_ms"] for e in _events(sync_engine, call_id, "pause_inserted")] == [300, 300, 300]
    history = [m["content"] for m in fakes.llm.seen_messages[-1] if m["role"] == "assistant"]
    assert PERMISSION in history  # the words are unchanged


def test_ai_replies_are_never_split_by_the_pause_switch(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "RHYTHM_SENTENCE_PAUSES", True)
    fakes.llm.reply = THREE
    call_id = _turns(client, auth, fakes, ["Hello?"])
    assert _events(sync_engine, call_id, "pause_inserted") == [] and fakes.tts.synthesized == []


# ================================================================== 4. interruptions
def _agent_talking(client, auth, fakes, ws):
    fakes.tts.chunks_per_sentence = 20  # 2 s of audio per sentence, 6 s in all
    fakes.llm.reply = THREE
    ws.send_text(json.dumps(_start_msg()))
    _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
    _recv_until(ws, "checkpoint")
    time.sleep(1.0)  # past the echo window, into the first sentence


def test_early_stop_cuts_the_agent_while_the_customer_is_still_talking(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "BARGE_EARLY_STOP", True)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Sorry, who gave you my number?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_talking(client, auth, fakes, ws)
        _realtime(ws, tone_mulaw(800))  # no silence yet: the customer has not finished
        assert _recv_until(ws, "clearAudio")[-1] == {"event": "clearAudio", "streamId": "stream-1"}
        fakes.llm.reply = "It came from our partner list, sir."
        _send_audio(ws, silence_mulaw(900))
        _recv_until(ws, "checkpoint")
    stop = _events(sync_engine, call_id, "barge_in_early")
    assert len(stop) == 1 and stop[0]["voiced_ms"] <= 600  # ~400 ms of voice, not 1.2 s
    assert fakes.llm.seen_messages[-1][-1]["content"] == "Sorry, who gave you my number?"  # answers what they said
    history = [m["content"] for m in fakes.llm.seen_messages[-1] if m["role"] == "assistant"]
    assert history[-1] == "We automate repetitive work for small businesses. ..."  # only what was heard


def test_backchannel_after_an_early_stop_goes_on_from_the_next_sentence(client, auth, fakes, sync_engine,
                                                                       monkeypatch):
    monkeypatch.setattr(settings, "BARGE_EARLY_STOP", True)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "ம்"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_talking(client, auth, fakes, ws)
        _realtime(ws, tone_mulaw(800))
        _recv_until(ws, "clearAudio")
        _send_audio(ws, silence_mulaw(900))
        _recv_until(ws, "checkpoint")
    assert len(fakes.llm.seen_messages) == 1  # no new AI reply for a "ம்"
    assert " ".join(fakes.tts.streams[-1].texts) == "It saves your team hours every week. Shall I explain more?"
    assert len(_events(sync_engine, call_id, "resumed_after_backchannel")) == 1


def test_early_stop_off_waits_as_today(client, auth, fakes, sync_engine):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Sorry, who gave you my number?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_talking(client, auth, fakes, ws)
        _realtime(ws, tone_mulaw(800))
        _send_audio(ws, silence_mulaw(900))  # today: stops only after the words are heard
        _recv_until(ws, "clearAudio")
        _recv_until(ws, "checkpoint")
    assert _events(sync_engine, call_id, "barge_in_early") == []
    history = [m["content"] for m in fakes.llm.seen_messages[-1] if m["role"] == "assistant"]
    assert history[-1] == THREE  # today's history: the whole reply, as if it was heard


def test_noise_never_stops_the_agent_early(client, auth, fakes, sync_engine, monkeypatch):
    from tests.test_noise import noise_mulaw

    monkeypatch.setattr(settings, "BARGE_EARLY_STOP", True)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", ""]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_talking(client, auth, fakes, ws)
        _realtime(ws, noise_mulaw(800, 3000))  # loud hiss, no voice pitch
        _send_audio(ws, silence_mulaw(900))
        time.sleep(0.5)
        ws.send_text(json.dumps({"event": "stop"}))
    assert _events(sync_engine, call_id, "barge_in_early") == []
