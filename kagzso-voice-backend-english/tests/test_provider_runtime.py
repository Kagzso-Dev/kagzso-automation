# Copyright (c) 2026 Kagzso Technology Services. All rights reserved.
# Proprietary and confidential. See LICENSE.md in the repository root.
# SPDX-License-Identifier: LicenseRef-Kagzso-Proprietary
"""AI Providers page as the runtime source of a call (this voice backend's language), end to end with mocked HTTP:

* the four LLM adapters (Groq, Sarvam, Anthropic, Gemini): endpoint, model, auth header, streamed text, and every
  failure (401/403 auth, 429 rate limit, 5xx, timeout) mapped to the kind the chain falls back on - the key never in
  an error message;
* STT: the page's model (Tamil saaras:v4 with the ta-IN language code, English its own model / en-IN), REST and
  streaming, the .env model as its fallback, kept by a "Pure" language-style flow;
* TTS: the page's model and key with the AI Agent's saved voice, one voice for every line; the agent's voice wins
  over a bulbul:v4-flash persona; ordinary flows unchanged;
* a simulated Tamil Autonomous AI Agent call (CallSession, live ON): its provider trace - LLM chain, the fallback
  attempt, STT and TTS models and the voice - and no key anywhere in the logs.

Nothing here reaches a provider, places a call or costs anything: every request goes to httpx.MockTransport.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import sys
import wave
from types import SimpleNamespace
from typing import Any, Dict, List
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import settings
from app.services import call_service, provider_registry as registry
from app.services.llm_service import ChainLLMProvider, LLMError
from app.services.sarvam_stt import SarvamSTT
from app.services.sarvam_stt_stream import SarvamSTTStream
from app.services.sarvam_tts import SarvamTTS
from tests.conftest import FakeLLM, FakePlivo
from tests.test_ai_providers import ANTHROPIC_KEY, GROQ_KEY, _build, _labels, secrets_key  # noqa: F401 (fixture)

SARVAM_PAGE_KEY = "sk_sarvam_page_key_0123456789"
GEMINI_KEY = "AIza-test-gemini-key-0123456789"
KEYS = (GROQ_KEY, ANTHROPIC_KEY, SARVAM_PAGE_KEY, GEMINI_KEY)


def _wav(rate: int = 8000, frames: int = 800) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate), w.writeframes(b"\x10\x00" * frames)
    return out.getvalue()


@pytest.fixture
def base_providers():
    """Today's .env providers with real Sarvam speech classes (no key: nothing could be sent anyway)."""
    call_service.set_providers(call_service.Providers(stt=SarvamSTT(settings), llm=FakeLLM(), tts=SarvamTTS(settings),
                                                      plivo=FakePlivo()))
    yield
    call_service.set_providers(None)


