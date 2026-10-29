"""AI provider settings (admin page): encrypted keys, admin-only API, LLM fallback order, independent
STT / TTS, per-call snapshots. Every provider is mocked - no paid request, no call."""
import asyncio
import base64
import json
import os
from typing import AsyncIterator, List, Optional

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import text

from app.core.config import settings
from app.db.database import dispose_engine, session_factory
from app.services import call_service, provider_registry as registry, provider_secrets as secrets
from app.services.llm_service import AnthropicProvider, ChainLLMProvider, LLMError, LLMProvider
from app.services.sarvam_stt import SarvamSTT
from app.services.sarvam_tts import SarvamTTS
from app.services.tts import TTSError

KEY_A = base64.b64encode(os.urandom(32)).decode()
KEY_B = base64.b64encode(os.urandom(32)).decode()
GROQ_KEY = "gsk_test_groq_key_0123456789"
ANTHROPIC_KEY = "sk-ant-test-key-0123456789"
BASE = "/api/admin/ai-providers"


@pytest.fixture(autouse=True)
def secrets_key(monkeypatch):
    monkeypatch.setattr(settings, "PROVIDER_SECRETS_KEY", SecretStr(KEY_A))
    registry.invalidate()
    yield
    registry.invalidate()


def run(coro):
    """Run DB work in its own loop, then drop the engine bound to it."""
    async def wrapper():
        try:
            return await coro
        finally:
            await dispose_engine()

    return asyncio.run(wrapper())


async def _with_db(fn):
    async with session_factory()() as db:
        return await fn(db)


def put(client, auth, pid, body, actor="admin@test"):
    return client.put(f"{BASE}/providers/{pid}", headers={**auth, "X-Actor": actor}, json=body)


def select_(client, auth, body):
    return client.put(f"{BASE}/selection", headers={**auth, "X-Actor": "admin@test"}, json=body)


# ------------------------------------------------------------------ encryption at rest
def test_keys_are_encrypted_bound_to_their_provider_and_rotatable(monkeypatch):
    stored = secrets.encrypt(GROQ_KEY, "groq_llm", settings)
    assert GROQ_KEY not in stored and stored.startswith("v1:")
    assert secrets.decrypt(stored, "groq_llm", settings) == GROQ_KEY
    with pytest.raises(secrets.SecretsError):
        secrets.decrypt(stored, "sarvam_llm", settings)  # copied onto another provider's row: unreadable
    monkeypatch.setattr(settings, "PROVIDER_SECRETS_KEY", SecretStr(KEY_B))
    with pytest.raises(secrets.SecretsError):
        secrets.decrypt(stored, "groq_llm", settings)  # old key gone
    monkeypatch.setattr(settings, "PROVIDER_SECRETS_OLD_KEYS", SecretStr(KEY_A))
    assert secrets.decrypt(stored, "groq_llm", settings) == GROQ_KEY and secrets.needs_reencrypt(stored, settings)


def test_no_encryption_key_means_keys_cannot_be_saved(client, auth, monkeypatch):
    monkeypatch.setattr(settings, "PROVIDER_SECRETS_KEY", SecretStr(""))
    r = put(client, auth, "groq_llm", {"api_key": GROQ_KEY})
    assert r.status_code == 503 and "PROVIDER_SECRETS_KEY" in r.json()["detail"]["message"]
    view = client.get(BASE, headers=auth).json()
    assert view["secrets_ready"] is False and any("PROVIDER_SECRETS_KEY" in w for w in view["warnings"])
    assert next(p for p in view["providers"] if p["id"] == "groq_llm")["key_configured"] is False


# ------------------------------------------------------------------ admin-only API
ENDPOINTS = [("get", BASE, None), ("put", f"{BASE}/providers/groq_llm", {"enabled": True}),
             ("put", f"{BASE}/selection", {"live": True}), ("post", f"{BASE}/providers/groq_llm/test", None),
             ("post", f"{BASE}/reencrypt", None)]


