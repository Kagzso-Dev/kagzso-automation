"""LLM_CHAIN_COOLDOWN_SECONDS (off by default): in the admin page's LLM order, a provider with quota /
overload / auth errors, or one that keeps missing the first-token timeout, is tried last for the cooldown -
never dropped, never after text was spoken. The state survives the chain being rebuilt. All providers fake."""
import asyncio

import pytest
from pydantic import SecretStr

from app.core.config import settings
from app.services import llm_service as llm, provider_registry as registry
from app.services.llm_service import ChainLLMProvider, LLMError
from tests.test_ai_providers import GROQ_KEY, KEY_A, Link, _say, _seed, _with_db, run


@pytest.fixture(autouse=True)
def fresh_health():
    llm.reset_chain_health()
    registry.invalidate()
    yield
    llm.reset_chain_health()
    registry.invalidate()  # never leave a fake chain in the 30 s providers cache for later tests


@pytest.fixture
def cooldown(monkeypatch):
    monkeypatch.setattr(settings, "LLM_CHAIN_COOLDOWN_SECONDS", 60.0)
    monkeypatch.setattr(settings, "LLM_CHAIN_BREAKER_TIMEOUTS", 2)
    monkeypatch.setattr(settings, "LLM_PRIMARY_FIRST_TOKEN_TIMEOUT_SECONDS", 0.05)


class Slow(Link):
    async def _stream(self, system_text, messages, model=None):
        self.seen.append((system_text, messages))
        await asyncio.sleep(1)
        yield "late"


def _chain(*links):
    return ChainLLMProvider(settings, [(lk.name, lk) for lk in links])


def test_off_by_default():
    assert settings.LLM_CHAIN_COOLDOWN_SECONDS == 0


async def test_off_tries_the_saved_order_every_reply():
    groq, sarvam = Link("groq", error=LLMError("rate_limit", "x")), Link("sarvam", reply="Sure.")
    for _ in range(3):
        assert await _say(_chain(groq, sarvam)) == "Sure."
    assert len(groq.seen) == 3 and llm._CHAIN_HEALTH == {}


@pytest.mark.parametrize("kind", ["rate_limit", "provider", "auth"])
async def test_quota_overload_or_auth_puts_the_provider_last_at_once(cooldown, kind):
    groq, sarvam = Link("groq", error=LLMError(kind, "x")), Link("sarvam", reply="Sure.")
    assert await _say(_chain(groq, sarvam)) == "Sure."
    assert await _say(_chain(groq, sarvam)) == "Sure."
    assert len(groq.seen) == 1  # skipped on the second reply: sarvam answered first


async def test_a_provider_that_keeps_timing_out_is_skipped_for_the_cooldown(cooldown):
    groq, sarvam = Slow("groq"), Link("sarvam", reply="Fast.")
    for _ in range(2):  # LLM_CHAIN_BREAKER_TIMEOUTS first-token timeouts
        assert await _say(_chain(groq, sarvam)) == "Fast."
    assert len(groq.seen) == 2
    for _ in range(3):  # cooling down: sarvam first, groq not waited for at all
        assert await _say(_chain(groq, sarvam)) == "Fast."
    assert len(groq.seen) == 2
    llm._CHAIN_HEALTH["groq:groq-model"]["until"] = 0.0  # the cooldown time has passed
    await _say(_chain(groq, sarvam))
    assert len(groq.seen) == 3  # back in its saved place


async def test_one_timeout_alone_does_not_trip_it(cooldown):
    groq, sarvam = Slow("groq"), Link("sarvam", reply="Fast.")
    await _say(_chain(groq, sarvam))
    llm._CHAIN_HEALTH["groq:groq-model"]["timeouts"] = []  # older than LLM_BREAKER_WINDOW_SECONDS
    await _say(_chain(groq, sarvam))
    await _say(_chain(groq, sarvam))
    assert len(groq.seen) == 3


async def test_the_state_survives_a_chain_rebuild(cooldown):
    first = _chain(Link("groq", error=LLMError("rate_limit", "x")), Link("sarvam", reply="Sure."))
    await _say(first)
    groq2, sarvam2 = Link("groq", reply="Groq."), Link("sarvam", reply="Sure.")  # new objects, same provider:model
    assert await _say(_chain(groq2, sarvam2)) == "Sure." and groq2.seen == []


def test_the_state_survives_the_registry_rebuilding_the_chain(cooldown, monkeypatch):
    """providers_for_call builds a new chain after its cache is cleared; the cooldown is still known."""
    monkeypatch.setattr(settings, "LLM_PROVIDER", "openai")
    monkeypatch.setattr(settings, "SARVAM_API_KEY", SecretStr(""))
    monkeypatch.setattr(settings, "PROVIDER_SECRETS_KEY", SecretStr(KEY_A))
    registry.invalidate()
    made = []

    def fake_build(pid, model, key, cfg):  # never a real provider: no request leaves the test
        name = registry.CATALOG[pid].provider
        link = Link(name, error=LLMError("rate_limit", "x")) if name == "groq" else Link(name, reply="Sure.")
        made.append(link)
        return link

    monkeypatch.setattr(registry, "build_llm", fake_build)

    async def go(db):
        await _seed(db, groq_llm={"enabled": True, "model": "openai/gpt-oss-120b", "priority": 1, "key": GROQ_KEY},
                    sarvam_llm={"enabled": True, "model": "sarvam-105b", "priority": 2, "key": "sarvam-key-0123456"})
        one = await registry.providers_for_call()
        await _say(one.llm)
        registry.invalidate()  # a saved change / the 30 s cache: a new chain object
        two = await registry.providers_for_call()
        await _say(two.llm)
        return one.llm, two.llm

    one, two = run(_with_db(go))
    assert one is not two
    groq_links = [lk for lk in made if lk.name == "groq"]
    assert len(groq_links) == 2 and len(groq_links[0].seen) == 1 and groq_links[1].seen == []


async def test_a_cooling_provider_is_still_tried_last_never_dropped(cooldown):
    groq = Link("groq", error=LLMError("rate_limit", "x"))
    await _say(_chain(groq, Link("sarvam", reply="Sure.")))
    groq.error, groq.reply = None, "Groq answered."
    assert await _say(_chain(groq, Link("sarvam", error=LLMError("provider", "x")))) == "Groq answered."


async def test_failover_stays_before_speech_only(cooldown):
    second = Link("sarvam", reply="Again.")
    talker = Link("groq", reply="Half", error=LLMError("provider", "x"), fail_after_text=True)
    with pytest.raises(LLMError):
        await _say(_chain(talker, second))
    assert second.seen == [] and llm._CHAIN_HEALTH == {}  # nothing said twice, nothing noted


async def test_a_refusal_is_not_a_cooldown(cooldown):
    with pytest.raises(LLMError):
        await _say(_chain(Link("anthropic", error=LLMError("blocked", "x")), Link("sarvam", reply="Sure.")))
    assert llm._CHAIN_HEALTH.get("anthropic:anthropic-model", {}).get("until", 0.0) == 0.0
