"""Voice response tuning, Tamil only (app/services/turn_tuning.py).

* words       what counts as a sound, a real word, a finished and an unfinished sentence
* settings    a private copy for a tuned call; every other call keeps the backend's own object
* live call   waiting for the customer, merging, replying once, the check-in line and its loop guard
* safety      English, Hindi, Telugu and Kannada ignore tuning and keep the exact same settings and prompt
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from app.core.config import settings
from app.schemas.calls import VoiceTuning
from app.services import call_service as cs
from app.services import llm_service as llm
from app.services import turn_tuning as tt
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_autonomous_agent import _capture_systems
from tests.test_autonomous_conversation import _dial, _flow
from tests.test_call_rhythm import _realtime
from tests.test_call_policy import _agent_lines, _rows
from tests.test_nila_flow import _call, _send, _start, _until
from tests.test_reply_speed import FRAME, _ack, _eos_waits, _events, _realtime_silence, _wait_for, said  # noqa: F401

PRESETS = json.loads((Path(__file__).resolve().parent / "fixtures" / "voice_tuning_presets.json").read_text(encoding="utf-8"))
BALANCED = PRESETS["balanced"]
TA = tt.LANGUAGE_RULES["ta"]
OTHER_LANGUAGES = ("en", "hi", "te", "kn")


# ------------------------------------------------------------------ sounds and real words
@pytest.mark.parametrize("text", [
    "aaa", "aa", "ohh", "oh", "hmm", "mm", "mmm", "uh", "um", "ஆஆ", "ஆஆஆஆ", "ம்ம்", "ம்ம்ம்ம்", "ஓ", "ஓஓஓ", "ம்", "mm-hmm", "Hmm.", "ம் ம்",
    "aaaa aaaa", "a", "k", "ஆ", "x", "5", "ab", "ஓஹோ", "ஆஹா",
])
def test_sounds_and_stray_letters(text):
    assert TA.is_sound(text)


@pytest.mark.parametrize("text", [
    "ஆமா", "ஆமாம்", "ஆம்", "சரி", "சரிங்க", "வேணாம்", "வேண்டாம்", "இல்ல", "இல்லை", "okay", "ok", "OK", "no", "yes", "ஓகே", "ஹலோ", "hello",
    "யாரு", "என்ன", "ஏன்", "அது", "இது", "போ", "வா", "நீ", "10", "ஆமா sir", "ம் சரி", "ஆ ஆமா", "okk", "noo",
])
def test_real_words_are_never_sounds(text):
    assert not TA.is_sound(text)


def test_nothing_at_all_is_not_a_sound_and_the_filler_list_has_one_source():
    assert not TA.is_sound("") and not TA.is_sound("...")
    assert tt.vf.LONE_FILLERS <= TA.sounds  # voice_focus stays the main list


# ------------------------------------------------------------------ finished or not
# The lists were written against these two. HELD_OUT_* below were not.
@pytest.mark.parametrize("text", ["ஆமா", "சரிங்க", "வேண்டாம்", "இல்லைங்க", "சொல்லுங்க", "நாங்க hotel நடத்துறோம்", "எனக்கு இது வேண்டாம்", "நீங்க யாரு"])
def test_finished_is_answered_quickly(text):
    assert TA.utterance_kind(text) == tt.COMPLETE


@pytest.mark.parametrize("text", ["நாங்க ஒரு", "எங்க கிட்ட", "நான் என்ன சொல்ல வரேன்னா", "அது வந்து", "இப்போ பாத்தீங்கன்னா", "எங்க hotel-ல", "ஆனா", "அப்புறம்",
                                  "நாங்க hotel நடத்துறோம், ", "சரி..."])
def test_unfinished_gets_the_extra_wait(text):
    assert TA.utterance_kind(text) == tt.TRAILING


HELD_OUT_FINISHED = ["எனக்கு புரியல", "நாளைக்கு கூப்பிடுங்க", "நான் வெளிய இருக்கேன்", "எங்ககிட்ட software இருக்கு", "இது எவ்வளவு", "அப்புறம் பேசலாம்",
                     "நான் யோசிச்சு சொல்றேன்", "எனக்கு தெரியாது", "அது வேணும்", "இப்போ முடியாது"]
HELD_OUT_UNFINISHED = ["நான் ஒரு விஷயம் சொன்னா", "எங்க கடையில", "எங்களோட", "நாங்க போன வாரம் வந்து", "உங்க company-ல", "அதுக்கு அப்புறம்", "நான் பாத்துட்டு",
                       "இந்த", "எங்க office-க்கு", "ஆனா எனக்கு"]


def test_phrases_the_rules_were_not_written_against():
    """Not a substitute for a native speaker's review of the lists: a check that they aren't fitted to one set."""
    finished = sum(TA.utterance_kind(t) == tt.COMPLETE for t in HELD_OUT_FINISHED)
    unfinished = sum(TA.utterance_kind(t) == tt.TRAILING for t in HELD_OUT_UNFINISHED)
    assert finished >= 9 and unfinished >= 9, (finished, unfinished)
    # Whatever isn't sure gets the normal wait, never the quick reply: an unfinished phrase must not be answered early.
    assert not [t for t in HELD_OUT_UNFINISHED if TA.utterance_kind(t) == tt.COMPLETE]


def test_a_sound_may_start_a_thought_and_minimum_words_apply():
    assert TA.utterance_kind("ம்ம்") == tt.NORMAL
    assert TA.utterance_kind("") == tt.NORMAL
    assert TA.utterance_kind("hotel நடத்துறோம்", min_words=3) == tt.TRAILING
    assert TA.utterance_kind("ஆமா", min_words=3) == tt.COMPLETE  # a short answer is complete whatever the minimum


# ------------------------------------------------------------------ settings
def test_presets_are_what_dispatch_sends_and_the_voice_backend_accepts():
    assert set(PRESETS) == {"fast", "balanced", "patient"}  # "Current behavior" sends nothing
    for payload in PRESETS.values():
        VoiceTuning(**payload)
    assert BALANCED == {"preset": "balanced", "finished_silence_ms": 450, "end_of_speech_silence_ms": 900,
                        "extra_wait_if_incomplete_ms": 500, "hard_cap_ms": 1600, "min_words_before_reply": 1}


def _ta_cfg():
    return settings.model_copy(update={"CALL_LANGUAGE": "ta"})


def _variables(payload):
    return {tt.VARIABLE: json.dumps(payload)}


def test_a_tuned_call_gets_a_private_copy_and_the_backend_keeps_its_own():
    base = _ta_cfg()
    cfg, tuning = tt.for_session(base, _variables(BALANCED))
    assert cfg is not base and tuning is not None and tuning.preset == "balanced"
    assert (cfg.VAD_SPEECH_END_SILENCE_MS, cfg.ADAPTIVE_EOS_SHORT_MS, cfg.ADAPTIVE_EOS_LONG_MS) == (900, 450, 1400)
    assert cfg.ADAPTIVE_EOS and cfg.TTS_WARM_STREAM and cfg.SLOW_SPEAKER_END_SILENCE_MS == 0 and not cfg.STT_STREAMING
    assert base.VAD_SPEECH_END_SILENCE_MS == 700 and base.ADAPTIVE_EOS is False and base.TTS_WARM_STREAM is False
    assert settings.VAD_SPEECH_END_SILENCE_MS == 700


def test_the_hard_cap_limits_every_wait():
    cfg, _ = tt.for_session(_ta_cfg(), _variables({**BALANCED, "hard_cap_ms": 1000}))
    assert cfg.ADAPTIVE_EOS_LONG_MS == 1000 and cfg.VAD_SPEECH_END_SILENCE_MS == 900
    cfg, _ = tt.for_session(_ta_cfg(), _variables({**BALANCED, "hard_cap_ms": 800}))
    assert cfg.VAD_SPEECH_END_SILENCE_MS == 800 and cfg.ADAPTIVE_EOS_LONG_MS == 800
    cfg, _ = tt.for_session(_ta_cfg(), _variables({**BALANCED, "hard_cap_ms": 0}))  # no cap
    assert cfg.ADAPTIVE_EOS_LONG_MS == 1400


@pytest.mark.parametrize("variables", [{}, {tt.VARIABLE: None}, {tt.VARIABLE: ""}, {tt.VARIABLE: "not json"},
                                       {tt.VARIABLE: "{}"}, {tt.VARIABLE: '{"hard_cap_ms": "x"}'}])
def test_no_tuning_or_broken_tuning_is_the_backend_itself(variables):
    base = _ta_cfg()
    assert tt.for_session(base, variables) == (base, None)
    assert tt.for_session(base, variables)[0] is base


# ------------------------------------------------------------------ safety: every other language
@pytest.mark.parametrize("language", OTHER_LANGUAGES)
def test_other_languages_ignore_tuning_completely(language):
    base = settings.model_copy(update={"CALL_LANGUAGE": language})
    assert tt.rules_for(language) is None
    assert tt.call_variable(BALANCED, base) is None
    cfg, tuning = tt.for_session(base, _variables(BALANCED))
    assert cfg is base and tuning is None  # the same object: not one setting differs


@pytest.mark.parametrize("language", OTHER_LANGUAGES)
def test_other_languages_keep_the_exact_same_prompt(language):
    base = llm.build_call_variables("Ragul", "male", "+919876543210")
    tuned = {**base, tt.VARIABLE: json.dumps(BALANCED)}
    assert llm.build_system_prompt("# Agent", tuned, language=language) == llm.build_system_prompt("# Agent", base, language=language)
    assert tt.TAMIL_REPLY_RULE not in llm.build_system_prompt("# Agent", tuned, language=language)


@pytest.mark.parametrize("language", OTHER_LANGUAGES)
def test_a_tuning_sent_to_another_language_is_never_kept(client, auth, monkeypatch, sync_engine, language):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", language)
    call_id, _ = _call(client, auth, voice_tuning=BALANCED)
    stored = _rows(sync_engine, "select variables from calls where id = :id", call_id)[0][0]
    assert tt.VARIABLE not in (json.loads(stored) if isinstance(stored, str) else stored)


def test_english_keeps_its_timings_and_shared_defaults():
    """The shared values are not changed in place: only a tuned call's private copy differs."""
    assert (settings.VAD_SPEECH_END_SILENCE_MS, settings.ADAPTIVE_EOS, settings.SLOW_SPEAKER_END_SILENCE_MS) == (700, False, 1600)
    assert (settings.TTS_WARM_STREAM, settings.TTS_FLUSH_FIRST_SENTENCE, settings.LLM_MAX_OUTPUT_TOKENS) == (False, False, 1024)
    assert llm.request_max_tokens(settings) == 1024


