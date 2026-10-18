"""Reply-latency changes: timing logs, warm connections, LLM before TTS connect, hedged /
turn-model failover, pre-rendered fixed lines and streaming STT. Behaviour must not change."""
import asyncio
import json
import re
import time

import httpx
import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import audio_service as audio
from app.services import call_service
from app.services import llm_service as llm
from app.services.sarvam_stt import SarvamSTT, STTError, STTResult, STTStream
from app.services.sarvam_stt_stream import SarvamSTTStream
from tests.conftest import energy_classifier, silence_mulaw, tone_mulaw
from tests.test_llm import _failing_primary, _provider
from tests.test_nila_flow import _call, _send, _start, _until


def _agent_lines(sync_engine, call_id):
    with sync_engine.connect() as c:
        return c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent' order by id"),
                         {"id": call_id}).scalars().all()


def _greet_then_reply(client, auth, fakes, replies=("Hello?", "Yes", "Yes, please tell me about it"),
                      wait_for_greeting=False):
    """Customer says Hello (greeting is spoken), answers it (identity question is spoken), then
    a real reply that goes to the LLM - over the end of the identity question, or after it
    finished playing (wait_for_greeting)."""
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = list(replies)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")  # greeting
        ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))
        time.sleep(0.1)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")  # identity question
        if wait_for_greeting:
            ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))
            time.sleep(0.1)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "playAudio")
        _until(ws, "checkpoint")
        time.sleep(0.3)
    return call_id


# ------------------------------------------------------------------ 1. timing logs
def test_endpointer_reports_silence_waited_and_streams_frames():
    ep = audio.SpeechEndpointer(energy_classifier, end_silence_ms=700)
    sunk = []
    ep.frame_sink = sunk.append
    events = ep.process(audio.mulaw_to_pcm16(tone_mulaw(400) + silence_mulaw(900)))
    end = [e for e in events if e.event == audio.VadEvent.SPEECH_END][0]
    assert end.silence_ms == 700
    assert sunk and all(len(f) == audio.PCM_FRAME_BYTES for f in sunk)


def test_turn_timing_line_has_every_stage_and_no_text():
    m = call_service.TurnMetrics(t0=10.0, t1=10.75, t2=11.0, t3=11.0, t3_first_token=11.5, t5=11.5, t6=12.0)
    m.tts_wait = 0.0625
    line = m.log_line(3)
    assert line == ("Turn 3 timing (ms): eos_wait=750 stt=250 tts_wait=62 llm_first_token=500 "
                    "first_token_to_audio=500 tts_first_audio=500 total=1250 reply_delay=2000")
    # the database row keeps its existing columns
    assert set(m.as_row()) == {"stt_ms", "llm_ms", "llm_first_token_ms", "tts_first_byte_ms", "total_response_ms"}


def test_reply_turn_logs_end_of_speech_wait(client, auth, fakes, caplog):
    caplog.set_level("INFO")
    _greet_then_reply(client, auth, fakes)
    lines = [r.getMessage() for r in caplog.records if "timing (ms)" in r.getMessage()]
    assert lines
    eos = [int(v) for v in re.findall(r"eos_wait=(\d+)", " ".join(lines))]
    assert eos and all(690 <= v <= 900 for v in eos)
    assert all("reply_delay=" in line for line in lines)


# ------------------------------------------------------------------ 2. warm connections
def test_provider_clients_keep_connections_alive_between_turns():
    assert settings.http_limits().keepalive_expiry == settings.PROVIDER_KEEPALIVE_SECONDS == 60.0


async def test_stt_prewarm_sends_no_api_key():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, dict(req.headers)))
        return httpx.Response(404)

    stt = SarvamSTT(settings, client=httpx.AsyncClient(base_url="https://api.sarvam.ai",
                                                       transport=httpx.MockTransport(handler)))
    await stt.prewarm()
    assert seen and seen[0][0] == "HEAD"
    assert "sarvam-test-key" not in json.dumps(seen)


async def test_llm_prewarm_sends_no_api_key():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, str(req.url), dict(req.headers)))
        return httpx.Response(404)

    await _provider(llm.GeminiProvider, handler).prewarm()
    assert seen[0][0] == "HEAD" and seen[0][1].startswith("https://generativelanguage.googleapis.com")
    assert "llm-test-key" not in json.dumps(seen)


