"""Identity question after the time-of-day opening, and the one-time re-ask: a bare
"Hello" in answer to the identity question is not a yes, so it is asked once more.
Spoken names drop standalone initials. Flows that still open with
"Hi, is this {{customer_name}}?" (published copies, the rollback file) keep the old re-ask."""
import json
import time
from pathlib import Path

import pytest

from app.services import llm_service as llm
from app.services.call_service import is_greeting_only, needs_script_at_opening
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_nila_flow import _call, _send, _start, _until

PERMISSION = ("Thank you, sir. This is Thaara from Kexo AI and Automation. Could you give me just one minute? "
              "I'll quickly tell you about our company. Is that okay?")
OLD_FLOW = json.loads((Path(__file__).parents[1] / "app/flows/rollback/nila_before_time_greeting.json")
                      .read_text(encoding="utf-8"))


@pytest.mark.parametrize("name,spoken", [
    ("Karthick G", "Karthick"), ("R. Karthick", "Karthick"), ("Karthick G.", "Karthick"),
    ("K S Raagul", "Raagul"), ("Ragul", "Ragul"), ("Mary Ann", "Mary Ann"), ("A B", "A B"), (None, ""),
])
def test_spoken_name_drops_initials(name, spoken):
    assert llm.spoken_name(name) == spoken


@pytest.mark.parametrize("text,expected", [
    ("Hello", True), ("Hello?", True), ("hello hello", True), ("Hi", True), ("Hmm hello", True),
    ("Yes", False), ("Yes, speaking", False), ("Hello, yes", False), ("Who is this?", False), ("", False),
])
def test_is_greeting_only(text, expected):
    assert is_greeting_only(text) is expected


@pytest.mark.parametrize("text,expected", [
    ("Don't call me again", True), ("Don’t call me again", True), ("Stop calling", True),
    ("Please remove my number", True), ("No more calls", True), ("call pannadheenga", True), ("call mat karo", True),
    ("Are you a robot?", True), ("Is this a real person?", True), ("Is this AI?", True), ("Is this a recording?", True),
    ("Hello", False), ("Yes", False), ("Yes tell me", False), ("Good afternoon sir", False), ("Hi sir", False),
    ("Not interested", False), ("I'm busy", False), ("Who is this?", False), ("vanakkam", False), ("", False),
])
def test_only_do_not_call_and_ai_questions_skip_the_identity_question(text, expected):
    assert needs_script_at_opening(text) is expected


def _converse(client, auth, fakes, replies, **call):
    """Customer says each reply in turn (the first one before the greeting); returns TTS texts per turn."""
    call_id, token = _call(client, auth, **{"customer_name": "Karthick G", "gender": "male", **call})
    fakes.stt.replies = replies
    fakes.llm.reply = PERMISSION
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _ in replies:
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            _until(ws, "checkpoint")
            time.sleep(0.5)  # let playback finish so the next words aren't treated as talking over Nila
    return [s.texts for s in fakes.tts.streams]


def test_first_reply_gets_the_identity_question_not_a_reask(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Hello"])
    assert spoken[0] == ["Hi sir, Good morning."]
    assert spoken[1] == ["Am I speaking with Karthick, sir?"]
    assert fakes.llm.seen_messages == []  # both lines are scripted, no LLM involved


def test_bare_hello_after_identity_question_reasks(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Yes", "Hello"])
    assert spoken[1] == ["Am I speaking with Karthick, sir?"]
    assert spoken[2] == ["Sorry, am I speaking with Karthick?"]
    assert fakes.llm.seen_messages == []


def test_yes_after_identity_question_goes_to_the_script(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Yes", "Yes, speaking"])
    assert spoken[2][0].startswith("Thank you, sir.")
    assert len(fakes.llm.seen_messages) == 1


def test_reask_happens_only_once(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Hello", "Hello", "Hello"])
    assert spoken[1] == ["Am I speaking with Karthick, sir?"]
    assert spoken[2] == ["Sorry, am I speaking with Karthick?"]
    assert spoken[3][0].startswith("Thank you, sir.")  # third bare hello is left to the script


def test_yes_said_over_the_greeting_is_answered_after_playback(client, auth, fakes):
    """A "Yes" spoken while "Hi sir, Good morning." is still playing is the answer, not filler."""
    call_id, token = _call(client, auth, customer_name="Karthick G", gender="male")
    fakes.stt.replies = ["Hello?", "Yes"]
    fakes.tts.chunks_per_sentence = 40  # greeting plays for ~4 s, so "Yes" lands on top of it
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        checkpoint = _until(ws, "checkpoint")
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # "Yes" while the greeting is still playing
        time.sleep(0.3)
        assert len(fakes.tts.streams) == 1  # nothing interrupted the greeting
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": checkpoint["name"]}))
        _until(ws, "checkpoint")
    assert fakes.tts.streams[0].texts == ["Hi sir, Good morning."]
    assert fakes.tts.streams[1].texts == ["Am I speaking with Karthick, sir?"]
    assert fakes.llm.seen_messages == []


# ------------------------------------------------------------------ old opening (published copies / rollback)
def test_old_opening_flow_keeps_the_old_reask(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Hello"], flow_id="old", flow_version=1, flow=OLD_FLOW)
    assert spoken[0] == ["Hi, is this Karthick?"]
    assert spoken[1] == ["Sorry, am I speaking with Karthick?"]
    assert fakes.llm.seen_messages == []


def test_old_opening_flow_yes_goes_straight_to_the_script(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Yes, speaking"], flow_id="old", flow_version=1, flow=OLD_FLOW)
    assert spoken[1][0].startswith("Thank you, sir.")
    assert len(fakes.llm.seen_messages) == 1