@pytest.mark.parametrize("method, path, body", ENDPOINTS)
@pytest.mark.parametrize("headers", [{}, {"X-API-Key": "wrong-key-0123456789"}])
def test_every_settings_endpoint_needs_the_admin_api_key(client, method, path, body, headers):
    r = getattr(client, method)(path, headers=headers, **({"json": body} if body is not None else {}))
    assert r.status_code == 401


def test_saved_keys_are_never_returned_and_an_empty_field_never_erases_one(client, auth, sync_engine):
    r = put(client, auth, "groq_llm", {"api_key": GROQ_KEY, "model": "openai/gpt-oss-120b", "enabled": True})
    assert r.status_code == 200 and GROQ_KEY not in r.text
    groq = next(p for p in r.json()["providers"] if p["id"] == "groq_llm")
    assert groq["key_configured"] is True and groq["key_source"] == "saved" and groq["status"] == "configured"
    assert GROQ_KEY not in client.get(BASE, headers=auth).text
    with sync_engine.connect() as c:
        stored = c.execute(text("select encrypted_key from ai_provider_settings where id = 'groq_llm'")).scalar()
    assert stored and GROQ_KEY not in stored
    # An empty field (or none) keeps the saved key.
    assert put(client, auth, "groq_llm", {"api_key": "", "model": "openai/gpt-oss-20b"}).status_code == 200
    with sync_engine.connect() as c:
        assert c.execute(text("select encrypted_key from ai_provider_settings where id = 'groq_llm'")).scalar() == stored
    # Replace, then remove on purpose.
    put(client, auth, "groq_llm", {"api_key": "gsk_new_key_9876543210"})
    with sync_engine.connect() as c:
        assert c.execute(text("select encrypted_key from ai_provider_settings where id = 'groq_llm'")).scalar() != stored
    r = put(client, auth, "groq_llm", {"remove_key": True})
    groq = next(p for p in r.json()["providers"] if p["id"] == "groq_llm")
    assert groq["key_configured"] is False and groq["status"] == "missing_key"
    with sync_engine.connect() as c:
        audit = c.execute(text("select actor, action, detail from ai_provider_audit order by id")).all()
    assert [a[1] for a in audit].count("provider_updated") == 4 and all(a[0] == "admin@test" for a in audit)
    assert all(GROQ_KEY not in json.dumps(a[2]) and "gsk_new" not in json.dumps(a[2]) for a in audit)


def test_a_bad_key_is_refused_without_echoing_it(client, auth):
    bad = "has spaces in it 12345"
    r = put(client, auth, "anthropic_llm", {"api_key": bad})
    assert r.status_code == 422 and bad not in r.text
    r = put(client, auth, "anthropic_llm", {"api_key": {"nested": "sk-ant-should-not-echo"}})
    assert r.status_code == 422 and "should-not-echo" not in r.text


def test_untested_speech_models_are_refused_in_production(client, auth, monkeypatch):
    monkeypatch.setattr(settings, "APP_ENV", "production")
    r = put(client, auth, "sarvam_stt", {"model": "saaras:v4", "enabled": True})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unverified_model"
    r = put(client, auth, "sarvam_tts", {"model": "bulbul:v4-flash", "options": {"speaker": "shubh_ta_casual"}})
    assert r.status_code == 422
    monkeypatch.setattr(settings, "VERIFIED_SPEECH_MODELS", "saaras:v4")  # benchmarked: allowed
    assert put(client, auth, "sarvam_stt", {"model": "saaras:v4"}).status_code == 200


def test_bulbul_v4_flash_needs_a_persona_not_a_v3_name(client, auth):
    r = put(client, auth, "sarvam_tts", {"model": "bulbul:v4-flash", "options": {"speaker": "roopa"}})
    assert r.status_code == 422 and "persona" in r.json()["detail"]["message"]
    r = put(client, auth, "sarvam_tts", {"model": "bulbul:v4-flash", "options": {"speaker": "kavya_ta_customer"}})
    tts = next(p for p in r.json()["providers"] if p["id"] == "sarvam_tts")
    assert r.status_code == 200 and tts["untested_model"] is True and tts["options"] == {"speaker": "kavya_ta_customer"}


