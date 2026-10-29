"""Reply speed (KEY_LINES_SCRIPTED, ADAPTIVE_EOS, TTS_FIRST_CLAUSE, TTS_FLUSH_FIRST_SENTENCE, TTS_WARM_STREAM,
THINKING_ACK, LLM_BREAKER_TIMEOUTS, LLM_FALLBACK2_*): fakes only - no call, no real STT / TTS / LLM / Plivo.

Every switch is off by default; each feature has a test that its off switch keeps today's behaviour."""
import asyncio
import base64
import json
import re
import time
from pathlib import Path

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.flows.schema import LOCKED_BLOCKS, CallFlow, render_blocks
from app.services import audio_service as audio
from app.services import call_service
from app.services import llm_service as llm
from app.services import reply_speed as rs
from app.services.llm_service import TURN_INFO, LLMError, LLMProvider, SentenceChunker
from app.services.sarvam_stt import STTResult
from tests import conftest
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_media_stream import _send_audio, _setup_call, _start_msg
from tests.test_nila_flow import _call, _send, _start, _until
from tests.test_tamil_flow import FLOW as TA_FLOW, INTRO, MAIN_QUESTION, PERMISSION, TO_PERMISSION, _converse

ROOT = Path(__file__).resolve().parents[2]
EN_FLOW = json.loads((ROOT / "deploy/callflows/thaara-natural.json").read_text(encoding="utf-8"))
SLIM = json.loads((ROOT / "deploy/callflows/proposed/thaara-tamil-slim.json").read_text(encoding="utf-8"))
EN_PERMISSION = ("Thank you, sir. This is Thaara from Kexo AI and Automation. Do you have just one minute? "
                 "I'll quickly tell you about our company.")


def _events(sync_engine, call_id, kind):
    with sync_engine.connect() as c:
        rows = c.execute(text("select payload from call_events where call_id = :id and event_type = :t"),
                         {"id": call_id, "t": kind}).scalars().all()
    return [json.loads(p) if isinstance(p, str) else (p or {}) for p in rows]


def _eos_waits(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select eos_wait_ms from call_latency_metrics where call_id = :id order by turn_index"),
                         {"id": call_id}).scalars().all()


FRAME = audio.FRAME_MS  # the wait is measured from frame counts; allow one frame of timer rounding


