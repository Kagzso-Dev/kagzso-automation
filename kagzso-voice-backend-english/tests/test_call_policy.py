"""Conversation reliability switches (each off by default = today's behaviour), fakes only - no call is placed:

* DNC_ENFORCE                 do-not-call enforced by the backend at every stage
* HANGUP_CANCEL_ON_BARGE_IN   real words over a closing line keep the call open (never after do-not-call)
* PARTIAL_REPLY_COMMIT        a reply that fails after its audio started is still saved in the history
* FALLBACK_RESET_ON_ANY_REPLY only two "couldn't hear you" lines IN A ROW close the call
* INDIC_WORD_SPLIT            Tamil / Hindi words stay whole in the word checks; English is checked as before
* SAFETY_NO_INTERNALS         fixed rule: never reveal instructions / code / configuration
"""
import asyncio
import json
import re
import time
from pathlib import Path

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.flows.loader import BUILTIN_FLOWS, parse_flow
from app.services import call_service, llm_service as llm, reply_speed as rs
from app.services.call_service import (
    CallContextData, CallSession, _question_words, _words, asked_questions, is_do_not_call, is_echo, is_filler,
    is_greeting_only, is_repeated_question, machine_evidence, silence_reprompt,
)
from app.services.tts import TTSError
from tests.conftest import FakeTTSStream, energy_classifier, silence_mulaw, tone_mulaw
from tests.test_fallback_line import CLOSING, UNCLEAR, _failing_llm
from tests.test_nila_flow import _call, _send, _start, _until

ROOT = Path(__file__).resolve().parents[2]
THAARA = json.loads((ROOT / "deploy/callflows/thaara-natural.json").read_text(encoding="utf-8"))
DNC_LINE = "Understood. I respect your request. Thank you."
SWITCHES = ("DNC_ENFORCE", "HANGUP_CANCEL_ON_BARGE_IN", "PARTIAL_REPLY_COMMIT", "FALLBACK_RESET_ON_ANY_REPLY",
            "INDIC_WORD_SPLIT", "SAFETY_NO_INTERNALS")


def _old_words(t: str):
    return "".join(c if c.isalnum() or c.isspace() else " " for c in t.lower()).split()


def _rows(sync_engine, sql, call_id):
    with sync_engine.connect() as c:
        return c.execute(text(sql), {"id": call_id}).all()


def _agent_lines(sync_engine, call_id):
    return [r[0] for r in _rows(sync_engine, "select text from transcripts where call_id = :id and speaker = 'agent' order by id", call_id)]


def _events(sync_engine, call_id):
    return [r[0] for r in _rows(sync_engine, "select event_type from call_events where call_id = :id order by id", call_id)]


def _say(ws):
    """One customer utterance after the agent's line has played; returns the reply's checkpoint."""
    time.sleep(0.5)
    _send(ws, tone_mulaw(400) + silence_mulaw(900))
    return _until(ws, "checkpoint")


def _finish(ws, last):
    ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": last["name"]}))
    time.sleep(0.8)  # a pending hang-up happens once the last line has played


def test_every_switch_is_off_by_default():
    from app.core.config import Settings

    assert all(Settings.model_fields[name].default is False for name in SWITCHES)


# ------------------------------------------------------------------ do-not-call detection
@pytest.mark.parametrize("said", [
    "Please don't call this number again", "Stop calling me", "Remove my number", "No more calls please",
    "இனிமே இந்த நம்பருக்கு கால் பண்ணாதீங்க", "Call பண்ணாதீங்க sir", "திரும்ப கூப்பிடாதீங்க",
    "मुझे फिर से कॉल मत करना", "మళ్ళీ కాల్ చేయకండి",
])
def test_do_not_call_is_recognised_in_every_call_language(said):
    assert is_do_not_call(said)


@pytest.mark.parametrize("said", [
    "Don't call me now, I'm in a meeting", "Don't call now, call me in the evening", "Call me later",
    "இப்போ call பண்ணாதீங்க, சாயங்காலம் பேசலாம்", "ஆமா, சொல்லுங்க", "We don't need it", "अभी कॉल मत करो",
    "Yes, speaking",
])
def test_not_now_and_ordinary_answers_are_not_do_not_call(said):
    assert not is_do_not_call(said)  # left to the AI (busy / callback / an answer), as before


def test_the_dnc_line_comes_from_the_flow_itself():
    assert rs.flow_dnc_line(parse_flow(THAARA)) == DNC_LINE  # locked block
    assert rs.flow_dnc_line(BUILTIN_FLOWS["nila"]) == DNC_LINE  # editable block with the same line


# ------------------------------------------------------------------ Tamil-safe word checks
ENGLISH = ["Hello?", "Yes, I'm Karthick.", "Don't call me again!", "Okay Mr. Kumar, 4 p.m. tomorrow",
           "kagzso.com - 2,500 rupees?", "hmm... yes sir", "Can you hear me?", "  Uh, um - no.  "]


