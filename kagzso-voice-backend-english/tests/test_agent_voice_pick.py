# Copyright (c) 2026 Kagzso Technology Services. All rights reserved.
# Proprietary and confidential. See LICENSE.md in the repository root.
# SPDX-License-Identifier: LicenseRef-Kagzso-Proprietary
"""AI Agent voice picked in Dispatch (Settings → AI Voice): the flow's voice_id speaks every line of an Autonomous
AI Agent call, whoever the customer is.

* the offered list: a voice SARVAM_TTS_VOICES leaves untagged gets only a gender Sarvam's docs state
  (DOCUMENTED_GENDERS); others stay without one (never guessed from the name); a tag always wins;
* mocked calls (no Sarvam request, no phone call - a recording SarvamTTS stands in for the network): every TTS
  request and stream of the call (greeting, replies, fixed lines) uses the picked voice with the agent voice profile,
  even with a voice rotation configured; a male contact with a female voice and a female contact with a male voice
  are still addressed by the CONTACT's gender;
* a picked voice this backend no longer offers is refused (409) before anything is dialled, instead of speaking in
  another voice; ordinary flows keep their old behaviour (rotation, an unknown voice playing as the default).

How each voice SOUNDS needs real Sarvam audio (a paid request): not done here.
"""
from __future__ import annotations

import json

import pytest

from app.core import voices
from app.core.config import settings
from app.core.voices import DOCUMENTED_GENDERS, offered_voices
from app.services import call_service as cs
from tests.test_agent_voice import REPLIES, RecordingSarvamTTS, recorder  # noqa: F401  (pytest fixture)
from tests.test_autonomous_agent import _capture_systems
from tests.test_autonomous_conversation import _converse, _flow
from tests.test_nila_flow import _call

TAMIL_ENV = "ishita:female,roopa:female,ritu:female,simran:female,priya,shreya,tanya,shruti,shubh,aditya,rahul,anand"
OFFERED = ("roopa", "ritu", "simran", "ishita", "shubh")


# ------------------------------------------------------------------ the offered list
def test_tamil_list_as_configured_has_one_documented_male_voice():
    listed, default = offered_voices(TAMIL_ENV, "ishita", "ta")
    by_gender = {g: [v["id"] for v in listed if v.get("gender") == g] for g in ("female", "male")}
    assert by_gender == {"female": ["ishita", "roopa", "ritu", "simran"], "male": ["shubh"]}
    assert default == "ishita"
    untagged = [v["id"] for v in listed if "gender" not in v]
    assert untagged == ["priya", "shreya", "tanya", "shruti", "aditya", "rahul", "anand"]  # not guessed
    assert {v["language"] for v in listed} == {"Tamil (India)"}


def test_documented_genders_fill_only_untagged_voices_and_a_tag_wins():
    assert DOCUMENTED_GENDERS == {"shubh": "male", "ratan": "male", "rohan": "male", "ishita": "female", "ritu": "female"}
    listed, _ = offered_voices("ratan,rohan,shubh:female,kavitha:female,mani:male,mani2", "", "ta")
    assert [(v["id"], v.get("gender")) for v in listed] == [
        ("ratan", "male"), ("rohan", "male"), ("shubh", "female"), ("kavitha", "female"), ("mani", "male"), ("mani2", None)]
    # The built-in list (SARVAM_TTS_VOICES empty) is unchanged: the four female voices, Roopa first.
    assert [(v["id"], v["gender"]) for v in offered_voices("", "", "ta")[0]] == [
        ("roopa", "female"), ("ritu", "female"), ("simran", "female"), ("ishita", "female")]


# ------------------------------------------------------------------ mocked calls
@pytest.fixture
def tamil_voices(monkeypatch):
    """This backend offers the Tamil list as configured (four female voices and Shubh)."""
    monkeypatch.setattr(voices, "VOICE_IDS", OFFERED)
    monkeypatch.setattr(cs, "SarvamTTS", RecordingSarvamTTS)  # tts_for_voice(picked voice) records too (no network)
    # A rotation is configured (the local .env.ta has one): an agent's picked voice must never be rotated away.
    monkeypatch.setattr(settings, "SARVAM_TTS_VOICE_ROTATION", "ritu,simran,ishita")