def _wait_for(predicate, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def tamil(monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "ta")


# ================================================================== key lines: extraction and "clear yes"
def test_key_lines_come_word_for_word_from_the_flow_blocks(tamil):
    lines = rs.flow_key_lines(CallFlow.model_validate(TA_FLOW))
    render = lambda t: llm.render_first_message(t, {"customer_name": "Ragul", "gender": "male"})  # noqa: E731
    assert render(lines["permission"]) == PERMISSION
    assert render(lines["intro"]) == INTRO


def test_english_intro_says_briefly_so_only_the_permission_line_is_scripted(monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "en")
    lines = rs.flow_key_lines(CallFlow.model_validate(EN_FLOW))
    assert set(lines) == {"permission"}
    assert llm.render_first_message(lines["permission"], {"customer_name": "Ragul", "gender": "male"}) == EN_PERMISSION


def test_a_block_with_an_unknown_variable_is_never_scripted():
    assert rs.quoted_line('Say:\n> "Hello {{unknown_thing}}"') is None
    assert rs.quoted_line('Say briefly:\n"Hi."', need_exactly=True) is None
    assert rs.quoted_line('Say exactly:\n> "Hi {{title_to_use}}."', need_exactly=True) == "Hi {{title_to_use}}."


@pytest.mark.parametrize("said", ["ஆமா", "ஆமா சார்", "ஆமாம்.", "Yes", "Yes sir", "Speaking", "நான் தான்",
                                  "சொல்லுங்க", "yeah, speaking"])
def test_clear_identity_yes(said):
    assert rs.clear_yes(said, "identity")


@pytest.mark.parametrize("said", ["ஆமா, யாரு பேசுறது?", "Yes but who is this?", "No", "இல்ல", "ம்", "Hello",
                                  "Okay", "யாரு?", "call பண்ணாதீங்க", "", "yes yes yes yes yes"])
def test_anything_else_is_not_a_clear_identity_yes(said):
    assert not rs.clear_yes(said, "identity")


@pytest.mark.parametrize("said", ["சரி", "சரிங்க sir", "Okay", "ok sure", "சொல்லுங்க", "Go ahead", "Tell me", "பேசுங்க"])
def test_clear_permission_yes(said):
    assert rs.clear_yes(said, "permission")


@pytest.mark.parametrize("said", ["இப்போ busy", "சரி, ஆனா price என்ன?", "No time", "Later", "வேண்டாம்"])
def test_busy_or_questions_are_not_permission(said):
    assert not rs.clear_yes(said, "permission")


# ================================================================== key lines in a call
def test_tamil_key_lines_are_spoken_word_for_word_without_the_ai(client, auth, fakes, sync_engine, tamil, monkeypatch):
    monkeypatch.setattr(settings, "KEY_LINES_SCRIPTED", True)
    call_id, lines = _converse(client, auth, fakes, TO_PERMISSION + [("சரி", True), ("ஆமா", True)],
                               llm_replies=[MAIN_QUESTION])
    assert lines[2] == PERMISSION and lines[3] == INTRO  # word for word, no paraphrase, no fallback line
    assert len(fakes.llm.seen_messages) == 1  # the AI answered only the interest question
    assert fakes.llm.seen_messages[0][-1]["content"] == "ஆமா"
    history = [m["content"] for m in fakes.llm.seen_messages[0] if m["role"] == "assistant"]
    assert PERMISSION in history and INTRO in history  # the AI knows both lines were said
    assert [e["line"] for e in _events(sync_engine, call_id, "key_line")] == ["permission", "introduction"]


def test_a_question_with_the_yes_still_goes_to_the_ai(client, auth, fakes, tamil, monkeypatch):
    monkeypatch.setattr(settings, "KEY_LINES_SCRIPTED", True)
    turns = TO_PERMISSION[:2] + [("ஆமா, யாரு பேசுறது?", True)]
    _, lines = _converse(client, auth, fakes, turns, llm_replies=[PERMISSION])
    assert fakes.llm.seen_messages[0][-1]["content"] == "ஆமா, யாரு பேசுறது?"


def test_key_lines_off_the_ai_says_them_as_before(client, auth, fakes, sync_engine, tamil):
    call_id, lines = _converse(client, auth, fakes, TO_PERMISSION + [("சரி", True)], llm_replies=[PERMISSION, INTRO])
    assert [m[-1]["content"] for m in fakes.llm.seen_messages] == ["ஆமா", "சரி"]
    assert _events(sync_engine, call_id, "key_line") == []


def test_english_permission_line_after_yes(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "en")
    monkeypatch.setattr(settings, "KEY_LINES_SCRIPTED", True)
    call_id, token = _call(client, auth, customer_name="ragul", gender="male", flow_id="thaara_en", flow_version=1,
                           flow=EN_FLOW)
    fakes.stt.replies = ["Hello?", "Yes, speaking."]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _ in range(2):
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            _ack(ws, _until(ws, "checkpoint"))
            time.sleep(0.5)
        ws.send_text(json.dumps({"event": "stop"}))
    lines = [" ".join(s.texts) for s in fakes.tts.streams]
    assert lines[-1] == EN_PERMISSION
    assert fakes.llm.seen_messages == []


def _ack(ws, cp):
    ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))


# ================================================================== LLM failover, circuit breaker, second fallback
class Scripted(LLMProvider):
    """Per-model behaviour: "slow" (no text for 1 s), an LLMError to raise, else a reply naming the model."""
    name = "scripted"

    def __init__(self, behaviour):
        super().__init__(settings)
        self.behaviour = behaviour
        self.calls = []

    async def _stream(self, system_text, messages, model=None):
        model = model or self.model
        self.calls.append(model)
        b = self.behaviour.get(model)
        if b == "slow":
            await asyncio.sleep(1.0)
        elif isinstance(b, LLMError):
            raise b
        yield f"reply from {model}."


