"""Customer voice focus (VOICE_FOCUS_LEVEL / VOICE_FOCUS_MODE): breath, noise, a lone "ம்" / "uh",
speech under the agent and its echo make no turn; a short "ஆமா" at normal or low volume still
counts; strict drops more than balanced; off (and log mode) keep today's behaviour."""
import itertools
import json
import time

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import audio_service as audio
from app.services import voice_focus as vf
from app.services.call_service import _words, is_echo
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_media_stream import _agent_playing, _recv_until, _send_audio, _setup_call, _start_msg, _wait_db
from tests.test_noise import mix, noise_mulaw, noise_pcm
from tests.test_nila_flow import _call, _send, _start, _until

QUESTION = "Hi Arun, this is Priya from Kagzso. Is now a good time for a quick introduction?"  # FakeLLM's reply


@pytest.fixture
def enforce(monkeypatch):
    monkeypatch.setattr(settings, "VOICE_FOCUS_LEVEL", "balanced")
    monkeypatch.setattr(settings, "VOICE_FOCUS_MODE", "enforce")


def _events(sync_engine, call_id, kind=None):
    with sync_engine.connect() as c:
        rows = c.execute(text("select event_type, payload from call_events where call_id = :id"), {"id": call_id}).all()
    out = [(t, json.loads(p) if isinstance(p, str) else (p or {})) for t, p in rows]
    return [p for t, p in out if t == kind] if kind else [t for t, _ in out]


def _customer_lines(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select text from transcripts where call_id = :id and speaker = 'customer' order by id"),
                         {"id": call_id}).scalars().all()


def _after_question(ws, then: bytes, wait: float = 0.5, hello_ms: int = 500):
    """Customer says "Hello?", the agent answers with a question and finishes playing it; then `then`
    (`wait` later: test audio arrives faster than real time, so this keeps it out of the echo window)."""
    ws.send_text(json.dumps(_start_msg()))
    _send_audio(ws, silence_mulaw(300) + tone_mulaw(hello_ms) + silence_mulaw(900))
    cp = _recv_until(ws, "checkpoint")[-1]
    ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))
    time.sleep(wait)
    _send_audio(ws, then)


# ------------------------------------------------------------------ units: text
def test_words_keep_tamil_and_hindi_words_whole():
    assert vf.words("சரிங்க, sir.") == ["சரிங்க", "sir"]
    assert vf.words("ஆமா!") == ["ஆமா"]
    assert vf.words("हाँ, बोलिए") == ["हाँ", "बोलिए"]
    assert _words("சரிங்க") == ["சர", "ங", "க"]  # the old split cuts Tamil words into pieces


def test_tamil_reply_is_not_mistaken_for_echo():
    agent = "சரிங்க sir, thank you. நாங்க AI agents and automation solutions provide பண்றோம்."
    assert is_echo("சரிங்க", agent)  # old split: three "words", all in the agent's line -> wrongly echo
    assert not is_echo("சரிங்க", agent, vf.words)  # one word: a reply, never echo
    assert is_echo("AI agents and automation", agent, vf.words)  # the agent's own words still are


@pytest.mark.parametrize("said", ["ம்", "ம் ம்", "ஆ", "ஹ்ம்", "உம்", "ஹம்", "ஊ", "uh", "Um.", "hmm", "mm-hmm", "Mhm", "हम्म", "ಹ್ಮ್", "ம்?"])
def test_lone_fillers_are_never_an_answer(said):
    assert vf.is_lone_filler(said)


@pytest.mark.parametrize("said", ["ஆமா", "சரி", "சரிங்க", "இல்ல", "Yes", "Okay", "No", "Hello", "हाँ", "haan", "हम",
                                  "ம் சொல்லுங்க", "ஆமா sir", ""])
def test_real_short_answers_are_not_fillers(said):
    assert not vf.is_lone_filler(said)


def test_asks_question():
    assert vf.asks_question(QUESTION)
    assert vf.asks_question("ஒரு minute பேசலாமா, sir?")
    assert vf.asks_question("Is now a good time? ...")  # interrupted
    assert not vf.asks_question("உங்க time-க்கு நன்றி. Have a nice day.")


# ------------------------------------------------------------------ units: audio gates
def _turn(voiced, snr_db, **kw):
    floor = 100
    return vf.TurnAudio(duration_ms=voiced + 200, voiced_ms=voiced, speech_rms=int(floor * 10 ** (snr_db / 20)),
                        floor_rms=floor, peak=0, max_gain=1.0, **kw)


BAL, STRICT = vf.LEVELS["balanced"], vf.LEVELS["strict"]


