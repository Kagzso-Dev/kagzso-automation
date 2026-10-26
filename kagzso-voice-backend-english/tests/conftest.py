"""Test configuration: SQLite instead of MySQL and in-process fake providers.
Environment is set BEFORE the app is imported; the real .env is never read."""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from typing import AsyncIterator, List

_TMP = Path(tempfile.mkdtemp(prefix="kagzso_test_"))
_DB = _TMP / "test.db"

os.environ.update({
    "KAGZSO_ENV_FILE": str(_TMP / "no-such.env"),
    "APP_ENV": "test",
    "DATABASE_URL": f"sqlite+aiosqlite:///{_DB.as_posix()}",
    "ADMIN_API_KEY": "test-admin-key-1234567890",
    "APP_SECRET_KEY": "test-secret-key-0123456789abcdef0123456789",
    "PUBLIC_BASE_URL": "https://test.example.com",
    "PUBLIC_URL_CHECK": "false",  # no real request to test.example.com; tests/test_public_url.py turns it on
    "NO_PROVIDER_CALLBACK_SECONDS": "0",  # no timers left behind; tests/test_public_url.py turns it on
    "PLIVO_AUTH_ID": "MATESTAUTHID000000",
    "PLIVO_AUTH_TOKEN": "plivo-test-token-abcdef",
    "PLIVO_FROM_NUMBER": "+918035000000",
    "PLIVO_VALIDATE_SIGNATURE": "false",
    "TWILIO_ACCOUNT_SID": "AC" + "0" * 32,
    "TWILIO_AUTH_TOKEN": "twilio-test-token-abcdef",
    "TWILIO_FROM_NUMBER": "+15005550006",
    "TWILIO_VALIDATE_SIGNATURE": "false",
    "TELEPHONY_PROVIDER": "plivo",
    "SARVAM_API_KEY": "sarvam-test-key",
    "LLM_PROVIDER": "gemini",
    "LLM_API_KEY": "llm-test-key",
    "LLM_MODEL": "test-model",
    "GREETING_DELAY_MS": "60000",
    "GREETING_PRERENDER": "false",
    "PRERENDER_FIXED_LINES": "false",
    "VAD_MIN_RMS": "0",
    "LOG_LEVEL": "INFO",
})

import pytest  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import reset_rate_limits  # noqa: E402
from app.db import models  # noqa: E402,F401
from app.db.database import Base  # noqa: E402
from app.services import audio_service as audio  # noqa: E402
from app.services import call_service  # noqa: E402
from app.services.tts import TTSProvider, TTSStream  # noqa: E402
from app.services.llm_service import LLMProvider, OUTCOME_SYSTEM  # noqa: E402
from app.services.plivo_service import OutboundCallResult, PlivoError, PlivoService  # noqa: E402
from app.services.twilio_service import TwilioService  # noqa: E402
from app.services.sarvam_stt import STTProvider, STTResult  # noqa: E402
from app.services.session_store import SessionStore, set_session_store  # noqa: E402
from app.services import llm_service  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

REAL_WEBRTC_CLASSIFIER = audio.make_webrtc_classifier  # tests patch the module attribute


# ----------------------------------------------------------------- fakes
class FakeSTT(STTProvider):
    name = "fake"

    def __init__(self):
        self.replies: List[str] = ["Hello?"]
        self.calls = 0

    async def transcribe(self, audio_data, filename="audio.wav", content_type="audio/wav") -> STTResult:
        assert audio_data[:4] == b"RIFF", "STT must receive WAV"
        self.calls += 1
        text = self.replies[min(self.calls - 1, len(self.replies) - 1)]
        return STTResult(text=text, language="en-IN", confidence=0.9)


class FakeLLM(LLMProvider):
    name = "fake"

    def __init__(self):
        super().__init__(settings)
        self.reply = "Hi Arun, this is Priya from Kagzso. Is now a good time for a quick introduction?"
        self.outcome_json = '{"outcome": "interested", "summary": "Customer is interested."}'
        self.seen_messages = []

    async def _stream(self, system_text, messages, model=None) -> AsyncIterator[str]:
        if system_text == OUTCOME_SYSTEM:
            yield self.outcome_json
            return
        self.seen_messages.append(messages)
        for word in self.reply.split(" "):
            yield word + " "