def _reply(provider):
    async def go():
        info = {}
        TURN_INFO.set(info)
        parts = [d async for d in provider.stream_response("Be brief.", [], "Hello", {})]
        return "".join(parts), info
    return asyncio.run(go())


@pytest.fixture
def chain(monkeypatch):
    monkeypatch.setattr(settings, "LLM_MODEL", "primary")
    monkeypatch.setattr(settings, "LLM_FALLBACK_MODEL", "backup")
    monkeypatch.setattr(settings, "LLM_PRIMARY_FIRST_TOKEN_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(settings, "LLM_PRIMARY_COOLDOWN_SECONDS", 120.0)


def test_failover_answers_from_the_backup_and_records_it(chain):
    p = Scripted({"primary": LLMError("rate_limit", "quota")})
    text_, info = _reply(p)
    assert text_ == "reply from backup."
    assert info == {"model": "backup", "failover": True}


def test_circuit_breaker_stays_on_the_working_model_after_repeated_timeouts(chain, monkeypatch):
    monkeypatch.setattr(settings, "LLM_BREAKER_TIMEOUTS", 2)
    p = Scripted({"primary": "slow"})
    _reply(p)
    _reply(p)  # second timeout within the window: breaker opens
    p.calls.clear()
    assert _reply(p)[0] == "reply from backup."
    assert p.calls == ["backup"]  # the slow model is not tried first any more


def test_breaker_off_keeps_trying_the_slow_model_first(chain):
    p = Scripted({"primary": "slow"})
    for _ in range(3):
        _reply(p)
    p.calls.clear()
    _reply(p)
    assert p.calls == ["primary", "backup"]


def _with_second(monkeypatch, p, second):
    monkeypatch.setattr(settings, "LLM_FALLBACK2_PROVIDER", "openai")
    monkeypatch.setattr(settings, "LLM_FALLBACK2_MODEL", "other")
    second.model = "other"
    monkeypatch.setattr(p, "_fallback2", lambda: second)


def test_second_fallback_answers_when_every_model_above_fails(chain, monkeypatch):
    p = Scripted({"primary": LLMError("provider", "down"), "backup": LLMError("provider", "down")})
    second = Scripted({})
    _with_second(monkeypatch, p, second)
    text_, info = _reply(p)
    assert text_ == "reply from other."
    assert info == {"model": "scripted:other", "failover": True}
    p.calls.clear()
    assert _reply(p)[0] == "reply from other."  # breaker: the working provider goes first now
    assert p.calls == []


def test_second_fallback_is_not_used_for_a_blocked_prompt(chain, monkeypatch):
    p = Scripted({"primary": LLMError("blocked", "safety")})
    second = Scripted({})
    _with_second(monkeypatch, p, second)
    with pytest.raises(LLMError):
        _reply(p)
    assert second.calls == []


def test_without_a_second_fallback_errors_are_unchanged(chain):
    p = Scripted({"primary": LLMError("provider", "down"), "backup": LLMError("provider", "down")})
    with pytest.raises(LLMError):
        _reply(p)


def _failing_llm(fakes, monkeypatch):
    async def down(system_text, messages, model=None):
        raise LLMError("provider", "down")
        yield  # pragma: no cover
    monkeypatch.setattr(fakes.llm, "_stream", down)


def test_provider_error_never_gives_the_fallback_line_when_a_second_model_works(client, auth, fakes, sync_engine,
                                                                                 tamil, monkeypatch):
    _failing_llm(fakes, monkeypatch)
    second = conftest.FakeLLM()
    second.reply = PERMISSION
    monkeypatch.setattr(settings, "LLM_FALLBACK2_PROVIDER", "openai")
    monkeypatch.setattr(settings, "LLM_FALLBACK2_MODEL", "other")
    monkeypatch.setattr(fakes.llm, "_fallback2", lambda: second)
    call_id, lines = _converse(client, auth, fakes, TO_PERMISSION)
    assert lines[2] == PERMISSION
    assert _events(sync_engine, call_id, "fallback_line") == []


def test_without_the_second_model_the_provider_error_gives_the_fallback_line_as_before(client, auth, fakes,
                                                                                         sync_engine, tamil, monkeypatch):
    _failing_llm(fakes, monkeypatch)
    call_id, _ = _converse(client, auth, fakes, TO_PERMISSION)
    assert [e["reason"] for e in _events(sync_engine, call_id, "fallback_line")] == ["llm_provider"]


# ================================================================== streaming: TTS starts on the first clause
def test_chunker_first_clause_and_hindi_full_stop():
    c = SentenceChunker(first_clause_chars=20)
    assert c.feed("Sure sir, I understand your question, ") == ["Sure sir, I understand your question,"]
    assert c.feed("we can help, ") == []  # only the first piece is cut at a comma
    assert c.feed("thanks. ") == ["we can help, thanks."]
    h = SentenceChunker(first_clause_chars=20)
    assert h.feed("जी हाँ। आगे ") == ["जी हाँ।"]


def test_chunker_off_is_unchanged():
    c = SentenceChunker()
    assert c.feed("Sure sir, I understand your question, ") == []
    assert c.feed("जी हाँ। आगे ") == []
    assert c.flush() == ["Sure sir, I understand your question, जी हाँ। आगे"]


def _slow_second_half(fakes, monkeypatch, pause=0.8):
    async def stream(system_text, messages, model=None):
        if system_text == llm.OUTCOME_SYSTEM:
            yield fakes.llm.outcome_json
            return
        fakes.llm.seen_messages.append(messages)
        for w in "Sure sir, I understand your question, ".split(" "):
            yield w + " "
        await asyncio.sleep(pause)
        yield "we can help with that."
    monkeypatch.setattr(fakes.llm, "_stream", stream)


@pytest.mark.parametrize("on", [True, False])
def test_tts_starts_on_the_first_clause_while_the_ai_is_still_writing(client, auth, fakes, monkeypatch, on):
    monkeypatch.setattr(settings, "TTS_FIRST_CLAUSE", on)
    monkeypatch.setattr(settings, "TTS_FLUSH_FIRST_SENTENCE", on)
    flushed = []

    async def flush(self):
        flushed.append(list(self.texts))
    monkeypatch.setattr(conftest.FakeTTSStream, "flush", flush)
    _slow_second_half(fakes, monkeypatch)
    call_id, token = _setup_call(client, auth)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        early = _wait_for(lambda: fakes.tts.streams and fakes.tts.streams[-1].texts, timeout=0.6)
        texts = list(fakes.tts.streams[-1].texts) if fakes.tts.streams else []
        _until(ws, "checkpoint")
    if on:
        assert early and texts == ["Sure sir, I understand your question,"]  # before the AI finished
        assert flushed == [["Sure sir, I understand your question,"]]  # spoken at once
    else:
        assert not early and flushed == []  # today: waits for the full sentence


# ================================================================== warm TTS connection
@pytest.mark.parametrize("on", [True, False])
def test_next_reply_uses_the_connection_opened_after_the_last_one(client, auth, fakes, monkeypatch, on):
    monkeypatch.setattr(settings, "TTS_WARM_STREAM", on)
    call_id, token = _setup_call(client, auth)
    fakes.stt.replies = ["Hello?", "Yes"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        for _ in range(2):
            _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
            _ack(ws, _until(ws, "checkpoint"))
            time.sleep(0.5)
    used = [s for s in fakes.tts.streams if s.texts]
    assert len(used) == 2
    assert len(fakes.tts.streams) == (3 if on else 2)  # on: one spare opened for the next reply


# ================================================================== adaptive end of speech
@pytest.fixture
def adaptive(monkeypatch):
    monkeypatch.setattr(settings, "ADAPTIVE_EOS", True)


@pytest.fixture
def said(fakes, monkeypatch):
    """What STT hears for every request (early or final) until the test changes it."""
    now = {"text": "Hello?", "calls": 0}

    async def transcribe(audio_data, filename="audio.wav", content_type="audio/wav"):
        now["calls"] += 1
        return STTResult(text=now["text"], language="en-IN", confidence=0.9)
    monkeypatch.setattr(fakes.stt, "transcribe", transcribe)
    return now


def _realtime_silence(ws, ms):
    for c in audio.chunk_bytes(silence_mulaw(ms), 160):
        ws.send_text(json.dumps({"event": "media", "media": {"track": "inbound", "payload": base64.b64encode(c).decode()}}))
        time.sleep(0.02)


def _answer_after_question(client, auth, fakes, said, answer, silence_ms, before=None):
    """The agent asks QUESTION; the customer says `answer` and is then silent for `silence_ms` in real time."""
    call_id, token = _setup_call(client, auth)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.5)
        if before:
            before(call_id)
        said["text"] = answer
        _send_audio(ws, tone_mulaw(400))
        _realtime_silence(ws, silence_ms)
        _until(ws, "checkpoint")
    return call_id


def test_complete_short_answer_gets_a_shorter_wait(client, auth, fakes, sync_engine, adaptive, said):
    call_id = _answer_after_question(client, auth, fakes, said, "Yes.", 900)
    assert fakes.llm.seen_messages[-1][-1]["content"] == "Yes."
    wait = _eos_waits(sync_engine, call_id)[-1]
    assert settings.ADAPTIVE_EOS_SHORT_MS - FRAME <= wait < settings.VAD_SPEECH_END_SILENCE_MS - FRAME


def test_trailing_sentence_waits_longer(client, auth, fakes, sync_engine, adaptive, said):
    call_id = _answer_after_question(client, auth, fakes, said, "We run a restaurant and", 1600)
    assert _eos_waits(sync_engine, call_id)[-1] >= settings.ADAPTIVE_EOS_LONG_MS - FRAME


def test_ordinary_sentence_keeps_the_normal_wait_and_reuses_the_early_transcript(client, auth, fakes, sync_engine,
                                                                                  adaptive, said):
    call_id = _answer_after_question(client, auth, fakes, said, "We run a restaurant in Chennai.", 1000)
    assert abs(_eos_waits(sync_engine, call_id)[-1] - settings.VAD_SPEECH_END_SILENCE_MS) < FRAME
    assert said["calls"] == 2  # one STT request per utterance: the final one reused the early one


def test_slow_speaker_is_never_cut_by_the_short_wait(client, auth, fakes, sync_engine, adaptive, said):
    def slow(call_id):
        s = call_service.ACTIVE_SESSIONS[call_id]
        s._slow_speaker = True
        s.endpointer.end_frames = settings.SLOW_SPEAKER_END_SILENCE_MS // audio.FRAME_MS
    call_id = _answer_after_question(client, auth, fakes, said, "Yes.", 1900, before=slow)
    assert _eos_waits(sync_engine, call_id)[-1] >= settings.SLOW_SPEAKER_END_SILENCE_MS - FRAME


def test_speaking_again_before_the_short_wait_is_never_cut_off(client, auth, fakes, sync_engine, adaptive, said):
    call_id, token = _setup_call(client, auth)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.5)
        said["text"] = "Yes."
        _send_audio(ws, tone_mulaw(400))
        _realtime_silence(ws, 360)  # early STT heard "Yes." but the short wait has not passed
        said["text"] = "Yes. But who gave you my number?"
        _send_audio(ws, tone_mulaw(600))
        _realtime_silence(ws, 900)
        _until(ws, "checkpoint")
    assert len(fakes.llm.seen_messages) == 2  # one turn for the whole answer
    assert fakes.llm.seen_messages[-1][-1]["content"] == "Yes. But who gave you my number?"


