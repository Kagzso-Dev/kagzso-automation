import asyncio
import base64
import json

import httpx
import pytest

from app.core.config import settings
from app.core.security import sign_stream_token, verify_stream_token
from app.services import audio_service as audio
from app.services.tts import TTSError
from app.services.plivo_service import PlivoService
from app.services.sarvam_stt import SarvamSTT, STTError


# ------------------------------------------------------------ Sarvam
def _sarvam(handler):
    return SarvamSTT(settings, client=httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler)))


async def test_sarvam_request_and_response():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["path"] = req.url.path
        seen["key"] = req.headers.get("api-subscription-key")
        body = req.content
        seen["body"] = body
        return httpx.Response(200, json={"request_id": "r1", "transcript": " Hello there ", "language_code": "en-IN", "language_probability": 0.93})

    stt = _sarvam(handler)
    res = await stt.transcribe(audio.mulaw_to_stt_wav(audio.pcm16_to_mulaw(b"\x00\x01" * 4000)))
    assert res == {"text": "Hello there", "language": "en-IN", "confidence": 0.93}
    assert seen["path"] == "/speech-to-text"
    assert seen["key"] == "sarvam-test-key"
    for field in (b'name="model"', b"saaras:v3", b'name="mode"', b"transcribe", b'name="language_code"', b"en-IN", b'name="file"'):
        assert field in seen["body"]


@pytest.mark.parametrize("status,kind", [(403, "auth"), (429, "rate_limit"), (400, "invalid_audio"), (500, "provider")])
async def test_sarvam_errors(status, kind):
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(status, json={"error": {"message": "x", "code": "y"}})

    with pytest.raises(STTError) as ei:
        await _sarvam(handler).transcribe(b"RIFF" + b"\x00" * 200)
    assert ei.value.kind == kind
    assert calls["n"] == (2 if kind in ("rate_limit", "provider") else 1)  # transient errors retried once


async def test_sarvam_timeout_and_invalid_audio():
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    with pytest.raises(STTError) as ei:
        await _sarvam(handler).transcribe(b"RIFF" + b"\x00" * 200)
    assert ei.value.kind == "timeout"
    with pytest.raises(STTError) as ei:
        await _sarvam(handler).transcribe(b"")
    assert ei.value.kind == "invalid_audio"


# ------------------------------------------------------------ Plivo
def test_stream_xml_matches_plivo_spec():
    p = PlivoService(settings)
    xml = p.build_stream_xml("abc123")
    assert 'bidirectional="true"' in xml and 'keepCallAlive="true"' in xml
    assert 'contentType="audio/x-mulaw;rate=8000"' in xml
    assert "wss://test.example.com/ws/plivo/media?call_id=abc123&amp;token=" in xml
    assert 'statusCallbackUrl="https://test.example.com/api/webhooks/plivo/stream-status?call_id=abc123"' in xml
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml.split("?>", 1)[1])
    url = root.find("Stream").text
    token = url.split("token=")[1]
    assert verify_stream_token("abc123", token)
    assert not verify_stream_token("other", token)


def test_stream_token_is_hmac():
    assert sign_stream_token("a") != sign_stream_token("b")
    assert not verify_stream_token("a", None)


async def test_plivo_outbound_uses_sdk_with_correct_urls(monkeypatch):
    captured = {}

    class FakeCalls:
        def create(self, **kw):
            captured.update(kw)
            return type("R", (), {"request_uuid": "req-uuid-1", "message": "call fired"})()

    p = PlivoService(settings)
    p._client = type("C", (), {"calls": FakeCalls()})()
    res = await p.make_outbound_call("cid1", "+919876543210")
    assert res.request_uuid == "req-uuid-1"
    assert captured["from_"] == "+918035000000" and captured["to_"] == "+919876543210"
    assert captured["answer_url"] == "https://test.example.com/api/webhooks/plivo/answer?call_id=cid1"
    assert captured["hangup_url"] == captured["ring_url"] == "https://test.example.com/api/webhooks/plivo/status?call_id=cid1"
    assert captured["time_limit"] == settings.MAX_CALL_DURATION_SECONDS


async def test_plivo_not_configured(monkeypatch):
    from app.services.plivo_service import PlivoError

    monkeypatch.setattr(settings, "PLIVO_AUTH_ID", "")
    with pytest.raises(PlivoError) as ei:
        await PlivoService(settings).make_outbound_call("c", "+919876543210")
    assert ei.value.kind == "not_configured"


# ------------------------------------------------------------ Sarvam TTS (Bulbul)
def _wav(pcm: bytes, rate: int) -> bytes:
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