class Recorder:
    """One MockTransport for every provider host: records what would be sent, answers like the provider."""

    def __init__(self, llm_status: Dict[str, int] | None = None, llm_timeout: tuple = ()):
        self.requests: List[Dict[str, Any]] = []
        self.llm_status = llm_status or {}
        self.llm_timeout = llm_timeout

    def __call__(self, request: httpx.Request) -> httpx.Response:
        host, path = request.url.host, request.url.path
        entry: Dict[str, Any] = {"host": host, "path": path, "headers": dict(request.headers)}
        self.requests.append(entry)
        if host in self.llm_timeout:
            raise httpx.ReadTimeout("slow", request=request)
        if path == "/speech-to-text":
            entry["form"] = {k: v[0] for k, v in parse_qs(request.content.split(b"\r\n\r\n")[0].decode(errors="ignore")).items()}
            entry["body"] = request.content.decode(errors="ignore")
            return httpx.Response(200, json={"request_id": "r1", "transcript": "ஆமா, சொல்லுங்க", "language_code": "ta-IN",
                                             "language_probability": 0.97})
        if path == "/text-to-speech":
            entry["json"] = json.loads(request.content)
            return httpx.Response(200, json={"audios": [base64.b64encode(_wav()).decode()]})
        body = json.loads(request.content) if request.content else {}
        entry["json"] = body
        status = self.llm_status.get(host, 200)
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "nope", "type": "rate_limit_error"}})
        if host == "generativelanguage.googleapis.com":
            data = {"candidates": [{"content": {"parts": [{"text": "வணக்கம் sir."}]}}]}
            return httpx.Response(200, text=f"data: {json.dumps(data)}\n\n", headers={"content-type": "text/event-stream"})
        if host == "api.anthropic.com":
            events = [{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "வணக்கம் sir."}},
                      {"type": "message_stop"}]
            return httpx.Response(200, text="".join(f"data: {json.dumps(e)}\n\n" for e in events),
                                  headers={"content-type": "text/event-stream"})
        chunk = {"choices": [{"delta": {"content": "வணக்கம் sir."}}]}
        return httpx.Response(200, text=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n", headers={"content-type": "text/event-stream"})


def _mock_llm_clients(monkeypatch, rec: Recorder) -> None:
    for name in ("groq", "sarvam", "anthropic", "gemini"):
        monkeypatch.setitem(registry._LLM_CLIENTS, name, httpx.AsyncClient(transport=httpx.MockTransport(rec)))


async def _reply(llm) -> str:
    history = [{"role": "assistant", "content": "Ragul-கிட்ட தான் பேசறேனா?"}]
    return "".join([d async for d in llm.stream_response("You are Thaara.", history, "ஆமா", {})]).strip()


# ------------------------------------------------------------------ LLM adapters
ADAPTERS = [
    # page entry, model, key, host, path, header carrying the key
    ("groq_llm", "openai/gpt-oss-120b", GROQ_KEY, "api.groq.com", "/openai/v1/chat/completions", ("authorization", f"Bearer {GROQ_KEY}")),
    ("sarvam_llm", "sarvam-105b-conversations", SARVAM_PAGE_KEY, "api.sarvam.ai", "/v1/chat/completions", ("api-subscription-key", SARVAM_PAGE_KEY)),
    ("anthropic_llm", "claude-haiku-5-5", ANTHROPIC_KEY, "api.anthropic.com", "/v1/messages", ("x-api-key", ANTHROPIC_KEY)),
    ("gemini_llm", "gemini-3.6-flash", GEMINI_KEY, "generativelanguage.googleapis.com",
     "/v1beta/models/gemini-3.6-flash:streamGenerateContent", ("x-goog-api-key", GEMINI_KEY)),
]


@pytest.mark.parametrize("pid,model,key,host,path,auth", ADAPTERS)
def test_each_adapter_sends_its_model_and_key_and_streams_the_reply(monkeypatch, pid, model, key, host, path, auth):
    rec = Recorder()
    _mock_llm_clients(monkeypatch, rec)
    llm = registry.build_llm(pid, model, key, settings)
    assert asyncio.run(_reply(llm)) == "வணக்கம் sir."
    sent = rec.requests[0]
    assert (sent["host"], sent["path"]) == (host, path)
    assert sent["headers"][auth[0]] == auth[1]
    if pid != "gemini_llm":  # Gemini names the model in the URL
        assert sent["json"]["model"] == model
    assert "Safety rules" in json.dumps(sent["json"], ensure_ascii=False)  # the same locked rules for every provider


@pytest.mark.parametrize("pid,model,key,host,path,auth", ADAPTERS)
@pytest.mark.parametrize("status,kind", [(401, "auth"), (403, "auth"), (429, "rate_limit"), (500, "provider"), (0, "timeout")])
def test_each_adapter_maps_failures_to_a_fallback_kind_without_the_key(monkeypatch, pid, model, key, host, path, auth, status, kind):
    rec = Recorder(llm_status={host: status} if status else {}, llm_timeout=(host,) if not status else ())
    _mock_llm_clients(monkeypatch, rec)
    with pytest.raises(LLMError) as exc:
        asyncio.run(_reply(registry.build_llm(pid, model, key, settings)))
    assert exc.value.kind == kind
    assert key not in str(exc.value)


def test_page_llm_clients_use_the_configured_timeout(monkeypatch):
    monkeypatch.setattr(registry, "_LLM_CLIENTS", {})
    llm = registry.build_llm("groq_llm", "openai/gpt-oss-120b", GROQ_KEY, settings)
    assert llm._client.timeout.read == settings.LLM_TIMEOUT_SECONDS and llm._client.timeout.connect == 5.0


# ------------------------------------------------------------------ STT
def _stream_url(cfg) -> str:
    """The streaming STT URL a call would open (built without opening a connection)."""
    return SarvamSTTStream._url(SimpleNamespace(cfg=cfg))  # type: ignore[arg-type]


def _stt_page(monkeypatch, language: str, model: str, **opts):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", language)
    return _build(monkeypatch, sarvam_stt={"enabled": True, "model": model, "key": SARVAM_PAGE_KEY, **opts})


def _stt_request(stt: SarvamSTT) -> Dict[str, Any]:
    rec = Recorder()
    stt._client = httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(rec))
    asyncio.run(stt.transcribe(_wav(16000, 1600)))
    body, headers = rec.requests[0]["body"], rec.requests[0]["headers"]
    fields = dict(
        (part.split('name="')[1].split('"')[0], part.split("\r\n\r\n", 1)[1].rsplit("\r\n", 1)[0])
        for part in body.split("--") if 'name="' in part and "filename" not in part)
    return {"fields": fields, "key": headers["api-subscription-key"]}


