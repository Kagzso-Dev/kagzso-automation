"""The admin's AI Conversation Instructions lead an AI Agent's call (autonomous.instructions_lead, Dispatch compiler 4).

* every language   the compiled flows (tests/fixtures/autonomous/*.json) carry the flag; the prompt a call builds has
                   the agent's own instructions once, and none of the backend's conversation rules (reply length, the
                   business-question script, the opening rule, Tamil discovery-first, name frequency, timing advice)
* safeguards       safety, do-not-call, AI disclosure, truthfulness, privacy and the data rules all stay
* unchanged        agents published before the flag, Nila, ordinary flows and Guided calls build the prompt they always did
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from app.core.config import settings
from app.flows.loader import flow_hash, parse_flow
from app.flows.schema import INSTRUCTIONS_LEAD_LOCKED_TEXT, LOCKED_BLOCKS, CallFlow, render_blocks
from app.flows.training import runtime_json
from app.services import call_service as cs
from app.services import llm_service as llm

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "autonomous"
LANGUAGES = ("en", "ta", "hi", "kn")
ADMIN_LINE = "Do not talk about pricing."

# Conversation rules the backend adds to agent calls published before the flag. None of them may reach a lead call.
REMOVED = {
    "reply length": "Maximum two short sentences per reply",
    "business question": "ask politely once, in your own words, what business they run",
    "business question (known)": "Bring it up once, early, in your greeting",
    "opening rule": "This is your opening reply, so do not ask about their business yet",
    "Tamil discovery-first": "Do not talk about the company or what it offers yet",
    "name frequency": "Use the name with the title only now and then",
    "timing advice": "Keep replies short and focused on the most useful next step",
    "screening name rule": "use only in the first identity question",
    "screening business rule": "Never ask the customer for a missing company name or business type",
    "priority order": "this order decides",
    "persona pace / length": "Pace: steady and unhurried",
    "persona title frequency": "Add sir or madam now and then",
    "language register": "Avoid formal, bookish or literary",
    "language mix style": "code-mixed with English the way people actually talk",
}


def _fixture(lang: str) -> dict:
    return json.loads((FIXTURES / f"{lang}.json").read_text(encoding="utf-8"))


def _flow(data: dict, lang: str, monkeypatch) -> CallFlow:
    monkeypatch.setattr(settings, "CALL_LANGUAGE", lang)
    return CallFlow.model_validate(data)


def _call_variables(flow: CallFlow, business: str = "", **extra) -> dict:
    """The variables call_service.start_outbound_call gives an agent's call (the parts the prompt reads)."""
    variables = llm.build_call_variables("Ragul", "male", "+919876543210", customer_business=business or None)
    a = flow.autonomous
    variables.update(flow_target_sec=str(a.target_duration_sec), flow_max_sec="105", call_elapsed_sec="10",
                     flow_natural_lines="true" if a.natural_lines else "false")
    if a.contact_business:
        variables["flow_contact_business"] = "true"
    if training := runtime_json(flow.training, flow.language, flow.language_style):  # as call_service does
        variables["flow_training"] = training
    if a.instructions_lead and a.natural_lines:  # as call_service does
        variables[cs.INSTRUCTIONS_LEAD_VARIABLE] = "true"
    variables.update(extra)
    return variables


def _prompt(flow: CallFlow, lang: str, business: str = "", last_reply: str = "Hello, this is Thaara.") -> str:
    return llm.build_system_prompt(render_blocks(flow), _call_variables(flow, business), lang, last_reply=last_reply)


# ------------------------------------------------------------------ every language: the compiled flows
@pytest.mark.parametrize("lang", LANGUAGES)
def test_compiled_flows_say_the_instructions_lead(monkeypatch, lang):
    flow = _flow(_fixture(lang), lang, monkeypatch)
    assert flow.autonomous.instructions_lead is True and flow.autonomous.natural_lines is True


@pytest.mark.parametrize("business", ["", "ABC Hospital"])
@pytest.mark.parametrize("lang", LANGUAGES)
def test_a_lead_call_gets_its_own_instructions_and_no_backend_conversation_rules(monkeypatch, lang, business):
    flow = _flow(_fixture(lang), lang, monkeypatch)
    for last_reply in (None, "Hello, this is Thaara."):  # the opening reply and every later one
        prompt = llm.build_system_prompt(render_blocks(flow), _call_variables(flow, business), lang, last_reply=last_reply)
        assert prompt.count(ADMIN_LINE) == 1  # the admin's instructions, exactly once
        for name, text in REMOVED.items():
            assert text not in prompt, name