def test_tamil_without_tuning_is_today_exactly():
    """"Current behavior" sends nothing, so a Tamil call has the same prompt as before this existed."""
    base = llm.build_call_variables("Ragul", "male", "+919876543210")
    assert tt.TAMIL_REPLY_RULE not in llm.build_system_prompt("# Agent", base, language="ta")
    assert tt.for_session(_ta_cfg(), base)[1] is None


def test_the_tamil_prompt_line_and_token_cap_stay_on_their_own_call():
    tuned = {**llm.build_call_variables("Ragul", "male", "+919876543210"), tt.VARIABLE: json.dumps(BALANCED)}
    assert llm.build_system_prompt("# Agent", tuned, language="ta").count(tt.TAMIL_REPLY_RULE) == 1

    async def one_call():
        llm.MAX_REPLY_TOKENS.set(tt.TAMIL_MAX_REPLY_TOKENS)  # as a reply's own task does
        return llm.request_max_tokens(settings)

    assert asyncio.run(one_call()) == tt.TAMIL_MAX_REPLY_TOKENS
    assert llm.request_max_tokens(settings) == settings.LLM_MAX_OUTPUT_TOKENS  # nothing leaked out of that task


# ------------------------------------------------------------------ a live Tamil call
SAID = tone_mulaw(400)
AFTER = silence_mulaw(1000)
OPENING = "வணக்கம் sir, நான் Thaara பேசறேன்."