def test_breath_and_weak_bursts_are_dropped():
    assert vf.check_audio(BAL, _turn(220, 12)) == "too_short"  # 220 ms when no short answer is expected
    assert vf.check_audio(BAL, _turn(400, 3)) == "too_quiet"  # barely above the line's own noise


def test_short_answers_count_after_a_question_at_normal_and_low_volume():
    assert vf.check_audio(BAL, _turn(260, 25, expects_short=True)) is None  # "ஆமா", normal
    assert vf.check_audio(BAL, _turn(220, 5, expects_short=True)) is None  # "ஆமா", quiet but clear
    assert vf.check_audio(BAL, _turn(220, 5)) is not None  # the same sound when nothing was asked


def test_speech_under_the_agent_needs_a_real_interruption():
    assert vf.check_audio(BAL, _turn(300, 20, agent_speaking=True)) == "agent_speaking"
    assert vf.check_audio(BAL, _turn(900, 20, agent_speaking=True)) is None
    assert vf.check_audio(BAL, _turn(300, 20, agent_speaking=True, answering_question=True)) is None


def test_answer_starting_in_the_echo_window_is_never_cut_off():
    assert vf.check_audio(BAL, _turn(300, 25, expects_short=True, after_agent_ms=0)) is None  # clear answer
    assert vf.check_audio(BAL, _turn(300, 6, expects_short=True, after_agent_ms=0)) == "agent_echo_window"  # faint tail
    assert vf.check_audio(BAL, _turn(300, 6, expects_short=True, after_agent_ms=600)) is None


def test_no_floor_means_only_the_voiced_time_is_checked():
    t = vf.TurnAudio(duration_ms=500, voiced_ms=300, speech_rms=50, floor_rms=None, peak=0, max_gain=1.0)
    assert t.snr_db is None and vf.check_audio(BAL, t) is None


def test_strict_drops_more_than_balanced():
    grid = [_turn(v, s, expects_short=e, agent_speaking=a)
            for v, s, e, a in itertools.product(range(200, 800, 40), range(0, 20, 2), (True, False), (True, False))]
    bal = sum(vf.check_audio(BAL, t) is not None for t in grid)
    strict = sum(vf.check_audio(STRICT, t) is not None for t in grid)
    assert strict > bal
    assert all(vf.check_audio(STRICT, t) is not None for t in grid if vf.check_audio(BAL, t) is not None)


def test_thresholds_follow_level_and_overrides(monkeypatch):
    monkeypatch.setattr(settings, "VOICE_FOCUS_LEVEL", "off")
    assert vf.thresholds_for(settings) is None
    monkeypatch.setattr(settings, "VOICE_FOCUS_LEVEL", "strict")
    monkeypatch.setattr(settings, "VOICE_FOCUS_MIN_VOICED_MS", 500)
    t = vf.thresholds_for(settings)
    assert t.min_voiced_ms == 500 and t.min_snr_db == STRICT.min_snr_db


def test_endpointer_measures_voiced_time_and_snr():
    gate = audio.NoiseFloorGate(min_rms=60, multiplier=2.5, max_rms=1000)
    ep = audio.SpeechEndpointer(lambda f: audio.rms(f) > 60, noise_gate=gate)
    ep.process(noise_pcm(1000, 40))  # the line's own noise
    pcm = audio.mulaw_to_pcm16(tone_mulaw(400, amplitude=2000)) + noise_pcm(900, 40, seed=3)
    end = [e for e in ep.process(pcm) if e.event == audio.VadEvent.SPEECH_END][0]
    a = vf.TurnAudio(end.duration_ms, end.voiced_ms, end.speech_rms, end.floor_rms, end.peak, end.max_gain)
    assert 380 <= a.voiced_ms <= 420
    assert 30 <= a.floor_rms <= 45 and 1350 <= a.speech_rms <= 1480
    assert 29 <= a.snr_db <= 34  # 2000/sqrt(2) over 40
    assert a.peak >= 1900


def test_voice_has_pitch_and_breath_does_not():
    import numpy as np

    t = np.arange(320) / 8000
    vowel = sum(np.sin(2 * np.pi * 150 * k * t) / k for k in range(1, 6)) * 3000  # 150 Hz voice, harmonics
    assert audio.is_pitched(vowel.astype("<i2").tobytes())
    assert not audio.is_pitched(noise_pcm(40, 2000))  # hiss / breath / cough: no repeating period
    assert not audio.is_pitched(b"\x00\x00" * 320)


