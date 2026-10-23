"""The Nila opening, end to end:
  1. "Hi {{title_to_use}}, {{time_greeting}}."                        (system)
  2. "Am I speaking with {{customer_name}}, {{title_to_use}}?"        (system: GREETING_WAIT_SECONDS
                                                                       after step 1, or at once when the
                                                                       customer says anything)
  3. "Thank you, {{title_to_use}}. This is Thaara ... Is that okay?" (script, after confirmation)
  4. "Yes {{title_to_use}}. Our company helps businesses automate ..." (script, after permission)
Do-not-call and AI questions at the opening still go to the script, no line is repeated, and the
preview renders the opening for male, female and unknown gender."""
import json
import re
import time
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import llm_service as llm
from app.services.call_service import FALLBACK_REPLIES
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_flows import nila_copy
from tests.test_nila_flow import PHONE, _call, _nila_id, _send, _start, _until

GREETING = "Hi sir, Good morning."
IDENTITY = "Am I speaking with Ragul, sir?"
PERMISSION = ("Thank you, sir. This is Thaara from Kexo AI and Automation. Could you give me just one minute? "
              "I'll quickly tell you about our company. Is that okay?")
INTRO = ("Yes sir. Our company helps businesses automate their daily repetitive tasks using AI, so employees get "
         "more time for important work. Does your team spend a lot of time on repetitive work every day?")
DNC = "Understood. I respect your request. Thank you."


def _turns(client, auth, fakes, steps, wait_hangup=False, **call):
    """steps = [(customer says, LLM reply or None)]; the first step is spoken before the greeting.
    Each line is acknowledged as played. wait_hangup: wait for the hang-up after the last line.
    Returns TTS texts per turn."""
    call_id, token = _call(client, auth, **{"gender": "male", **call})
    fakes.stt.replies = [said for said, _ in steps]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _, reply in steps:
            if reply is not None:
                fakes.llm.reply = reply
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            cp = _until(ws, "checkpoint")
            ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
            time.sleep(0.3)
        if wait_hangup:
            deadline = time.time() + 5
            while not fakes.plivo.hangups and time.time() < deadline:
                time.sleep(0.05)
    return [" ".join(s.texts) for s in fakes.tts.streams]


# ------------------------------------------------------------------ the 4 steps
def test_yes_at_step_two_gives_the_introduction(client, auth, fakes):
    spoken = _turns(client, auth, fakes, [
        ("Hello?", None), ("Good afternoon", None), ("Yes, speaking", PERMISSION), ("Go ahead", INTRO),
    ])
    assert spoken[0] == GREETING
    assert spoken[1] == IDENTITY
    assert spoken[2] == PERMISSION
    assert spoken[3].startswith("Yes sir. Our company helps businesses automate their daily repetitive tasks using AI")
    assert len(fakes.llm.seen_messages) == 2  # only steps 3 and 4 use the LLM
    history = fakes.llm.seen_messages[0]
    assert {"role": "assistant", "content": GREETING} in history
    assert {"role": "assistant", "content": IDENTITY} in history
    assert history[-1] == {"role": "user", "content": "Yes, speaking"}


def test_greeting_and_identity_question_are_never_repeated(client, auth, fakes):
    spoken = _turns(client, auth, fakes, [
        ("Hello?", None), ("Yes", None), ("Yes", PERMISSION), ("Yes", INTRO), ("Hello", "Okay, understood."),
    ])
    assert spoken.count(GREETING) == 1 and spoken.count(IDENTITY) == 1
    assert sum("Sorry, am I speaking with" in s for s in spoken) == 0
    assert all(FALLBACK_REPLIES["en"] not in s for s in spoken)  # no "couldn't hear you clearly"


# ------------------------------------------------------------------ step 2: any word, any language, or a pause
@pytest.mark.parametrize("said", ["Yes", "Hello", "Good afternoon sir", "Not interested", "Who is this?",
                                  "வணக்கம்", "Haan ji bolo", "Hmm"])
def test_any_word_or_language_moves_to_step_two(client, auth, fakes, said):
    spoken = _turns(client, auth, fakes, [("Hello?", None), (said, "LLM SHOULD NOT SPEAK")])
    assert spoken == [GREETING, IDENTITY]
    assert fakes.llm.seen_messages == []  # said to the opening, it is not an identity confirmation


