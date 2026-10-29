"""Hindi and Telugu calls with the reply-speed and call-rhythm switches (Thaara Hindi / Telugu flows from
deploy/callflows): fakes only - no call, no real STT / TTS / LLM / Plivo, throw-away SQLite (tests/conftest.py).

What the code decides itself is proved here: the key lines said word for word after the flow's own "yes"
words, a question with the yes still going to the AI, the short / long end-of-speech decision, and the
language's own acknowledgement pool. The acknowledgement lines need native-speaker review before real use."""
import asyncio
import json
import re
import time
from pathlib import Path

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.flows.schema import CallFlow
from app.services import llm_service as llm
from app.services import reply_speed as rs
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until

ROOT = Path(__file__).resolve().parents[2]
FLOWS = {lang: json.loads((ROOT / "deploy/callflows" / name).read_text(encoding="utf-8"))
         for lang, name in (("hi", "thaara-hindi.json"), ("te", "thaara-telugu.json"))}
NOT_CLEAR = {
    "hi": ["हाँ, पर आप कौन?", "नहीं", "अभी नहीं", "कौन बोल रहा है?", "हाँ लेकिन price क्या है"],
    "te": ["అవును, మీరు ఎవరు?", "లేదు", "ఇప్పుడు కాదు", "ఎవరు మాట్లాడుతున్నారు?", "సరే కానీ price ఎంత"],
}
MULTI = {"hi": "हाँ, ये useful लग रहा है", "te": "అవును, ఇది useful గా ఉంటుంది"}


def _block(lang, bid):
    return next(b["text"] for b in FLOWS[lang]["blocks"] if b.get("id") == bid)


def _quoted_words(lang, bid):
    return re.findall(r'"([^"]+)"', _block(lang, bid))


def _line(lang, bid):
    line = re.search(r'^\s*>\s*"(.+)"\s*$', _block(lang, bid), re.MULTILINE).group(1)
    return line.replace("{{title_to_use}}", "sir")  # male customer: title_to_use = sir


def _events(sync_engine, call_id, kind):
    with sync_engine.connect() as c:
        rows = c.execute(text("select payload from call_events where call_id = :id and event_type = :t"),
                         {"id": call_id, "t": kind}).scalars().all()
    return [json.loads(p) if isinstance(p, str) else (p or {}) for p in rows]


def _converse(client, auth, fakes, lang, said):
    """Each line of `said` is one customer turn; every answer is acknowledged as played."""
    call_id, token = _call(client, auth, customer_name="Ragul", gender="male", flow_id=f"thaara_{lang}",
                           flow_version=1, flow=FLOWS[lang])
    fakes.stt.replies = list(said)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        time.sleep(0.3)  # fixed lines pre-rendered (when on)
        for _ in said:
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            cp = _until(ws, "checkpoint")
            ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
            time.sleep(0.5)
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.2)
    return call_id, [" ".join(s.texts) for s in fakes.tts.streams]


