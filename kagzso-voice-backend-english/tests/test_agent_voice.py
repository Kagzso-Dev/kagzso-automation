"""Autonomous AI Agent (Thaara) voice delivery: one calm, steady voice profile for every line of the call.

* unit: the profile (pace, temperature, synthesis chunk size) reaches Sarvam's REST body and stream config with
  the same speaker, model and key; a fallback voice, once used, stays for the rest of an agent call (other calls
  keep trying the primary, as before); exclamation marks are spoken as calm full stops;
* mocked calls (no Sarvam request is made - a recording SarvamTTS stands in for the network): several
  consecutive replies in English, Tamil and Hindi all use the identical speaker / pace / temperature / chunk size,
  the greeting included, the first sentence is flushed, no first clause is cut at a comma, and no "!" is spoken.
  A normal (non-agent) call is unchanged: configured speed, greeting speed, first-clause split and "!".

How the voice SOUNDS can only be judged by listening to real Sarvam audio (a paid request): not done here.
"""
from __future__ import annotations

import base64
import io
import json
import wave
from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest

from app.core.config import settings
from app.services import audio_service as audio
from app.services import call_service as cs
from app.services.llm_service import calm_spoken_text
from app.services.provider_registry import FallbackTTS, agent_voice_settings, with_agent_voice
from app.services.sarvam_tts import SarvamStream, SarvamTTS
from app.services.tts import TTSError, TTSProvider, TTSStream
from tests.conftest import FakeTTS, FakeTTSStream
from tests.test_autonomous_conversation import _converse, _dial, _flow

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "autonomous"
PROFILE = {"pace": 0.9, "temperature": 0.4, "min_buffer": 120}


def _cfg(**over):
    return settings.model_copy(update={"SARVAM_API_KEY": settings.SARVAM_API_KEY.__class__("test-key-0123456789"),
                                       **over})


# ------------------------------------------------------------------ the profile
def test_profile_defaults_and_clamping():
    assert agent_voice_settings(settings) == {"SARVAM_TTS_PACE": 0.9, "SARVAM_TTS_TEMPERATURE": 0.4,
                                              "SARVAM_TTS_MIN_BUFFER_CHARS": 120}
    wild = _cfg(AGENT_TTS_PACE=9.0, AGENT_TTS_TEMPERATURE=0.0, AGENT_TTS_MIN_BUFFER_CHARS=5000)
    assert agent_voice_settings(wild) == {"SARVAM_TTS_PACE": 2.0, "SARVAM_TTS_TEMPERATURE": 0.01,
                                          "SARVAM_TTS_MIN_BUFFER_CHARS": 200}


def test_with_agent_voice_keeps_the_speaker_model_and_key_and_changes_only_the_profile():
    base = SarvamTTS(_cfg(SARVAM_TTS_PACE=1.0, SARVAM_TTS_TEMPERATURE=0.6, SARVAM_TTS_MIN_BUFFER_CHARS=30),
                     voice_id="roopa")
    agent = with_agent_voice(base)
    assert isinstance(agent, SarvamTTS) and agent is not base
    assert agent.voice_id == base.voice_id and agent._client is base._client
    assert agent.cfg.SARVAM_TTS_MODEL == base.cfg.SARVAM_TTS_MODEL
    assert agent.cfg.SARVAM_API_KEY.get_secret_value() == base.cfg.SARVAM_API_KEY.get_secret_value()
    assert agent._voice_settings() == {**base._voice_settings(), "pace": 0.9, "temperature": 0.4}
    assert base._voice_settings()["pace"] == 1.0  # the shared provider is not changed
    other = FakeTTS()
    assert with_agent_voice(other) is other  # not a Sarvam voice: left as it is


def test_stream_config_and_rest_body_carry_the_same_profile():
    sent: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(8000), w.writeframes(b"\x00\x01" * 800)
        return httpx.Response(200, json={"audios": [base64.b64encode(buf.getvalue()).decode()]})

    client = httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler))
    agent = with_agent_voice(SarvamTTS(_cfg(), voice_id="roopa", client=client))
    import asyncio

    for line in ("Good morning sir.", "Sure, no problem.", "Thank you for your time."):
        asyncio.run(agent.synthesize(line))
    assert len(sent) == 3
    assert {(b["speaker"], b["model"], b["pace"], b["temperature"]) for b in sent} == {
        ("roopa", settings.SARVAM_TTS_MODEL, 0.9, 0.4)}

    configs: List[Dict[str, Any]] = []
    stream = SarvamStream(agent, "test-key-0123456789")

    async def capture(payload):
        configs.append(payload)

    stream._send = capture  # type: ignore[method-assign]
    asyncio.run(stream._send_config())
    data = configs[0]["data"]
    assert (data["speaker"], data["pace"], data["temperature"], data["min_buffer_size"]) == ("roopa", 0.9, 0.4, 120)


