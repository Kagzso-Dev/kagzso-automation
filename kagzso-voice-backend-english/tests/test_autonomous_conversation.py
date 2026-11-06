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
import time
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import call_service as cs
from app.flows.training import KNOWLEDGE_TITLE
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_autonomous_agent import _capture_systems
from tests.test_call_policy import _agent_lines, _events, _finish, _rows, _say
from tests.test_fallback_line import _failing_llm
from tests.test_nila_flow import _call, _send, _start, _until

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "autonomous"
ANSWER = "It works alongside the software the hospital already uses."  # approved Q&A (k2)
ALWAYS = "Kagzso automates billing follow-ups"  # approved always-on fact (k1)
NO_INVENTION = "never guess or invent"
# Agents open the call in their own words (autonomous.natural_lines): the LLM answers "Hello?" with its greeting,
# then answers the customer's next words. The fake LLM's first two replies.
OPENING = {
    "en": ["Hello sir, this is Thaara from Kagzso Technology Services. How are you doing today?",
           "Thank you sir. I'm calling about automation for your hospital."],
    "ta": ["வணக்கம் sir, நான் Thaara, Kagzso Technology Services-லிருந்து பேசுகிறேன். எப்படி இருக்கீங்க?",
           "நன்றி sir. உங்க hospital-க்கு automation பத்தி பேசலாம்னு call பண்ணேன்."],
}


def _opening_then(fakes, lang: str, reply: str) -> None:
    """The natural opening (two LLM replies in the call's language), then `reply` for every later turn."""
    fakes.llm.replies = list(OPENING.get(lang, OPENING["en"]))
    fakes.llm.reply = reply


def _flow(lang: str, monkeypatch) -> dict:
    monkeypatch.setattr(settings, "CALL_LANGUAGE", lang)
    # Kannada autonomous calls are paused in production (AUTONOMOUS_CALLS_BLOCKED); these tests check the call
    # behaviour that applies once the native-speaker review lifts the pause.
    monkeypatch.setattr(cs, "AUTONOMOUS_CALLS_BLOCKED", {})
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
    _opening_then(fakes, "en", "Thank you for asking.")
    call_id, token = _dial(client, auth, flow)
    said = [
        "Hello?",                                                   # the AI greets and asks for Ragul
        "Yes, speaking",                                            # the AI says why it is calling
        "Do you have an office in Dubai?",                          # 1 unexpected question, nothing approved on it
        "We already have billing software, will it replace our software?",  # 2 objection with an approved answer
        "And what does it do for payment reminders?",              # 3 follow-up question
        "Sorry, again - will it replace our software?",            # 4 the same question repeated
    ]
    fakes.stt.replies = list(said)
    _converse(client, call_id, token, turns=len(said) - 1)
    assert len(systems) == 6  # the AI answers every customer turn, the opening ones too
    _hello, _yes, unexpected, objection, follow_up, repeated = systems
    assert _agent_lines(sync_engine, call_id)[:2] == OPENING["en"]  # its own words, no fixed greeting

    # Every turn: the approved always-on fact, the no-invention rules and the objection handling.
    for s in systems:
        assert ALWAYS in s and NO_INVENTION in s and "don't have that detail" in s
        assert "An objection or doubt" in s and "answer that question first" in s
    # All the approved knowledge is offered on every turn (the model reads it, whatever the language or wording),
    # most relevant first, and the rules above say what to do when none of it answers the question.
    first_line = lambda s: s.split(KNOWLEDGE_TITLE, 1)[1].splitlines()[0]  # noqa: E731
    assert all(ANSWER in s for s in systems)
    assert ANSWER in first_line(objection) and ANSWER in first_line(repeated)

    # Context memory: each reply is asked with the whole conversation so far, in order.
    history = [m["content"] for m in fakes.llm.seen_messages[-1]]
    asked = [h for h in history if any(q in h for q in said[2:])]
    assert [next(q for q in said[2:] if q in h) for h in asked] == said[2:]
    assert history.count(fakes.llm.reply) >= 3  # the earlier answers are there too (consistent repeats)
    assert "do_not_call_detected" not in _events(sync_engine, call_id)


