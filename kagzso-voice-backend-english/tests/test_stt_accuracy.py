"""Speech-to-text accuracy options (Sarvam only, all off by default):
STT_NORMALIZE_AUDIO (a level-normalised copy for STT only), STT_KEYTERMS (saaras:v4), and
STT_FALLBACK_MODEL (one more try with another Sarvam model). Fakes / mocked HTTP only."""
import io
import json
import logging
import math
import time
import wave

import httpx
import numpy as np
import pytest
from sqlalchemy import text

from app.core.config import Settings, settings
from app.services import audio_service as audio
from app.services.sarvam_stt import SarvamSTT, STTError
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until


def _sine(ms, amplitude, freq=440):
    n = 8 * ms
    return np.array([amplitude * math.sin(2 * math.pi * freq * i / 8000) for i in range(n)], dtype="<i2").tobytes()


def _rms(pcm):
    x = np.frombuffer(pcm, dtype="<i2").astype(np.float64)
    return float(np.sqrt(np.mean(x ** 2))) if x.size else 0.0


def _peak(pcm):
    return int(np.max(np.abs(np.frombuffer(pcm, dtype="<i2").astype(np.int32))))


# ------------------------------------------------------------------ normalisation (STT copy only)
def test_normalization_lifts_a_quiet_voice_by_at_most_the_max_gain():
    quiet = _sine(500, 300)  # a soft speaker
    out = audio.normalize_for_stt(quiet, target_rms=3000, max_gain_db=12)
    gain = _rms(out) / _rms(quiet)
    assert 3.5 < gain <= 10 ** (12 / 20) + 0.01  # lifted, capped at +12 dB
    medium = _sine(500, 1500)
    assert abs(_rms(audio.normalize_for_stt(medium, 3000, 12)) - 3000) < 150  # reaches the target


def test_normalization_never_clips_or_quietens_a_loud_voice():
    loud = _sine(500, 30000)
    assert audio.normalize_for_stt(loud, 3000, 12) == loud  # already loud: unchanged
    # Peaky audio (quiet level, sharp peaks) is lifted but the limiter keeps every sample below full scale.
    rng = np.random.default_rng(1)
    x = rng.normal(0, 700, 8000)
    x[::160] = 12000
    peaky = np.clip(x, -32768, 32767).astype("<i2").tobytes()
    out = audio.normalize_for_stt(peaky, 3000, 12)
    assert _rms(out) > _rms(peaky) * 1.5 and _peak(out) < 0.98 * 32767 + 1
    assert audio.normalize_for_stt(b"", 3000, 12) == b"" and audio.normalize_for_stt(b"\x00\x00" * 4000, 3000, 12) == b"\x00\x00" * 4000


def _wav_pcm(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        return w.readframes(w.getnframes())


@pytest.mark.parametrize("on", [False, True])
def test_stt_gets_the_louder_copy_while_the_live_and_recorded_audio_stay_original(client, auth, fakes, sync_engine,
                                                                                    monkeypatch, tmp_path, on):
    monkeypatch.setattr(settings, "STT_NORMALIZE_AUDIO", on)
    monkeypatch.setattr(settings, "CALL_RECORDING_ENABLED", True)
    monkeypatch.setattr(settings, "RECORDINGS_DIR", str(tmp_path / "rec"))
    heard = []
    real = fakes.stt.transcribe

    async def spy(audio_data, *a, **k):
        heard.append(audio_data)
        return await real(audio_data, *a, **k)

    monkeypatch.setattr(fakes.stt, "transcribe", spy)
    fakes.stt.replies = ["Hello?"]
    call_id, token = _call(client, auth)
    sent = tone_mulaw(400, amplitude=1600)  # a soft voice (the test VAD needs RMS > 1000)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, sent + silence_mulaw(900))
        _until(ws, "checkpoint")
        _send(ws, silence_mulaw(300))
    stt_level = _rms(_wav_pcm(heard[0]))
    original_level = _rms(audio.resample_pcm16(audio.mulaw_to_pcm16(sent), 8000, 16000))
    if on:
        assert stt_level > original_level * 1.5  # STT heard the lifted copy
    else:
        assert stt_level < original_level * 1.05  # exactly today's audio
    # The recording (= what the line carried) keeps the customer's original level either way.
    end = time.time() + 5
    row = None
    while time.time() < end and row is None:
        with sync_engine.connect() as c:
            row = c.execute(text("select storage_key from call_recordings where call_id = :id and status = 'completed'"),
                            {"id": call_id}).scalar()
        time.sleep(0.05)
    with wave.open(str(tmp_path / "rec" / row)) as w:
        left = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")[0::2]
    assert abs(_rms(left[: 400 * 8].tobytes()) - _rms(audio.mulaw_to_pcm16(sent))) < 20


@pytest.mark.parametrize("on", [False, True])
@pytest.mark.parametrize("word", ["Yes", "No"])
def test_short_answers_survive(client, auth, fakes, sync_engine, monkeypatch, on, word):
    monkeypatch.setattr(settings, "STT_NORMALIZE_AUDIO", on)
    fakes.stt.replies = ["Hello?", word]
    call_id, token = _call(client, auth)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # the greeting
        time.sleep(0.2)
        _send(ws, tone_mulaw(260, amplitude=1600) + silence_mulaw(900))  # a short, soft "yes" / "no"
        _until(ws, "checkpoint")
    time.sleep(0.3)
    with sync_engine.connect() as c:
        said = c.execute(text("select text from transcripts where call_id = :id and speaker = 'customer' order by id"),
                         {"id": call_id}).scalars().all()
    assert word in said


# ------------------------------------------------------------------ Sarvam request: keyterms and fallback model
def _stt(handler, **cfg):
    base = {"SARVAM_API_KEY": "sk-test-key-123456", "STT_TIMING_LOG": True}
    s = Settings(**{**base, **cfg})
    return SarvamSTT(s, client=httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler)))