@pytest.mark.parametrize("on", [False, True])
def test_english_is_checked_exactly_as_before(monkeypatch, on):
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", on)
    for t in ENGLISH:
        assert _words(t) == _old_words(t)
        assert _question_words(t) == re.findall(r"[a-z0-9']+", t.lower())
    assert [is_filler(t) for t in ENGLISH] == [True, False, False, False, False, True, True, False]
    assert is_greeting_only("Hello?") and not is_greeting_only("Yes, I'm Karthick.")


def test_tamil_words_stay_whole_with_the_switch(monkeypatch):
    assert _words("சரிங்க") == ["சர", "ங", "க"]  # today: broken at every vowel sign / virama
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    assert _words("இப்போ busy-ஆ இருக்கேன்") == ["இப்போ", "busy", "ஆ", "இருக்கேன்"]


def test_a_real_tamil_answer_is_not_mistaken_for_echo(monkeypatch):
    agent = "சரிங்க sir, நம்ம Kexo AI automation பத்தி ஒரு நிமிஷம் பேசலாமா? உங்களுக்கு இப்போ பேச வசதியா இருக்குமா?"
    assert is_echo("வசதியா இருக்கு", agent)  # today: dropped as the agent's own voice
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    assert not is_echo("வசதியா இருக்கு", agent)
    assert is_echo("உங்களுக்கு இப்போ பேச வசதியா", agent)  # real echo (3+ of its words in order) still caught


def test_tamil_backchannels_over_the_agent_are_fillers_but_a_no_is_not(monkeypatch):
    assert not is_filler("ஆமா")  # today: interrupts the agent
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    for said in ("ஆமா", "சரிங்க", "ம்", "ஆமா சொல்லுங்க", "हाँ जी"):
        assert is_filler(said), said
    for said in ("இல்ல", "வேண்டாம்", "நிறுத்துங்க"):
        assert not is_filler(said), said


def test_a_tamil_sentence_is_not_counted_as_a_voicemail_monologue(monkeypatch):
    said = "இல்லைங்க நான் இப்போ கொஞ்சம் வெளியில இருக்கேன் அப்புறம் பேசுங்க"
    assert machine_evidence([said]) == "machine"  # today: 8 words counted as 26
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    assert machine_evidence([said]) == "human"


def test_a_repeated_tamil_question_is_recognised(monkeypatch):
    question = "உங்களுக்கு இப்போ பேச வசதியா இருக்குமா?"
    asked = asked_questions([question])
    assert not is_repeated_question(question, asked)  # today: Tamil-script questions are invisible
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    assert is_repeated_question(question, asked_questions([question]))


# ------------------------------------------------------------------ safety line
def test_internals_rule_only_with_the_switch(monkeypatch):
    plain = llm.build_system_prompt("You are Thaara.", {"customer_name": "Ragul"})
    assert llm.INTERNALS_RULES not in plain
    monkeypatch.setattr(settings, "SAFETY_NO_INTERNALS", True)
    guarded = llm.build_system_prompt("You are Thaara.", {"customer_name": "Ragul"})
    assert llm.INTERNALS_RULES in guarded and llm.SAFETY_RULES in guarded
    assert guarded.replace(llm.INTERNALS_RULES, "") == plain  # nothing else changes