# ------------------------------------------------------------------ interruption
def test_customer_interrupts_the_agent(client, auth, fakes, sync_engine, monkeypatch):
    flow = _flow("en", monkeypatch)
    _opening_then(fakes, "en",
                  "Kagzso helps hospitals. It automates billing follow-ups. It also sends payment reminders. It saves staff time.")
    call_id, token = _dial(client, auth, flow)
    fakes.stt.replies = ["Hello?", "Yes", "What is this about?", "Wait, is this a sales call?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # the AI's greeting
        _say(ws)  # the AI says why it is calling
        fakes.tts.chunks_per_sentence = 20  # ~2 s per sentence still queued at Plivo: interruptible
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
# A warm goodbye per language, the customer's refusal, and what they say over the goodbye.
GOODBYE = {
    "en": "Okay, no problem sir. Thank you so much for your time. Have a nice day.",
    "ta": "பரவாயில்ல sir, புரியுது. உங்க time-க்கு ரொம்ப thanks. Have a nice day sir.",
}
REFUSAL = {"en": "Not interested, thanks", "ta": "இப்போ interest இல்ல sir"}
OVER_GOODBYE = {"en": "Wait, do you have a website?", "ta": "Sorry, உங்க website என்ன?"}
WEBSITE = {"en": "Yes sir, it is kagzso.com.", "ta": "ஆமா sir, kagzso.com."}


@pytest.mark.parametrize("lang", ["en", "ta"])
def test_customer_refusal_ends_politely_without_do_not_call(client, auth, fakes, sync_engine, monkeypatch, lang):
    flow = _flow(lang, monkeypatch)
    systems = _capture_systems(fakes)
    _opening_then(fakes, lang, GOODBYE[lang] + " [[END_CALL]]")
    call_id, token = _dial(client, auth, flow, flow_id=f"agent_{lang}")
    fakes.stt.replies = ["Hello?", "Yes", REFUSAL[lang]]
    _converse(client, call_id, token, turns=2)
    lines = _agent_lines(sync_engine, call_id)
    assert lines[-1] == GOODBYE[lang]  # the warm goodbye is spoken in full; the marker never is
    assert fakes.plivo.hangups == ["uuid-k"]  # then the call ends naturally
    assert "# NOT INTERESTED" in systems[-1] and "Do not ask why" in systems[-1]
    # Said in its own words, in the call's language: no fixed English line is handed to the model.
    assert "Okay, no problem. Thank you so much for your time" not in systems[-1]
    assert "in your own words and in the call's language" in systems[-1]
    # A refusal gets a warm closing; only do-not-call ends the call at once.
    assert "gets one short, warm closing" in systems[-1]
    assert "refuses or asks not to be called again ends the call at once" not in systems[-1]
    events = _events(sync_engine, call_id)
    assert "do_not_call_detected" not in events
    dnd = _rows(sync_engine, "select c.dnd from contacts c join calls k on k.contact_id = c.id where k.id = :id", call_id)
    assert not dnd[0][0]  # a refusal is not a do-not-call: the contact can be called again


@pytest.mark.parametrize("lang", ["en", "ta"])
def test_words_over_the_goodbye_keep_an_agent_call_open(client, auth, fakes, sync_engine, monkeypatch, lang):
    assert settings.HANGUP_CANCEL_ON_BARGE_IN is False  # the shared switch stays off: agent calls only
    flow = _flow(lang, monkeypatch)
    _opening_then(fakes, lang, GOODBYE[lang] + " [[END_CALL]]")
    call_id, token = _dial(client, auth, flow, flow_id=f"agent_{lang}")
    fakes.stt.replies = ["Hello?", "Yes", REFUSAL[lang], OVER_GOODBYE[lang]]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # the AI's greeting
        _say(ws)  # the AI says why it is calling
        fakes.tts.chunks_per_sentence = 20  # the goodbye is still playing at Plivo: the hang-up is pending
        _say(ws)  # the goodbye, still playing
        fakes.llm.reply = WEBSITE[lang]
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # the customer talks over the goodbye
        _finish(ws, _until(ws, "checkpoint", limit=400))
    events = _events(sync_engine, call_id)
    assert "hangup_cancelled" in events and "agent_hangup" not in events
    assert fakes.plivo.hangups == []  # the call stays open
    assert _agent_lines(sync_engine, call_id)[-1] == WEBSITE[lang]  # and the customer is answered


# ------------------------------------------------------------------ natural lines: silent pick-up and silence
@pytest.mark.parametrize("lang", ["en", "ta"])
def test_silent_pickup_and_silence_are_said_by_the_ai_in_its_own_words(client, auth, fakes, sync_engine, monkeypatch, lang):
    monkeypatch.setattr(settings, "GREETING_DELAY_MS", 200)
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 0.6)
    flow = _flow(lang, monkeypatch)
    assert flow["autonomous"]["natural_lines"] is True
    said = [OPENING[lang][0], "Hello sir, can you hear me okay?", "No problem sir, I'll call another time. Have a nice day."]
    fakes.llm.replies = list(said)
    call_id, token = _dial(client, auth, flow, flow_id=f"agent_{lang}")
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, silence_mulaw(300))  # the customer picks up and says nothing, all call long
        for _ in range(3):  # greeting, check-in, goodbye - each played
            cp = _until(ws, "checkpoint")
            ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        deadline = time.time() + 5
        while not fakes.plivo.hangups and time.time() < deadline:
            time.sleep(0.05)
    # Each moment was the LLM's own reply to a one-off instruction (never stored as the customer's words).
    asked = [m[-1]["content"] for m in fakes.llm.seen_messages]
    assert asked == [cs.AGENT_GREETING_INSTRUCTION, cs.AGENT_SILENCE_REPROMPT_INSTRUCTION, cs.AGENT_SILENCE_CLOSE_INSTRUCTION]
    lines = _agent_lines(sync_engine, call_id)
    assert lines == said
    assert flow["silence"]["reprompt"] not in lines and flow["silence"]["closing"] not in lines  # no fixed lines
    assert fakes.plivo.hangups == ["uuid-k"]  # the call still ends after the silent goodbye
    customer = _rows(sync_engine, "select text from transcripts where call_id = :id and speaker = 'customer'", call_id)
    assert customer == []