def _tamil(client, auth, fakes, monkeypatch, tuning=BALANCED, natural=True):
    """An autonomous agent's Tamil call. natural=False: an agent published before natural lines, which has the fixed
    lines (and so the fixed check-in line), as a Guided Call Flow does."""
    fakes.llm.replies = [OPENING]
    fakes.llm.reply = "சரி sir."
    extra = {"voice_tuning": tuning} if tuning else {}
    flow = _flow("ta", monkeypatch)
    flow["autonomous"]["natural_lines"] = natural
    return _dial(client, auth, flow, **extra)


def _open(ws, said):  # noqa: F811
    """The call connects and the AI has finished its opening."""
    _start(ws)
    said["text"] = "ஹலோ"
    _send(ws, SAID + AFTER)
    _ack(ws, _until(ws, "checkpoint"))
    time.sleep(0.3)


def _says(ws, said, text):  # noqa: F811
    said["text"] = text
    _send(ws, SAID + AFTER)


def _llm_turns(fakes):
    return len(fakes.llm.seen_messages)


@pytest.mark.parametrize("sound", ["mm", "ஆஆ", "ohh", "a", "uh"])
def test_a_sound_after_the_ai_finishes_gets_one_checkin_and_no_llm(client, auth, fakes, monkeypatch, sync_engine, said, sound):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch, natural=False)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        before = _llm_turns(fakes)
        _says(ws, said, sound)
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.2)
    assert _llm_turns(fakes) == before  # the LLM is never called
    assert _agent_lines(sync_engine, call_id)[-1] == tt.TAMIL_CHECKIN_LINES[0]
    assert len(_events(sync_engine, call_id, "checkin_sent")) == 1


