"""A Tamil Autonomous AI Agent's opening (2026-11-19, a cloned-voice call: the customer said "Hello?" several times,
the opening broke up and repeated, the verb came first, the company was spelt two ways). What the backend guarantees:
  * a greeting word ("ஹலோ", "ஹாய்", "Hello சார்" ...) said over or before the opening never cancels or restarts it
    (INDIC_WORD_SPLIT), and BARGE_EARLY_STOP never cuts the opening on voice alone;
  * AGENT_FIXED_GREETING: the agent's published greeting is the one fixed line, rendered while the phone rings and
    played as soon as the call connects, or at once as the answer to a "Hello?"; the LLM leads after it;
  * the LLM's own opening (switch off) is asked with the Tamil word order beside it, described, never quoted;
  * the company name is spoken one way in Tamil.
Fake STT / LLM / TTS / Plivo: nothing real is called."""
from __future__ import annotations

import json
import time

import pytest

from app.core.config import settings
from app.services import call_service as cs
from app.services.call_service import is_filler
from app.services.llm_service import build_system_prompt
from app.services.tts import apply_pronunciations
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_autonomous_conversation import OPENING, _dial, _flow, _opening_then
from tests.test_call_policy import _agent_lines, _events, _rows
from tests.test_nila_flow import _send, _start, _until

# Every greeting word the customer may say, as Sarvam's Tamil STT writes it (with and without punctuation, mixed).
GREETING_WORDS = ["ஹலோ", "ஹலோ?", "ஹலோ!", "ஹல்லோ", "ஹாய்", "ஹாய்!", "ஹலோ ஹலோ", "Hello சார்", "Hi சார்",
                  "ஹலோ சார், கேக்குதா?", "கேட்குதா", "Hello?"]


def _lines(sync_engine, call_id, count=1, limit=3.0):
    """The agent's saved lines, once the call's teardown has written them."""
    deadline = time.time() + limit
    while len(_agent_lines(sync_engine, call_id)) < count and time.time() < deadline:
        time.sleep(0.05)
    return _agent_lines(sync_engine, call_id)


def _wait(cond, limit=5.0):
    deadline = time.time() + limit
    while not cond() and time.time() < deadline:
        time.sleep(0.05)
    return cond()


# ------------------------------------------------------------------ greeting words over the agent
def test_every_greeting_word_is_a_line_check_with_the_switch(monkeypatch):
    for said in GREETING_WORDS[:-1]:
        assert not is_filler(said), said  # switch off: Tamil letters are split up and count as real words (the call)
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    for said in GREETING_WORDS:
        assert is_filler(said), said
    for said in ("ஒரு நிமிஷம், யாரு பேசுறது?", "வேண்டாம்", "ஹலோ, யாரு?", "call me later"):
        assert not is_filler(said), said  # real words still interrupt


def _long_line(fakes):
    """The fake TTS's one-shot audio (the pre-rendered greeting), about 4 s long."""
    async def synthesize(text, pace=None):
        fakes.tts.synthesized.append((text, pace))
        return fakes.tts.chunk * 40
    return synthesize


def _opening_call(client, auth, fakes, monkeypatch, fixed: bool):
    """A Tamil agent call that opens by itself; the opening plays for about 4 s (never acknowledged)."""
    monkeypatch.setattr(settings, "AGENT_FIXED_GREETING", fixed)
    monkeypatch.setattr(settings, "GREETING_PRERENDER", fixed)
    monkeypatch.setattr(settings, "GREETING_DELAY_MS", 100)
    monkeypatch.setattr(fakes.tts, "synthesize", _long_line(fakes))
    flow = _flow("ta", monkeypatch)
    _opening_then(fakes, "ta", "சரி sir.")
    fakes.tts.chunks_per_sentence = 20
    return _dial(client, auth, flow)