@pytest.fixture(params=["hi", "te"])
def lang(request, monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", request.param)
    return request.param


# ================================================================== the flows' own words and lines
def test_key_lines_are_the_flows_own_lines(lang):
    lines = rs.flow_key_lines(CallFlow.model_validate(FLOWS[lang]))
    render = lambda t: llm.render_first_message(t, {"customer_name": "Ragul", "gender": "male"})  # noqa: E731
    assert render(lines["permission"]) == _line(lang, "permission")
    assert render(lines["intro"]) == _line(lang, "company_intro")


def test_every_identity_word_the_flow_lists_is_a_clear_yes(lang):
    words = _quoted_words(lang, "identity_confirmation")
    assert len(words) >= 5
    assert [w for w in words if not rs.clear_yes(w, "identity")] == []


def test_every_permission_word_the_flow_lists_is_a_clear_yes(lang):
    words = _quoted_words(lang, "positive_permission")
    assert len(words) >= 8
    assert [w for w in words if not rs.clear_yes(w, "permission")] == []


def test_a_question_or_a_no_is_never_a_clear_yes(lang):
    for said in NOT_CLEAR[lang]:
        assert not rs.clear_yes(said, "identity") and not rs.clear_yes(said, "permission"), said


@pytest.mark.parametrize("said,after_q,kind", [
    ("हाँ", True, "complete"), ("नहीं", True, "complete"), ("ठीक है", True, "complete"), ("जी sir", True, "complete"),
    ("అవును", True, "complete"), ("లేదు", True, "complete"), ("సరే", True, "complete"), ("అవునండి", True, "complete"),
    ("हाँ", False, "normal"), ("हमारे पास दस लोग हैं", True, "normal"), ("మా దగ్గర పది మంది ఉన్నారు", True, "normal"),
    ("हमारा business और", True, "trailing"), ("మా business లో కానీ", True, "trailing"),
])
def test_end_of_speech_words(said, after_q, kind):
    assert rs.utterance_kind(said, after_q) == kind


def test_each_language_has_its_own_acknowledgements(lang):
    pool = rs.ack_templates(lang)
    script = r"[ऀ-ॿ]" if lang == "hi" else r"[ఀ-౿]"
    assert pool != rs.ack_templates("en") and sum(bool(re.search(script, x)) for x in pool) >= 2


# ================================================================== in a call
def test_key_lines_after_yes_in_a_call(client, auth, fakes, sync_engine, lang, monkeypatch):
    monkeypatch.setattr(settings, "KEY_LINES_SCRIPTED", True)
    yes = _quoted_words(lang, "identity_confirmation")[0]  # हाँ / అవును
    ok = {"hi": "ठीक है", "te": "సరే"}[lang]
    call_id, lines = _converse(client, auth, fakes, lang, ["Hello?", "Hello", yes, ok, MULTI[lang]])
    assert lines[2] == _line(lang, "permission") and lines[3] == _line(lang, "company_intro")
    assert [m[-1]["content"] for m in fakes.llm.seen_messages] == [MULTI[lang]]  # the AI only for the real answer
    assert [e["line"] for e in _events(sync_engine, call_id, "key_line")] == ["permission", "introduction"]


def test_key_lines_off_the_ai_answers_as_before(client, auth, fakes, sync_engine, lang):
    yes = _quoted_words(lang, "identity_confirmation")[0]
    call_id, _ = _converse(client, auth, fakes, lang, ["Hello?", "Hello", yes])
    assert [m[-1]["content"] for m in fakes.llm.seen_messages] == [yes]
    assert _events(sync_engine, call_id, "key_line") == []


def test_a_question_with_the_yes_goes_to_the_ai_in_a_call(client, auth, fakes, lang, monkeypatch):
    monkeypatch.setattr(settings, "KEY_LINES_SCRIPTED", True)
    _converse(client, auth, fakes, lang, ["Hello?", "Hello", NOT_CLEAR[lang][0]])
    assert [m[-1]["content"] for m in fakes.llm.seen_messages] == [NOT_CLEAR[lang][0]]


def test_slow_ai_gets_the_languages_own_acknowledgement(client, auth, fakes, sync_engine, lang, monkeypatch):
    monkeypatch.setattr(settings, "THINKING_ACK", True)
    monkeypatch.setattr(settings, "THINKING_ACK_AFTER_SECONDS", 0.1)
    monkeypatch.setattr(settings, "PRERENDER_FIXED_LINES", True)
    real = fakes.llm._stream

    async def slow(system_text, messages, model=None):
        if system_text != llm.OUTCOME_SYSTEM:
            await asyncio.sleep(0.4)
        async for d in real(system_text, messages, model):
            yield d
    monkeypatch.setattr(fakes.llm, "_stream", slow)
    call_id, _ = _converse(client, auth, fakes, lang, ["Hello?", "Hello", MULTI[lang]])
    played = _events(sync_engine, call_id, "thinking_ack")
    assert len(played) == 1
    line = llm.render_first_message(rs.ack_templates(lang)[played[0]["ack"] - 1], {"gender": "male"})
    assert line in [t for t, _ in fakes.tts.synthesized]  # pre-rendered in this call's voice
    assert line not in [llm.render_first_message(t, {"gender": "male"}) for t in rs.ack_templates("en")]
    with sync_engine.connect() as c:
        agent = c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent'"),
                          {"id": call_id}).scalars().all()
    assert line not in agent  # never saved as the agent's reply