def test_tamil_stt_uses_the_pages_saaras_v4(monkeypatch, base_providers):
    monkeypatch.setattr(settings, "APP_ENV", "production")
    monkeypatch.setattr(settings, "VERIFIED_SPEECH_MODELS", "saaras:v4")  # production needs it benchmarked first
    p = _stt_page(monkeypatch, "ta", "saaras:v4")
    assert p.stt.cfg.SARVAM_STT_MODEL == "saaras:v4" and p.stt.cfg.STT_FALLBACK_MODEL == settings.SARVAM_STT_MODEL
    sent = _stt_request(p.stt)
    assert sent["fields"]["model"] == "saaras:v4" and sent["fields"]["language_code"] == "ta-IN"
    assert "mode" not in sent["fields"]  # a saaras:v3-only setting
    assert sent["key"] == SARVAM_PAGE_KEY
    url = urlparse(_stream_url(p.stt.cfg))
    q = parse_qs(url.query)
    assert q["model"] == ["saaras:v4"] and q["language-code"] == ["ta-IN"] and "mode" not in q


def test_production_without_benchmark_keeps_the_env_stt(monkeypatch, base_providers):
    monkeypatch.setattr(settings, "APP_ENV", "production")
    monkeypatch.setattr(settings, "VERIFIED_SPEECH_MODELS", "")
    p = _stt_page(monkeypatch, "ta", "saaras:v4")
    assert p.stt is call_service.get_providers().stt  # refused when saved, ignored by calls


def test_english_stt_uses_its_own_model_and_language(monkeypatch, base_providers):
    p = _stt_page(monkeypatch, "en", "saaras:v3", options={"mode": "codemix"})
    sent = _stt_request(p.stt)
    assert sent["fields"]["model"] == "saaras:v3" and sent["fields"]["language_code"] == "en-IN"
    assert sent["fields"]["mode"] == "codemix"
    assert parse_qs(urlparse(_stream_url(p.stt.cfg)).query)["mode"] == ["codemix"]


def test_a_pure_style_flow_keeps_the_pages_stt_model_and_key(monkeypatch, base_providers):
    monkeypatch.setattr(settings, "SARVAM_STT_MODE_PURE", "transcribe")
    p = _stt_page(monkeypatch, "ta", "saaras:v3", options={"mode": "codemix"})
    pure = call_service.stt_for_call(p.stt, {"flow_language_style": "pure"}, settings)
    assert pure is not p.stt and pure.cfg.SARVAM_STT_MODE == "transcribe"
    assert pure.cfg.SARVAM_STT_MODEL == "saaras:v3"
    assert pure.cfg.SARVAM_API_KEY.get_secret_value() == SARVAM_PAGE_KEY  # was the .env key before