def test_breath_and_cough_have_no_pitch_but_an_answer_does():
    def measure(pcm):
        ep = audio.SpeechEndpointer(lambda f: audio.rms(f) > 60, measure_pitch=True,
                                    noise_gate=audio.NoiseFloorGate(min_rms=60, multiplier=2.5, max_rms=1000))
        ep.process(noise_pcm(1000, 30))
        return [e for e in ep.process(pcm + noise_pcm(900, 30, seed=5)) if e.event == audio.VadEvent.SPEECH_END][0]

    breath = measure(noise_pcm(450, 400, seed=11))
    answer = measure(audio.mulaw_to_pcm16(tone_mulaw(300, amplitude=2000)))
    assert breath.voiced_ms >= 200 and breath.pitched_ms == 0
    assert answer.pitched_ms >= 200
    a = vf.TurnAudio(breath.duration_ms, breath.voiced_ms, breath.speech_rms, breath.floor_rms, breath.peak,
                     breath.max_gain, breath.pitched_ms, expects_short=True)
    assert vf.check_audio(BAL, a) == "no_voice_pitch"


def test_gates_add_no_noticeable_time():
    t = _turn(300, 10, expects_short=True)
    start = time.perf_counter()
    for _ in range(10000):
        vf.check_audio(BAL, t)
        vf.is_lone_filler("ஆமா sir")
    assert (time.perf_counter() - start) / 10000 < 0.0005  # well under a millisecond per turn


# ------------------------------------------------------------------ calls
@pytest.mark.parametrize("level,mode", [("balanced", "enforce"), ("balanced", "log"), ("off", "log")])
def test_utterance_failing_the_gates_never_reaches_stt_when_enforced(client, auth, fakes, sync_engine, monkeypatch,
                                                                     level, mode):
    monkeypatch.setattr(settings, "VOICE_FOCUS_LEVEL", level)
    monkeypatch.setattr(settings, "VOICE_FOCUS_MODE", mode)
    monkeypatch.setattr(settings, "VOICE_FOCUS_SHORT_VOICED_MS", 1000)  # make a 400 ms sound "too short"
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Yes"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _after_question(ws, tone_mulaw(400) + silence_mulaw(900), hello_ms=1200)
        if mode == "enforce":
            _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='turn_rejected'",
                     lambda rows: bool(rows))
        else:
            _recv_until(ws, "checkpoint")  # today's behaviour: it is answered
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    if mode == "enforce":
        assert fakes.stt.calls == 1 and len(fakes.llm.seen_messages) == 1  # only "Hello?"
        [rejected] = _events(sync_engine, call_id, "turn_rejected")
        assert rejected["reason"] == "too_short" and rejected["voiced_ms"] >= 380 and "text" not in rejected
    else:
        assert fakes.stt.calls == 2 and fakes.llm.seen_messages[-1][-1]["content"] == "Yes"
        assert bool(_events(sync_engine, call_id, "turn_would_reject")) is (level != "off")


def test_breath_after_a_question_makes_no_turn(client, auth, fakes, sync_engine, enforce, monkeypatch):
    monkeypatch.setattr(audio, "make_webrtc_classifier", lambda *a, **k: (lambda frame: audio.rms(frame) > 200))
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "சரி"]  # what STT would have made of the breath
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _after_question(ws, audio.pcm16_to_mulaw(noise_pcm(500, 1500, seed=4)) + silence_mulaw(900))
        _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='turn_rejected'",
                 lambda rows: bool(rows))
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    assert fakes.stt.calls == 1 and len(fakes.llm.seen_messages) == 1  # only "Hello?"
    assert _events(sync_engine, call_id, "turn_rejected")[0]["reason"] == "no_voice_pitch"


@pytest.mark.parametrize("amplitude", [8000, 1500])  # normal and low volume
def test_short_tamil_answer_counts_after_a_question(client, auth, fakes, enforce, amplitude):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "ஆமா"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _after_question(ws, tone_mulaw(300, amplitude) + silence_mulaw(900))
        _recv_until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.llm.seen_messages[-1][-1] == {"role": "user", "content": "ஆமா"}


def test_soft_answer_over_background_noise_still_counts(client, auth, fakes, enforce, monkeypatch):
    monkeypatch.setattr(audio, "make_webrtc_classifier", lambda *a, **k: (lambda frame: audio.rms(frame) > 200))
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "ஆமா"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, noise_mulaw(1500, 80))  # the room
        _send_audio(ws, mix(tone_mulaw(500), noise_mulaw(500, 80)) + noise_mulaw(900, 80))
        cp = _recv_until(ws, "checkpoint")[-1]
        ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))
        _send_audio(ws, noise_mulaw(300, 80))
        _send_audio(ws, mix(tone_mulaw(300, 1500), noise_mulaw(300, 80)) + noise_mulaw(900, 80))  # soft "ஆமா"
        _recv_until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.llm.seen_messages[-1][-1] == {"role": "user", "content": "ஆமா"}