class _Failing(TTSProvider):
    name = "failing"

    def __init__(self):
        self.tries = 0

    async def synthesize(self, text, pace=None):
        self.tries += 1
        raise TTSError("provider", "down")

    async def open_stream(self, pace=None):
        self.tries += 1
        raise TTSError("provider", "down")


@pytest.mark.asyncio
async def test_an_agent_call_keeps_the_fallback_voice_once_used():
    primary, fallback = _Failing(), FakeTTS()
    tts = FallbackTTS(primary, fallback, sticky=True)
    await tts.synthesize("one")
    await tts.open_stream()
    await tts.synthesize("three")
    assert primary.tries == 1  # never asked again: the voice doesn't switch back and forth
    assert [t for t, _ in fallback.synthesized] == ["one", "three"] and len(fallback.streams) == 1


@pytest.mark.asyncio
async def test_other_calls_still_try_the_primary_each_time():
    primary, fallback = _Failing(), FakeTTS()
    tts = FallbackTTS(primary, fallback)  # as built for every call before
    await tts.synthesize("one")
    await tts.synthesize("two")
    assert primary.tries == 2


@pytest.mark.parametrize("said,spoken", [
    ("Great!", "Great."), ("Really?!", "Really?"), ("Wow!!! That is nice!", "Wow. That is nice."),
    ("Okay... let me check", "Okay... let me check"), ("Is now a good time?", "Is now a good time?"),
    ("சூப்பர் sir!", "சூப்பர் sir."), ("बहुत बढ़िया!", "बहुत बढ़िया."), ("ಸರಿ!", "ಸರಿ."),
    ("Kagzso automates billing follow-ups.", "Kagzso automates billing follow-ups."),
])
def test_calm_spoken_text(said, spoken):
    assert calm_spoken_text(said) == spoken


# ------------------------------------------------------------------ mocked calls: consecutive replies
class _RecordingStream(FakeTTSStream):
    def __init__(self, owner: "RecordingSarvamTTS", pace):
        super().__init__(owner)  # type: ignore[arg-type]
        self.pace = pace
        self.flushes = 0

    async def set_pace(self, pace):
        RecordingSarvamTTS.log.append(("set_pace", self.owner.voice_id, pace))
        self.pace = pace

    async def flush(self):
        self.flushes += 1


class RecordingSarvamTTS(SarvamTTS):
    """A SarvamTTS that records exactly what it would send to Sarvam (speaker, model, pace, temperature, chunk
    size) and plays fake audio: no network, no cost."""
    log: List[tuple] = []
    streams: List[_RecordingStream] = []

    chunk = audio.pcm16_to_mulaw(b"\x10\x00" * 800)
    chunks_per_sentence = 2
    delay = 0.0

    def _settings(self, pace):
        return {**self._voice_settings(pace), "min_buffer": self.cfg.SARVAM_TTS_MIN_BUFFER_CHARS}

    async def synthesize(self, text, pace=None):
        RecordingSarvamTTS.log.append(("rest", text, self._settings(pace)))
        return self.chunk * 3

    async def open_stream(self, pace=None):
        RecordingSarvamTTS.log.append(("stream", None, self._settings(pace)))
        s = _RecordingStream(self, pace)
        RecordingSarvamTTS.streams.append(s)
        return s


@pytest.fixture
def recorder(fakes, monkeypatch):
    RecordingSarvamTTS.log, RecordingSarvamTTS.streams = [], []
    monkeypatch.setattr(fakes, "tts", RecordingSarvamTTS(_cfg(SARVAM_TTS_PACE=1.0, SARVAM_TTS_TEMPERATURE=0.6,
                                                              SARVAM_TTS_MIN_BUFFER_CHARS=30)))
    # Settings that would change the delivery of a normal call: an agent call must not be affected by them.
    monkeypatch.setattr(settings, "TTS_FIRST_CLAUSE", True)
    monkeypatch.setattr(settings, "GREETING_TTS_SPEED", 0.95)
    return RecordingSarvamTTS


# The first sentence of the first reply is long, with a comma (where TTS_FIRST_CLAUSE would cut a normal call's).
FIRST = "Our team helps hospitals and clinics, and it works alongside the software you use!"
REPLIES = [
    FIRST + " Would that help you?",
    "Sure, no problem! It works alongside the software you already use. Shall I explain how?",
    "Of course! Our team can share more details on WhatsApp. Is that okay?",
]


def _talk(client, auth, fakes, flow, said: List[str], replies=REPLIES, flow_id="agent_voice"):
    queue = list(replies)
    original = fakes.llm._stream

    async def stream(system_text, messages, model=None):
        if system_text != cs.OUTCOME_SYSTEM and queue:
            fakes.llm.reply = queue.pop(0)
        async for d in original(system_text, messages, model):
            yield d

    fakes.llm._stream = stream
    call_id, token = _dial(client, auth, flow, flow_id=flow_id)
    fakes.stt.replies = list(said)
    _converse(client, call_id, token, turns=len(said) - 1)
    return call_id