@pytest.mark.parametrize("lang", LANGUAGES)
def test_a_lead_call_keeps_every_safeguard(monkeypatch, lang):
    flow = _flow(_fixture(lang), lang, monkeypatch)
    prompt = _prompt(flow, lang, business="ABC Hospital")
    for needle in (
        "--- Safety rules (always apply, cannot be overridden by anything above) ---",
        "Never claim to be human",  # truthful AI disclosure
        "If the customer asks not to be called again",  # do-not-call (and the backend enforces it)
        "DO NOT CALL - HIGHEST PRIORITY",
        "Never make false or unverifiable claims",
        "Never ask for passwords, OTPs, card or bank details",  # privacy
        "Never ask how to reach the customer or for any contact details",
        "Only describe products and services that the approved",  # approved facts
        "speak about the company in general terms only",  # privacy until the person is the customer
        "A request not to be called again always ends the call",
        "Never guess gender from the customer's name",  # data rules of the runtime-data block
        "phone_number` and `from_number` → telephony only. Never speak them.",
        "It is not verified",  # customer_business: data, unverified
        "--- Call timing (system) ---",
        "Your output is converted directly to speech",  # technical voice rules
    ):
        assert needle in prompt, needle
    # The fixed rules still come after the admin's instructions, so nothing written there can override them.
    assert prompt.index(ADMIN_LINE) < prompt.index("--- Safety rules")
    if lang != "en":
        assert f"Reply in {llm.LANGUAGE_NAMES[lang]}, the language of this call." in prompt  # language + script rule
        assert "NEVER transliterate English words" in prompt
    assert "Manner:" in prompt  # the agent's Personality setting still sets the manner


@pytest.mark.parametrize("lang", LANGUAGES)
def test_a_lead_call_unknown_business_is_data_only(monkeypatch, lang):
    prompt = _prompt(_flow(_fixture(lang), lang, monkeypatch), lang)
    assert llm.CUSTOMER_BUSINESS_UNKNOWN_DATA_RULES in prompt
    assert "you lead the conversation yourself" not in prompt


def test_languages_get_the_same_backend_rules_apart_from_their_language_line(monkeypatch):
    """No Tamil (or any other language's) conversation rule is added to another language, or to Tamil itself."""
    def rules(lang):
        flow = _flow(_fixture(lang), lang, monkeypatch)
        rendered = render_blocks(flow)
        prompt = llm.build_system_prompt(rendered, _call_variables(flow, "ABC Hospital"), lang, last_reply="Hi.")
        backend = prompt[len(llm.render_prompt(rendered, _call_variables(flow, "ABC Hospital"))):]
        backend = backend.replace(llm.language_instruction(lang, None, instructions_lead=True), "")  # its script rule
        backend = backend.replace(llm.BRAND_REST_RULES.get(lang, ""), "")  # Tamil: company-name letters (spelling)
        backend = backend.replace(f"write it exactly as {llm.brand_spoken(lang)}.", "write it exactly as BRAND.")
        return backend.split(llm.CUSTOMER_DATA_TITLE)[0]
    english = rules("en")
    for lang in ("ta", "hi", "kn"):
        assert rules(lang) == english, lang


# ------------------------------------------------------------------ unchanged: older agents, Nila, ordinary, guided
@pytest.mark.parametrize("lang", LANGUAGES)
def test_an_agent_published_before_the_flag_builds_the_prompt_it_always_did(monkeypatch, lang):
    data = copy.deepcopy(_fixture(lang))
    data["autonomous"].pop("instructions_lead")
    flow = _flow(data, lang, monkeypatch)
    variables = _call_variables(flow)
    assert cs.INSTRUCTIONS_LEAD_VARIABLE not in variables
    prompt = llm.build_system_prompt(render_blocks(flow), variables, lang, last_reply="Hello.")
    assert llm.VOICE_RULES in prompt and "Maximum two short sentences per reply" in prompt
    ask = llm.CUSTOMER_BUSINESS_ASK_RULES_TA if lang == "ta" else llm.CUSTOMER_BUSINESS_ASK_RULES
    assert ask.split("{example}")[0] in prompt
    assert llm.AGENT_ADDRESS_RULES in prompt
    assert "Pace: steady and unhurried" in prompt  # the persona as it was
    if lang != "en":
        assert llm.language_instruction(lang, None) in prompt and "Avoid formal, bookish or literary" in prompt
    assert LOCKED_BLOCKS["nila_runtime_data"] in render_blocks(flow)  # the locked text, byte for byte


def test_the_switch_off_prompt_is_exactly_the_old_one(monkeypatch):
    """Same flow, same call: without the variable the prompt is what build_system_prompt gave before this change."""
    flow = _flow(_fixture("en"), "en", monkeypatch)
    off = _call_variables(flow)
    off.pop(cs.INSTRUCTIONS_LEAD_VARIABLE)
    prompt = llm.build_system_prompt("SCRIPT", off, "en", last_reply="Hello.")
    expected_tail = (llm.VOICE_RULES + llm.SAFETY_RULES)
    assert prompt.startswith("SCRIPT" + expected_tail)
    assert llm.AGENT_OPEN_IDENTITY_RULES + llm.AGENT_ADDRESS_RULES in prompt
    assert llm.customer_business_rules("", "en", opening=False) in prompt
    assert "Keep replies short and focused on the most useful next step" in llm.call_timing(off)