# ------------------------------------------------------------------ 3. LLM before TTS connect
@pytest.mark.parametrize("enabled", [True, False])
def test_llm_starts_while_tts_connects(client, auth, fakes, sync_engine, monkeypatch, enabled):
    monkeypatch.setattr(settings, "LLM_START_BEFORE_TTS", enabled)
    marks = {"llm": [], "tts_ready": []}
    real_open, real_stream = fakes.tts.open_stream, fakes.llm._stream

    async def slow_open():
        await asyncio.sleep(0.3)
        marks["tts_ready"].append(time.monotonic())
        return await real_open()

    def timed_stream(system_text, messages, model=None):
        if system_text != llm.OUTCOME_SYSTEM:
            marks["llm"].append(time.monotonic())
        return real_stream(system_text, messages, model)

    monkeypatch.setattr(fakes.tts, "open_stream", slow_open)
    monkeypatch.setattr(fakes.llm, "_stream", timed_stream)
    fakes.llm.reply = "Thank you sir. This is Thaara from Kagzso AI and Automation. Is that okay?"
    call_id = _greet_then_reply(client, auth, fakes)
    assert _agent_lines(sync_engine, call_id)[2] == fakes.llm.reply  # same words either way
    llm_start, ready = marks["llm"][0], marks["tts_ready"][-1]
    assert (llm_start < ready) is enabled


# ------------------------------------------------------------------ 4. hedged failover
@pytest.fixture
def hedged(monkeypatch):
    monkeypatch.setattr(settings, "LLM_FALLBACK_MODEL", "backup-model")
    monkeypatch.setattr(settings, "LLM_HEDGE_AFTER_SECONDS", 0.05)


async def test_hedge_speaks_backup_when_primary_is_slow(hedged):
    hits = []
    p = _provider(llm.GeminiProvider, _failing_primary(hits, primary_status=200, primary_delay=0.5))
    assert await p.generate_response("x", [], "hi", {}) == "Backup reply."
    assert hits == ["test-model", "backup-model"]
    assert p._primary_skip_until == 0.0  # slow is not broken


async def test_hedge_keeps_slow_primary_running_and_uses_it_if_first(hedged):
    hits = []
    p = _provider(llm.GeminiProvider, _failing_primary(hits, primary_status=200, primary_delay=0.1, backup_delay=1.0))
    assert await p.generate_response("x", [], "hi", {}) == "Primary reply."
    assert hits == ["test-model", "backup-model"]  # backup was started, then cancelled


async def test_hedge_not_used_when_primary_is_fast(hedged):
    hits = []
    p = _provider(llm.GeminiProvider, _failing_primary(hits, primary_status=200))
    assert await p.generate_response("x", [], "hi", {}) == "Primary reply."
    assert hits == ["test-model"]


async def test_hedge_fails_over_at_once_on_quota_error(hedged):
    hits = []
    p = _provider(llm.GeminiProvider, _failing_primary(hits, primary_status=429))
    assert await p.generate_response("x", [], "hi", {}) == "Backup reply."
    assert hits == ["test-model", "backup-model"] and p._primary_skip_until > 0


async def test_hedge_does_not_retry_auth_error(hedged):
    hits = []
    p = _provider(llm.GeminiProvider, _failing_primary(hits, primary_status=401))
    with pytest.raises(llm.LLMError):
        await p.generate_response("x", [], "hi", {})
    assert hits == ["test-model"]


# ------------------------------------------------------------------ 5. turn model
def _by_model(hits, failing=()):
    def handler(req: httpx.Request) -> httpx.Response:
        model = req.url.path.rsplit("/", 1)[1].split(":")[0]
        hits.append(model)
        if model in failing:
            return httpx.Response(503, json={"error": {"message": "overloaded"}})
        return httpx.Response(200, text='data: {"candidates":[{"content":{"parts":[{"text":"' + model + '"}]}}]}\n\n')
    return handler


async def test_turn_model_used_for_replies_only(monkeypatch):
    monkeypatch.setattr(settings, "LLM_TURN_MODEL", "fast-model")
    hits = []
    p = _provider(llm.GeminiProvider, _by_model(hits))
    assert await p.generate_response("x", [], "hi", {}) == "fast-model"
    assert await p.complete_raw(llm.OUTCOME_SYSTEM, "transcript") == "test-model"
    assert hits == ["fast-model", "test-model"]


async def test_turn_model_falls_back_to_current_model(monkeypatch):
    monkeypatch.setattr(settings, "LLM_TURN_MODEL", "fast-model")
    monkeypatch.setattr(settings, "LLM_FALLBACK_MODEL", "backup-model")
    hits = []
    p = _provider(llm.GeminiProvider, _by_model(hits, failing=("fast-model",)))
    assert await p.generate_response("x", [], "hi", {}) == "test-model"
    assert await p.generate_response("x", [], "again", {}) == "test-model"
    # quota/overload on the turn model cools it down; LLM_MODEL's own cooldown is untouched
    assert hits == ["fast-model", "test-model", "test-model"] and p._primary_skip_until == 0.0


async def test_no_turn_model_keeps_current_chain():
    hits = []
    p = _provider(llm.GeminiProvider, _by_model(hits))
    assert await p.generate_response("x", [], "hi", {}) == "test-model"