def test_going_live_or_disabling_the_last_llm_needs_confirmation(client, auth):
    r = select_(client, auth, {"live": True})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "no_usable_llm"
    put(client, auth, "groq_llm", {"api_key": GROQ_KEY, "model": "openai/gpt-oss-120b", "enabled": True})
    assert select_(client, auth, {"live": True}).json()["live"] is True
    r = put(client, auth, "groq_llm", {"enabled": False})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "would_leave_no_llm"
    assert put(client, auth, "groq_llm", {"enabled": False, "confirm": True}).status_code == 200


def test_test_connection_shows_a_sanitized_result(client, auth, monkeypatch):
    async def failing(pid, model, key, cfg):
        raise LLMError("auth", f"Groq authentication failed (401) body echoing {key}", 401)

    monkeypatch.setattr(registry, "_test_llm", failing)
    put(client, auth, "groq_llm", {"api_key": GROQ_KEY, "model": "openai/gpt-oss-120b"})
    r = client.post(f"{BASE}/providers/groq_llm/test", headers=auth)
    assert r.status_code == 200 and GROQ_KEY not in r.text and "body echoing" not in r.text
    assert r.json()["test"]["message"] == "Authentication failed - check the API key (401)"
    groq = next(p for p in r.json()["providers"] if p["id"] == "groq_llm")
    assert groq["status"] == "disabled" and groq["last_test"]["status"] == "error"


# ------------------------------------------------------------------ which providers a call uses
async def _seed(db, *, live=True, **rows):
    from app.db.models import AiProviderSelection, AiProviderSetting, utcnow

    await db.merge(AiProviderSelection(id=1, live=live, updated_at=utcnow()))
    for pid, fields in rows.items():
        key = fields.pop("key", None)
        await db.merge(AiProviderSetting(id=pid, updated_at=utcnow(),
                                         encrypted_key=secrets.encrypt(key, pid, settings) if key else None, **fields))
    await db.commit()


def _labels(providers) -> List[str]:
    return providers.llm.labels if isinstance(providers.llm, ChainLLMProvider) else []


def _build(monkeypatch, **seed):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "gemini")  # the test .env LLM: never a bootstrap key here
    monkeypatch.setattr(settings, "SARVAM_API_KEY", SecretStr(""))

    async def go(db):
        await _seed(db, **seed)
        return await registry.build_call_providers(db, settings)

    return run(_with_db(go))


def test_empty_groq_key_skips_to_sarvam(monkeypatch):
    p = _build(monkeypatch, groq_llm={"enabled": True, "model": "openai/gpt-oss-120b", "priority": 1},
               sarvam_llm={"enabled": True, "model": "sarvam-105b-conversations", "priority": 2, "key": "sarvam-key-0123456"})
    assert _labels(p) == ["sarvam:sarvam-105b-conversations"]


def test_disabled_groq_skips_to_the_next_enabled_provider(monkeypatch):
    p = _build(monkeypatch, groq_llm={"enabled": False, "model": "openai/gpt-oss-120b", "priority": 1, "key": GROQ_KEY},
               sarvam_llm={"enabled": False, "priority": 2, "key": "sarvam-key-0123456"},
               anthropic_llm={"enabled": True, "model": "claude-opus-5-5", "priority": 3, "key": ANTHROPIC_KEY})
    assert _labels(p) == ["anthropic:claude-opus-5-5"]


def test_priority_order_is_the_admins(monkeypatch):
    p = _build(monkeypatch, groq_llm={"enabled": True, "model": "openai/gpt-oss-120b", "priority": 3, "key": GROQ_KEY},
               sarvam_llm={"enabled": True, "model": "sarvam-105b", "priority": 2, "key": "sarvam-key-0123456"},
               anthropic_llm={"enabled": True, "model": "claude-opus-5-5", "priority": 1, "key": ANTHROPIC_KEY})
    assert _labels(p) == ["anthropic:claude-opus-5-5", "sarvam:sarvam-105b", "groq:openai/gpt-oss-120b"]


@pytest.mark.parametrize("enabled", [True, False])
def test_no_usable_llm_keeps_the_env_llm(monkeypatch, enabled):
    p = _build(monkeypatch, groq_llm={"enabled": enabled, "priority": 1}, anthropic_llm={"enabled": enabled, "priority": 3})
    assert p.llm is call_service.get_providers().llm  # clear, safe fallback: today's .env LLM