def test_lone_filler_asks_the_question_again_once_then_is_ignored(client, auth, fakes, sync_engine, enforce):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "ம்", "ம்"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _after_question(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _recv_until(ws, "checkpoint")[-1]  # the agent asks again
        ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))
        time.sleep(0.3)
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='turn_rejected'",
                 lambda rows: bool(rows))
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    assert len(fakes.llm.seen_messages) == 2  # "Hello?" and the one re-ask; the second "ம்" never reaches it
    assert fakes.llm.seen_messages[1][-1]["content"] == vf.FILLER_NOTE.format(text="ம்")
    assert _customer_lines(sync_engine, call_id) == ["Hello?", "[filler] ம்", "[filler] ம்"]
    assert [e["reason"] for e in _events(sync_engine, call_id, "turn_rejected")] == ["filler"]


def test_off_switch_keeps_todays_behaviour_for_a_filler(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "VOICE_FOCUS_LEVEL", "off")
    monkeypatch.setattr(settings, "VOICE_FOCUS_MODE", "enforce")
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "ம்"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _after_question(ws, tone_mulaw(400) + silence_mulaw(900))
        _recv_until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.llm.seen_messages[-1][-1] == {"role": "user", "content": "ம்"}


def test_filler_to_the_identity_question_gets_the_reask(client, auth, fakes, enforce):
    call_id, token = _call(client, auth, customer_name="Karthick G", gender="male")
    fakes.stt.replies = ["Hello?", "Yes", "ம்"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _ in range(3):
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            _until(ws, "checkpoint")
            time.sleep(0.5)
    spoken = [s.texts for s in fakes.tts.streams]
    assert spoken[1] == ["Am I speaking with Karthick, sir?"]
    assert spoken[2] == ["Sorry, am I speaking with Karthick?"]
    assert fakes.llm.seen_messages == []


def test_weak_sound_while_the_agent_talks_is_ignored(client, auth, fakes, sync_engine, enforce):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Sorry, who is this?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(300) + silence_mulaw(900))  # a short sound under the agent
        _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='turn_rejected'",
                 lambda rows: bool(rows))
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    assert fakes.stt.calls == 1 and "barge_in" not in _events(sync_engine, call_id)
    assert _events(sync_engine, call_id, "turn_rejected")[0]["reason"] == "agent_speaking"


def test_real_interruption_still_works(client, auth, fakes, enforce):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Sorry, who is this?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(800) + silence_mulaw(900))
        msgs = _recv_until(ws, "checkpoint")
        assert msgs[0] == {"event": "clearAudio", "streamId": "stream-1"}
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.llm.seen_messages[-1][-1]["content"] == "Sorry, who is this?"


def test_tamil_filler_under_the_agent_does_not_cut_it_off(client, auth, fakes, sync_engine, enforce):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "ம்"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(800) + silence_mulaw(900))  # long enough to be heard, but only "ம்"
        _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='barge_in_ignored'",
                 lambda rows: bool(rows))
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    assert "barge_in" not in _events(sync_engine, call_id) and len(fakes.llm.seen_messages) == 1


def test_agents_echo_never_becomes_a_turn(client, auth, fakes, sync_engine, enforce):
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "is now a good time for a quick"]  # the agent's line came back
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_playing(client, auth, fakes, ws)
        _send_audio(ws, tone_mulaw(800) + silence_mulaw(900))
        _wait_db(sync_engine, f"select 1 from call_events where call_id='{call_id}' and event_type='echo_ignored'",
                 lambda rows: bool(rows))
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)
    assert "barge_in" not in _events(sync_engine, call_id) and len(fakes.llm.seen_messages) == 1


def test_short_utterance_is_never_boosted_for_stt(client, auth, fakes, enforce, monkeypatch):
    monkeypatch.setattr(settings, "STT_NORMALIZE_AUDIO", True)
    boosted = []
    real = audio.normalize_for_stt
    monkeypatch.setattr(audio, "normalize_for_stt", lambda pcm, *a: boosted.append(len(pcm)) or real(pcm, *a))
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "ஆமா"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _after_question(ws, tone_mulaw(300) + silence_mulaw(900))  # 300 ms voiced: below the 400 ms no-gain line
        _recv_until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    assert len(boosted) == 1  # only the 500 ms "Hello?"
    assert fakes.llm.seen_messages[-1][-1]["content"] == "ஆமா"
