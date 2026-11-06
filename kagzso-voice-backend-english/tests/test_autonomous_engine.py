"""The Autonomous AI Agent conversation: the LLM leads, the backend enforces.

The LLM here is a fake, so these tests can't judge how well a real model talks. They prove the structure: nothing
scripted reaches an autonomous call (no time-of-day greeting, no identity question, no sequence, no key lines), the
knowledge reaches the model whatever the wording or the language, nothing is promised because of a setting, and
the same changes never reach any other call. scripts/autonomous_conversation_check.py runs real conversations.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import settings
from app.flows.loader import parse_flow
from app.flows.schema import render_blocks
from app.flows.training import (DEFAULT_TOKEN_CAP, KNOWLEDGE_TITLE, TAIL_TITLE, compile_training, estimate_tokens)
from app.services import llm_service as llm
from tests.test_autonomous_agent import _capture_systems
from tests.test_autonomous_conversation import _dial, _flow, _opening_then, _converse
from tests.test_call_policy import _agent_lines, _events

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "autonomous"
LANGUAGES = ("en", "ta", "hi", "kn")


def _vars(name: str = "Ragul", gender: str = "male", natural: bool = True) -> dict:
    v = llm.build_call_variables(name, gender, "+919876543210")
    v.update(flow_target_sec="60", flow_max_sec="105")
    if natural:
        v["flow_natural_lines"] = "true"
    return v


def _compiled(lang: str) -> str:
    flow = parse_flow(json.loads((FIXTURES / f"{lang}.json").read_text(encoding="utf-8")))
    return render_blocks(flow)


def _knowledge(*items) -> dict:
    """A training payload as call_service sends it, with `items` as (topic, question or None, text)."""
    qa = [{"topic": t, "questions": [q], "text": a} for t, q, a in items if q]
    facts = [{"topic": t, "always": False, "text": a} for t, q, a in items if not q]
    return {"cap": DEFAULT_TOKEN_CAP, "qa": qa, "facts": facts, "phrases": [], "examples": []}


# ------------------------------------------------------------------ nothing scripted reaches the model
@pytest.mark.parametrize("lang", LANGUAGES)
def test_the_whole_prompt_of_a_natural_call_has_no_fixed_sequence(lang, monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", lang)
    prompt = llm.build_system_prompt(_compiled(lang), _vars(), language=lang)
    data = json.loads(prompt.split(llm.CUSTOMER_DATA_TITLE, 1)[1].split("\n", 1)[0])
    assert "time_greeting" not in data
    assert "HOW A GOOD BUSINESS CONVERSATION GOES" not in prompt  # the built-in numbered stages
    assert "Short introduction" not in prompt and "Permission" not in prompt
    assert "No problem, thanks for picking up." not in prompt  # a quoted line for "wrong person"
    assert "Am I speaking" not in prompt
    assert "This is a real conversation, not a script" in prompt
    # What stays: the honesty and safety rules, whatever the conversation does.
    assert "Never claim to be human" in prompt and "--- Safety rules" in prompt


def test_no_identity_check_but_private_details_wait_for_the_customer():
    prompt = llm.build_system_prompt("# Agent", _vars())
    assert llm.AGENT_OPEN_IDENTITY_RULES in prompt and llm.AGENT_IDENTITY_RULES not in prompt
    assert "There is no identity check on this call" in prompt
    assert "never mention `follow_up_detail`" in prompt
    assert "ask whether the customer (by `address_as`) is available" in prompt
    assert "Never pitch to them" in prompt
    assert "A request not to be called again always ends the call" in prompt


def test_a_call_without_a_name_gets_no_wrong_person_lines():
    prompt = llm.build_system_prompt("# Agent", _vars(name=""))
    assert llm.NO_NAME_RULE in prompt and llm.IDENTITY_RULES not in prompt
    assert "address_as" in prompt and llm.AGENT_ADDRESS_RULES not in prompt


def test_an_agent_published_before_natural_lines_keeps_its_rules():
    prompt = llm.build_system_prompt("# Agent", _vars(natural=False))
    assert llm.AGENT_IDENTITY_RULES in prompt and llm.AGENT_OPEN_IDENTITY_RULES not in prompt


@pytest.mark.parametrize("lang", ["en", "ta"])
def test_a_call_has_no_system_spoken_line_whatever_the_switches_say(client, auth, fakes, sync_engine, monkeypatch, lang):
    """Every reply is the LLM's, even with the switches that script other flows turned on."""
    monkeypatch.setattr(settings, "KEY_LINES_SCRIPTED", True)
    flow = _flow(lang, monkeypatch)
    systems = _capture_systems(fakes)
    _opening_then(fakes, lang, "Thank you.")
    call_id, token = _dial(client, auth, flow, flow_id=f"engine_{lang}")
    fakes.stt.replies = ["Hello?", "Yes", "Yes", "What is this about?"]
    _converse(client, call_id, token, turns=3)
    assert len(systems) == 4  # four customer turns, four LLM replies: nothing was answered by the system
    events = _events(sync_engine, call_id)
    assert "identity_question" not in events and "key_line" not in events
    assert flow["greeting"]["text"] not in _agent_lines(sync_engine, call_id)