def test_switched_off_means_todays_env_providers(monkeypatch):
    p = _build(monkeypatch, live=False, groq_llm={"enabled": True, "model": "openai/gpt-oss-120b", "key": GROQ_KEY})
    assert p is None
    assert run(registry.providers_for_call()) is call_service.get_providers()


def test_stt_and_tts_are_chosen_independently_of_the_llm(monkeypatch):
    p = _build(monkeypatch, groq_llm={"enabled": True, "model": "openai/gpt-oss-120b", "priority": 1, "key": GROQ_KEY},
               sarvam_stt={"enabled": True, "model": "saaras:v3", "options": {"mode": "codemix"}, "key": "sarvam-key-0123456"},
               sarvam_tts={"enabled": True, "model": "bulbul:v4-flash", "options": {"speaker": "kavya_ta_customer"},
                           "key": "sarvam-key-0123456"})
    assert _labels(p) == ["groq:openai/gpt-oss-120b"]
    assert isinstance(p.stt, SarvamSTT) and p.stt.cfg.SARVAM_STT_MODEL == "saaras:v3" and p.stt.cfg.SARVAM_STT_MODE == "codemix"
    tts = p.tts_for_voice("ritu")  # the flow's v3 voice stays the fallback
    assert isinstance(tts, registry.FallbackTTS) and tts.primary.voice_id == "kavya_ta_customer"
    assert tts.primary.cfg.SARVAM_TTS_MODEL == "bulbul:v4-flash"
    assert tts.fallback is call_service.get_providers().tts_for_voice("ritu")  # today's TTS (a fake in tests)
    # Speech settings only: the LLM side would be the same with STT / TTS switched off.
    q = _build(monkeypatch, sarvam_stt={"enabled": False}, sarvam_tts={"enabled": False})
    assert _labels(q) == _labels(p) and q.stt is call_service.get_providers().stt and q.fixed_tts is None


def test_production_ignores_an_unverified_speech_model_already_saved(monkeypatch):
    monkeypatch.setattr(settings, "APP_ENV", "production")
    p = _build(monkeypatch, sarvam_stt={"enabled": True, "model": "saaras:v4", "key": "sarvam-key-0123456"})
    assert p.stt is call_service.get_providers().stt


def test_each_call_keeps_its_snapshot(monkeypatch):
    monkeypatch.setattr(settings, "LLM_PROVIDER", "gemini")
    monkeypatch.setattr(settings, "SARVAM_API_KEY", SecretStr(""))

    async def go(db):
        from app.db.models import AiProviderSetting

        await _seed(db, groq_llm={"enabled": True, "model": "openai/gpt-oss-120b", "priority": 1, "key": GROQ_KEY})
        first = await registry.providers_for_call()
        row = await db.get(AiProviderSetting, "groq_llm")
        row.model = "openai/gpt-oss-20b"
        await db.commit()
        registry.invalidate()  # what a saved change does
        second = await registry.providers_for_call()
        return first, second

    first, second = run(_with_db(go))
    assert _labels(first) == ["groq:openai/gpt-oss-120b"]  # the call already running is unchanged
    assert _labels(second) == ["groq:openai/gpt-oss-20b"]


# ------------------------------------------------------------------ the LLM fallback chain
class Link(LLMProvider):
    def __init__(self, name: str, reply: Optional[str] = None, error: Optional[LLMError] = None,
                 fail_after_text: bool = False):
        super().__init__(settings, client=httpx.AsyncClient())
        self.name, self.model, self.reply, self.error, self.fail_after_text = name, f"{name}-model", reply, error, fail_after_text
        self.seen: List[tuple] = []

    async def _stream(self, system_text, messages, model=None) -> AsyncIterator[str]:
        self.seen.append((system_text, messages))
        if self.error and not self.fail_after_text:
            raise self.error
        for word in (self.reply or "").split(" "):
            yield word + " "
        if self.error:
            raise self.error