async def test_sarvam_tts_rest_request_and_mulaw(monkeypatch):
    from app.services import audio_service as audio
    from app.services.sarvam_tts import SarvamTTS

    seen = {}
    pcm = b"\x10\x20" * 800

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["key"] = request.headers.get("api-subscription-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"request_id": "r1", "audios": [base64.b64encode(_wav(pcm, 8000)).decode()]})

    monkeypatch.setattr(settings, "CALL_LANGUAGE", "en")
    tts = SarvamTTS(settings, client=httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler)))
    out = await tts.synthesize("Hello from Kagzso.")
    await tts.aclose()

    assert seen["path"] == "/text-to-speech" and seen["key"] == "sarvam-test-key"
    body = seen["body"]
    assert body["model"] == "bulbul:v3" and body["speaker"] == "roopa" and body["language_code"] == "en-IN"
    assert body["speech_sample_rate"] == 8000 and body["output_audio_codec"] == "wav"
    assert body["text"] == "Hello from Kexo."
    assert out == audio.pcm16_to_mulaw(pcm)


async def test_sarvam_tts_resamples_and_maps_errors():
    from app.services.sarvam_tts import SarvamTTS, wav_to_mulaw

    assert len(wav_to_mulaw(_wav(b"\x00\x00" * 1600, 16000))) in (799, 800, 801)
    tts = SarvamTTS(settings, client=httpx.AsyncClient(base_url="https://x", transport=httpx.MockTransport(lambda r: httpx.Response(403, text="no"))))
    with pytest.raises(TTSError) as ei:
        await tts.synthesize("Hi")
    assert ei.value.kind == "auth"


def test_sarvam_tts_ignores_non_bulbul_voice_ids():
    from app.services.sarvam_tts import SarvamTTS

    assert SarvamTTS(settings, voice_id="9cebb910-d4b7-4a4a-85a4-12c79137724c").voice_id == "roopa"
    assert SarvamTTS(settings, voice_id="ritu").voice_id == "ritu"


async def test_sarvam_tts_websocket_stream(monkeypatch):
    from websockets.asyncio.server import serve

    from app.services import audio_service as audio
    from app.services.sarvam_tts import SarvamTTS

    received = []
    headers = {}
    pcm = b"\x10\x20" * 200

    async def handler(ws):
        headers["key"] = ws.request.headers.get("Api-Subscription-Key")
        headers["path"] = ws.request.path
        async for raw in ws:
            msg = json.loads(raw)
            received.append(msg)
            if msg["type"] == "text":
                # odd-length chunks: a sample split across messages must survive
                await ws.send(json.dumps({"type": "audio", "data": {"audio": base64.b64encode(pcm[:201]).decode()}}))
                await ws.send(json.dumps({"type": "audio", "data": {"audio": base64.b64encode(pcm[201:]).decode()}}))
                await ws.send(json.dumps({"type": "event", "data": {"event_type": "final"}}))  # before flush: ignored
            if msg["type"] == "flush":
                await ws.send(json.dumps({"type": "event", "data": {"event_type": "final"}}))

    async with serve(handler, "127.0.0.1", 0) as server:
        monkeypatch.setattr(settings, "SARVAM_TTS_WS_URL", f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/text-to-speech/ws")
        stream = await SarvamTTS(settings).open_stream()
        await stream.send_text("Hi Arun.")
        await stream.send_text("Is now a good time?")
        await stream.end_input()
        chunks = [c async for c in stream.audio()]
        await stream.aclose()

    assert b"".join(chunks) == audio.pcm16_to_mulaw(pcm) * 2
    assert headers["key"] == "sarvam-test-key"
    assert "model=bulbul%3Av3" in headers["path"] and "send_completion_event=true" in headers["path"]
    config = received[0]
    assert config["type"] == "config"
    assert config["data"]["output_audio_codec"] == "linear16" and config["data"]["speech_sample_rate"] == "8000"
    assert config["data"]["speaker"] == "roopa" and config["data"]["language_code"] == "en-IN"
    assert [m["type"] for m in received[1:]] == ["text", "text", "flush"]


async def test_sarvam_tts_websocket_error(monkeypatch):
    from websockets.asyncio.server import serve

    from app.services.sarvam_tts import SarvamTTS

    async def handler(ws):
        async for raw in ws:
            if json.loads(raw)["type"] == "text":
                await ws.send(json.dumps({"type": "error", "data": {"message": "bad speaker", "code": 422}}))

    async with serve(handler, "127.0.0.1", 0) as server:
        monkeypatch.setattr(settings, "SARVAM_TTS_WS_URL", f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}")
        stream = await SarvamTTS(settings).open_stream()
        await stream.send_text("Hello.")
        with pytest.raises(TTSError) as ei:
            async for _ in stream.audio():
                pass
        await stream.aclose()
    assert ei.value.kind == "invalid_request"