# ------------------------------------------------------------------ busy / interested (follow-up switched off)
BUSY = {"en": "I'm busy right now, I'm in a meeting", "ta": "நான் இப்போ busy-ஆ இருக்கேன் sir"}
BUSY_CLOSE = {
    "en": "No problem sir. Thanks for your time. Have a nice day.",
    "ta": "பரவாயில்ல sir. உங்க time-க்கு thanks. Have a nice day sir.",
}
INTERESTED = {
    "en": ["Yes, tell me. We run a hospital.", "How do billing follow-ups work?"],
    "ta": ["ஆமா, சொல்லுங்க. நாங்க hospital நடத்துறோம்.", "Billing follow-up எப்படி வேலை செய்யும்?"],
}
NO_FOLLOW_UP = "No team follow-up is linked to this call"


@pytest.mark.parametrize("lang", ["en", "ta"])
def test_busy_customer_gets_a_polite_closing_without_a_callback(client, auth, fakes, sync_engine, monkeypatch, lang):
    monkeypatch.setattr(settings, "TEAM_FOLLOWUP_ENABLED", False)  # as in the local .env / .env.ta
    flow = _flow(lang, monkeypatch)
    systems = _capture_systems(fakes)
    _opening_then(fakes, lang, BUSY_CLOSE[lang] + " [[END_CALL]]")
    call_id, token = _dial(client, auth, flow, flow_id=f"agent_{lang}")
    fakes.stt.replies = ["Hello?", "Yes", BUSY[lang]]
    _converse(client, call_id, token, turns=2)
    assert _agent_lines(sync_engine, call_id)[-1] == BUSY_CLOSE[lang]
    assert fakes.plivo.hangups == ["uuid-k"]
    assert "# BUSY / NOT NOW" in systems[-1] and "never promise a callback" in systems[-1]
    assert "apologise briefly for disturbing them" in systems[-1]
    assert "No problem. Thanks for your time. Have a nice day." not in systems[-1]  # no fixed line to copy
    assert NO_FOLLOW_UP in systems[-1] and '"team_follow_up_configured": false' in systems[-1]
    assert "do_not_call_detected" not in _events(sync_engine, call_id)
    dnd = _rows(sync_engine, "select c.dnd from contacts c join calls k on k.contact_id = c.id where k.id = :id", call_id)
    assert not dnd[0][0]  # busy is not a do-not-call


