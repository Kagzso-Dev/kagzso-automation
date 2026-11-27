"""Bulbul v4 Flash Tamil voices (SARVAM_TTS_V4_VOICES, 2026-11-27).

The Tamil backend offers Sarvam's four Tamil v4 personas (aravind_ta_ads, aravind_ta_suspense, gokul_ta_narration,
vijay_ta_narration) besides its existing voices. The model goes with the voice: a persona is always sent with
bulbul:v4-flash and its exact id, and every other voice (the v3 stock voices such as the female ishita / ritu, and
cloned voices) is sent exactly as before. Sarvam states no gender for the personas, so they have one only from a tag.
A persona that fails falls back to a stock v3 voice for the rest of the call. Other languages offer none, and their
lists are unchanged. No real request is made: Sarvam is a mock transport / a local socket."""
import base64
import io
import json
import logging
import wave

import httpx
import pytest

from app.core import voices
from app.core.config import settings
from app.services import provider_registry
from app.services.call_service import Providers
from app.services.sarvam_tts import SarvamTTS
from tests.test_cloned_voice import TA_M1, _cfg as _clone_cfg

PERSONAS = ["aravind_ta_ads", "aravind_ta_suspense", "gokul_ta_narration", "vijay_ta_narration"]
V4 = "bulbul:v4-flash"


def _cfg(language="ta", **extra):
    return settings.model_copy(update={"CALL_LANGUAGE": language, "SARVAM_TTS_MODEL": "bulbul:v3", **extra})


def _wav(rate=8000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x10\x00" * 80)
    return buf.getvalue()


def _sarvam(bodies, refuse_v4=False):
    def handler(request: httpx.Request):
        bodies.append(json.loads(request.content))
        if refuse_v4 and bodies[-1]["model"] == V4:
            status = 400
            return httpx.Response(status, json={"error": {"message": "speaker not supported for this model"}})
        return httpx.Response(200, json={"request_id": "r", "audios": [base64.b64encode(_wav()).decode()]})
    return httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler))


def _offer(monkeypatch, env="vijay_ta_narration:male,gokul_ta_narration:male,aravind_ta_ads,aravind_ta_suspense"):
    """This backend as the Tamil one with SARVAM_TTS_V4_VOICES = env (tests run as the English backend)."""
    entries = voices.v4_voice_entries(env, "ta", voices.STOCK_VOICE_IDS)
    monkeypatch.setattr(voices, "V4_VOICES", entries)
    monkeypatch.setattr(voices, "V4_VOICE_IDS", frozenset(str(e["id"]) for e in entries))
    monkeypatch.setattr(voices, "VOICES", voices.VOICES + entries)
    monkeypatch.setattr(voices, "VOICE_IDS", voices.VOICE_IDS + tuple(str(e["id"]) for e in entries))
    return entries


# ------------------------------------------------------------------ the offered list
def test_the_tamil_backend_offers_the_four_verified_personas_with_no_guessed_gender():
    entries = voices.v4_voice_entries("auto", "ta")
    assert [e["id"] for e in entries] == PERSONAS
    assert all(e["model"] == V4 and "gender" not in e and e["language"] == "Tamil (India)" for e in entries)
    assert [e["name"] for e in entries] == ["Aravind (Ads)", "Aravind (Suspense)", "Gokul (Narration)", "Vijay (Narration)"]
    assert next(e for e in entries if e["id"] == "vijay_ta_narration")["style"] == "narration"


@pytest.mark.parametrize("language", ["en", "hi", "kn"])
def test_other_languages_offer_no_v4_voice_and_their_lists_are_unchanged(language):
    assert voices.v4_voice_entries("auto", language) == []
    stock, default = voices.offered_voices("", "roopa", language)
    assert all("model" not in v for v in stock) and default == "roopa"


def test_this_english_test_backend_lists_exactly_what_it_did():
    assert voices.V4_VOICES == [] and voices.V4_VOICE_IDS == frozenset()
    assert all("model" not in v and "style" not in v for v in voices.VOICES)


def test_gender_only_from_a_tag_off_switch_and_bad_ids():
    tagged = voices.v4_voice_entries("vijay_ta_narration:male, gokul_ta_narration:MALE ,aravind_ta_ads", "ta")
    assert [(e["id"], e.get("gender")) for e in tagged] == [
        ("vijay_ta_narration", "male"), ("gokul_ta_narration", "male"), ("aravind_ta_ads", None)]
    for off in ("", "off", "OFF", "none"):
        assert voices.v4_voice_entries(off, "ta") == []
    # v3 names, junk and duplicates are never offered as v4 voices; an id already offered is skipped
    out = voices.v4_voice_entries("ishita,roopa:female,bad id,vijay_ta_narration,vijay_ta_narration", "ta", ("ishita",))
    assert [e["id"] for e in out] == ["vijay_ta_narration"]


