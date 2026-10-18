"""Background noise: noise-only audio makes no turn, short answers still count, real
interruptions still work, the agent's own echo is ignored, and noise never changes call state."""
import json
import random
import time

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import audio_service as audio
from app.services.call_service import is_echo, is_noise_text
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_media_stream import _agent_playing, _recv_until, _send_audio, _setup_call, _start_msg, _wait_db
from tests.test_nila_flow import _call, _send, _start, _until


def noise_pcm(ms: int, level: int, seed: int = 7) -> bytes:
    """White-ish noise with RMS close to `level` (16-bit PCM, 8 kHz)."""
    rnd = random.Random(seed)
    amp = int(level * 1.73)  # uniform noise: RMS = amp / sqrt(3)
    return b"".join(rnd.randint(-amp, amp).to_bytes(2, "little", signed=True) for _ in range(8 * ms))


def noise_mulaw(ms: int, level: int = 350) -> bytes:
    return audio.pcm16_to_mulaw(noise_pcm(ms, level))


def mix(a_mulaw: bytes, b_mulaw: bytes) -> bytes:
    a, b = audio.mulaw_to_pcm16(a_mulaw), audio.mulaw_to_pcm16(b_mulaw)
    n = min(len(a), len(b))
    import audioop

    return audio.pcm16_to_mulaw(audioop.add(a[:n], b[:n], 2))


def _events(sync_engine, call_id):
    with sync_engine.connect() as c:
        return [r[0] for r in c.execute(text(f"select event_type from call_events where call_id='{call_id}'"))]


def _agent_lines(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent' order by id"),
                         {"id": call_id}).scalars().all()


@pytest.fixture
def noise_sensitive_vad(monkeypatch):
    """A detector that, like webrtcvad on a noisy line, calls anything above RMS 200 speech."""
    monkeypatch.setattr(audio, "make_webrtc_classifier", lambda *a, **k: (lambda frame: audio.rms(frame) > 200))


# ------------------------------------------------------------------ units
def test_noise_floor_gate_learns_the_line_and_is_capped():
    gate = audio.NoiseFloorGate(min_rms=300, multiplier=2.5, max_rms=1000)
    assert gate.threshold == 300
    for _ in range(50):
        gate.observe(200)
    assert gate.threshold == 500  # 200 x 2.5
    for _ in range(150):
        gate.observe(900)
    assert gate.threshold == 1000  # never above the cap: quiet customers stay audible
    quiet = audio.NoiseFloorGate(min_rms=300, multiplier=2.5, max_rms=1000)
    for _ in range(50):
        quiet.observe(10)
    assert quiet.threshold == 300  # never below VAD_MIN_RMS


def test_noise_text_never_drops_short_answers():
    for t in ("", "...", "Uh", "um, uh.", "Er", "ah"):
        assert is_noise_text(t), t
    for t in ("Yes", "yes.", "No", "Okay", "OK", "Hello?", "Hmm", "Mm", "Ha", "Ya", "Uh yes"):
        assert not is_noise_text(t), t


def test_echo_needs_three_of_the_agents_own_words_in_order():
    line = "Hi Arun, this is Priya from Kagzso. Is now a good time for a quick introduction?"
    assert is_echo("is now a good time", line)
    assert is_echo("Priya from Kagzso is now", line)
    assert is_echo("is now good time", line)  # STT dropped a word
    for reply in ("Yes", "Yes, now is a good time", "No, not a good time", "Okay", "Who is this?",
                  "Yes this is Arun", "this is Arun", "now is good"):
        assert not is_echo(reply, line), reply
    assert not is_echo("this is Ragul", "Hi, is this Ragul?")  # answering the identity question


# ------------------------------------------------------------------ noise-only audio makes no turn
@pytest.mark.parametrize("adaptive", [True, False])
def test_steady_background_noise_makes_no_turn(client, auth, fakes, monkeypatch, noise_sensitive_vad, adaptive):
    # The adaptive floor on its own (noise suppression off; with it on, the floor is always used -
    # see test_noise_suppression.py).
    monkeypatch.setattr(settings, "NOISE_SUPPRESSION_ENABLED", False)
    monkeypatch.setattr(settings, "VAD_ADAPTIVE_FLOOR", adaptive)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, noise_mulaw(3000) + silence_mulaw(900))
        time.sleep(0.5)
        ws.send_text(json.dumps({"event": "stop"}))
    # with the adaptive floor the noise never reaches STT; without it, it does
    assert (fakes.stt.calls == 0) is adaptive


def test_yes_over_background_noise_is_still_answered(client, auth, fakes, noise_sensitive_vad):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Yes"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, noise_mulaw(1500))  # floor learns the room
        _send_audio(ws, mix(tone_mulaw(400), noise_mulaw(400)) + noise_mulaw(900))
        _recv_until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.stt.calls == 1
    assert fakes.llm.seen_messages[-1][-1] == {"role": "user", "content": "Yes"}


def test_noise_words_make_no_turn_and_greeting_still_plays(client, auth, fakes, sync_engine):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Uh"]  # STT wrote down a breath / line noise
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "playAudio")  # greeting still plays (no dead air)
        _until(ws, "checkpoint")
        time.sleep(0.3)
    assert fakes.llm.seen_messages == []  # the LLM was never asked to answer noise
    assert _agent_lines(sync_engine, call_id) == ["Hi sir, Good morning."]
    assert "noise_ignored" in _events(sync_engine, call_id)