def test_adaptive_off_keeps_the_normal_wait_and_one_stt_request(client, auth, fakes, sync_engine, said):
    call_id = _answer_after_question(client, auth, fakes, said, "Yes.", 900)
    assert abs(_eos_waits(sync_engine, call_id)[-1] - settings.VAD_SPEECH_END_SILENCE_MS) < FRAME
    assert said["calls"] == 2


@pytest.mark.parametrize("words,after_q,kind", [
    ("ஆமா", True, "complete"), ("Yes sir.", True, "complete"), ("இல்ல", True, "complete"), ("No.", True, "complete"),
    ("Yes.", False, "normal"), ("We have twenty employees.", True, "normal"), ("ம்", True, "normal"),
    ("எங்க business வந்து", True, "trailing"), ("I think that,", True, "trailing"), ("Well and", False, "trailing"),
])
def test_utterance_kind(words, after_q, kind):
    assert rs.utterance_kind(words, after_q) == kind


# ================================================================== thinking acknowledgment
@pytest.fixture
def slow_ai(fakes, monkeypatch):
    real = fakes.llm._stream

    async def stream(system_text, messages, model=None):
        if system_text != llm.OUTCOME_SYSTEM:
            await asyncio.sleep(0.4)
        async for d in real(system_text, messages, model):
            yield d
    monkeypatch.setattr(fakes.llm, "_stream", stream)