def _silent_after_greeting(client, auth, fakes):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")
        played = time.monotonic()
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        _until(ws, "checkpoint")  # the identity question, with no further customer speech
        asked_after = time.monotonic() - played
    return [" ".join(s.texts) for s in fakes.tts.streams], asked_after


def test_silence_for_one_second_moves_to_step_two(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "GREETING_WAIT_SECONDS", 1.0)
    spoken, asked_after = _silent_after_greeting(client, auth, fakes)
    assert spoken == [GREETING, IDENTITY]
    assert 1.0 <= asked_after < 2.5
    assert fakes.llm.seen_messages == []


def test_wait_comes_from_config(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "GREETING_WAIT_SECONDS", 0.2)
    spoken, asked_after = _silent_after_greeting(client, auth, fakes)
    assert spoken == [GREETING, IDENTITY] and asked_after < 1.0


def test_words_said_over_the_greeting_are_kept_and_move_to_step_two(client, auth, fakes):
    call_id, token = _call(client, auth, gender="male")
    fakes.stt.replies = ["Hello?", "Yes yes, tell me"]
    fakes.tts.chunks_per_sentence = 40  # greeting plays for ~4 s, so the words land on top of it
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        cp = _until(ws, "checkpoint")
        _send(ws, tone_mulaw(400) + silence_mulaw(900))  # spoken while the greeting is still playing
        time.sleep(0.3)
        assert len(fakes.tts.streams) == 1  # the greeting was not cut off
        ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))
        _until(ws, "checkpoint")
    assert [s.texts for s in fakes.tts.streams] == [[GREETING], [IDENTITY]]
    assert fakes.llm.seen_messages == []


# ------------------------------------------------------------------ exceptions: do-not-call, AI question
@pytest.mark.parametrize("said", ["Don't call me again", "Stop calling", "Please remove my number"])
def test_do_not_call_at_the_greeting_ends_the_call(client, auth, fakes, said):
    spoken = _turns(client, auth, fakes, [("Hello?", None), (said, DNC + " " + llm.END_CALL_TOKEN)], wait_hangup=True)
    assert spoken == [GREETING, DNC]
    assert fakes.plivo.hangups == ["uuid-k"]


def test_do_not_call_after_the_identity_question_ends_the_call(client, auth, fakes):
    spoken = _turns(client, auth, fakes,
                    [("Hello?", None), ("Yes", None), ("Don't call me again", DNC + " " + llm.END_CALL_TOKEN)],
                    wait_hangup=True)
    assert spoken == [GREETING, IDENTITY, DNC]
    assert fakes.plivo.hangups == ["uuid-k"]


def test_ai_question_at_the_greeting_gets_the_honest_answer(client, auth, fakes):
    answer = "I'm an AI assistant calling on behalf of Kexo AI and Automation."
    spoken = _turns(client, auth, fakes, [("Hello?", None), ("Are you a robot?", answer)])
    assert spoken == [GREETING, answer]
    assert len(fakes.llm.seen_messages) == 1
    assert "say honestly that you are an AI assistant" in llm.SAFETY_RULES


# ------------------------------------------------------------------ titles
def test_female_title_in_the_spoken_lines(client, auth, fakes):
    spoken = _turns(client, auth, fakes, [("Hello?", None), ("Yes", None)], gender="female", customer_name="Priya")
    assert spoken == ["Hi madam, Good morning.", "Am I speaking with Priya, madam?"]


def test_unknown_gender_uses_the_default_title(client, auth, fakes):
    spoken = _turns(client, auth, fakes, [("Hello?", None), ("Yes", None)], gender=None)
    assert spoken == [GREETING, IDENTITY]


def test_call_without_a_name_is_placed(client, auth):
    r = client.post("/api/calls/outbound", headers=auth,
                    json={"phone_number": PHONE, "gender": "male", "agent_id": _nila_id(client, auth)})
    assert r.status_code == 200, r.text  # no name: the opening plays, the identity question is skipped


def test_prompt_keeps_the_safety_layer_and_the_locked_blocks():
    prompt = llm.build_system_prompt(llm.NILA_AGENT["system_prompt"], {"customer_name": "Ragul"}, "en")
    assert llm.SAFETY_RULES in prompt
    for heading in ("# DO NOT CALL — HIGHEST PRIORITY", "# WRONG PERSON", "# CUSTOMER DATA SAFETY", "# OUTCOME RULES"):
        assert heading in prompt
    assert '"Hi sir, Good morning."' in prompt and '"Am I speaking with Ragul, sir?"' in prompt