# ------------------------------------------------------------------ TTS and the agent's voice
def test_agent_voice_with_the_pages_bulbul_v3(monkeypatch, base_providers):
    p = _build(monkeypatch, sarvam_tts={"enabled": True, "model": "bulbul:v3", "options": {"speaker": "ishita"},
                                        "key": SARVAM_PAGE_KEY})
    agent = p.tts_for_agent_voice("roopa")
    assert isinstance(agent, SarvamTTS) and agent.voice_id == "roopa"
    assert agent.cfg.SARVAM_TTS_MODEL == "bulbul:v3" and agent.cfg.SARVAM_API_KEY.get_secret_value() == SARVAM_PAGE_KEY
    assert p.tts_for_voice(None).voice_id == "ishita"  # ordinary flows: the page's speaker, as before


def test_agent_voice_wins_over_a_v4_persona_and_ordinary_flows_keep_it(monkeypatch, base_providers, caplog):
    p = _build(monkeypatch, sarvam_tts={"enabled": True, "model": "bulbul:v4-flash",
                                        "options": {"speaker": "kavya_ta_customer"}, "key": SARVAM_PAGE_KEY})
    with caplog.at_level(logging.WARNING):
        agent = p.tts_for_agent_voice("ritu")
    assert not isinstance(agent, registry.FallbackTTS) and agent.voice_id == "ritu"
    assert agent.cfg.SARVAM_TTS_MODEL == "bulbul:v3"
    assert "not used for this AI Agent call" in caplog.text and "ritu" in caplog.text
    ordinary = p.tts_for_voice("ritu")
    assert isinstance(ordinary, registry.FallbackTTS) and ordinary.primary.voice_id == "kavya_ta_customer"


# ------------------------------------------------------------------ a simulated Tamil agent call: the trace
def _seed_tamil_live(monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "ta")
    monkeypatch.setattr(settings, "APP_ENV", "production")
    monkeypatch.setattr(settings, "VERIFIED_SPEECH_MODELS", "saaras:v4")
    return _build(
        monkeypatch,
        groq_llm={"enabled": True, "model": "openai/gpt-oss-120b", "priority": 1, "key": GROQ_KEY},
        sarvam_llm={"enabled": True, "model": "sarvam-105b-conversations", "priority": 2, "key": SARVAM_PAGE_KEY},
        anthropic_llm={"enabled": True, "model": "claude-haiku-5-5", "priority": 3, "key": ANTHROPIC_KEY},
        gemini_llm={"enabled": False, "model": "gemini-3.6-flash", "priority": 4, "key": GEMINI_KEY},
        sarvam_stt={"enabled": True, "model": "saaras:v4", "key": SARVAM_PAGE_KEY},
        sarvam_tts={"enabled": True, "model": "bulbul:v3", "options": {"speaker": "ishita"}, "key": SARVAM_PAGE_KEY},
    )