@pytest.mark.parametrize("early_stop", [False, True], ids=["", "BARGE_EARLY_STOP"])
@pytest.mark.parametrize("hello", ["ஹலோ?", "ஹாய்!", "Hello சார்", "ஹலோ சார், கேக்குதா?"])
@pytest.mark.parametrize("fixed", [True, False], ids=["fixed greeting", "llm opening"])
def test_a_greeting_word_over_the_opening_never_cancels_or_restarts_it(client, auth, fakes, sync_engine, monkeypatch,
                                                                       fixed, hello, early_stop):
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    monkeypatch.setattr(settings, "BARGE_EARLY_STOP", early_stop)
    call_id, token = _opening_call(client, auth, fakes, monkeypatch, fixed)
    if fixed:
        assert _wait(lambda: cs.has_greeting_audio(call_id))
    fakes.stt.replies = [hello]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _until(ws, "checkpoint")  # the opening is sent; it plays on
        time.sleep(1.0)  # past the echo window
        _send(ws, tone_mulaw(700) + silence_mulaw(900))  # the greeting word, over it
        _wait(lambda: {"barge_in", "barge_in_ignored"} & set(_events(sync_engine, call_id)))
        ws.send_text(json.dumps({"event": "stop"}))
    events = _events(sync_engine, call_id)
    assert "barge_in_ignored" in events
    assert "barge_in" not in events and "barge_in_early" not in events  # never cut off
    assert len(_lines(sync_engine, call_id)) == 1  # said once: never restarted
    assert len(fakes.llm.seen_messages) == (0 if fixed else 1)  # nothing was asked again


