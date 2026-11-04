"""Autonomous AI Agent conversations, mocked end to end (fake STT / LLM / TTS / Plivo; nothing real is called).

The LLM is a fake, so these tests cannot judge how well a real model talks. They prove what the system controls:
what the model is given on every turn (approved knowledge for THAT turn, the no-invention rules, the history,
the timing hint, the language rule) and what the backend enforces whatever the model says (interruptions,
do-not-call, provider failures, the hard time limit, the call language's own fixed lines).

Scenarios: unexpected questions, missing knowledge, objections, follow-up questions, context memory, repeated
questions, customer interruption, customer refusal, do-not-call (en / ta / hi / kn), provider failures, maximum
duration and correct-language lines.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import call_service as cs
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_autonomous_agent import _capture_systems
from tests.test_call_policy import _agent_lines, _events, _finish, _rows, _say
from tests.test_fallback_line import _failing_llm
from tests.test_nila_flow import _call, _send, _start, _until

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "autonomous"
ANSWER = "It works alongside the software the hospital already uses."  # approved Q&A (k2)
ALWAYS = "Kagzso automates billing follow-ups"  # approved always-on fact (k1)
NO_INVENTION = "never guess or invent"


def _flow(lang: str, monkeypatch) -> dict:
    monkeypatch.setattr(settings, "CALL_LANGUAGE", lang)
    return json.loads((FIXTURES / f"{lang}.json").read_text(encoding="utf-8"))


def _dial(client, auth, flow, flow_id="agent_conv", **extra):
    return _call(client, auth, gender="male", flow_id=flow_id, flow_version=1, flow=flow, **extra)


def _converse(client, call_id, token, turns: int, on_open=None):
    """Opening, then `turns` customer utterances (the first one is answered by the identity question)."""
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        last = _until(ws, "checkpoint")  # opening
        if on_open:
            on_open()
        for _ in range(turns):
            last = _say(ws)
        _finish(ws, last)


# ------------------------------------------------------------------ knowledge, questions, memory
def test_questions_objections_follow_ups_memory_and_repeats(client, auth, fakes, sync_engine, monkeypatch):
    """One English agent call through every kind of customer turn."""
    flow = _flow("en", monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Thank you for asking."
    call_id, token = _dial(client, auth, flow)
    said = [
        "Hello?",
        "Yes, speaking",                                            # identity (answered by the system)
        "Do you have an office in Dubai?",                          # 1 unexpected question, nothing approved on it
        "We already have billing software, will it replace our software?",  # 2 objection with an approved answer
        "And what does it do for payment reminders?",              # 3 follow-up question
        "Sorry, again - will it replace our software?",            # 4 the same question repeated
    ]
    fakes.stt.replies = list(said)
    _converse(client, call_id, token, turns=len(said) - 1)
    assert len(systems) == 4  # one LLM reply per customer turn after the identity question
    unexpected, objection, follow_up, repeated = systems

    # Every turn: the approved always-on fact, the no-invention rules and the objection handling.
    for s in systems:
        assert ALWAYS in s and NO_INVENTION in s and "don't have that detail" in s
        assert "An objection or doubt" in s and "answer that question first" in s
    # Missing knowledge: nothing approved matches "an office in Dubai" -> no Q&A answer is given to the model.
    assert ANSWER not in unexpected
    # The objection turn and the repeated question get the approved answer; the turns that don't ask, don't.
    assert ANSWER in objection and ANSWER in repeated
    assert ANSWER not in follow_up

    # Context memory: each reply is asked with the whole conversation so far, in order.
    history = [m["content"] for m in fakes.llm.seen_messages[-1]]
    asked = [h for h in history if any(q in h for q in said[2:])]
    assert [next(q for q in said[2:] if q in h) for h in asked] == said[2:]
    assert history.count(fakes.llm.reply) >= 3  # the earlier answers are there too (consistent repeats)
    assert "do_not_call_detected" not in _events(sync_engine, call_id)


# ------------------------------------------------------------------ interruption
def test_customer_interrupts_the_agent(client, auth, fakes, sync_engine, monkeypatch):
    flow = _flow("en", monkeypatch)
    fakes.llm.reply = "Kagzso helps hospitals. It automates billing follow-ups. It also sends payment reminders. It saves staff time."
    fakes.tts.chunks_per_sentence = 20  # ~2 s per sentence still queued at Plivo: interruptible
    call_id, token = _dial(client, auth, flow)
    fakes.stt.replies = ["Hello?", "Yes", "What is this about?", "Wait, is this a sales call?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # opening
        _say(ws)  # identity question
        _say(ws)  # the long AI reply, still playing
        # The customer talks over it (no playedStream): playback is cleared at once.
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        msgs = []
        for _ in range(400):
            m = ws.receive_json()
            msgs.append(m)
            if m["event"] == "checkpoint":
                break
        assert {"event": "clearAudio", "streamId": "s-k"} in msgs
        _finish(ws, msgs[-1])
    assert "barge_in" in _events(sync_engine, call_id)
    # (The reply had been fully generated and handed to Plivo, so its transcript row is complete; a reply cut
    # off while still being generated is stored as interrupted - test_media_stream / test_recording.)
    # The interruption is answered with the conversation intact.
    assert any("Wait, is this a sales call?" in m["content"] for m in fakes.llm.seen_messages[-1])


# ------------------------------------------------------------------ refusal (not do-not-call)
def test_customer_refusal_ends_politely_without_do_not_call(client, auth, fakes, sync_engine, monkeypatch):
    flow = _flow("en", monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Okay, no problem. Thank you so much for your time. Have a nice day. [[END_CALL]]"
    call_id, token = _dial(client, auth, flow)
    fakes.stt.replies = ["Hello?", "Yes", "Not interested, thanks"]
    _converse(client, call_id, token, turns=2)
    lines = _agent_lines(sync_engine, call_id)
    assert lines[-1] == "Okay, no problem. Thank you so much for your time. Have a nice day."  # marker never spoken
    assert fakes.plivo.hangups == ["uuid-k"]
    assert "# NOT INTERESTED" in systems[-1] and "Do not ask why" in systems[-1]
    events = _events(sync_engine, call_id)
    assert "do_not_call_detected" not in events
    dnd = _rows(sync_engine, "select c.dnd from contacts c join calls k on k.contact_id = c.id where k.id = :id", call_id)
    assert not dnd[0][0]  # a refusal is not a do-not-call: the contact can be called again


# ------------------------------------------------------------------ do-not-call in every agent language
DNC = {
    "en": ("Please never call this number again", "Understood. I respect your request. Thank you."),
    "ta": ("இனிமே கால் பண்ணாதீங்க", "சரி, புரியுது. உங்க request-ஐ மதிக்கிறோம். நன்றி."),
    "hi": ("मुझे दोबारा कॉल मत करो", "ठीक है, आपकी request का पूरा सम्मान है. धन्यवाद."),
    "kn": ("ದಯವಿಟ್ಟು ಮತ್ತೆ ಕಾಲ್ ಮಾಡಬೇಡಿ", "ಸರಿ, ಅರ್ಥ ಆಯ್ತು. ನಿಮ್ಮ request-ಅನ್ನು ಗೌರವಿಸುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು."),
}


@pytest.mark.parametrize("lang", sorted(DNC))
def test_do_not_call_overrides_the_conversation_in_the_call_language(client, auth, fakes, sync_engine, monkeypatch, lang):
    assert settings.DNC_ENFORCE is False
    flow = _flow(lang, monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Thank you."
    request, line = DNC[lang]
    call_id, token = _dial(client, auth, flow, flow_id=f"agent_{lang}")
    fakes.stt.replies = ["Hello?", "Yes", "Tell me more", request]
    _converse(client, call_id, token, turns=3)
    assert _agent_lines(sync_engine, call_id)[-1] == line  # word for word, in the call's language
    assert len(systems) == 1  # the model answered "Tell me more" only, never the do-not-call turn
    assert fakes.plivo.hangups == ["uuid-k"]
    assert _rows(sync_engine, "select outcome from calls where id = :id", call_id)[0][0] == "do_not_call"


# ------------------------------------------------------------------ provider failures
@pytest.mark.parametrize("lang", ["en", "kn"])
def test_llm_failures_get_the_call_languages_fallback_then_a_polite_close(client, auth, fakes, sync_engine, monkeypatch, lang):
    flow = _flow(lang, monkeypatch)
    _failing_llm(fakes, monkeypatch, fail_times=2)
    call_id, token = _dial(client, auth, flow)
    fakes.stt.replies = ["Hello?", "Yes", "Tell me more", "Hello?"]
    _converse(client, call_id, token, turns=3)
    lines = _agent_lines(sync_engine, call_id)
    assert lines[-2] == cs.FALLBACK_REPLIES[lang]  # one clarification, in the call's language
    assert lines[-1] == flow["silence"]["closing"]  # then the flow's own closing line
    assert fakes.plivo.hangups == ["uuid-k"]
    assert _events(sync_engine, call_id).count("fallback_line") == 2


def test_a_telephony_failure_when_placing_the_call_is_reported_not_retried(client, auth, fakes, monkeypatch):
    flow = _flow("en", monkeypatch)
    fakes.plivo.fail_with = "rate_limited"
    body = {"phone_number": "+919876543210", "customer_name": "Ragul", "flow_id": "agent_x", "flow_version": 1, "flow": flow}
    from tests.test_nila_flow import _nila_id
    r = client.post("/api/calls/outbound", headers=auth, json={**body, "agent_id": _nila_id(client, auth)})
    assert r.status_code >= 400
    assert fakes.plivo.placed == []


# ------------------------------------------------------------------ maximum duration
def test_maximum_duration_is_the_providers_hard_limit_and_the_target_triggers_wrap_up(client, auth, fakes, sync_engine,
                                                                                      monkeypatch):
    flow = _flow("en", monkeypatch)
    assert flow["limits"]["max_duration_sec"] == 105 and flow["autonomous"]["target_duration_sec"] == 60
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Thank you."
    call_id, token = _dial(client, auth, flow)
    assert fakes.plivo.time_limits[-1] == 105  # Plivo cuts the call at 1:45 whatever is happening

    def past_the_target():  # as if the call had been running for 100 s (no real waiting)
        cs.ACTIVE_SESSIONS[call_id]._session_started -= 100

    fakes.stt.replies = ["Hello?", "Yes", "Tell me more"]
    _converse(client, call_id, token, turns=2, on_open=past_the_target)
    timing = systems[-1].split("--- Call timing (system) ---", 1)[1]
    assert "60" in timing and "close" in timing.lower()