# ------------------------------------------------------------------ what is sent to Sarvam
@pytest.mark.parametrize("persona", PERSONAS)
async def test_each_persona_sends_bulbul_v4_flash_and_its_exact_id(monkeypatch, persona):
    _offer(monkeypatch)
    bodies = []
    tts = SarvamTTS(_cfg(), voice_id=persona, client=_sarvam(bodies))
    assert tts.voice_id == persona and tts.model == V4 and tts.v4_persona
    assert await tts.synthesize("வணக்கம் சார்.")
    assert bodies[0]["model"] == V4 and bodies[0]["speaker"] == persona and bodies[0]["language_code"] == "ta-IN"
    assert bodies[0]["speech_sample_rate"] == 8000  # telephony audio, as before
    # the "Listen" preview too
    bodies.clear()
    assert (await tts.synthesize_preview("வணக்கம்"))[:4] == b"RIFF"
    assert bodies[0]["model"] == V4 and bodies[0]["speaker"] == persona


@pytest.mark.parametrize("female", ["ishita", "ritu"])
async def test_v3_female_tamil_voices_still_send_bulbul_v3_with_ta_in(monkeypatch, female):
    _offer(monkeypatch)
    bodies = []
    tts = SarvamTTS(_cfg(SARVAM_TTS_VOICES="ishita:female,ritu:female"), voice_id=female, client=_sarvam(bodies),
                    exact_voice=True)
    await tts.synthesize("வணக்கம் சார்.")
    assert (bodies[0]["model"], bodies[0]["speaker"], bodies[0]["language_code"]) == ("bulbul:v3", female, "ta-IN")
    assert not tts.v4_persona


async def test_a_persona_not_offered_never_reaches_sarvam_as_a_v4_request(monkeypatch):
    bodies = []  # not in SARVAM_TTS_V4_VOICES: plays as the default voice on SARVAM_TTS_MODEL, never a v3 + persona 400
    tts = SarvamTTS(_cfg(), voice_id="vijay_ta_narration", client=_sarvam(bodies))
    await tts.synthesize("Hello.")
    assert bodies[0]["model"] == "bulbul:v3" and bodies[0]["speaker"] != "vijay_ta_narration"


async def test_cloned_voices_are_unchanged(monkeypatch):
    _offer(monkeypatch)
    tts = SarvamTTS(_clone_cfg("ta"), voice_id=TA_M1, exact_voice=True)
    assert tts.cloned and not tts.v4_persona and "model" not in tts._voice_settings()


async def test_the_live_stream_opens_the_v4_socket_for_a_persona_and_v3_for_the_rest(monkeypatch):
    from websockets.asyncio.server import serve

    _offer(monkeypatch)
    paths, configs = [], []
    pcm = b"\x10\x20" * 200

    async def handler(ws):
        paths.append(ws.request.path)
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "config":
                configs.append(msg["data"])
            if msg["type"] == "text":
                await ws.send(json.dumps({"type": "audio", "data": {"audio": base64.b64encode(pcm).decode()}}))
            if msg["type"] == "flush":
                await ws.send(json.dumps({"type": "event", "data": {"event_type": "final"}}))

    async with serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        cfg = _cfg(SARVAM_TTS_WS_URL=f"ws://127.0.0.1:{port}/text-to-speech/ws")
        for voice in ("vijay_ta_narration", "ishita"):
            stream = await SarvamTTS(cfg, voice_id=voice, exact_voice=True).open_stream(pace=0.9)
            await stream.send_text("எங்க shop-ல billing software இருக்கு")
            await stream.end_input()
            chunks = [c async for c in stream.audio()]
            await stream.aclose()
            assert chunks and all(chunks)  # mu-law audio for the phone line
    assert "model=bulbul%3Av4-flash" in paths[0] and "model=bulbul%3Av3" in paths[1]
    assert configs[0]["speaker"] == "vijay_ta_narration" and configs[0]["language_code"] == "ta-IN"
    assert str(configs[0]["speech_sample_rate"]) == "8000" and configs[1]["speaker"] == "ishita"