class FakeTTSStream(TTSStream):
    def __init__(self, owner: "FakeTTS"):
        self.owner = owner
        self.queue: asyncio.Queue = asyncio.Queue()
        self.texts: List[str] = []
        self.cancelled = False
        self.pace = None  # None = the configured speed

    async def set_pace(self, pace):
        self.pace = pace

    async def send_text(self, text):
        self.texts.append(text)
        for _ in range(self.owner.chunks_per_sentence):
            await self.queue.put(self.owner.chunk)

    async def end_input(self):
        await self.queue.put(None)

    async def audio(self):
        while True:
            item = await self.queue.get()
            if item is None:
                return
            if self.owner.delay:
                await asyncio.sleep(self.owner.delay)
            yield item

    async def cancel(self):
        self.cancelled = True

    async def aclose(self):
        pass


class FakeTTS(TTSProvider):
    name = "fake"

    def __init__(self):
        self.chunk = audio.pcm16_to_mulaw(b"\x10\x00" * 800)  # 100 ms
        self.chunks_per_sentence = 2
        self.delay = 0.0
        self.streams: List[FakeTTSStream] = []
        self.synthesized: List[tuple] = []  # (text, pace)

    async def synthesize(self, text, pace=None):
        self.synthesized.append((text, pace))
        return self.chunk * 3

    async def open_stream(self, pace=None):
        s = FakeTTSStream(self)
        s.pace = pace
        self.streams.append(s)
        return s


class FakePlivo(PlivoService):
    def __init__(self):
        super().__init__(settings)
        self.fail_with = None
        self.hangups: List[str] = []
        self.placed: List[str] = []
        self.time_limits: list = []

    async def make_outbound_call(self, call_id, to_number, time_limit=None):
        self.time_limits.append(time_limit)
        if self.fail_with:
            raise PlivoError(self.fail_with, "simulated failure")
        self.placed.append(to_number)
        return OutboundCallResult(request_uuid=f"req-{call_id[:8]}", message="call fired")

    async def hangup(self, call_uuid):
        self.hangups.append(call_uuid)
        return True

    async def verify_credentials(self):
        return {"account_type": "standard"}


class FakeTwilio(TwilioService):
    def __init__(self):
        super().__init__(settings)
        self.fail_with = None
        self.hangups: List[str] = []
        self.placed: List[str] = []
        self.time_limits: list = []

    async def make_outbound_call(self, call_id, to_number, time_limit=None):
        self.time_limits.append(time_limit)
        if self.fail_with:
            raise PlivoError(self.fail_with, "simulated failure")
        self.placed.append(to_number)
        return OutboundCallResult(request_uuid="CA" + call_id[:32].ljust(32, "0"), message="queued")

    async def hangup(self, call_sid):
        self.hangups.append(call_sid)
        return True

    async def verify_credentials(self):
        return {"account_type": "Trial", "account_status": "active"}


def energy_classifier(frame: bytes) -> bool:
    return audio.rms(frame) > 1000


def tone_mulaw(ms: int, amplitude: int = 8000) -> bytes:
    import math

    n = 8 * ms
    pcm = b"".join(int(amplitude * math.sin(2 * math.pi * 440 * i / 8000)).to_bytes(2, "little", signed=True) for i in range(n))
    return audio.pcm16_to_mulaw(pcm)


def silence_mulaw(ms: int) -> bytes:
    return audio.pcm16_to_mulaw(b"\x00\x00" * 8 * ms)


# ----------------------------------------------------------------- fixtures
@pytest.fixture(autouse=True)
def fresh_db():
    eng = create_engine(f"sqlite:///{_DB.as_posix()}")
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    eng.dispose()
    yield


@pytest.fixture
def sync_engine():
    eng = create_engine(f"sqlite:///{_DB.as_posix()}")
    yield eng
    eng.dispose()


REAL_TIME_GREETING = llm_service.time_greeting_for
GREETING_CLOCK = datetime(2026, 1, 5, 3, 30, tzinfo=timezone.utc)  # 09:00 IST -> "Good morning"


@pytest.fixture(autouse=True)
def fixed_greeting_clock(monkeypatch):
    """{{time_greeting}} uses the current time; pin it so greetings in tests don't depend on
    when they run. Tests that pass `now` explicitly get the real calculation."""
    monkeypatch.setattr(llm_service, "time_greeting_for",
                        lambda now=None, tz_name=None: REAL_TIME_GREETING(now or GREETING_CLOCK, tz_name))


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    reset_rate_limits()
    set_session_store(SessionStore())
    providers = call_service.Providers(stt=FakeSTT(), llm=FakeLLM(), tts=FakeTTS(), plivo=FakePlivo(), twilio=FakeTwilio())
    call_service.set_providers(providers)
    monkeypatch.setattr(audio, "make_webrtc_classifier", lambda *a, **k: energy_classifier)
    yield providers
    call_service.set_providers(None)
    set_session_store(None)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:  # lifespan disposes the engine on exit
        yield c


@pytest.fixture
def auth():
    return {"X-API-Key": "test-admin-key-1234567890"}
