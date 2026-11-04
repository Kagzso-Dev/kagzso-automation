"""Autonomous AI Agents address the customer by name with the title for the contact's GIVEN gender, in every
language: in the identity lines (Dispatch's AI_AGENT_OPENINGS, rendered here) and, as structured context
(address_as) with rules, on every LLM turn. The AI voice's gender plays no part. Other calls (Nila, Follow-up,
Executive, guided) keep their prompt exactly as before.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.config import LANGUAGE_NAMES, settings
from app.services import llm_service as ls
from app.services.call_service import identity_lines

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "autonomous"
AGENT_LANGUAGES = ("en", "ta", "hi", "kn")  # the languages AI Agents can be compiled for (AI_AGENT_OPENINGS)


def _vars(gender: str, name: str = "Ragul", agent: bool = True, voice: str | None = None) -> dict:
    v = ls.build_call_variables(name, gender, "+919876543210")
    if agent:
        v.update(flow_target_sec="60", flow_voice_profile="agent")
    if voice:
        v["flow_agent_voice"] = voice
    return v


def _data(prompt: str) -> dict:
    return json.loads(prompt.split(ls.CUSTOMER_DATA_TITLE, 1)[1].split("\n", 1)[0])


# ------------------------------------------------------------------ identity lines, every agent language
EXPECTED_IDENTITY = {
    "en": {"male": "Am I speaking with Ragul sir?", "female": "Am I speaking with Priya madam?",
           "unknown": "Am I speaking with Ragul?"},
    "ta": {"male": "Ragul sir-கிட்ட தான் பேசறேனா?", "female": "Priya madam-கிட்ட தான் பேசறேனா?",
           "unknown": "Ragul-கிட்ட தான் பேசறேனா?"},
    "hi": {"male": "क्या मेरी बात Ragul जी से हो रही है?", "female": "क्या मेरी बात Priya जी से हो रही है?",
           "unknown": "क्या मेरी बात Ragul जी से हो रही है?"},
    "kn": {"male": "ನಾನು Ragul sir ಅವರ ಜೊತೆ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆಯೇ?", "female": "ನಾನು Priya madam ಅವರ ಜೊತೆ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆಯೇ?",
           "unknown": "ನಾನು Ragul ಅವರ ಜೊತೆ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆಯೇ?"},
}


@pytest.mark.parametrize("lang", AGENT_LANGUAGES)
@pytest.mark.parametrize("gender", ["male", "female", "unknown"])
def test_identity_question_has_the_title_after_the_name(lang, gender):
    flow = json.loads((FIXTURES / f"{lang}.json").read_text(encoding="utf-8"))
    name = "Priya" if gender == "female" else "Ragul"
    question, reask = identity_lines(_vars(gender, name), flow["identity"]["question"], flow["identity"]["reask"])
    assert question == EXPECTED_IDENTITY[lang][gender]
    assert reask.startswith("Sorry, ") and reask.lower().endswith(question.lower())  # "Sorry, " + the same line
    assert "  " not in question and " -" not in question
    if gender == "unknown":
        assert "sir" not in question and "madam" not in question  # never guessed


def test_the_ai_voice_never_changes_the_customers_title():
    flow = json.loads((FIXTURES / "ta.json").read_text(encoding="utf-8"))
    # Roopa (female voice) calling a male customer: still "sir".
    q, _ = identity_lines(_vars("male", voice="roopa"), flow["identity"]["question"], flow["identity"]["reask"])
    assert q == "Ragul sir-கிட்ட தான் பேசறேனா?"


def test_an_empty_value_before_a_word_ending_takes_its_space_with_it():
    r = ls.render_first_message
    assert r("{{customer_name}} {{title}}-கிட்ட", _vars("unknown")) == "Ragul-கிட்ட"
    assert r("{{customer_name}} {{title}}-கிட்ட", _vars("male")) == "Ragul sir-கிட்ட"
    # Only an EMPTY value right before "-": everything else renders exactly as before.
    assert r("Hello - {{customer_name}} {{title}}, ok", _vars("unknown")) == "Hello - Ragul, ok"
    assert r("{{title}}-x", _vars("unknown")) == "-x"


# ------------------------------------------------------------------ address_as, every backend language
@pytest.mark.parametrize("lang", sorted(LANGUAGE_NAMES))
def test_address_as_in_every_language(lang):
    a = ls.address_as_for
    if lang == "hi":
        assert [a("Ragul", "male", lang), a("Priya", "female", lang), a("Ragul", "unknown", lang)] == \
               ["Ragul ji", "Priya ji", "Ragul ji"]
    else:
        assert [a("Ragul", "male", lang), a("Priya", "female", lang), a("Ragul", "unknown", lang)] == \
               ["Ragul sir", "Priya madam", "Ragul"]
    assert a("", "male", lang) == "" and a(None, "female", lang) == ""
    assert a("R. Karthick", "male", lang).startswith("Karthick")  # spoken name, initials dropped


# ------------------------------------------------------------------ every LLM turn of an agent call
@pytest.mark.parametrize("lang", AGENT_LANGUAGES)
@pytest.mark.parametrize("gender,expected", [("male", "sir"), ("female", "madam"), ("unknown", "")])
def test_agent_turns_get_address_as_and_the_rules(lang, gender, expected, monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", lang)
    name = "Priya" if gender == "female" else "Ragul"
    p = ls.build_system_prompt("# Agent\nTalk.", _vars(gender, name), language=lang)
    data = _data(p)
    want = f"{name} ji" if lang == "hi" else f"{name} {expected}".strip()
    assert data["address_as"] == want
    assert data["customer_name"] == name and data["gender"] == gender
    assert ls.AGENT_ADDRESS_RULES in p and ls.AGENT_IDENTITY_RULES in p
    assert ls.IDENTITY_RULES not in p  # "continue with whoever answered" is replaced for agent calls
    for rule in ("never one in every sentence", "asks to be addressed differently", "never translate sir or madam",
                 "is available to speak", "never explain the products", "Never assume that whoever answered"):
        assert rule.lower() in p.lower()


def test_agent_call_without_a_name_keeps_the_no_name_rules():
    p = ls.build_system_prompt("# Agent", _vars("male", name=""), language="en")
    assert _data(p)["address_as"] is None
    assert ls.NO_NAME_RULE in p and ls.AGENT_ADDRESS_RULES not in p


@pytest.mark.parametrize("guided", [False, True])
def test_other_calls_keep_their_prompt_exactly(guided):
    """Nila / Follow-up / Executive / guided: no address_as, no agent rules - the prompt is byte-identical to a
    prompt built without the agent switch."""
    v = _vars("male", agent=False)
    p = ls.build_system_prompt("# Nila\nTalk.", v, language="ta", guided=guided)
    assert "address_as" not in _data(p)
    assert ls.IDENTITY_RULES in p and ls.AGENT_ADDRESS_RULES not in p and ls.AGENT_IDENTITY_RULES not in p
    # A guided call never gets the agent rules, even with the agent variables.
    if guided:
        assert ls.AGENT_ADDRESS_RULES not in ls.build_system_prompt("# G", _vars("male"), language="ta", guided=True)