def test_the_customer_can_change_direction_and_the_model_sees_the_whole_conversation(client, auth, fakes, monkeypatch):
    flow = _flow("en", monkeypatch)
    _opening_then(fakes, "en", "I see, thank you.")
    call_id, token = _dial(client, auth, flow, flow_id="engine_turn")
    said = ["Hello?", "Who is this?", "We run a hospital", "Actually my brother's hotel needs this more", "Can you do billing there?"]
    fakes.stt.replies = list(said)
    _converse(client, call_id, token, turns=4)
    history = " ".join(m["content"] for m in fakes.llm.seen_messages[-1])
    for words in said[1:]:
        assert words in history


# ------------------------------------------------------------------ knowledge
ITEMS = (
    ("Reminders", "How do payment reminders work?", "Reminders go out automatically on the due date."),
    ("Integration", "Will it replace our software?", "It works alongside the software you already use."),
    ("Kitchen orders", None, "Kitchen orders can be tracked from the billing counter."),
)


def _offered(block: str) -> list:
    return block.split(KNOWLEDGE_TITLE, 1)[1].splitlines()


def test_everything_approved_is_offered_most_relevant_first():
    text = compile_training(_knowledge(*ITEMS), "Will it replace our software?", None, []).text
    lines = _offered(text)
    assert len(lines) == len(ITEMS)
    assert "alongside the software" in lines[0]


def test_a_follow_up_that_names_no_topic_keeps_the_topic_of_the_conversation():
    payload = _knowledge(*ITEMS)
    text = compile_training(payload, "How does that work exactly?", None, ["We lose time on payment reminders"]).text
    assert "Reminders go out automatically" in _offered(text)[0]


def test_tamil_speech_reaches_knowledge_written_in_english():
    """Keyword matching alone finds nothing here, so the model has to be given the knowledge to understand it."""
    payload = _knowledge(*ITEMS)
    words = "பணம் கட்ட நினைவூட்டல் எப்படி அனுப்புவீங்க?"
    assert TAIL_TITLE not in compile_training(payload, words).text  # what every other flow's turn gets: nothing
    assert "Reminders go out automatically" in compile_training(payload, words, None, []).text


def test_the_token_cap_still_holds_and_the_most_relevant_item_survives():
    many = [(f"Topic {i}", None, f"Filler note number {i} about nothing in particular, repeated a few times over.")
            for i in range(200)]
    many.append(("Reminders", "How do payment reminders work?", "Reminders go out automatically on the due date."))
    payload = _knowledge(*many)
    compiled = compile_training(payload, "How do payment reminders work?", None, [])
    assert compiled.tokens <= DEFAULT_TOKEN_CAP
    assert "Reminders go out automatically" in compiled.text and compiled.dropped


def test_do_not_call_offers_no_knowledge():
    text = compile_training(_knowledge(*ITEMS), "Don't call me again", None, []).text
    assert "Reminders go out" not in text and "do-not-call line" in text


def test_other_calls_keep_picking_for_the_customers_last_words():
    text = compile_training(_knowledge(*ITEMS), "Will it replace our software?").text
    assert TAIL_TITLE in text and KNOWLEDGE_TITLE not in text
    assert "alongside the software" in text and "Reminders go out" not in text


def test_only_a_natural_agent_call_ranks_by_the_conversation():
    v = _vars()
    v["flow_training"] = json.dumps(_knowledge(*ITEMS))
    assert KNOWLEDGE_TITLE in llm.build_system_prompt("# A", v, user_message="hello", recent=["hi"])
    assert KNOWLEDGE_TITLE not in llm.build_system_prompt("# A", _vars_with_training(natural=False), user_message="hello", recent=["hi"])
    assert KNOWLEDGE_TITLE not in llm.build_system_prompt("# A", v, user_message="hello", recent=["hi"], guided=True)


def _vars_with_training(natural: bool) -> dict:
    v = _vars(natural=natural)
    v["flow_training"] = json.dumps(_knowledge(*ITEMS))
    return v