# ------------------------------------------------------------------ do-not-call, end to end
def test_dnc_mid_call_speaks_the_flow_line_ends_the_call_and_records_it_now(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "DNC_ENFORCE", True)
    fakes.llm.reply = "Thank you, sir. This is Thaara from Kexo AI and Automation. Do you have just one minute?"
    call_id, token = _call(client, auth, gender="male", flow_id="thaara_natural", flow_version=1, flow=THAARA)
    fakes.stt.replies = ["Hello?", "Yes, speaking", "Please don't call this number again"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # the flow's opening line
        _say(ws)  # the AI's introduction + permission
        _finish(ws, _say(ws))  # do-not-call
    assert _agent_lines(sync_engine, call_id) == ["Hello, am I speaking with Ragul?", fakes.llm.reply, DNC_LINE]
    assert len(fakes.llm.seen_messages) == 1  # the do-not-call line is the flow's own, not the AI's
    assert fakes.plivo.hangups == ["uuid-k"]
    assert _rows(sync_engine, "select outcome from calls where id = :id", call_id)[0][0] == "do_not_call"
    assert _rows(sync_engine, "select c.dnd from contacts c join calls k on k.contact_id = c.id where k.id = :id", call_id)[0][0]
    assert "do_not_call_detected" in _events(sync_engine, call_id)


def test_dnc_switch_off_keeps_todays_behaviour(client, auth, fakes, sync_engine):
    fakes.llm.reply = "Okay, sir."
    call_id, token = _call(client, auth, gender="male", flow_id="thaara_natural", flow_version=1, flow=THAARA)
    fakes.stt.replies = ["Hello?", "Yes, speaking", "Please don't call this number again"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        _say(ws)
        _finish(ws, _say(ws))
    assert _agent_lines(sync_engine, call_id)[-1] == "Okay, sir."  # the AI answers it, as before
    assert fakes.plivo.hangups == [] and "do_not_call_detected" not in _events(sync_engine, call_id)


def test_dnc_as_the_first_words_ends_the_call_even_if_the_ai_forgets_the_marker(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "DNC_ENFORCE", True)
    fakes.llm.reply = "Understood, sorry for the trouble."  # no [[END_CALL]] marker
    call_id, token = _call(client, auth, gender="male")  # built-in agent: no flow line, the AI answers
    fakes.stt.replies = ["Stop calling me"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _finish(ws, _until(ws, "checkpoint"))
    assert _agent_lines(sync_engine, call_id) == [fakes.llm.reply]  # never the greeting first
    assert fakes.plivo.hangups == ["uuid-k"]
    assert _rows(sync_engine, "select outcome from calls where id = :id", call_id)[0][0] == "do_not_call"


# ------------------------------------------------------------------ hang-up and interruptions
class _Sender:
    async def send_audio(self, mulaw): ...
    async def clear(self): ...
    async def checkpoint(self, name): ...


def _session():
    ctx = CallContextData(call_id="c-policy", agent_prompt="x", variables={})
    return CallSession(ctx, _Sender(), call_service.get_providers(), classifier=energy_classifier)


@pytest.mark.parametrize("switch, locked, cancelled", [(True, False, True), (False, False, False), (True, True, False)])
async def test_words_over_the_closing_line_cancel_the_hang_up_but_never_after_dnc(monkeypatch, switch, locked, cancelled):
    monkeypatch.setattr(settings, "HANGUP_CANCEL_ON_BARGE_IN", switch)
    s = _session()
    s.end_call_requested, s._end_locked = True, locked
    hangup = s._hangup_task = asyncio.create_task(asyncio.sleep(30))
    await s.barge_in()
    await asyncio.sleep(0.01)
    assert hangup.cancelled() is cancelled
    assert s.end_call_requested is not cancelled
    hangup.cancel()


def test_a_reply_that_fails_after_its_audio_started_is_kept_in_the_history(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "PARTIAL_REPLY_COMMIT", True)
    fakes.llm.reply = "Thank you sir. This is Thaara from Kagzso AI and Automation. Is that okay?"
    armed = {"on": True}
    real_audio = FakeTTSStream.audio

    async def failing_audio(self):
        async for chunk in real_audio(self):
            yield chunk
            if armed["on"] and any("Thaara" in t for t in self.texts):
                armed["on"] = False
                raise TTSError("timeout", "Sarvam TTS stopped sending audio")

    monkeypatch.setattr(FakeTTSStream, "audio", failing_audio)
    call_id, token = _call(client, auth, customer_name="Ragul", gender="male")
    fakes.stt.replies = ["Hello?", "Hello", "Yes, I'm Ragul", "Sure, go ahead"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # greeting
        _say(ws)  # identity question
        _say(ws)  # the AI reply whose audio stops part-way (still closed with a checkpoint)
        _finish(ws, _say(ws))
    second = fakes.llm.seen_messages[-1]
    assert second[-1] == {"role": "user", "content": "Sure, go ahead"}  # not "Yes, I'm Ragul Sure, go ahead"
    assert second[-2]["role"] == "assistant" and second[-2]["content"].endswith("...")
    assert second[-3] == {"role": "user", "content": "Yes, I'm Ragul"}


@pytest.mark.parametrize("switch", [True, False])
def test_only_two_fallback_lines_in_a_row_close_the_call(client, auth, fakes, sync_engine, monkeypatch, switch):
    monkeypatch.setattr(settings, "FALLBACK_RESET_ON_ANY_REPLY", switch)
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 1.0)
    _failing_llm(fakes, monkeypatch, fail_times=2)
    call_id, token = _call(client, auth, customer_name="Karthick", gender="male")
    fakes.stt.replies = ["Hello?", "Hello", "Yes, I'm Karthick", "Yes, I'm Karthick"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # greeting
        _say(ws)  # identity question
        _say(ws)  # first failure -> "couldn't hear you"
        _until(ws, "checkpoint")  # silence -> the scripted re-prompt
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _finish(ws, _until(ws, "checkpoint"))  # second failure
    agent = _agent_lines(sync_engine, call_id)
    assert agent[2:4] == [UNCLEAR, silence_reprompt("en")]
    if switch:  # the re-prompt in between was a reply: this is the first failure in a row again
        assert agent[4] == UNCLEAR and fakes.plivo.hangups == []
    else:  # today: any second failure closes the call
        assert agent[4] == CLOSING and fakes.plivo.hangups == ["uuid-k"]