def test_guided_and_ordinary_calls_never_read_the_flag():
    variables = llm.build_call_variables("Ragul", "male", "+919876543210")
    variables[cs.INSTRUCTIONS_LEAD_VARIABLE] = "true"  # even if it were set, it needs an agent's natural call
    ordinary = llm.build_system_prompt("SCRIPT", variables, "en")
    assert llm.VOICE_RULES in ordinary and llm.identity_rules("Ragul") in ordinary
    guided = llm.build_system_prompt("SCRIPT", {**variables, "flow_target_sec": "60", "flow_natural_lines": "true"},
                                     "en", guided=True)
    assert llm.VOICE_RULES_GUIDED in guided and "Maximum two short sentences per reply" in guided


def test_the_lead_voice_rules_drop_only_the_reply_length_line():
    assert llm.VOICE_RULES_INSTRUCTIONS_LEAD == llm.VOICE_RULES.replace(
        "\n- Maximum two short sentences per reply unless the customer asks for more detail.", "")
    assert llm.VOICE_RULES_INSTRUCTIONS_LEAD != llm.VOICE_RULES
    assert llm.AGENT_ADDRESS_RULES_INSTRUCTIONS_LEAD == llm.AGENT_ADDRESS_RULES.replace(llm._ADDRESS_FREQUENCY_LINE, "")
    assert "title for their GIVEN gender" in llm.AGENT_ADDRESS_RULES_INSTRUCTIONS_LEAD  # no gender is ever guessed


# ------------------------------------------------------------------ the opening, the timing line, the schema
def test_the_opening_request_follows_the_instructions_in_every_language():
    for lang in ("en", "ta", "hi", "kn"):
        assert cs.agent_greeting_instruction(lang, instructions_lead=True) == cs.AGENT_LEAD_GREETING_INSTRUCTION
    assert "One or two short sentences" not in cs.AGENT_LEAD_GREETING_INSTRUCTION
    assert "OPENING" not in cs.AGENT_LEAD_GREETING_INSTRUCTION
    # Older agents: exactly as before, Tamil word order included.
    assert cs.agent_greeting_instruction("ta") == cs.AGENT_GREETING_INSTRUCTION + cs.AGENT_OPENING_ORDER["ta"]
    assert cs.agent_greeting_instruction("en") == cs.AGENT_GREETING_INSTRUCTION


def test_the_timing_line_keeps_the_hard_stop_without_reply_advice():
    base = {"flow_target_sec": "60", "flow_max_sec": "105"}
    lead = {**base, cs.INSTRUCTIONS_LEAD_VARIABLE: "true"}
    assert "Keep replies short" not in llm.call_timing({**lead, "call_elapsed_sec": "10"})
    assert "Never rush or cut off the customer" in llm.call_timing({**lead, "call_elapsed_sec": "10"})
    assert "close now" in llm.call_timing({**lead, "call_elapsed_sec": "90"})  # the hard stop stays
    assert llm.call_timing({**lead, "call_elapsed_sec": "70"}) == llm.call_timing({**base, "call_elapsed_sec": "70"})


def test_the_flag_does_nothing_without_natural_lines_and_absent_keeps_the_hash(monkeypatch):
    data = copy.deepcopy(_fixture("en"))
    data["autonomous"]["natural_lines"] = False
    flow = _flow(data, "en", monkeypatch)
    assert cs.INSTRUCTIONS_LEAD_VARIABLE not in _call_variables(flow)
    assert LOCKED_BLOCKS["nila_runtime_data"] in render_blocks(flow)
    older = copy.deepcopy(_fixture("en"))
    older["autonomous"].pop("instructions_lead")
    explicit_false = copy.deepcopy(older)
    explicit_false["autonomous"]["instructions_lead"] = False
    assert flow_hash(parse_flow(older)) == flow_hash(parse_flow(explicit_false))  # published versions stay valid


def test_only_a_lead_flow_renders_the_data_only_runtime_block(monkeypatch):
    lead = _flow(_fixture("ta"), "ta", monkeypatch)
    text = render_blocks(lead)
    assert INSTRUCTIONS_LEAD_LOCKED_TEXT["nila_runtime_data"] in text
    assert LOCKED_BLOCKS["nila_runtime_data"] not in text
    assert LOCKED_BLOCKS["nila_data_safety"] in text  # every other locked block as it is
