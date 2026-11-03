"""What the LLM is sent: LLM_HISTORY_MAX_MESSAGES (history cap, off by default) and
OUTCOME_NAMES_CALL_LANGUAGE (the classifier prompt names a Hindi / Kannada ... call's language, off by default)."""
import pytest

from app.core.config import settings
from app.services import call_service, llm_service as llm
from app.services.llm_service import ChainLLMProvider, trim_history
from tests.test_ai_providers import Link

GREETING = {"role": "assistant", "content": "Hi sir, Good morning."}


def _history(exchanges: int):
    out = [GREETING]
    for i in range(exchanges):
        out += [{"role": "user", "content": f"u{i}"}, {"role": "assistant", "content": f"a{i}"}]
    return out


# ------------------------------------------------------------------ history cap
def test_history_cap_off_by_default():
    assert settings.LLM_HISTORY_MAX_MESSAGES == 0
    assert trim_history(_history(10), 0) == _history(10)


def test_history_cap_keeps_the_greeting_and_the_latest_messages_from_a_customer_turn():
    trimmed = trim_history(_history(10), 4)
    assert trimmed == [GREETING, {"role": "user", "content": "u8"}, {"role": "assistant", "content": "a8"},
                       {"role": "user", "content": "u9"}, {"role": "assistant", "content": "a9"}]
    odd = trim_history(_history(10), 3)  # would start at an agent line: starts at the next customer line
    assert odd[0] == GREETING and odd[1] == {"role": "user", "content": "u9"}
    assert trim_history(_history(2), 10) == _history(2)  # short calls: unchanged


async def test_history_cap_applies_to_the_admin_chain_and_the_env_provider(monkeypatch, fakes):
    monkeypatch.setattr(settings, "LLM_HISTORY_MAX_MESSAGES", 2)
    link = Link("sarvam", reply="Okay.")
    chain = ChainLLMProvider(settings, [("sarvam", link)])
    [d async for d in chain.stream_response("S", _history(6), "latest", {})]
    sent = link.seen[0][1]
    assert sent[1] == GREETING and sent[-1] == {"role": "user", "content": "latest"} and len(sent) == 5
    [d async for d in fakes.llm.stream_response("S", _history(6), "latest", {})]
    assert fakes.llm.seen_messages[-1] == sent


async def test_without_the_cap_the_whole_history_is_sent(fakes):
    [d async for d in fakes.llm.stream_response("S", _history(6), "latest", {})]
    assert len(fakes.llm.seen_messages[-1]) == 2 + len(_history(6))  # "(call connected)" + history + latest


# ------------------------------------------------------------------ outcome prompt language
@pytest.mark.parametrize("lang", ["en", "ta", "hi", "kn", "te"])
def test_outcome_prompt_unchanged_when_off(lang):
    assert settings.OUTCOME_NAMES_CALL_LANGUAGE is False
    assert llm.outcome_system(lang) == llm.OUTCOME_SYSTEM


@pytest.mark.parametrize("lang, name", [("hi", "Hindi"), ("kn", "Kannada"), ("te", "Telugu")])
def test_outcome_prompt_names_the_call_language_when_on(monkeypatch, lang, name):
    monkeypatch.setattr(settings, "OUTCOME_NAMES_CALL_LANGUAGE", True)
    prompt = llm.outcome_system(lang)
    assert f"The transcript may be in {name}, English" in prompt and "Tanglish" not in prompt
    assert prompt.replace(prompt.splitlines()[-1], "") == llm.OUTCOME_SYSTEM.replace(llm.OUTCOME_SYSTEM.splitlines()[-1], "")


@pytest.mark.parametrize("lang", ["en", "ta"])
def test_english_and_tamil_keep_todays_outcome_prompt_even_when_on(monkeypatch, lang):
    monkeypatch.setattr(settings, "OUTCOME_NAMES_CALL_LANGUAGE", True)
    assert llm.outcome_system(lang) == llm.OUTCOME_SYSTEM


async def test_the_classifier_gets_the_call_language_prompt(monkeypatch):
    monkeypatch.setattr(settings, "OUTCOME_NAMES_CALL_LANGUAGE", True)
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "kn")
    link = Link("sarvam", reply='{"outcome": "busy", "reached": true, "summary": "Busy."}')
    raw = await call_service.classify_outcome(ChainLLMProvider(settings, [("sarvam", link)]), "Customer: busy")
    assert "busy" in raw and "Kannada" in link.seen[0][0]
