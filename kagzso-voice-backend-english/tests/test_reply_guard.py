"""REPLY_GUARD (off by default; "log" = log only): rule checks on each AI reply. In log mode the reply is
spoken exactly as the model wrote it; only the issue names are logged and recorded as a call event."""
import pytest
from sqlalchemy import text

from app.core.config import Settings, settings
from app.services.llm_service import END_CALL_TOKEN, reply_issues
from tests.test_fallback_line import _talk
from tests.test_nila_flow import _call

BAD = "Sure. That is great. We help with reports. Is that useful? Shall I go on?"


@pytest.mark.parametrize("raw, language, issues", [
    ("Okay, no problem. Thanks for your time.", "en", []),
    ("Thank you. Have a nice day. " + END_CALL_TOKEN, "en", []),
    ("சரிங்க sir, ஒரு minute பேசலாமா?", "ta", []),
    ("ठीक है sir, एक minute बात कर सकते हैं?", "hi", []),
    ("ಸರಿ sir, ಒಂದು minute ಮಾತಾಡಬಹುದಾ?", "kn", []),
    ("Sure sir, can we talk for a minute?", "ta", ["wrong_script"]),
    ("Sure sir, can we talk for a minute?", "kn", ["wrong_script"]),
    ("சரிங்க sir.", "en", ["wrong_script"]),
    ("Okay. Have a nice day. [END_CALL]", "en", ["marker_variant"]),
    ("Okay, bye. END CALL", "en", ["marker_variant"]),
    (END_CALL_TOKEN + " Okay, bye.", "en", ["marker_not_at_end"]),
    ("No problem. Outcome: busy", "en", ["outcome_label"]),
    ("Noted as not_interested.", "en", ["outcome_label"]),
    ("**Sure**, here it is.", "en", ["markdown"]),
    (BAD, "en", ["too_many_sentences", "multiple_questions"]),
    ("", "en", ["empty"]),
])
def test_reply_issues(raw, language, issues):
    assert reply_issues(raw, language) == issues


def test_off_by_default_and_only_log_is_accepted():
    assert settings.REPLY_GUARD == "off"
    assert Settings(_env_file=None, REPLY_GUARD="LOG").REPLY_GUARD == "log"
    assert Settings(_env_file=None, REPLY_GUARD="enforce").REPLY_GUARD == "off"  # log-only for now


def _rows(sync_engine, sql, call_id):
    with sync_engine.connect() as c:
        return c.execute(text(sql), {"id": call_id}).all()


@pytest.mark.parametrize("mode", ["off", "log"])
def test_log_mode_never_changes_the_reply(client, auth, fakes, sync_engine, monkeypatch, mode):
    monkeypatch.setattr(settings, "REPLY_GUARD", mode)
    fakes.llm.reply = BAD
    call_id, token = _call(client, auth, customer_name="Karthick", gender="male")
    fakes.stt.replies = ["Hello?", "Hello", "Yes, I'm Karthick"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _talk(ws, times=2)  # greeting, identity question, then the AI reply
    agent = [r[0] for r in _rows(sync_engine, "select text from transcripts where call_id = :id and speaker = 'agent' order by id", call_id)]
    assert agent[-1] == BAD  # spoken (and stored) exactly as the model wrote it, in both modes
    assert " ".join(fakes.tts.streams[-1].texts) == BAD
    events = _rows(sync_engine, "select payload from call_events where call_id = :id and event_type = 'reply_guard'", call_id)
    if mode == "off":
        assert events == []
    else:
        assert len(events) == 1 and BAD not in str(events[0][0])  # issue names only, never the text
        assert "too_many_sentences" in str(events[0][0]) and "multiple_questions" in str(events[0][0])


def test_a_failing_check_never_breaks_a_call(client, auth, fakes, sync_engine, monkeypatch):
    from app.services import call_service

    monkeypatch.setattr(settings, "REPLY_GUARD", "log")
    monkeypatch.setattr(call_service, "reply_issues", lambda *a, **k: 1 / 0)
    fakes.llm.reply = "Thank you sir. Is that okay?"
    call_id, token = _call(client, auth, customer_name="Karthick", gender="male")
    fakes.stt.replies = ["Hello?", "Hello", "Yes, I'm Karthick"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _talk(ws, times=2)  # greeting, identity question, then the AI reply
    agent = [r[0] for r in _rows(sync_engine, "select text from transcripts where call_id = :id and speaker = 'agent' order by id", call_id)]
    assert agent[-1] == "Thank you sir. Is that okay?"