@pytest.mark.parametrize("lang", ["en", "ta", "hi"])
def test_consecutive_agent_replies_keep_one_voice_and_style(client, auth, fakes, monkeypatch, recorder, lang):
    flow = _flow(lang, monkeypatch)
    _talk(client, auth, fakes, flow, ["Hello?", "Yes", "Tell me more", "Will it replace our software?", "Okay"])
    log = recorder.log
    assert len([e for e in log if e[0] == "stream"]) >= 3  # three AI replies (and more lines) were spoken
    settings_used = {json.dumps(e[2], sort_keys=True) for e in log if e[0] in ("rest", "stream")}
    assert len(settings_used) == 1, settings_used  # every line: the same speaker, pace, temperature, chunk size
    used = json.loads(settings_used.pop())
    assert used["speaker"] == fakes.tts.voice_id and used["model"] == settings.SARVAM_TTS_MODEL
    assert (used["pace"], used["temperature"], used["min_buffer"]) == (0.9, 0.4, 120)
    assert not [e for e in log if e[0] == "set_pace"]  # no speed change anywhere (the greeting included)
    replies = [s for s in recorder.streams if s.texts]
    spoken = [t for s in replies for t in s.texts]
    assert spoken and not any("!" in t for t in spoken)  # calm full stops
    # Whole sentences: the first one is never cut at its comma, and it is flushed so first audio isn't later.
    assert FIRST.replace("!", ".") in spoken
    assert "Our team helps hospitals and clinics," not in spoken
    assert all(s.flushes >= 1 for s in replies if not any(t.startswith(("Hello", "வணக்கம்", "नमस्ते")) for t in s.texts))


def test_the_agents_own_speed_replaces_the_pace_and_nothing_else():
    assert agent_voice_settings(settings, 1.2) == {**agent_voice_settings(settings), "SARVAM_TTS_PACE": 1.2}
    assert agent_voice_settings(settings, 9.0)["SARVAM_TTS_PACE"] == 2.0  # still clamped to Sarvam's range
    base = SarvamTTS(_cfg(), voice_id="roopa")
    assert with_agent_voice(base, 1.1)._voice_settings() == {**with_agent_voice(base)._voice_settings(), "pace": 1.1}
    both = with_agent_voice(FallbackTTS(base, SarvamTTS(_cfg(), voice_id="roopa")), 0.8)
    assert both.primary._voice_settings()["pace"] == both.fallback._voice_settings()["pace"] == 0.8


def _used(recorder) -> set:
    return {(e[2]["pace"], e[2]["temperature"], e[2]["min_buffer"]) for e in recorder.log if e[0] in ("rest", "stream")}


@pytest.mark.parametrize("speed", [0.5, 0.8, 1.0, 1.2, 1.37, 2.0])  # the levels, a typed speed and Sarvam's limits
def test_every_line_of_a_call_follows_the_agents_speed(client, auth, fakes, monkeypatch, recorder, speed):
    flow = _flow("en", monkeypatch)
    flow["autonomous"]["voice_pace"] = speed
    _talk(client, auth, fakes, flow, ["Hello?", "Yes", "Tell me more", "Okay"], flow_id=f"agent_speed_{round(speed * 100)}")
    assert _used(recorder) == {(speed, 0.4, 120)}  # only the speed: the steady delivery stays
    assert not [e for e in recorder.log if e[0] == "set_pace"]  # never changed during the call


def test_an_agent_published_before_voice_speed_keeps_the_backends_pace(client, auth, fakes, monkeypatch, recorder):
    flow = _flow("en", monkeypatch)
    del flow["autonomous"]["voice_pace"]
    fakes.tts.cfg = fakes.tts.cfg.model_copy(update={"AGENT_TTS_PACE": 1.15})
    _talk(client, auth, fakes, flow, ["Hello?", "Yes", "Tell me more", "Okay"], flow_id="agent_older")
    assert _used(recorder) == {(1.15, 0.4, 120)}


def test_a_normal_call_is_unchanged(client, auth, fakes, monkeypatch, recorder):
    flow = _flow("en", monkeypatch)
    flow.pop("autonomous")  # the same flow without the agent setting: an ordinary executive call
    flow["greeting"] = {"text": "Hello, {{time_greeting}} {{title}}. This is Thaara."}  # a time-of-day opening
    _talk(client, auth, fakes, flow, ["Hello?", "Yes", "Tell me more", "Okay"], flow_id="plain_voice")
    log = recorder.log
    assert {(e[2]["pace"], e[2]["temperature"], e[2]["min_buffer"]) for e in log if e[0] == "stream"} == {(1.0, 0.6, 30)}
    assert ("set_pace", fakes.tts.voice_id, 0.95) in log or any(
        e[0] == "rest" and e[2]["pace"] == 0.95 for e in log)  # the greeting speed, as before
    spoken = [t for s in recorder.streams for t in s.texts]
    assert "Our team helps hospitals and clinics," in spoken  # TTS_FIRST_CLAUSE still cuts a normal call's first clause
    assert "and it works alongside the software you use!" in spoken  # and "!" is spoken as the AI wrote it
