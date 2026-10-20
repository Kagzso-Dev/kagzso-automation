"""The offered voices (app/core/voices.py): only Roopa, Ritu, Simran and Ishita, Roopa by default.
Any other voice - an old flow, SARVAM_TTS_SPEAKER or the rotation list naming a voice that is
no longer offered - plays as Roopa. "Listen" previews only synthesize audio; nothing is dialled."""
import base64
import io
import json
import wave

import httpx

from app.core.config import settings
from app.core.voices import DEFAULT_VOICE, VOICE_IDS, voice_or_default
from app.services.sarvam_tts import SarvamTTS


def _wav(pcm: bytes, rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def test_only_four_voices_roopa_first_and_default():
    assert VOICE_IDS == ("roopa", "ritu", "simran", "ishita")
    assert DEFAULT_VOICE == "roopa"
    for gone in ("tanya", "shreya", "priya", "shruti", "", None):
        assert voice_or_default(gone) == "roopa"
    assert voice_or_default("Ishita") == "ishita"


def test_main_voice_and_rotation_keep_only_offered_voices(monkeypatch):
    monkeypatch.setattr(settings, "SARVAM_TTS_SPEAKER", "tanya")
    assert settings.tts_speaker == "roopa"
    monkeypatch.setattr(settings, "SARVAM_TTS_VOICE_ROTATION", "priya,ritu,simran,ishita,shreya,roopa,tanya,shruti")
    assert settings.voice_rotation == ["roopa", "ritu", "simran", "ishita"]
    monkeypatch.setattr(settings, "SARVAM_TTS_VOICE_ROTATION", "tanya,shreya")
    assert settings.voice_rotation == []  # nothing offered left: every call uses the main voice


def test_a_flow_or_call_naming_a_removed_voice_speaks_as_roopa(monkeypatch):
    monkeypatch.setattr(settings, "SARVAM_TTS_SPEAKER", "roopa")
    assert SarvamTTS(settings, voice_id="tanya").voice_id == "roopa"
    assert SarvamTTS(settings, voice_id="shreya").voice_id == "roopa"
    assert SarvamTTS(settings, voice_id="simran").voice_id == "simran"


def test_catalog_lists_the_four_voices(client, auth):
    r = client.get("/api/flows/builtin", headers=auth)
    assert r.status_code == 200
    body = r.json()
    assert [v["id"] for v in body["voices"]] == ["roopa", "ritu", "simran", "ishita"]
    assert [v["name"] for v in body["voices"]] == ["Roopa", "Ritu", "Simran", "Ishita"]
    assert body["default_voice"] == "roopa"


def test_preview_returns_wav_for_the_chosen_voice_and_places_no_call(client, auth, fakes, monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"audios": [base64.b64encode(_wav(b"\x01\x00" * 2205, 22050)).decode()]})

    monkeypatch.setattr(settings, "SARVAM_API_KEY", type(settings.SARVAM_API_KEY)("sarvam-test-key"))
    fakes.tts = SarvamTTS(settings, client=httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler)))

    r = client.post("/api/voices/preview", json={"voice_id": "ritu", "text": "Hi, is this Ragul?"}, headers=auth)
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(r.content)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 22050, 2205)
    assert seen[0]["speaker"] == "ritu" and seen[0]["text"] == "Hi, is this Ragul?"
    assert seen[0]["speech_sample_rate"] == 22050
    assert fakes.plivo.calls == [] if hasattr(fakes.plivo, "calls") else True


def test_preview_refuses_removed_voices_bad_text_and_missing_key(client, auth):
    assert client.post("/api/voices/preview", json={"voice_id": "tanya", "text": "Hi"}, headers=auth).status_code == 422
    assert client.post("/api/voices/preview", json={"voice_id": "roopa", "text": "x" * 201}, headers=auth).status_code == 422
    assert client.post("/api/voices/preview", json={"voice_id": "roopa", "text": "   "}, headers=auth).status_code == 422
    assert client.post("/api/voices/preview", json={"voice_id": "roopa", "text": "Hi"}).status_code in (401, 403)


def test_preview_puts_real_silence_where_the_pause_markers_are(client, auth, fakes, monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["text"])
        return httpx.Response(200, json={"audios": [base64.b64encode(_wav(b"\x01\x00" * 2205, 22050)).decode()]})

    monkeypatch.setattr(settings, "SARVAM_API_KEY", type(settings.SARVAM_API_KEY)("sarvam-test-key"))
    fakes.tts = SarvamTTS(settings, client=httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler)))

    body = {"voice_id": "roopa", "text": "Hi sir, {{short_delay}} Good afternoon.",
            "pauses": {"short_ms": 500, "medium_ms": 700, "long_ms": 1200}}
    r = client.post("/api/voices/preview", json=body, headers=auth)
    assert r.status_code == 200
    with wave.open(io.BytesIO(r.content)) as w:
        frames = w.readframes(w.getnframes())
    assert len(frames) // 2 == 2205 * 2 + 22050 * 500 // 1000  # two parts + 500 ms of silence
    assert frames[2205 * 2:(2205 + 11025) * 2] == b"\x00\x00" * 11025
    assert sorted(seen) == ["Good afternoon.", "Hi sir,"]  # the marker never reaches TTS
    assert client.post("/api/voices/preview", json={**body, "pauses": {"short_ms": 4000}}, headers=auth).status_code == 422
