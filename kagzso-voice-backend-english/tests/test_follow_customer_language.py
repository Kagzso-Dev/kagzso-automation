"""AGENT_FOLLOW_CUSTOMER_LANGUAGE (default off): a Tamil AI agent's call may follow a customer who speaks plain English.
Off = every language's rule exactly as before. On = only Tamil AI agent calls (mixed style) change; Tamil guided calls,
Tamil flows without natural lines, Hindi, Kannada, Telugu and English stay as they are."""
import pytest

from app.core.config import LANGUAGE_NAMES, settings
from app.services import llm_service as llm

FOLLOW = "Follow the customer's language: when the customer speaks to you in plain English, reply in simple spoken English"
ONE_LANGUAGE = "One call, one language"


def _before(language, style=None):
    """language_instruction as it was before AGENT_FOLLOW_CUSTOMER_LANGUAGE (kept here to prove "off" is unchanged)."""
    code = (language or "en").split("-")[0].strip().lower()
    name = LANGUAGE_NAMES.get(code)
    if not name or code == "en":
        return ""
    if style == "pure":
        return (
            f"\n- Always reply in simple, natural spoken {name}: the polite everyday {name} people use on a "
            f"phone call, never formal, bookish or literary.\n"
            f"- Use {name} words wherever a common {name} word exists. Keep in English (Latin letters) only "
            f"names, the company name and words people only say in English, such as WhatsApp or email.\n"
            f"- Write {name} words in {name} script. NEVER transliterate English words into {name} script.\n"
            f"- Example phrases in the instructions may be written in English or romanized {name}; say them in "
            f"{name}.\n"
            f"- Write numbers, times and dates as spoken {name} words.\n"
            f"- One call, one language: keep every reply in {name} even if the customer answers in English or "
            f"another language. Never switch whole replies to another language."
        )
    return (
        f"\n- Always reply in natural, everyday spoken {name} (code-mixed with English the way people "
        f"actually talk on a phone call).\n"
        f"- Write {name} words in {name} script. Write every English word in English (Latin) letters exactly "
        f"as spelled in English - e.g. 'Thank you sir', 'No problem', 'business', 'follow-up', 'Have a nice day'. "
        f"NEVER transliterate English words into {name} script.\n"
        f"- Example phrases in the instructions may be written in romanized {name} (e.g. Tanglish); convert only "
        f"the {name} words to {name} script.\n"
        f"- Avoid formal, bookish or literary {name}. Write numbers, times and dates as spoken {name} words.\n"
        f"- One call, one language: keep every reply in {name} (with everyday English words as above) even if "
        f"the customer answers in English or another language. Never switch whole replies to another language."
    )


LANGS = sorted(set(LANGUAGE_NAMES) | {"en", "ta-IN", "unknown"}) + [None]
STYLES = [None, "mixed", "pure"]


def test_the_switch_is_off_by_default():
    assert settings.AGENT_FOLLOW_CUSTOMER_LANGUAGE is False


@pytest.mark.parametrize("style", STYLES)
@pytest.mark.parametrize("language", LANGS)
def test_switch_off_is_exactly_as_before(language, style):
    assert llm.language_instruction(language, style) == _before(language, style)
    assert llm.language_instruction(language, style, follow_customer=False) == _before(language, style)


@pytest.mark.parametrize("style", STYLES)
@pytest.mark.parametrize("language", LANGS)
def test_switch_on_changes_only_tamil_mixed(language, style):
    got = llm.language_instruction(language, style, follow_customer=True)
    if language in ("ta", "ta-IN") and style != "pure":
        assert got.startswith(_before(language, style).split("- One call, one language")[0])
        assert FOLLOW in got and ONE_LANGUAGE not in got
    else:
        assert got == _before(language, style)


def _vars(**extra):
    v = llm.build_call_variables("Ragul", "male", "+919876543210", run_id="r", log_id="l")
    v.update(extra)
    return v


AGENT = {"flow_target_sec": "60", "flow_max_sec": "105", "flow_natural_lines": "true"}


@pytest.mark.parametrize("language", ["ta", "hi", "kn", "en"])
@pytest.mark.parametrize("call", ["agent", "agent_without_natural_lines", "guided", "flow"])
def test_only_a_tamil_ai_agent_call_gets_it(monkeypatch, language, call):
    variables = {"agent": _vars(**AGENT), "agent_without_natural_lines": _vars(flow_target_sec="60"),
                 "guided": _vars(**AGENT), "flow": _vars()}[call]
    guided = call == "guided"
    monkeypatch.setattr(settings, "AGENT_FOLLOW_CUSTOMER_LANGUAGE", False)
    off = llm.build_system_prompt("You are kayal.", variables, language, "நான் ஒரு textile shop நடத்துறேன்.", guided=guided)
    monkeypatch.setattr(settings, "AGENT_FOLLOW_CUSTOMER_LANGUAGE", True)
    on = llm.build_system_prompt("You are kayal.", variables, language, "நான் ஒரு textile shop நடத்துறேன்.", guided=guided)
    if language == "ta" and call == "agent":
        assert FOLLOW in on and FOLLOW not in off
        old_line = _before("ta").split("\n")[-1]  # the one line that changes, and nothing else
        new_line = llm.language_instruction("ta", None, follow_customer=True).split("\n")[-1]
        assert off.count(old_line) == 1 and on == off.replace(old_line, new_line)
    else:
        assert on == off  # byte for byte
        assert FOLLOW not in on