async def _say(chain: ChainLLMProvider) -> str:
    history = [{"role": "assistant", "content": "Hello, am I speaking with Ragul?"}]
    return "".join([d async for d in chain.stream_response("You are Thaara.", history, "Yes, speaking", {})]).strip()


@pytest.mark.parametrize("kind", ["auth", "rate_limit", "timeout", "provider", "invalid_request"])
async def test_a_failure_before_any_text_falls_back_with_the_same_prompt_and_history(kind):
    groq = Link("groq", error=LLMError(kind, "x", 401 if kind == "auth" else None))
    sarvam = Link("sarvam", reply="Thank you, sir.")
    assert await _say(ChainLLMProvider(settings, [("groq", groq), ("sarvam", sarvam)])) == "Thank you, sir."
    assert groq.seen == sarvam.seen  # same system prompt (with safety rules), same history, same latest words
    assert "Safety rules" in sarvam.seen[0][0] and sarvam.seen[0][1][-1] == {"role": "user", "content": "Yes, speaking"}


async def test_sarvam_timeout_falls_back_to_anthropic():
    chain = ChainLLMProvider(settings, [("sarvam", Link("sarvam", error=LLMError("timeout", "x"))),
                                        ("anthropic", Link("anthropic", reply="Sure."))])
    assert await _say(chain) == "Sure."


async def test_no_second_provider_after_text_was_spoken_and_never_after_a_refusal():
    second = Link("sarvam", reply="Again.")
    chain = ChainLLMProvider(settings, [("groq", Link("groq", reply="Half", error=LLMError("provider", "x"),
                                                      fail_after_text=True)), ("sarvam", second)])
    with pytest.raises(LLMError):
        await _say(chain)
    assert second.seen == []  # nothing said twice
    refused = ChainLLMProvider(settings, [("anthropic", Link("anthropic", error=LLMError("blocked", "x"))), ("sarvam", second)])
    with pytest.raises(LLMError):
        await _say(refused)
    assert second.seen == []


async def test_all_providers_failing_is_one_bounded_pass():
    links = [Link(n, error=LLMError("rate_limit", "x")) for n in ("groq", "sarvam", "anthropic")]
    with pytest.raises(LLMError) as exc:
        await _say(ChainLLMProvider(settings, [(lk.name, lk) for lk in links]))
    assert exc.value.kind == "rate_limit" and [len(lk.seen) for lk in links] == [1, 1, 1]


async def test_a_slow_provider_gives_way_after_the_first_token_timeout(monkeypatch):
    monkeypatch.setattr(settings, "LLM_PRIMARY_FIRST_TOKEN_TIMEOUT_SECONDS", 0.05)

    class Slow(Link):
        async def _stream(self, system_text, messages, model=None):
            await asyncio.sleep(1)
            yield "late"

    chain = ChainLLMProvider(settings, [("groq", Slow("groq")), ("sarvam", Link("sarvam", reply="Fast."))])
    assert await _say(chain) == "Fast."


# ------------------------------------------------------------------ Anthropic request / response
def _sse(*events) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def _anthropic(handler, model="claude-opus-5-5", effort="minimal") -> AnthropicProvider:
    cfg = settings.model_copy(update={"LLM_API_KEY": SecretStr(ANTHROPIC_KEY), "LLM_MODEL": model,
                                      "LLM_PROVIDER": "anthropic", "LLM_THINKING_LEVEL": effort})
    return AnthropicProvider(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_anthropic_request_format_and_streamed_text():
    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent["url"], sent["headers"], sent["body"] = str(request.url), request.headers, json.loads(request.content)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=_sse(
            {"type": "message_start", "message": {"id": "msg_1"}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "private"}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Thank you, "}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "sir."}},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
            {"type": "message_stop"}))

    p = _anthropic(handler)
    text_ = "".join([d async for d in p._stream("SYSTEM", [{"role": "user", "content": "Yes"}], "claude-opus-5-5")])
    assert text_ == "Thank you, sir."  # thinking is never spoken
    assert sent["url"] == "https://api.anthropic.com/v1/messages"
    assert sent["headers"]["x-api-key"] == ANTHROPIC_KEY and sent["headers"]["anthropic-version"] == "2026-10-21"
    assert sent["headers"]["anthropic-beta"] == "server-side-fallback-2026-07-01"
    body = sent["body"]
    assert body["system"] == "SYSTEM" and body["messages"] == [{"role": "user", "content": "Yes"}]
    assert body["stream"] is True and body["output_config"] == {"effort": "low"} and body["fallbacks"] == "default"
    assert "temperature" not in body and "top_p" not in body