def _form(request):
    body = request.content.decode("latin-1")
    fields = {}
    for part in body.split("--")[1:]:
        if 'name="' in part and "filename=" not in part:
            name = part.split('name="', 1)[1].split('"', 1)[0]
            fields[name] = part.split("\r\n\r\n", 1)[1].rsplit("\r\n", 1)[0]
    return fields


WAV = audio.telephony_pcm_to_stt_wav(_sine(300, 2000))


@pytest.mark.asyncio
async def test_keyterms_go_with_saaras_v4_only():
    seen = []

    def handler(request):
        seen.append(_form(request))
        return httpx.Response(200, json={"transcript": "What does Kexo do?", "language_code": "en-IN"})

    terms = "Kexo,Kagzso,UiPath,automation,WhatsApp"
    v4 = _stt(handler, SARVAM_STT_MODEL="saaras:v4", STT_KEYTERMS=terms)
    assert (await v4.transcribe(WAV))["text"] == "What does Kexo do?"
    assert seen[0]["model"] == "saaras:v4" and json.loads(seen[0]["keyterms"]) == terms.split(",")
    assert "mode" not in seen[0]
    v3 = _stt(handler, SARVAM_STT_MODEL="saaras:v3", STT_KEYTERMS=terms, SARVAM_STT_MODE="transcribe")
    await v3.transcribe(WAV)
    assert "keyterms" not in seen[1] and seen[1]["mode"] == "transcribe"  # today's request, unchanged
    off = _stt(handler, SARVAM_STT_MODEL="saaras:v4", STT_KEYTERMS="")
    await off.transcribe(WAV)
    assert "keyterms" not in seen[2]


@pytest.mark.asyncio
async def test_the_fallback_model_answers_when_the_main_model_fails(caplog):
    caplog.set_level(logging.INFO)
    models = []

    def handler(request):
        model = _form(request)["model"]
        models.append(model)
        if model == "saaras:v4":
            return httpx.Response(503, json={"error": {"message": "down"}})
        return httpx.Response(200, json={"transcript": "yes", "language_code": "en-IN"})

    stt = _stt(handler, SARVAM_STT_MODEL="saaras:v4", STT_FALLBACK_MODEL="saaras:v3")
    assert (await stt.transcribe(WAV))["text"] == "yes"
    assert models == ["saaras:v4", "saaras:v4", "saaras:v3"]  # its own retry, then the fallback once
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "saaras:v3" in logged and "(fallback model)" in logged
    assert "sk-test-key-123456" not in logged  # never the key


@pytest.mark.asyncio
async def test_no_fallback_for_auth_errors_or_when_it_is_the_same_model():
    calls = []

    def handler(request):
        calls.append(_form(request)["model"])
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    with pytest.raises(STTError) as exc:
        await _stt(handler, SARVAM_STT_MODEL="saaras:v4", STT_FALLBACK_MODEL="saaras:v3").transcribe(WAV)
    assert exc.value.kind == "auth" and calls == ["saaras:v4"]

    def down(request):
        calls.append(_form(request)["model"])
        return httpx.Response(503)

    calls.clear()
    with pytest.raises(STTError):
        await _stt(down, SARVAM_STT_MODEL="saaras:v3", STT_FALLBACK_MODEL="saaras:v3").transcribe(WAV)
    assert calls == ["saaras:v3", "saaras:v3"]  # exactly today's behaviour (one retry)


def test_keyterms_are_cleaned_up_and_capped():
    s = Settings(STT_KEYTERMS=" Kexo, kexo ,," + ",".join(f"t{i}" for i in range(60)) + ",x" * 1)
    assert s.stt_keyterms[0] == "Kexo" and len(s.stt_keyterms) == 50
    assert Settings(STT_KEYTERMS="a" * 100).stt_keyterms == ["a" * 64]
    assert Settings().stt_keyterms == []