def test_early_stop_still_works_after_the_opening(client, auth, fakes, sync_engine, monkeypatch):
    """BARGE_EARLY_STOP only spares the opening: real speech over a later reply stops it at once, as before."""
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    monkeypatch.setattr(settings, "BARGE_EARLY_STOP", True)
    call_id, token = _opening_call(client, auth, fakes, monkeypatch, fixed=False)
    fakes.stt.replies = ["சொல்லுங்க", "ஒரு நிமிஷம் இருங்க"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        cp = _until(ws, "checkpoint")  # the opening
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        time.sleep(4.5)  # it has played
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # a reply, still playing
        time.sleep(1.0)
        _send(ws, tone_mulaw(900) + silence_mulaw(900))  # real speech over it
        _wait(lambda: "barge_in_early" in _events(sync_engine, call_id))
        ws.send_text(json.dumps({"event": "stop"}))
    assert "barge_in_early" in _events(sync_engine, call_id)


def test_a_real_question_over_the_opening_still_interrupts_it(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    call_id, token = _opening_call(client, auth, fakes, monkeypatch, fixed=False)
    fakes.stt.replies = ["ஒரு நிமிஷம், யாரு பேசுறது?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _until(ws, "checkpoint")
        time.sleep(1.0)
        _send(ws, tone_mulaw(700) + silence_mulaw(900))
        _wait(lambda: "barge_in" in _events(sync_engine, call_id))
        _until(ws, "checkpoint")  # the answer to the question
        ws.send_text(json.dumps({"event": "stop"}))
    assert "barge_in" in _events(sync_engine, call_id)
    assert fakes.llm.seen_messages[-1][-1]["content"] == "ஒரு நிமிஷம், யாரு பேசுறது?"


# ------------------------------------------------------------------ AGENT_FIXED_GREETING
@pytest.fixture
def fixed_greeting(monkeypatch):
    monkeypatch.setattr(settings, "AGENT_FIXED_GREETING", True)
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)


def test_the_published_greeting_is_rendered_while_ringing_and_plays_on_connect(client, auth, fakes, sync_engine,
                                                                               monkeypatch, fixed_greeting):
    flow = _flow("ta", monkeypatch)
    _opening_then(fakes, "ta", "சரி sir.")
    call_id, token = _dial(client, auth, flow)  # dialled; the phone rings
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    rendered = fakes.tts.synthesized[-1][0]
    assert rendered.startswith("வணக்கம்") and rendered.endswith("இருந்து பேசறேன்.") and "Thaara" in rendered  # verb last
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        started = time.monotonic()
        _start(ws)
        _until(ws, "checkpoint")  # no customer words: GREETING_PRERENDERED_DELAY_MS after connecting
        waited = time.monotonic() - started
        ws.send_text(json.dumps({"event": "stop"}))
    assert waited < 1.0  # GREETING_DELAY_MS is 60 s in the tests: only the ready greeting plays this soon
    assert fakes.llm.seen_messages == [] and all(s.texts == [] for s in fakes.tts.streams)  # no LLM, no live TTS
    assert _lines(sync_engine, call_id) == [rendered]
    started_rows = _rows(sync_engine, "select payload from call_events where call_id = :id "
                                      "and event_type = 'greeting_started'", call_id)
    payload = started_rows[0][0]
    payload = json.loads(payload) if isinstance(payload, str) else payload
    assert payload["ms_after_stream_start"] < 1000


@pytest.mark.parametrize("hello", ["ஹலோ?", "Hello?", "ஹாய்"])
def test_a_hello_before_the_greeting_is_answered_with_it_at_once_then_the_llm_leads(client, auth, fakes, sync_engine,
                                                                                   monkeypatch, fixed_greeting, hello):
    monkeypatch.setattr(settings, "INDIC_WORD_SPLIT", True)
    flow = _flow("ta", monkeypatch)
    fakes.llm.reply = "சரி sir."
    call_id, token = _dial(client, auth, flow)
    assert _wait(lambda: cs.has_greeting_audio(call_id))
    fakes.stt.replies = [hello, "என்ன விஷயம்?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # the customer speaks first
        cp = _until(ws, "checkpoint")  # the greeting answers it
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        time.sleep(0.5)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # their next words: the LLM answers
        _until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    lines = _lines(sync_engine, call_id, count=2)
    assert lines[0].startswith("வணக்கம்") and lines[1] == "சரி sir."
    assert len(fakes.llm.seen_messages) == 1  # only the second turn went to the LLM
    history = [m["content"] for m in fakes.llm.seen_messages[0]]
    assert lines[0] in history  # it knows the greeting was said, and answers the customer from there


def test_without_the_switch_an_agent_call_opens_in_the_llms_words_as_before(client, auth, fakes, sync_engine, monkeypatch):
    monkeypatch.setattr(settings, "GREETING_PRERENDER", True)
    monkeypatch.setattr(settings, "GREETING_DELAY_MS", 100)
    flow = _flow("ta", monkeypatch)
    _opening_then(fakes, "ta", "சரி sir.")
    call_id, token = _dial(client, auth, flow)
    time.sleep(0.3)
    assert not cs.has_greeting_audio(call_id) and fakes.tts.synthesized == []
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _until(ws, "checkpoint")
        ws.send_text(json.dumps({"event": "stop"}))
    assert _lines(sync_engine, call_id) == [OPENING["ta"][0]]
    # A compiler 4 agent (the admin's instructions lead): asked to open as its instructions describe.
    assert fakes.llm.seen_messages[0][-1]["content"] == cs.agent_greeting_instruction("ta", instructions_lead=True)


# ------------------------------------------------------------------ word order, no quoted lines, one spelling
def test_the_llm_opening_is_asked_with_the_tamil_word_order_described_not_quoted():
    assert cs.agent_greeting_instruction("en") == cs.AGENT_GREETING_INSTRUCTION  # English: unchanged
    assert cs.agent_greeting_instruction("hi") == cs.AGENT_GREETING_INSTRUCTION
    ta = cs.agent_greeting_instruction("ta-IN")
    assert ta.startswith(cs.AGENT_GREETING_INSTRUCTION) and "end the sentence with the verb" in ta
    assert not any(c in ta[len(cs.AGENT_GREETING_INSTRUCTION):] for c in "\"“”")  # described, never a quoted line


def test_the_company_name_keeps_its_english_words_in_writing_and_one_spelling_in_speech():
    variables = {"customer_name": "Ragul", "gender": "male"}
    ta = build_system_prompt("You are Thaara from Kagzso Technology Services.", variables, language="ta")
    assert "write it exactly as கெக்ஸோ. Only that one word changes" in ta and "in English letters" in ta
    for lang in ("en", "hi", "kn"):
        other = build_system_prompt("You are Thaara from Kagzso Technology Services.", variables, language=lang)
        assert "Only that one word changes" not in other, lang
    one = "கெக்ஸோ டெக்னாலஜி சர்வீசஸ்"
    for written in ("Kagzso Technology Services", "கெக்சோ டெக்னாலஜி சர்விஸஸ்", "கெக்ஸோ டெக்னோலஜி சர்வீஸஸ்",
                    "காக்ஸோ டெக்னாலஜி சர்விசஸ்", "KAGZSO TECHNOLOGY SERVICES"):
        assert apply_pronunciations(written, "ta") == one, written
    assert apply_pronunciations("Kagzso Technology Services", "en") == "Kexo Technology Services"  # English: as before
