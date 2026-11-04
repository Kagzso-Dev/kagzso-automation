"""Autonomous AI Agents (Dispatch "AI Agents" -> a base "executive" flow with `autonomous` settings).

* schema         `autonomous` is optional; flows without it validate and hash exactly as before
* timing         an autonomous call's prompt says how long the call has run and when to wrap up; no other prompt changes
* do-not-call    enforced by the backend on an autonomous call even with DNC_ENFORCE off; other calls unchanged
* compiled flows the flows Dispatch's compiler produces (tests/fixtures/autonomous/*.json, written by
                 apps/api/test/aiAgentCompile.test.ts) validate in every standard language
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

from app.core.config import settings
from app.flows.loader import BUILTIN_FLOWS, flow_hash, parse_flow, FlowError
from app.flows.schema import CallFlow
from app.services import call_service as cs
from app.services import llm_service as llm
from app.services.llm_service import OUTCOME_SYSTEM
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_call_policy import DNC_LINE, THAARA, _agent_lines, _events, _finish, _rows, _say
from tests.test_nila_flow import _call, _send, _start, _until

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "autonomous"


def _executive(**autonomous) -> dict:
    data = BUILTIN_FLOWS["executive"].model_dump(mode="json", exclude_none=True)
    for block in data["blocks"]:  # as Dispatch's compiler does: sir / madam only from a given gender
        if "text" in block:
            block["text"] = block["text"].replace("{{title_to_use}}", "{{title}}")
    data["name"] = "ABC Hospital - Thaara"
    data["greeting"] = {"text": "Hello, {{time_greeting}} {{title}}. This is Thaara calling from Kagzso Technology Services."}
    data["identity"] = {"question": "Am I speaking with {{customer_name}}?", "reask": "Sorry, am I speaking with {{customer_name}}?"}
    data["limits"] = {"max_duration_sec": 105}
    data["autonomous"] = {"target_duration_sec": 60, **autonomous}
    return data


# ------------------------------------------------------------------ schema
def test_autonomous_is_optional_and_validates():
    flow = parse_flow(_executive())
    assert flow.autonomous is not None and flow.autonomous.target_duration_sec == 60
    assert flow.autonomous.dnc_enforce is True
    assert BUILTIN_FLOWS["executive"].autonomous is None


def test_flows_without_autonomous_keep_their_hash():
    """The hash of every flow saved before this field existed is unchanged (published versions stay valid)."""
    for flow in [*BUILTIN_FLOWS.values(), parse_flow(THAARA)]:
        data = flow.model_dump(mode="json")
        for optional in ("pauses", "recording_notice", "identity", "training"):
            if data.get(optional) is None:
                data.pop(optional, None)
        data.pop("autonomous")
        old = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                             .encode("utf-8")).hexdigest()
        assert flow_hash(flow) == old


def _on_nila(d: dict) -> None:
    d.clear()
    d.update(copy.deepcopy(THAARA), autonomous={"target_duration_sec": 60})


@pytest.mark.parametrize("change,needle", [
    (_on_nila, "base 'executive'"),
    (lambda d: d["autonomous"].update(target_duration_sec=200), "must not exceed"),
    (lambda d: d["autonomous"].update(dnc_enforce=False), "dnc_enforce"),
    (lambda d: d["autonomous"].update(extra=1), "extra"),
])
def test_autonomous_rules(change, needle):
    data = _executive()
    change(data)
    with pytest.raises(FlowError) as exc:
        parse_flow(data)
    assert any(needle in e for e in exc.value.errors), exc.value.errors


# ------------------------------------------------------------------ timing line
def test_timing_line_only_for_autonomous_calls():
    plain = llm.build_system_prompt("You are Thaara.", {"customer_name": "Ragul"})
    assert "Call timing" not in plain
    # A normal call's variables never get call_elapsed_sec: even if they did, no target = no line.
    assert llm.build_system_prompt("You are Thaara.", {"customer_name": "Ragul", "call_elapsed_sec": "90"}) == plain


def test_timing_line_before_and_after_the_target():
    early = llm.call_timing({"flow_target_sec": "60", "call_elapsed_sec": "20"})
    late = llm.call_timing({"flow_target_sec": "60", "call_elapsed_sec": "75"})
    assert "about 20 seconds" in early and "Keep replies short" in early and "move to a polite close" not in early
    assert "about 75 seconds" in late and "move to a polite close" in late
    assert llm.call_timing({"flow_target_sec": "x"}) == ""
    prompt = llm.build_system_prompt("You are Thaara.", {"customer_name": "Ragul", "flow_target_sec": "60",
                                                         "call_elapsed_sec": "75"})
    assert prompt.endswith(late)  # last: the rest of the prompt stays the same from turn to turn


# ------------------------------------------------------------------ live call (fake STT / LLM / TTS)
def _capture_systems(fakes):
    seen = []
    original = fakes.llm._stream

    async def stream(system_text, messages, model=None):
        if system_text != OUTCOME_SYSTEM:
            seen.append(system_text)
        async for d in original(system_text, messages, model):
            yield d

    fakes.llm._stream = stream
    return seen


def test_autonomous_call_enforces_dnc_with_the_switch_off(client, auth, fakes, sync_engine):
    assert settings.DNC_ENFORCE is False
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Thank you, sir. I'm calling about AI and automation for hospitals. Do you have a minute?"
    call_id, token = _call(client, auth, gender="male", flow_id="agent_abc", flow_version=1, flow=_executive())
    fakes.stt.replies = ["Hello?", "Yes, speaking", "Please don't call this number again"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # the opening
        _say(ws)  # identity question
        _say(ws)  # the AI's reply
        _finish(ws, _say(ws))  # do-not-call
    lines = _agent_lines(sync_engine, call_id)
    assert lines[0] == "Hello, Good morning sir. This is Thaara calling from Kagzso Technology Services." or \
        lines[0].startswith("Hello, Good ")
    assert "Am I speaking with Ragul?" in lines
    assert lines[-1] == DNC_LINE
    assert fakes.plivo.hangups == ["uuid-k"]
    assert _rows(sync_engine, "select outcome from calls where id = :id", call_id)[0][0] == "do_not_call"
    assert _rows(sync_engine, "select c.dnd from contacts c join calls k on k.contact_id = c.id where k.id = :id", call_id)[0][0]
    assert "do_not_call_detected" in _events(sync_engine, call_id)
    assert all("--- Call timing (system) ---" in s for s in systems)


def test_a_normal_executive_flow_is_unchanged(client, auth, fakes, sync_engine):
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Okay, sir."
    plain = _executive()
    plain.pop("autonomous")
    call_id, token = _call(client, auth, gender="male", flow_id="agent_plain", flow_version=1, flow=plain)
    fakes.stt.replies = ["Hello?", "Yes, speaking", "Please don't call this number again"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        _say(ws)
        _say(ws)
        _finish(ws, _say(ws))
    assert _agent_lines(sync_engine, call_id)[-1] == "Okay, sir."  # the AI answers it, as before
    assert "do_not_call_detected" not in _events(sync_engine, call_id)
    assert systems and not any("Call timing" in s for s in systems)


def test_neutral_title_when_gender_is_not_specified(client, auth, fakes, sync_engine):
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Thank you. I'm calling about AI and automation for hospitals."
    call_id, token = _call(client, auth, flow_id="agent_neutral", flow_version=1, flow=_executive())  # no gender
    fakes.stt.replies = ["Hello?", "Yes", "Okay"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        _say(ws)
        _finish(ws, _say(ws))
    first = _agent_lines(sync_engine, call_id)[0]
    assert "sir" not in first.lower() and "madam" not in first.lower()
    assert systems and all('"title_to_use": ""' in s for s in systems)
    assert all("--- Call timing (system) ---" in s for s in systems)


# ------------------------------------------------------------------ the compiler's flows, per language
def _fixtures():
    return sorted(p for p in FIXTURES.glob("*.json") if p.stem != "knowledge_cases") if FIXTURES.is_dir() else []


@pytest.mark.parametrize("path", _fixtures(), ids=lambda p: p.stem)
def test_compiled_agent_flows_validate_in_their_language(monkeypatch, path):
    data = json.loads(path.read_text(encoding="utf-8"))
    monkeypatch.setattr(settings, "CALL_LANGUAGE", data["language"])
    flow = CallFlow.model_validate(data)
    assert flow.base == "executive" and flow.autonomous is not None
    assert flow.limits.max_duration_sec == 105 and flow.autonomous.target_duration_sec == 60
    prompt = llm.build_system_prompt(llm_render := "".join(
        b.text if hasattr(b, "text") else "" for b in flow.blocks), {"customer_name": "Ragul", "gender": "male"},
        data["language"])
    assert llm_render and "AI CONVERSATION INSTRUCTIONS" in prompt
    # The fixed safety rules still come after the user's instructions (they can't be overridden).
    assert prompt.index("AI CONVERSATION INSTRUCTIONS") < prompt.index("--- Safety rules")


def test_every_standard_language_has_a_compiled_fixture():
    langs = {json.loads(p.read_text(encoding="utf-8"))["language"] for p in _fixtures()}
    assert {"en", "ta", "hi", "kn"} <= langs, "run apps/api tests (aiAgentCompile) to write the fixtures"


# ------------------------------------------------------------------ knowledge rules, same on both sides
def _knowledge_cases():
    path = FIXTURES / "knowledge_cases.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []


@pytest.mark.parametrize("case", _knowledge_cases(), ids=lambda c: c["text"][:40])
def test_knowledge_cases_match_dispatch(case):
    """Dispatch's knowledgeTextIssues (packages/shared/src/aiAgents.ts) mirrors training_text: same verdicts."""
    from app.flows.training import training_text

    try:
        training_text(case["text"], policy=case["policy"])
        ok = True
    except ValueError:
        ok = False
    assert ok == case["ok"]