@pytest.mark.parametrize("on", [True, False])
def test_thinking_ack_never_a_turn_never_twice_in_a_row(client, auth, fakes, sync_engine, slow_ai, monkeypatch, on):
    monkeypatch.setattr(settings, "THINKING_ACK", on)
    monkeypatch.setattr(settings, "THINKING_ACK_AFTER_SECONDS", 0.1)
    monkeypatch.setattr(settings, "PRERENDER_FIXED_LINES", True)
    call_id, token = _setup_call(client, auth)
    said = ["Hello, who is this?", "Yes, tell me more", "Okay, go on please"]  # one-word answers never get one
    fakes.stt.replies = said
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        ws.send_text(json.dumps(_start_msg()))
        time.sleep(0.3)  # fixed lines pre-rendered
        for _ in range(3):
            _send_audio(ws, tone_mulaw(400) + silence_mulaw(900))
            _ack(ws, _until(ws, "checkpoint"))
            time.sleep(0.5)
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.2)
    acks = [e["turn"] for e in _events(sync_engine, call_id, "thinking_ack")]
    assert acks == ([1, 3] if on else [])  # never two replies in a row
    with sync_engine.connect() as c:
        rows = c.execute(text("select speaker, text from transcripts where call_id = :id order by id"),
                         {"id": call_id}).all()
    assert [t for s, t in rows if s == "customer"] == said  # never counted as a turn
    assert all(not t.startswith("Okay sir") for s, t in rows if s == "agent")  # never instead of the reply
    assert len([t for s, t in rows if s == "agent"]) == 3
    assert all("Okay sir" not in m["content"] for msgs in fakes.llm.seen_messages for m in msgs)