@pytest.mark.parametrize("lang", ["en", "ta"])
def test_interested_customer_keeps_talking_past_the_target(client, auth, fakes, sync_engine, monkeypatch, lang):
    monkeypatch.setattr(settings, "TEAM_FOLLOWUP_ENABLED", False)  # as in the local .env / .env.ta
    flow = _flow(lang, monkeypatch)
    systems = _capture_systems(fakes)
    _opening_then(fakes, lang, "It sends the reminders for your team, sir.")
    call_id, token = _dial(client, auth, flow, flow_id=f"agent_{lang}")

    def past_the_target():  # 70 s into the call (no real waiting)
        cs.ACTIVE_SESSIONS[call_id]._session_started -= 70

    fakes.stt.replies = ["Hello?", "Yes", *INTERESTED[lang]]
    _converse(client, call_id, token, turns=3, on_open=past_the_target)
    assert len(systems) == 4  # every turn answered: the two opening turns and both of the customer's questions
    systems = systems[2:]
    assert fakes.plivo.hangups == []  # nothing ends the call while they are interested
    for s in systems:
        assert ALWAYS in s and NO_INVENTION in s  # approved facts only
        assert NO_FOLLOW_UP in s and '"team_follow_up_configured": false' in s
    timing = systems[-1].split("--- Call timing (system) ---", 1)[1]
    assert "continue naturally" in timing and "close now" not in timing
    history = [m["content"] for m in fakes.llm.seen_messages[-1]]
    assert all(any(q in h for h in history) for q in INTERESTED[lang])  # the conversation is kept, in order


# ------------------------------------------------------------------ do-not-call in every agent language
DNC = {
    "en": ("I'm busy now, don't call me again from now on", "Understood. I respect your request. Thank you."),
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
    assert _agent_lines(sync_engine, call_id)[-1] == line  # word for word, in the call's language (still fixed)
    assert len(systems) == 3  # the model answered "Hello?", "Yes" and "Tell me more", never the do-not-call turn
    assert fakes.plivo.hangups == ["uuid-k"]
    assert _rows(sync_engine, "select outcome from calls where id = :id", call_id)[0][0] == "do_not_call"


# ------------------------------------------------------------------ provider failures
@pytest.mark.parametrize("lang", ["en", "kn"])
def test_llm_failures_get_the_call_languages_fallback_then_a_polite_close(client, auth, fakes, sync_engine, monkeypatch, lang):
    flow = _flow(lang, monkeypatch)
    _failing_llm(fakes, monkeypatch, fail_times=2)
    call_id, token = _dial(client, auth, flow)
    # The AI says the opening itself, so the LLM being down shows at once: "Hello?" and "Yes" both fail.
    fakes.stt.replies = ["Hello?", "Yes"]
    _converse(client, call_id, token, turns=1)
    lines = _agent_lines(sync_engine, call_id)
    assert lines == [cs.FALLBACK_REPLIES[lang], flow["silence"]["closing"]]  # one clarification, then the close
    # (both fixed: with the LLM down, nothing else can speak - in the call's language)
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
@pytest.mark.parametrize("lang", ["en", "ta"])
@pytest.mark.parametrize("elapsed, expect, absent", [
    (70, "interested and asking relevant questions, continue naturally", "close now"),  # past the target
    (100, "ends the call at 105 seconds: close now", "continue naturally"),             # near the hard stop
])
def test_maximum_duration_is_the_providers_hard_limit_and_the_target_triggers_wrap_up(client, auth, fakes, sync_engine,
                                                                                      monkeypatch, lang, elapsed,
                                                                                      expect, absent):
    flow = _flow(lang, monkeypatch)
    assert flow["limits"]["max_duration_sec"] == 105 and flow["autonomous"]["target_duration_sec"] == 60
    systems = _capture_systems(fakes)
    fakes.llm.reply = "Thank you."
    call_id, token = _dial(client, auth, flow, flow_id=f"agent_{lang}")
    assert fakes.plivo.time_limits[-1] == 105  # Plivo cuts the call at 1:45 whatever is happening

    def running_for():  # as if the call had been running this long (no real waiting)
        cs.ACTIVE_SESSIONS[call_id]._session_started -= elapsed

    fakes.stt.replies = ["Hello?", "Yes", "Tell me more"]
    _converse(client, call_id, token, turns=2, on_open=running_for)
    timing = systems[-1].split("--- Call timing (system) ---", 1)[1]
    assert "60" in timing and expect in timing and absent not in timing