# ------------------------------------------------------------------ 8. pre-rendered fixed lines
def test_fixed_lines_play_without_a_tts_round_trip(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "PRERENDER_FIXED_LINES", True)
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 0.5)
    synthesized = []
    real = fakes.tts.synthesize

    async def record(text, pace=None):
        synthesized.append(text)
        return await real(text, pace=pace)

    monkeypatch.setattr(fakes.tts, "synthesize", record)
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")  # greeting
        ws.send_text(json.dumps({"event": "playedStream", "name": cp["name"]}))
        _until(ws, "checkpoint")  # silence re-prompt
        time.sleep(0.3)
    lines = _agent_lines(sync_engine, call_id)
    assert lines[0] == "Hi sir, Good morning." and len(lines) >= 2
    reprompt = lines[1]
    assert reprompt in synthesized  # rendered once at call start
    assert "Sorry, am I speaking with Ragul?" in synthesized
    streamed = [t for s in fakes.tts.streams for t in s.texts]
    assert reprompt not in streamed  # played from the cache, no TTS stream for it


# ------------------------------------------------------------------ 7. streaming STT
class FakeWS:
    def __init__(self, replies_after_flush=({"type": "data", "data": {"transcript": "Yes tell me"}},)):
        self.sent = []
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.replies_after_flush = replies_after_flush
        self.closed = False

    async def send(self, raw):
        msg = json.loads(raw)
        self.sent.append(msg)
        if msg.get("type") == "flush":
            for r in self.replies_after_flush:
                await self.inbox.put(json.dumps(r))

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.inbox.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def close(self):
        self.closed = True


async def test_streaming_stt_sends_audio_while_speaking_then_flushes():
    ws, seen = FakeWS(), {}

    async def connect(url, headers):
        seen["url"], seen["headers"] = url, headers
        return ws

    s = SarvamSTTStream(settings, connect=connect)
    s.feed(audio.mulaw_to_pcm16(tone_mulaw(500)))
    result = await s.finish(timeout=1.0)
    await s.aclose()
    assert result["text"] == "Yes tell me"
    assert "language-code=en-IN" in seen["url"] and "flush_signal=true" in seen["url"]
    assert "input_audio_codec=pcm_s16le" in seen["url"] and "sample_rate=16000" in seen["url"]
    assert seen["headers"] == {"Api-Subscription-Key": "sarvam-test-key"}
    audio_msgs = [m for m in ws.sent if "audio" in m]
    assert len(audio_msgs) >= 5 and ws.sent[-1] == {"type": "flush"}
    assert ws.closed


async def test_streaming_stt_errors_and_timeouts_raise():
    s = SarvamSTTStream(settings, connect=lambda url, headers: _raise(OSError()))
    with pytest.raises(STTError):
        await s.finish(timeout=1.0)
    await s.aclose()

    ws = FakeWS(replies_after_flush=({"type": "error", "data": {"error": "bad audio", "code": "400"}},))
    s = SarvamSTTStream(settings, connect=lambda url, headers: _value(ws))
    with pytest.raises(STTError):
        await s.finish(timeout=1.0)
    await s.aclose()

    ws = FakeWS(replies_after_flush=())
    s = SarvamSTTStream(settings, connect=lambda url, headers: _value(ws))
    with pytest.raises(STTError) as ei:
        await s.finish(timeout=0.1)
    assert ei.value.kind == "timeout"
    await s.aclose()


async def _raise(exc):
    raise exc


async def _value(v):
    return v


def test_streaming_stt_off_by_default():
    assert settings.STT_STREAMING is False
    assert SarvamSTT(settings).open_stream() is None


class _FakeStream(STTStream):
    def __init__(self, text_or_error):
        self.result = text_or_error
        self.fed = 0
        self.closed = False

    def feed(self, pcm8k):
        self.fed += len(pcm8k)

    async def finish(self, timeout):
        if isinstance(self.result, Exception):
            raise self.result
        return STTResult(text=self.result, language="en-IN", confidence=0.9)

    async def aclose(self):
        self.closed = True


@pytest.mark.parametrize("streamed,uses_rest", [("Yes, please tell me about it", False),
                                                (STTError("timeout", "slow"), True), ("", True)])
def test_session_uses_streamed_transcript_or_falls_back(client, auth, fakes, sync_engine, monkeypatch,
                                                        streamed, uses_rest):
    streams = []

    def open_stream():
        streams.append(_FakeStream("Hello?" if not streams else streamed))
        return streams[-1]

    monkeypatch.setattr(fakes.stt, "open_stream", open_stream)
    fakes.llm.reply = "Thank you sir. Is that okay?"
    call_id = _greet_then_reply(client, auth, fakes, replies=["Yes", "Yes, please tell me about it"],
                                wait_for_greeting=True)
    assert len(streams) == 3 and all(s.fed > 0 and s.closed for s in streams)
    assert fakes.stt.calls == (2 if uses_rest else 0)  # REST only when the stream gave nothing
    assert _agent_lines(sync_engine, call_id)[:3] == ["Hi sir, Good morning.", "Am I speaking with Ragul, sir?",
                                                      "Thank you sir. Is that okay?"]
