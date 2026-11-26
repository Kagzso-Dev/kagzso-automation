"""A Sarvam STT request that gets 429 (rate limit) is retried once, after STT_RATE_LIMIT_RETRY_SECONDS (or Sarvam's
Retry-After when longer, at most STT_RATE_LIMIT_RETRY_MAX_SECONDS). The defaults keep today's 0.25 s; other failures
always wait 0.25 s. Still one retry: at most 2 requests per transcription."""
import httpx
import pytest
from pydantic import SecretStr

from app.core.config import Settings, settings
from app.services import sarvam_stt
from app.services.sarvam_stt import SarvamSTT, STTError

WAV = b"RIFF" + b"\0" * 400


def _stt(responses, monkeypatch, **update):
    sent, pauses = [], []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return responses[min(len(sent), len(responses)) - 1]

    async def no_sleep(seconds):
        pauses.append(seconds)

    monkeypatch.setattr(sarvam_stt.asyncio, "sleep", no_sleep)
    cfg = settings.model_copy(update={"SARVAM_API_KEY": SecretStr("test-key"), "SARVAM_STT_MODEL": "saaras:v3",
                                      "STT_FALLBACK_MODEL": "saaras:v3", **update})
    client = httpx.AsyncClient(base_url="https://sarvam.test", transport=httpx.MockTransport(handler))
    return SarvamSTT(cfg, client=client), sent, pauses


TAMIL = {"STT_RATE_LIMIT_RETRY_SECONDS": 0.8, "STT_RATE_LIMIT_RETRY_MAX_SECONDS": 1.5}  # the .env.ta lines


def test_the_defaults_keep_todays_pause():
    fresh = Settings(_env_file=None)
    assert fresh.STT_RATE_LIMIT_RETRY_SECONDS == 0.25 and fresh.STT_RATE_LIMIT_RETRY_MAX_SECONDS == 0.25


@pytest.mark.parametrize("headers", [{}, {"Retry-After": "1"}, {"Retry-After": "30"}, {"Retry-After": "0.1"}])
async def test_defaults_wait_025s_whatever_sarvam_says(monkeypatch, headers):
    stt, sent, pauses = _stt([httpx.Response(429, json={}, headers=headers),
                              httpx.Response(200, json={"transcript": "சொல்லுங்க"})], monkeypatch,
                             STT_RATE_LIMIT_RETRY_SECONDS=0.25, STT_RATE_LIMIT_RETRY_MAX_SECONDS=0.25)
    assert (await stt.transcribe(WAV))["text"] == "சொல்லுங்க"
    assert len(sent) == 2 and pauses == [0.25]


async def test_tamil_settings_wait_08s_then_retry_once(monkeypatch):
    stt, sent, pauses = _stt([httpx.Response(429, json={}), httpx.Response(200, json={"transcript": "சொல்லுங்க"})],
                             monkeypatch, **TAMIL)
    assert (await stt.transcribe(WAV))["text"] == "சொல்லுங்க"
    assert len(sent) == 2 and pauses == [0.8]


@pytest.mark.parametrize("retry_after,pause", [("1", 1.0), ("1.2", 1.2), ("30", 1.5), ("0.1", 0.8), ("soon", 0.8)])
async def test_tamil_settings_use_a_longer_retry_after_capped(monkeypatch, retry_after, pause):
    stt, _, pauses = _stt([httpx.Response(429, json={}, headers={"Retry-After": retry_after}),
                           httpx.Response(200, json={"transcript": "ok"})], monkeypatch, **TAMIL)
    await stt.transcribe(WAV)
    assert pauses == [pause]


async def test_still_rate_limited_after_the_retry_raises_after_two_requests(monkeypatch):
    stt, sent, pauses = _stt([httpx.Response(429, json={})], monkeypatch, **TAMIL)
    with pytest.raises(STTError) as err:
        await stt.transcribe(WAV)
    assert err.value.kind == "rate_limit"
    assert len(sent) == 2 and pauses == [0.8]  # one retry only; the backup model is the same model: no third request


@pytest.mark.parametrize("status", [500, 503])
async def test_other_failures_keep_the_short_pause(monkeypatch, status):
    stt, _, pauses = _stt([httpx.Response(status, json={}), httpx.Response(200, json={"transcript": "ok"})],
                          monkeypatch, **TAMIL)
    await stt.transcribe(WAV)
    assert pauses == [0.25]