def test_simulated_tamil_agent_call_trace(monkeypatch, base_providers, caplog, capsys):
    rec = Recorder(llm_status={"api.groq.com": 429})  # Groq is over quota: Sarvam answers before any audio
    _mock_llm_clients(monkeypatch, rec)
    p = _seed_tamil_live(monkeypatch)
    sarvam_http = httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(rec))
    p.stt._client = sarvam_http
    p.tts._client = sarvam_http  # the agent's voice shares the page TTS's connection pool
    variables = {"flow_voice_profile": call_service.AGENT_VOICE_PROFILE, "flow_agent_voice": "roopa",
                 "flow_dnc_force": "true"}
    ctx = call_service.CallContextData(call_id="trace-call", agent_prompt="You are Thaara.", variables=variables,
                                       voice_id="roopa", first_message="வணக்கம் {{title}}.")

    async def call() -> Dict[str, Any]:
        session = call_service.CallSession(ctx, sender=None, providers=p)  # type: ignore[arg-type]
        heard = await session.stt.transcribe(_wav(16000, 1600))
        lines = ["வணக்கம் sir, நான் Thaara.", await _reply(session.providers.llm), "நன்றி, have a nice day."]
        for line in lines:  # greeting, a reply, the closing: each its own TTS request
            await session.tts.synthesize(line)
        return {"session": session, "heard": heard["text"], "lines": lines}

    with caplog.at_level(logging.INFO):
        out = asyncio.run(call())
    session = out["session"]
    trace = registry.describe_call(session.providers, session.stt, session.tts)
    assert trace["source"] == "admin"
    assert trace["llm"] == ["groq:openai/gpt-oss-120b", "sarvam:sarvam-105b-conversations", "anthropic:claude-haiku-5-5"]
    assert trace["stt"]["model"] == "saaras:v4" and trace["stt"]["language"] == "ta-IN"
    assert trace["tts"]["model"] == "bulbul:v3" and trace["tts"]["voice"] == "roopa"
    llm_hosts = [r["host"] for r in rec.requests if r["path"] not in ("/speech-to-text", "/text-to-speech")]
    assert llm_hosts == ["api.groq.com", "api.sarvam.ai"]  # Groq failed before any text; Sarvam answered; no third try
    tts = [r["json"] for r in rec.requests if r["path"] == "/text-to-speech"]
    assert {(t["speaker"], t["model"], t["pace"], t["temperature"]) for t in tts} == {("roopa", "bulbul:v3", 0.9, 0.4)}
    assert {r["headers"]["api-subscription-key"] for r in rec.requests if r["path"].startswith("/te") or r["path"] == "/speech-to-text"} == {SARVAM_PAGE_KEY}
    logs = caplog.text
    assert "Call providers:" in logs and "groq failed (rate_limit)" in logs and "trying sarvam" in logs
    for key in KEYS:  # never in a log line or in the trace
        assert key not in logs and key not in json.dumps(trace)
    shown = ["", "===== provider execution trace (simulated Tamil AI Agent call, live ON) =====",
             json.dumps(trace, ensure_ascii=False, indent=2)]
    for r in rec.requests:
        what = {"/speech-to-text": "STT", "/text-to-speech": "TTS"}.get(r["path"], "LLM")
        detail = (r.get("json") or {}).get("speaker") or (r.get("json") or {}).get("model") or ""
        shown.append(f"  {what:3} {r['host']}{r['path']} {detail}")
    shown += [f"  log: {line.split(' ', 2)[-1][:220]}" for line in logs.splitlines()
              if "LLM provider" in line or "Call providers" in line]
    shown.append(f"  heard: {out['heard']}")
    with capsys.disabled():  # UTF-8 whatever the console's code page (Tamil text)
        sys.stdout.buffer.write(("\n".join(shown) + "\n").encode("utf-8"))
        sys.stdout.flush()


def test_ordinary_call_with_the_same_page_settings_is_unchanged(monkeypatch, base_providers):
    p = _seed_tamil_live(monkeypatch)
    ctx = call_service.CallContextData(call_id="plain", agent_prompt="x", variables={}, voice_id=None)
    session = call_service.CallSession(ctx, sender=None, providers=p)  # type: ignore[arg-type]
    assert session.tts.voice_id == "ishita"  # the page's speaker, no agent voice profile
    assert session.tts.cfg.SARVAM_TTS_PACE == settings.SARVAM_TTS_PACE
    assert isinstance(p.llm, ChainLLMProvider) and _labels(p)[0] == "groq:openai/gpt-oss-120b"


def test_live_off_keeps_the_env_providers_exactly(monkeypatch, base_providers):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "ta")
    p = _build(monkeypatch, live=False, groq_llm={"enabled": True, "model": "openai/gpt-oss-120b", "key": GROQ_KEY},
               sarvam_stt={"enabled": True, "model": "saaras:v3", "key": SARVAM_PAGE_KEY})
    assert p is None
    env = call_service.get_providers()
    ctx = call_service.CallContextData(call_id="env", agent_prompt="x", variables={}, voice_id=None)
    session = call_service.CallSession(ctx, sender=None, providers=env)  # type: ignore[arg-type]
    assert registry.describe_call(env, session.stt, session.tts)["source"] == "env"
    assert session.stt is env.stt and session.tts is env.tts