def _talk(client, auth, fakes, flow, gender, flow_id):
    queue = list(REPLIES)
    original = fakes.llm._stream

    async def stream(system_text, messages, model=None):
        if system_text != cs.OUTCOME_SYSTEM and queue:
            fakes.llm.reply = queue.pop(0)
        async for d in original(system_text, messages, model):
            yield d

    fakes.llm._stream = stream
    call_id, token = _call(client, auth, gender=gender, flow_id=flow_id, flow_version=1, flow=flow)
    said = ["Hello?", "Yes", "Tell me more", "Will it replace our software?", "Okay"]
    fakes.stt.replies = list(said)
    _converse(client, call_id, token, turns=len(said) - 1)
    return call_id


def _speakers(log):
    return {e[2]["speaker"] for e in log if e[0] in ("rest", "stream")}


@pytest.mark.parametrize("voice", ["roopa", "ritu", "simran", "ishita", "shubh"])
def test_every_line_of_a_tamil_agent_call_uses_the_picked_voice(client, auth, fakes, monkeypatch, recorder, tamil_voices, voice):
    flow = {**_flow("ta", monkeypatch), "voice_id": voice}
    _talk(client, auth, fakes, flow, "male", flow_id=f"agent_{voice}")
    log = recorder.log
    assert len([e for e in log if e[0] == "stream"]) >= 3  # several replies, each its own stream
    assert _speakers(log) == {voice}  # greeting, replies and fixed lines: one voice, never a rotation voice
    used = {json.dumps({k: v for k, v in e[2].items()}, sort_keys=True) for e in log if e[0] in ("rest", "stream")}
    assert len(used) == 1  # and one profile: same speaker, model, pace, temperature, chunk size on every request
    assert (json.loads(used.pop())["pace"]) == 0.9


@pytest.mark.parametrize("contact,voice", [("male", "roopa"), ("female", "shubh")])
def test_the_customer_is_addressed_by_the_contact_gender_whatever_the_voice(client, auth, fakes, monkeypatch, recorder,
                                                                           tamil_voices, contact, voice):
    flow = {**_flow("ta", monkeypatch), "voice_id": voice}
    systems = _capture_systems(fakes)
    _talk(client, auth, fakes, flow, contact, flow_id=f"agent_{contact}_{voice}")
    title, other = ("sir", "madam") if contact == "male" else ("madam", "sir")  # llm_service: male → sir, female → madam
    # The agent greets in its own words (natural_lines): every reply is told how to address the customer, by the
    # contact's gender - never by the voice's.
    assert systems
    for s in systems:
        assert f'"address_as": "Ragul {title}' in s and f'"address_as": "Ragul {other}' not in s
    assert _speakers(recorder.log) == {voice}


def test_a_picked_voice_no_longer_offered_is_refused_and_nothing_is_dialled(client, auth, fakes, monkeypatch, recorder,
                                                                            tamil_voices):
    flow = {**_flow("ta", monkeypatch), "voice_id": "kavya"}
    r = client.post("/api/calls/outbound", headers=auth, json={
        "phone_number": "+919876543210", "customer_name": "Ragul", "gender": "male", "agent_name": "Nila",
        "flow_id": "agent_gone", "flow_version": 1, "flow": flow})
    assert r.status_code == 409, r.text
    assert "kavya" in r.text and "not offered" in r.text
    assert recorder.log == []


def test_ordinary_flows_keep_their_old_voice_behaviour(client, auth, fakes, monkeypatch, recorder, tamil_voices):
    # Not an agent flow: an unknown voice still plays as the default, and the rotation still picks the voice.
    flow = _flow("ta", monkeypatch)
    flow.pop("autonomous")
    flow["voice_id"] = "kavya"
    _talk(client, auth, fakes, flow, "male", flow_id="plain_rotation")
    assert _speakers(recorder.log) <= {"ritu", "simran", "ishita", settings.tts_speaker}
    assert "kavya" not in _speakers(recorder.log)