async def test_anthropic_models_without_server_fallback_get_no_fallback_parameter():
    p = _anthropic(lambda r: httpx.Response(200), model="claude-haiku-5-5")
    body = p.request_body("S", [{"role": "user", "content": "Hi"}], "claude-haiku-5-5")
    assert "fallbacks" not in body


@pytest.mark.parametrize("status, kind", [(401, "auth"), (429, "rate_limit"), (529, "provider"), (500, "provider"),
                                          (400, "invalid_request")])
async def test_anthropic_http_errors_map_to_fallback_kinds(status, kind):
    p = _anthropic(lambda r: httpx.Response(status, json={"type": "error", "error": {"type": "x", "message": "m"}}))
    with pytest.raises(LLMError) as exc:
        [d async for d in p._stream("S", [{"role": "user", "content": "Hi"}], "claude-opus-5-5")]
    assert exc.value.kind == kind


@pytest.mark.parametrize("etype, kind", [("overloaded_error", "provider"), ("rate_limit_error", "rate_limit")])
async def test_anthropic_stream_errors_and_refusals(etype, kind):
    p = _anthropic(lambda r: httpx.Response(200, content=_sse({"type": "error", "error": {"type": etype, "message": "m"}})))
    with pytest.raises(LLMError) as exc:
        [d async for d in p._stream("S", [{"role": "user", "content": "Hi"}], "claude-opus-5-5")]
    assert exc.value.kind == kind
    refused = _anthropic(lambda r: httpx.Response(200, content=_sse(
        {"type": "message_delta", "delta": {"stop_reason": "refusal"}})))
    with pytest.raises(LLMError) as exc:
        [d async for d in refused._stream("S", [{"role": "user", "content": "Hi"}], "claude-opus-5-5")]
    assert exc.value.kind == "blocked"


# ------------------------------------------------------------------ speech: Tamil, code-mixed, fallback voice
@pytest.mark.parametrize("transcript", ["ஆமா, நான் தான் பேசுறேன்.", "இப்போ meeting-ல இருக்கேன், evening call பண்ணுங்க."])
async def test_tamil_and_code_mixed_transcripts_pass_through_unchanged(transcript):
    from app.db.models import AiProviderSetting

    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent["form"] = request.content
        return httpx.Response(200, json={"transcript": transcript, "language_code": "ta-IN"})

    cfg = settings.model_copy(update={"CALL_LANGUAGE": "ta"})
    row = AiProviderSetting(id="sarvam_stt", model="saaras:v3", options={"mode": "codemix"})
    stt = registry.build_stt(row, "sarvam-key-0123456", cfg,
                             httpx.AsyncClient(base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler)))
    result = await stt.transcribe(registry._silence_wav())
    assert result["text"] == transcript and result["language"] == "ta-IN"
    assert b'name="language_code"\r\n\r\nta-IN' in sent["form"] and b'name="mode"\r\n\r\ncodemix' in sent["form"]


async def test_a_new_voice_that_fails_before_audio_uses_the_working_one():
    class Broken(SarvamTTS):
        async def open_stream(self, pace=None):
            raise TTSError("invalid_request", "unknown speaker", 400)

        async def synthesize(self, text, pace=None):
            raise TTSError("invalid_request", "unknown speaker", 400)

    class Working(SarvamTTS):
        async def open_stream(self, pace=None):
            return "stream"

        async def synthesize(self, text, pace=None):
            return b"audio"

    tts = registry.FallbackTTS(Broken(settings, voice_id="kavya_ta_customer", exact_voice=True), Working(settings))
    assert await tts.open_stream() == "stream" and await tts.synthesize("Hello") == b"audio"