def test_the_conversation_reaches_retrieval_on_a_live_turn():
    v = _vars_with_training(natural=True)
    history = [{"role": "assistant", "content": "Hello."},
               {"role": "user", "content": "We lose time on payment reminders"},
               {"role": "assistant", "content": "I see."}]
    text = llm.turn_system_prompt("# A", history, "How does that work exactly?", v)
    assert "Reminders go out automatically" in text.split(KNOWLEDGE_TITLE, 1)[1].splitlines()[0]


# ------------------------------------------------------------------ nothing is promised because of a setting
@pytest.mark.parametrize("natural", [True, False])
def test_the_follow_up_setting_never_makes_an_agent_promise_anything(monkeypatch, natural):
    monkeypatch.setattr(llm.default_settings, "TEAM_FOLLOWUP_ENABLED", True)
    prompt = llm.build_system_prompt(_compiled("en"), _vars(natural=natural))
    assert llm.AGENT_NO_FOLLOW_UP in prompt
    assert "MUST include" not in prompt and "Our team will get in touch" not in prompt
    assert '"team_follow_up_configured": false' in prompt


def test_the_follow_up_setting_still_works_on_every_other_call(monkeypatch):
    monkeypatch.setattr(llm.default_settings, "TEAM_FOLLOWUP_ENABLED", True)
    prompt = llm.build_system_prompt("# Nila", llm.build_call_variables("Ragul", "male", "+919876543210"))
    assert "Our team will get in touch" in prompt and '"team_follow_up_configured": true' in prompt


# ------------------------------------------------------------------ the backend still enforces
def test_the_time_limit_does_not_depend_on_the_conversation(client, auth, fakes, monkeypatch):
    flow = _flow("en", monkeypatch)
    _dial(client, auth, flow, flow_id="engine_limit")
    assert flow["limits"]["max_duration_sec"] == 105 and fakes.plivo.time_limits[-1] == 105


def test_the_prompt_stays_a_size_a_live_turn_can_afford():
    prompt = llm.build_system_prompt(_compiled("en"), _vars())
    assert estimate_tokens(prompt) < 5500  # the prompt before the conversation rewrite was about 300 tokens smaller


# ------------------------------------------------------------------ the end-of-call marker, as models really write it
GOODBYE = "[[END_CALL]]\n\nUnderstood sir. Thank you for your time."


async def _sarvam_reply(monkeypatch, *deltas) -> str:
    """One streamed reply from Sarvam's server, each delta as its own SSE chunk."""
    monkeypatch.setattr(settings, "LLM_API_KEY", SecretStr("k"))
    monkeypatch.setattr(settings, "LLM_MODEL", "sarvam-105b-conversations")
    monkeypatch.setattr(settings, "LLM_FALLBACK_MODEL", "")

    def handler(request):
        body = "".join(f"data: {json.dumps({'choices': [{'delta': d}]})}\n\n" for d in deltas) + "data: [DONE]\n\n"
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    provider = llm.SarvamProvider(settings, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return "".join([d async for d in provider._stream("system", [{"role": "user", "content": "Not interested"}])])


async def test_a_reply_sarvam_misreads_as_a_tool_call_is_still_spoken(monkeypatch):
    """Seen live: a reply starting with the marker comes back as a tool call named after the whole reply, with no
    content. Dropping it answered "not interested" with "sorry, I couldn't hear you"."""
    misread = {"content": None, "tool_calls": [{"index": 0, "id": "x", "function": {"arguments": "{}", "name": GOODBYE}}]}
    text = await _sarvam_reply(monkeypatch, {"content": "", "role": "assistant"}, misread)
    spoken, ended = llm.extract_end_call(text)
    assert ended and llm.clean_spoken_text(spoken) == "Understood sir. Thank you for your time."


async def test_an_ordinary_sarvam_reply_is_unchanged(monkeypatch):
    text = await _sarvam_reply(monkeypatch, {"content": "Thank you. "}, {"content": "[[END_CALL]]"}, {"content": None})
    assert text == "Thank you. [[END_CALL]]"


@pytest.mark.parametrize("written", ["[[END_CALL]]", "[END_CALL]", "[[END CALL]]", "[end_call]", "[[END-CALL]]"])
def test_the_marker_is_never_spoken_however_it_is_spelled(written):
    for text in (f"{written} Thank you.", f"Thank you. {written}"):
        spoken, ended = llm.extract_end_call(text)
        assert spoken == "Thank you." and ended
        assert llm.clean_spoken_text(text) == "Thank you."


@pytest.mark.parametrize("text", ["Please end the call now", "I will end call soon", "[END] Thank you", "We [called] you"])
def test_ordinary_words_are_not_the_marker(text):
    assert llm.extract_end_call(text) == (text, False)