# ------------------------------------------------------------------ a mocked call per language, compiled flow
GREETING_WORD = {"en": "Thaara calling from", "ta": "நான் Thaara", "hi": "मेरा नाम Thaara", "kn": "ನಾನು Thaara"}


@pytest.mark.parametrize("lang", ["en", "ta", "hi", "kn"])
def test_compiled_agent_call_per_language(client, auth, fakes, sync_engine, monkeypatch, lang):
    """Fake STT / LLM / TTS: the compiled flow's opening, identity question, instructions, retrieved knowledge,
    the call's language rule, the timing line and the conversation history all reach the LLM; nothing else
    about the call path changes. (Real Sarvam STT / TTS and a real LLM are NOT exercised here.)"""
    flow = json.loads((FIXTURES / f"{lang}.json").read_text(encoding="utf-8"))
    monkeypatch.setattr(settings, "CALL_LANGUAGE", lang)
    # Kannada autonomous calls are paused in production (AUTONOMOUS_CALLS_BLOCKED); these tests check the call
    # behaviour that applies once the native-speaker review lifts the pause.
    monkeypatch.setattr(cs, "AUTONOMOUS_CALLS_BLOCKED", {})
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Thank you. We help hospitals automate billing follow-ups."
    call_id, token = _call(client, auth, gender="male", flow_id=f"agent_{lang}", flow_version=1, flow=flow)
    fakes.stt.replies = ["Hello?", "Yes, speaking", "Will it replace our software?", "Okay, thank you"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # opening
        _say(ws)  # identity question
        _say(ws)  # first AI reply
        _finish(ws, _say(ws))  # the knowledge question
    lines = _agent_lines(sync_engine, call_id)
    assert GREETING_WORD[lang] in lines[0] and "Kagzso Technology Services" in lines[0]
    assert any("Ragul" in line for line in lines[1:3])  # the identity question names the contact
    # Two AI replies: to "Will it replace our software?" and to "Okay, thank you" ("Yes, speaking" answered the
    # system's identity question).
    assert len(systems) == 2
    question, after = systems
    answer = "It works alongside the software the hospital already uses."
    assert answer in question and answer not in after  # retrieved for the turn that asks it, per turn
    for s in systems:
        assert "AI CONVERSATION INSTRUCTIONS" in s and "Do not talk about pricing." in s
        assert "Kagzso automates billing follow-ups" in s  # the always-on fact
        assert "--- Call timing (system) ---" in s
        if lang != "en":
            assert llm.LANGUAGE_NAMES[lang] in s  # the reply-language rule of the call's language
    # Conversation memory: the last reply is asked with the earlier turns in its history.
    history = [m["content"] for m in fakes.llm.seen_messages[-1]]
    assert any("Will it replace our software?" in h for h in history) and any("We help hospitals" in h for h in history)