# ------------------------------------------------------------------ the rename
def test_no_interim_agent_names_in_spoken_or_displayed_text():
    """The agent is Nila again: the interim names Radhi / Kayal are never spoken or shown."""
    for agent in (llm.NILA_AGENT, llm.FOLLOWUP_AGENT):
        for field in ("name", "description", "system_prompt", "first_message"):
            assert not re.search(r"\b(radhi|kayal)\b", agent[field] or "", re.I), (agent["name"], field)
    builtin = Path(__file__).parents[1] / "app/flows/builtin"
    for f in ("nila.json", "followup.json"):
        d = json.loads((builtin / f).read_text(encoding="utf-8"))
        shown = [d["name"], d["greeting"]["text"], d["silence"]["reprompt"], d["silence"]["closing"],
                 *(b.get("text", "") for b in d["blocks"])]
        assert not any(re.search(r"\b(radhi|kayal)\b", t, re.I) for t in shown), f
    assert llm.NILA_AGENT["name"] == "Nila"


def test_the_agent_introduces_itself_as_thaara():
    """Spoken name is Thaara; "Nila" stays only as the agent's internal name / flow id (routing)."""
    for agent in (llm.NILA_AGENT, llm.FOLLOWUP_AGENT):
        for field in ("system_prompt", "first_message"):
            assert not re.search(r"\bnila\b", agent[field] or "", re.I), (agent["name"], field)
    assert "This is Thaara from Kexo AI and Automation." in llm.NILA_AGENT["system_prompt"]
    assert "1. Agent name = **Thaara**." in llm.NILA_AGENT["system_prompt"]
    assert "this is Thaara from Kagzso AI and Automation" in llm.FOLLOWUP_AGENT["first_message"]
    assert llm.NILA_AGENT["name"] == "Nila" and llm.FOLLOWUP_AGENT["name"] == "Follow-up"  # routing unchanged


@pytest.mark.parametrize("old_name", ["Radhi", "Kayal"])
def test_old_agent_name_still_finds_the_agent(client, auth, sync_engine, old_name):
    from sqlalchemy import text
    r = client.post("/api/calls/outbound", headers=auth,
                    json={"phone_number": PHONE, "customer_name": "Ragul", "agent_name": old_name})
    assert r.status_code == 200, r.text
    with sync_engine.connect() as c:
        assert c.execute(text("select a.name from calls c join agents a on a.id = c.agent_id")).scalar() == "Nila"


# ------------------------------------------------------------------ preview with sample data
@pytest.mark.parametrize("gender,title", [("male", "sir"), ("female", "madam"), (None, "sir")])
def test_preview_renders_the_opening_by_gender(client, auth, gender, title):
    sample = {"customer_name": "Ragul", **({"gender": gender} if gender else {})}
    r = client.post("/api/flows/preview", headers=auth, json={"flow": nila_copy(), "sample": sample})
    body = r.json()
    assert r.status_code == 200 and body["valid"]
    assert body["greeting"] == f"Hi {title}, Good morning."
    assert f'"Am I speaking with Ragul, {title}?"' in body["system_prompt"]
    assert f'"Thank you, {title}. This is Thaara from Kexo AI and Automation.' in body["system_prompt"]
    assert f'"title_to_use": "{title}"' in body["system_prompt"]


@pytest.mark.parametrize("old_name", ["Radhi", "Kayal"])
def test_startup_sync_updates_a_row_with_an_interim_name_in_place(old_name):
    """A row someone renamed to an interim name (Radhi / Kayal) is updated in place by the
    startup sync (keeping its id and name) - never a second "Nila" agent."""
    import asyncio

    from sqlalchemy import select

    from app.db import repositories as repo
    from app.db.database import session_factory
    from app.db.models import Agent

    async def run():
        async with session_factory()() as db:
            old = await repo.create_agent(db, **{**llm.NILA_AGENT, "name": old_name, "system_prompt": "old prompt"})
            synced = await repo.upsert_agent_by_name(db, llm.NILA_AGENT)
            names = (await db.execute(select(Agent.name))).scalars().all()
            found = await repo.get_agent_by_name(db, "Nila")
            return old.id, synced, names, found

    old_id, synced, names, found = asyncio.run(run())
    assert synced.id == old_id and synced.name == old_name
    assert synced.system_prompt == llm.NILA_AGENT["system_prompt"]
    assert "Nila" not in names and found.id == old_id