@pytest.mark.parametrize("sound", ["mm", "ம்", "ஆஆ"])
def test_an_agent_answers_a_sound_in_its_own_words_never_a_fixed_line(client, auth, fakes, monkeypatch, sync_engine, said, sound):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        assert not set(tt.TAMIL_CHECKIN_LINES) & {t for t, _ in fakes.tts.synthesized}  # nothing rendered for it
        before = _llm_turns(fakes)
        fakes.llm.replies = ["ஆமா sir, hotel-க்கு billing-அ automate பண்ணலாம்."]
        _says(ws, said, sound)
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.2)
        history = cs.ACTIVE_SESSIONS[call_id].history
        assert history[-1]["role"] == "assistant" and history[-2]["role"] == "assistant"  # the sound isn't their words
        _says(ws, said, "ஆஆ")  # right after: the AI stays quiet, as after a check-in line
        assert _wait_for(lambda: _events(sync_engine, call_id, "checkin_skipped"))
    assert _llm_turns(fakes) == before + 1
    sent = fakes.llm.seen_messages[-1][-1]["content"]
    assert sent.startswith(cs.AGENT_SOUND_INSTRUCTION.format(sound=sound)) and sent.endswith(tt.TAMIL_REPLY_REMINDER)
    assert _agent_lines(sync_engine, call_id)[-1] == "ஆமா sir, hotel-க்கு billing-அ automate பண்ணலாம்."
    assert not set(tt.TAMIL_CHECKIN_LINES) & set(_agent_lines(sync_engine, call_id))
    assert [e.get("llm") for e in _events(sync_engine, call_id, "checkin_sent")] == [True]


def test_the_checkin_lines_are_rendered_when_the_call_starts_and_play_from_that_audio(client, auth, fakes, monkeypatch, said):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch, natural=False)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        rendered = [t for t, _ in fakes.tts.synthesized]
        assert all(line in rendered for line in tt.TAMIL_CHECKIN_LINES)
        _says(ws, said, "mm")
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.2)
    assert not [s for s in fakes.tts.streams if tt.TAMIL_CHECKIN_LINES[0] in s.texts]  # played, never synthesized live


@pytest.mark.parametrize("sound", ["mm", "ஆஆ", "ohh", "a"])
def test_a_sound_while_the_ai_is_talking_changes_nothing(client, auth, fakes, monkeypatch, sync_engine, said, sound):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        fakes.tts.chunks_per_sentence = 40  # 4 s of speech
        _says(ws, said, "நாங்க hotel நடத்துறோம்")
        _until(ws, "playAudio")
        before = _llm_turns(fakes)
        _says(ws, said, sound)
        assert _wait_for(lambda: _events(sync_engine, call_id, "barge_in_ignored"))
    assert _llm_turns(fakes) == before
    assert _events(sync_engine, call_id, "barge_in_ignored")[-1]["reason"] == "sound"
    assert _events(sync_engine, call_id, "checkin_sent") == []
    assert "barge_in" not in [e for e in _rows(sync_engine, "select event_type from call_events where call_id = :id", call_id)]