# ------------------------------------------------------------------ an AI Agent's call, and the fallback
async def test_an_agent_call_with_a_v4_voice_keeps_it_and_falls_back_to_a_v3_voice_of_its_gender(monkeypatch, caplog):
    _offer(monkeypatch)
    bodies = []
    base = SarvamTTS(_cfg(), client=_sarvam(bodies, refuse_v4=True))
    providers = Providers(stt=None, llm=None, tts=base, plivo=None)
    tts = provider_registry.with_clone_fallback(
        provider_registry.with_agent_voice(providers.tts_for_agent_voice("vijay_ta_narration"), 0.9))
    assert isinstance(tts, provider_registry.V4VoiceFallback)
    assert (tts.primary.voice_id, tts.primary.model) == ("vijay_ta_narration", V4)
    assert (tts.fallback.voice_id, tts.fallback.model) == ("ratan", "bulbul:v3")  # tagged male: the male stock voice
    with caplog.at_level(logging.WARNING):
        await tts.synthesize("வணக்கம் சார்.")  # Sarvam refuses the persona (400): said in ratan, and stays on it
        await tts.synthesize("சரி சார்.")
    assert [(b["model"], b["speaker"]) for b in bodies] == [(V4, "vijay_ta_narration"), ("bulbul:v3", "ratan"),
                                                            ("bulbul:v3", "ratan")]
    assert "V4 VOICE FALLBACK" in caplog.text and "the stock voice ratan" in caplog.text


def test_an_untagged_persona_falls_back_to_the_default_stock_voice_with_a_warning(monkeypatch, caplog):
    _offer(monkeypatch)
    with caplog.at_level(logging.WARNING):
        tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg(), voice_id="aravind_ta_ads"))
    assert tts.fallback.voice_id == _cfg().stock_speaker and "has no gender" in caplog.text
    assert provider_registry.with_clone_fallback(tts) is tts  # never wrapped twice


def test_stock_and_cloned_voices_keep_their_fallbacks(monkeypatch):
    _offer(monkeypatch)
    stock = SarvamTTS(_cfg(), voice_id="ishita", exact_voice=True)
    assert provider_registry.with_clone_fallback(stock) is stock
    clone = provider_registry.with_clone_fallback(SarvamTTS(_clone_cfg("ta"), voice_id=TA_M1, exact_voice=True))
    assert type(clone) is provider_registry.ClonedVoiceFallback and clone.fallback.voice_id == "ratan"


def test_the_call_trace_names_the_voice_s_own_model(monkeypatch):
    _offer(monkeypatch)
    tts = provider_registry.with_clone_fallback(SarvamTTS(_cfg(), voice_id="gokul_ta_narration"))
    view = provider_registry._tts_view(tts)
    assert view["primary"]["model"] == V4 and view["primary"]["voice"] == "gokul_ta_narration"
    assert view["fallback"]["model"] == "bulbul:v3"


# ------------------------------------------------------------------ the catalog and "Listen"
def test_the_catalog_lists_the_personas_after_the_existing_voices(client, auth, monkeypatch):
    _offer(monkeypatch)
    from app.api import flows as flows_api

    monkeypatch.setattr(flows_api, "VOICES", voices.VOICES)  # the catalog's list, as the Tamil backend has it
    listed = client.get("/api/flows/builtin", headers=auth).json()["voices"]
    assert [v["id"] for v in listed][-4:] == ["vijay_ta_narration", "gokul_ta_narration", "aravind_ta_ads",
                                             "aravind_ta_suspense"]
    vijay = listed[-4]
    assert vijay["model"] == V4 and vijay["gender"] == "male" and vijay["name"] == "Vijay (Narration)"
    assert [v["id"] for v in listed][:-4] == [str(v["id"]) for v in voices.VOICES[:-4]]  # the rest as before


async def test_listen_on_a_refused_persona_fails_with_a_clear_error(client, auth, monkeypatch):
    _offer(monkeypatch)
    from app.api import voices as voices_api

    class Refusing:
        async def synthesize_preview(self, text):
            from app.services.tts import TTSError
            raise TTSError("invalid_request", "Sarvam TTS rejected the request (400): speaker", 400)

    monkeypatch.setattr(settings, "SARVAM_API_KEY", type(settings.SARVAM_API_KEY)("k"))
    monkeypatch.setattr(voices_api, "get_providers", lambda: type("P", (), {"tts_for_voice": lambda self, v: Refusing()})())
    r = client.post("/api/voices/preview", headers=auth, json={"voice_id": "vijay_ta_narration", "text": "வணக்கம்"})
    assert r.status_code == 502 and "rejected the request" in r.json()["detail"]
    r = client.post("/api/voices/preview", headers=auth, json={"voice_id": "nobody_ta_narration", "text": "வணக்கம்"})
    assert r.status_code == 422  # never offered: refused before anything is sent