@pytest.mark.parametrize("suppression", [False, True])
def test_noise_burst_does_not_cancel_greeting(client, auth, fakes, sync_engine, monkeypatch, suppression):
    monkeypatch.setattr(settings, "NOISE_SUPPRESSION_ENABLED", suppression)
    monkeypatch.setattr(settings, "FIRST_SPEECH_WAIT_SECONDS", 0.5)
    fakes.stt.replies = [""]  # if the burst reaches STT, it hears no words
    call_id, token = _call(client, auth, gender="male")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(220) + silence_mulaw(900))  # starts like speech, too short to be speech
        _until(ws, "playAudio")
        _until(ws, "checkpoint")
        time.sleep(0.3)
    # Without suppression a 220 ms burst is dropped as too short; with it, anything that started
    # like speech goes to STT (when unsure, STT decides) - either way the greeting plays once.
    assert fakes.stt.calls == (1 if suppression else 0)
    assert _agent_lines(sync_engine, call_id) == ["Hi sir, Good morning."]


# ------------------------------------------------------------------ short "yes" still counts
def test_short_yes_after_the_question_is_answered(client, auth, fakes, sync_engine):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello?", "Yes"]
    fakes.llm.reply = "Thank you sir. This is Thaara from Kagzso AI and Automation. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))  # question finished
        _send(ws, tone_mulaw(300) + silence_mulaw(900))  # a short "Yes" right after it (echo tail window)
        _until(ws, "playAudio")
        _until(ws, "checkpoint")
        time.sleep(0.3)
    assert fakes.llm.seen_messages == []  # "Yes" to the opening gets the scripted identity question
    assert _agent_lines(sync_engine, call_id) == ["Hi sir, Good morning.", "Am I speaking with Ragul, sir?"]


def test_yes_said_over_the_identity_question_is_answered(client, auth, fakes, sync_engine):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello?", "Yes"]
    fakes.llm.reply = "Thank you sir. Is that okay?"
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")
        _send(ws, tone_mulaw(300) + silence_mulaw(900))  # "Yes" while the question is still playing
        time.sleep(0.3)
        ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))
        _until(ws, "playAudio")
        _until(ws, "checkpoint")
        time.sleep(0.3)
    assert fakes.llm.seen_messages == []
    assert _agent_lines(sync_engine, call_id) == ["Hi sir, Good morning.", "Am I speaking with Ragul, sir?"]


# ------------------------------------------------------------------ real interruptions still work
def test_real_interruption_still_stops_the_agent_at_once(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "BARGE_IN_GRACE_MS", 0)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Wait, who is this?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(1500))  # one unbroken sentence, still talking
        assert ws.receive_json() == {"event": "clearAudio", "streamId": "stream-1"}
        assert fakes.stt.calls == 1  # cut off before STT
        ws.send_text(json.dumps({"event": "stop"}))


def test_real_interruption_with_words_still_works(client, auth, fakes):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Sorry, who is this?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        msgs = _recv_until(ws, "checkpoint")
        assert msgs[0] == {"event": "clearAudio", "streamId": "stream-1"}
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.llm.seen_messages[-1][-1]["content"] == "Sorry, who is this?"


@pytest.mark.parametrize("consecutive", [True, False])
def test_broken_up_loud_noise_does_not_cut_the_agent_off(client, auth, fakes, sync_engine, monkeypatch, consecutive):
    monkeypatch.setattr(settings, "BARGE_IN_GRACE_MS", 0)
    monkeypatch.setattr(settings, "BARGE_IN_CONSECUTIVE", consecutive)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", ""]  # clatter, no words
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, (tone_mulaw(300) + silence_mulaw(200)) * 6 + silence_mulaw(900))  # 1.8 s loud, in bits
        if consecutive:
            _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='barge_in_ignored'",
                     lambda rows: bool(rows))
        else:  # old rule: loud audio added up across the sentence cuts the agent off
            assert ws.receive_json() == {"event": "clearAudio", "streamId": "stream-1"}
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    assert ("barge_in" in _events(sync_engine, call_id)) is not consecutive


# ------------------------------------------------------------------ echo
def test_agents_own_echo_does_not_interrupt(client, auth, fakes, sync_engine):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "is now a good time for a quick"]  # the agent's line came back
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(800) + silence_mulaw(900))
        _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='echo_ignored'",
                 lambda rows: bool(rows))
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    assert "barge_in" not in _events(sync_engine, call_id) and len(fakes.tts.streams) == 1


# ------------------------------------------------------------------ noise never changes call state
def test_noise_during_goodbye_does_not_cancel_the_hangup(client, auth, fakes, sync_engine):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Please don't call me again", ""]
    fakes.llm.reply = "Sorry to bother you, we won't call again. Goodbye! [[END_CALL]]"
    fakes.tts.chunks_per_sentence, fakes.tts.delay = 10, 0.05  # goodbye takes ~1 s to stream
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(500) + silence_mulaw(900))
        _recv_until(ws, "playAudio")  # goodbye is being spoken (end-of-call already requested)
        _send_audio(ws, tone_mulaw(300) + silence_mulaw(900))  # background noise meanwhile
        cp = _recv_until(ws, "checkpoint")[-1]
        ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))
        deadline = time.time() + 4
        while not fakes.plivo.hangups and time.time() < deadline:
            time.sleep(0.05)
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.plivo.hangups, "the call must still be hung up after the do-not-call goodbye"