@pytest.mark.parametrize("word", ["ஆமா", "சரி", "வேணாம்", "okay", "இல்ல"])
def test_real_short_answers_get_a_normal_reply(client, auth, fakes, monkeypatch, sync_engine, said, word):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        before = _llm_turns(fakes)
        _says(ws, said, word)
        _ack(ws, _until(ws, "checkpoint"))
    assert _llm_turns(fakes) == before + 1
    assert fakes.llm.seen_messages[-1][-1]["content"].startswith(word)
    assert _events(sync_engine, call_id, "checkin_sent") == []


def test_two_sounds_in_a_row_get_one_checkin_and_a_real_word_resets_it(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch, natural=False)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        _says(ws, said, "mm")
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.4)
        _says(ws, said, "ஆஆ")  # right after the check-in: the AI stays quiet
        assert _wait_for(lambda: _events(sync_engine, call_id, "checkin_skipped"))
        assert len(_events(sync_engine, call_id, "checkin_sent")) == 1
        _says(ws, said, "சரி")  # a real word
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.4)
        _says(ws, said, "ohh")  # the counter was reset: one check-in again, the other line
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.2)
    assert len(_events(sync_engine, call_id, "checkin_sent")) == 2
    lines = _agent_lines(sync_engine, call_id)
    assert tt.TAMIL_CHECKIN_LINES[0] in lines and lines[-1] == tt.TAMIL_CHECKIN_LINES[1]