# ================================================================== proposed slimmer Tamil prompt
def _tokens(s):
    indic = len(re.findall(r"[ऀ-෿]", s))
    return round((len(s) - indic) / 4 + indic / 1.3)


def _quoted(flow):
    return {m for b in flow["blocks"] if b.get("text")
            for m in re.findall(r'^\s*>\s*"(.+)"\s*$', b["text"], flags=re.MULTILINE)}


def test_proposed_slim_tamil_prompt_is_smaller_and_keeps_every_line_and_locked_block(tamil):
    before, after = CallFlow.model_validate(TA_FLOW), CallFlow.model_validate(SLIM)  # still a valid flow
    assert _tokens(render_blocks(after)) < _tokens(render_blocks(before)) * 0.95
    locked = lambda f: [b["locked"] for b in f["blocks"] if b.get("locked")]  # noqa: E731
    assert locked(SLIM) == locked(TA_FLOW)  # safety / DNC / outcome blocks untouched, same order
    assert all(LOCKED_BLOCKS[k] in render_blocks(after) for k in locked(SLIM))
    silence_lines = {TA_FLOW["silence"]["reprompt"], TA_FLOW["silence"]["closing"]}
    assert _quoted(TA_FLOW) - silence_lines <= _quoted(SLIM)  # every line to say is still there word for word
    assert SLIM["silence"] == TA_FLOW["silence"] and SLIM["greeting"] == TA_FLOW["greeting"]
    assert SLIM["identity"] == TA_FLOW["identity"]
    kept = {b["id"] for b in SLIM["blocks"]}
    assert {b["id"] for b in TA_FLOW["blocks"]} - kept == {"screening_flow"}