def test_a_mid_sentence_pause_waits_and_the_rest_joins_the_same_turn(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        before = _llm_turns(fakes)
        said["text"] = "நாங்க ஒரு"
        _send(ws, SAID)
        _realtime_silence(ws, 1100)  # longer than today's 700 ms and the normal 900: an unfinished sentence waits on
        assert _llm_turns(fakes) == before
        said["text"] = "நாங்க ஒரு hotel நடத்துறோம்"
        _send(ws, SAID)
        _realtime_silence(ws, 700)
        _ack(ws, _until(ws, "checkpoint"))
    assert _llm_turns(fakes) == before + 1  # one reply
    assert fakes.llm.seen_messages[-1][-1]["content"].startswith("நாங்க ஒரு hotel நடத்துறோம்")


def test_a_clearly_finished_sentence_is_answered_quickly(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        said["text"] = "நாங்க hotel நடத்துறோம்"
        _send(ws, SAID)
        _realtime_silence(ws, 800)
        _until(ws, "checkpoint")
    wait = _eos_waits(sync_engine, call_id)[-1]
    assert 450 - FRAME <= wait < 700 - FRAME  # sooner than today's 700 ms


def test_an_unfinished_sentence_never_waits_past_the_cap(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        said["text"] = "நாங்க ஒரு"
        _send(ws, SAID)
        _realtime_silence(ws, 1700)
        _until(ws, "checkpoint")
    wait = _eos_waits(sync_engine, call_id)[-1]
    assert 1400 - FRAME <= wait <= 1600 + FRAME


def test_a_ready_reply_waits_for_the_customer_and_new_words_join_it(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    """The turn had ended and the reply was being prepared when the customer went on: nothing plays over them, and one
    reply answers everything they said."""
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        before = _llm_turns(fakes)
        fakes.tts.delay = 0.5
        said["text"] = "நாங்க hotel நடத்துறோம்"
        _send(ws, SAID + AFTER)
        assert _wait_for(lambda: _llm_turns(fakes) == before + 1)  # its reply is on the way
        said["text"] = "இப்போ எனக்கு time இல்ல"
        _send(ws, SAID + AFTER)
        fakes.tts.delay = 0
        _ack(ws, _until(ws, "checkpoint"))
    assert _llm_turns(fakes) == before + 2
    assert fakes.llm.seen_messages[-1][-1]["content"].startswith("நாங்க hotel நடத்துறோம் இப்போ எனக்கு time இல்ல")
    assert len(_agent_lines(sync_engine, call_id)) == 2  # the opening and one reply: the first never played


def test_a_sound_during_the_wait_leaves_the_ready_reply_alone(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        before = _llm_turns(fakes)
        fakes.tts.delay = 0.5
        said["text"] = "நாங்க hotel நடத்துறோம்"
        _send(ws, SAID + AFTER)
        assert _wait_for(lambda: _llm_turns(fakes) == before + 1)
        said["text"] = "mm"
        _send(ws, SAID + AFTER)
        fakes.tts.delay = 0
        _ack(ws, _until(ws, "checkpoint"))
    assert _llm_turns(fakes) == before + 1  # the same reply, not a new one
    assert len(_agent_lines(sync_engine, call_id)) == 2


def test_a_tuned_call_uses_the_lower_token_cap_and_the_prompt_line(client, auth, fakes, monkeypatch, said):  # noqa: F811
    caps = []
    original = fakes.llm._stream

    async def stream(system_text, messages, model=None):
        caps.append(llm.request_max_tokens(settings))
        async for d in original(system_text, messages, model):
            yield d

    fakes.llm._stream = stream
    systems = _capture_systems(fakes)
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
    assert caps and all(c == tt.TAMIL_MAX_REPLY_TOKENS for c in caps)
    assert systems and tt.TAMIL_REPLY_RULE in systems[0]


TWO_AND_THE_ACK = "புரியுது sir. நாங்க AI மூலமா வேலைய simple ஆக்குறோம். இது உங்க team-க்கு ரொம்ப உதவும்."
QUESTION = "உங்க hotel-ல எந்த வேலைக்கு நேரம் போகுது?"


def _reply_heard(client, auth, fakes, monkeypatch, sync_engine, said, reply):  # noqa: F811
    """What the customer hears of `reply` on a tuned call, and that the AI remembers exactly that."""
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    fakes.llm.replies = [OPENING, reply]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        _says(ws, said, "நாங்க hotel நடத்துறோம்")
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.2)
        remembered = cs.ACTIVE_SESSIONS[call_id].history[-1]["content"]
    heard = _agent_lines(sync_engine, call_id)[-1]
    assert remembered == heard  # the AI remembers only what was said
    return heard


def test_a_reply_stops_after_two_sentences_on_a_whole_sentence(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    reply = f"{TWO_AND_THE_ACK} இதெல்லாம் ஒரே screen-ல பாக்கலாம்."
    assert _reply_heard(client, auth, fakes, monkeypatch, sync_engine, said, reply) == TWO_AND_THE_ACK  # the ack didn't use one up


def test_the_reply_s_question_is_said_even_past_the_limit(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    # The model puts its question last: dropping it left the customer in silence, not knowing it was their turn.
    reply = f"{TWO_AND_THE_ACK} இதெல்லாம் ஒரே screen-ல பாக்கலாம். {QUESTION} அப்போ நான் சரியா சொல்ல முடியும்."
    assert _reply_heard(client, auth, fakes, monkeypatch, sync_engine, said, reply) == f"{TWO_AND_THE_ACK} {QUESTION}"


def test_only_one_question_and_none_after_one_within_the_limit(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    asked = "நீங்க hotel நடத்துறீங்களா? நாங்க AI மூலமா வேலைய simple ஆக்குறோம்."
    reply = f"{asked} இது உங்க team-க்கு ரொம்ப உதவும். {QUESTION}"
    assert _reply_heard(client, auth, fakes, monkeypatch, sync_engine, said, reply) == asked


def test_a_hum_that_stops_the_agent_early_lets_it_go_on(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    """BARGE_EARLY_STOP on a tuned call: a "ம்" over the agent stops it at once, and it is a backchannel, so the agent
    goes on from the next sentence. It never reaches the sound turn, which would have dropped the rest."""
    monkeypatch.setattr(settings, "BARGE_EARLY_STOP", True)
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    rest = f"இது உங்க team-க்கு ரொம்ப உதவும். {QUESTION}"
    fakes.llm.replies = [OPENING, f"நாங்க AI மூலமா வேலைய simple ஆக்குறோம். {rest}"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        fakes.tts.chunks_per_sentence = 20  # 2 s of audio per sentence
        _says(ws, said, "நாங்க hotel நடத்துறோம்")
        _until(ws, "playAudio")
        time.sleep(1.0)  # past the echo window, into the first sentence
        said["text"] = "ம்"
        _realtime(ws, tone_mulaw(800))  # the customer is still humming
        _until(ws, "clearAudio")
        _send(ws, silence_mulaw(1000))
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.2)
    assert len(_events(sync_engine, call_id, "barge_in_early")) == 1
    assert len(_events(sync_engine, call_id, "resumed_after_backchannel")) == 1
    assert _events(sync_engine, call_id, "checkin_sent") == []
    assert _agent_lines(sync_engine, call_id)[-1] == rest  # no new AI reply and no fixed line: the rest of this one


def test_the_limit_keeps_the_question_on_its_own():
    tuning = tt.CallTuning(rules=TA, preset="balanced", min_words=1)
    two = ["நாங்க AI மூலமா வேலைய simple ஆக்குறோம்.", "இது உங்க team-க்கு ரொம்ப உதவும்."]
    assert tuning.speaks(two[:1], two[1]) and not tuning.speaks(two, "இன்னொரு விஷயம் இருக்கு sir.")
    assert tuning.speaks(two, QUESTION) and not tuning.speaks([*two, QUESTION], "இன்னொரு கேள்வி இருக்கா sir?")
    assert tuning.speaks(two, "எந்த வேலைக்கு நேரம் போகுது? ") and not tuning.speaks(two, "சரி sir")


def test_the_reminder_reaches_the_model_but_not_the_history(client, auth, fakes, monkeypatch, said):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        _says(ws, said, "நாங்க hotel நடத்துறோம்")
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.2)
        history = cs.ACTIVE_SESSIONS[call_id].history
        assert history[-2] == {"role": "user", "content": "நாங்க hotel நடத்துறோம்"}
    assert fakes.llm.seen_messages[-1][-1]["content"] == "நாங்க hotel நடத்துறோம்" + tt.TAMIL_REPLY_REMINDER


def test_the_end_of_call_marker_is_never_lost_to_the_limit(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    call_id, token = _tamil(client, auth, fakes, monkeypatch)
    fakes.llm.replies = [OPENING, "நீங்க பேசினதுக்கு ரொம்ப நன்றி sir. உங்க நேரம் எங்களுக்கு முக்கியம் sir. இது மூன்றாவது வாக்கியம் தான். இனிய நாளா இருக்கட்டும் sir. [[END_CALL]]"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        _says(ws, said, "வேண்டாம்")
        _ack(ws, _until(ws, "checkpoint"))
        assert _wait_for(lambda: fakes.plivo.hangups)  # the marker was read, so the call still ends
    assert "இனிய நாளா" in _agent_lines(sync_engine, call_id)[-1]  # and the goodbye is said


# ------------------------------------------------------------------ the same call without tuning
def test_a_tamil_call_on_current_behavior_keeps_today_s_path(client, auth, fakes, monkeypatch, sync_engine, said):  # noqa: F811
    """No tuning sent: no check-in, the normal 700 ms wait, the backend's own settings and token cap."""
    call_id, token = _tamil(client, auth, fakes, monkeypatch, tuning=None)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        session = cs.ACTIVE_SESSIONS[call_id]
        assert session._tuning is None and session.cfg is settings
        assert session.endpointer.end_frames == settings.VAD_SPEECH_END_SILENCE_MS // FRAME
        _says(ws, said, "mm")
        time.sleep(0.5)
    assert _events(sync_engine, call_id, "checkin_sent") == []


@pytest.mark.parametrize("language", ["en", "hi", "kn"])
def test_a_call_in_another_language_runs_on_the_backend_s_own_settings(client, auth, fakes, monkeypatch, sync_engine, said, language):  # noqa: F811
    flow = _flow(language, monkeypatch)
    fakes.llm.replies = ["Hello sir."]
    fakes.llm.reply = "Thank you."
    call_id, token = _dial(client, auth, flow, voice_tuning=BALANCED)  # sent anyway: ignored
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _open(ws, said)
        session = cs.ACTIVE_SESSIONS[call_id]
        assert session._tuning is None and session._rules is None and session.cfg is settings
        assert session.endpointer.end_frames == settings.VAD_SPEECH_END_SILENCE_MS // FRAME
        _says(ws, said, "mm")
        time.sleep(0.5)
    assert _events(sync_engine, call_id, "checkin_sent") == []
