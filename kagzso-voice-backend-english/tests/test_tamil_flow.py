"""Tamil (ta) calls with the Thaara Tamil flow (deploy/callflows/thaara-tamil.json), fakes only: no call,
no real STT / TTS / LLM / Plivo, and a throw-away SQLite database (tests/conftest.py).

Two kinds of check:
  * system   - what the code does or speaks itself (greeting, identity lines, silence lines, voice-focus
               gates, echo, fallback). These prove behaviour.
  * prompt   - what the rendered Tamil prompt tells the AI (introduction, closings, outcomes, safety). With
               a fake LLM these prove only that the instruction is there, not that the AI obeys it.

Known gaps are marked xfail(strict=True): they fail today and will flag (XPASS) once fixed.

Run only the Tamil tests (from kagzso-voice-backend-english):
    .venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/test_tamil_flow.py
"""
import hashlib
import io
import json
import time
import wave
from pathlib import Path

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.services import audio_service as audio
from app.services import llm_service as llm
from app.services import voice_focus as vf
from app.services.call_service import fallback_reply, needs_script_at_opening
from app.services.sarvam_stt import STTError
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_noise import noise_pcm
from tests.test_nila_flow import _call, _send, _start, _until

ROOT = Path(__file__).resolve().parents[2]
BACKEND = Path(__file__).resolve().parents[1]
FLOW = json.loads((ROOT / "deploy/callflows/thaara-tamil.json").read_text(encoding="utf-8"))

GREETING = "Hi sir, Good morning."  # conftest fixes the clock to the morning
IDENTITY = "நான் Ragul sir-கிட்ட தான் பேசுறேனா?"
PERMISSION = ("Thank you sir. நான் Thaara பேசுறேன், Kexo AI and Automation-ல இருந்து. "
              "இது எங்க company பத்தின ஒரு சின்ன introduction call. ஒரு minute பேசலாமா, sir?")
INTRO = ("சரிங்க sir, thank you. நாங்க AI agents and automation solutions provide பண்றோம். Customer follow-up, "
         "data entry, reporting மாதிரியான repetitive work-ல manual effort-ஐ குறைக்க உதவுவோம். "
         "உங்க business-க்கு இது useful-ஆ இருக்கும்னு நினைக்கிறீங்களா?")
MAIN_QUESTION = "உங்க team தினமும் repetitive work-க்கு நிறைய time செலவு பண்றாங்களா?"
REPROMPT = "Hello, கேக்குதா?"
CLOSING = "பரவாயில்ல. உங்க time-க்கு thanks. Have a nice day."

# Scenario 16: these English / Hindi / Kannada files must be byte-for-byte the same after the Tamil tests.
PROTECTED = sorted(
    [BACKEND / "app/flows/builtin" / n for n in ("nila.json", "followup.json", "locked_blocks.json")]
    + list((BACKEND / "app/flows/builtin/hi").glob("*.json")) + list((BACKEND / "app/flows/builtin/kn").glob("*.json"))
    + [ROOT / "deploy/callflows" / n for n in ("thaara-natural.json", "thaara-hindi.json", "pooja.json")]
)


def _hashes():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in PROTECTED}


@pytest.fixture(scope="module", autouse=True)
def other_languages_untouched():
    before = _hashes()
    assert len(before) >= 9, before  # the list really found the files
    yield
    assert _hashes() == before, "an English / Hindi / Kannada flow file changed during the Tamil tests"


@pytest.fixture(autouse=True)
def tamil(monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "ta")


@pytest.fixture
def enforce(monkeypatch):
    monkeypatch.setattr(settings, "VOICE_FOCUS_LEVEL", "balanced")
    monkeypatch.setattr(settings, "VOICE_FOCUS_MODE", "enforce")


@pytest.fixture
def prompts(fakes, monkeypatch):
    """The system prompt of every LLM request (the fake LLM records only the messages)."""
    seen = []
    real = fakes.llm._stream

    async def spy(system_text, messages, model=None):
        seen.append(system_text)
        async for part in real(system_text, messages, model):
            yield part

    monkeypatch.setattr(fakes.llm, "_stream", spy)
    return seen


def _tamil_call(client, auth, name="ragul", **extra):
    return _call(client, auth, customer_name=name, gender="male", flow_id="thaara_ta", flow_version=1, flow=FLOW, **extra)


def _ack(ws, cp):
    ws.send_text(json.dumps({"event": "playedStream", "streamId": "s-k", "name": cp["name"]}))


def _converse(client, auth, fakes, turns, llm_replies=(), name="ragul"):
    """turns: (what STT hears, whether the agent answers it). Each answered line is acknowledged as played,
    then the customer waits 0.5 s (out of the echo window) before speaking again. Returns (call_id, lines)."""
    call_id, token = _tamil_call(client, auth, name=name)
    fakes.stt.replies = [t for t, _ in turns]
    replies = list(llm_replies)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _, answered in turns:
            if replies and len(fakes.llm.seen_messages) < len(replies):
                fakes.llm.reply = replies[len(fakes.llm.seen_messages)]
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            if answered:
                _ack(ws, _until(ws, "checkpoint"))
            time.sleep(0.5 if answered else 1.0)
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.2)
    return call_id, [" ".join(s.texts) for s in fakes.tts.streams]


def _events(sync_engine, call_id, kind):
    with sync_engine.connect() as c:
        rows = c.execute(text("select payload from call_events where call_id = :id and event_type = :t"),
                         {"id": call_id, "t": kind}).scalars().all()
    return [json.loads(p) if isinstance(p, str) else (p or {}) for p in rows]


def _preview(client, auth, **sample):
    body = client.post("/api/flows/preview", headers=auth,
                       json={"flow": FLOW, "sample": {"customer_name": "Ragul", "gender": "male", **sample}}).json()
    assert body["valid"], body
    return body


def _block(block_id):
    return next(b["text"] for b in FLOW["blocks"] if b.get("id") == block_id)


TO_PERMISSION = [("Hello?", True), ("Hello", True), ("ஆமா", True)]  # greeting, identity question, intro + permission


# ------------------------------------------------------------------ 1. opening (system)
def test_1_opening_uses_title_time_greeting_and_name_and_asks_identity_once(client, auth, fakes):
    _, lines = _converse(client, auth, fakes, [("Hello?", True), ("Hello", True), ("ஆமா", True)],
                         llm_replies=[PERMISSION], name="Ragul")
    assert lines[0] == GREETING
    assert lines[1] == IDENTITY
    assert sum(line == IDENTITY for line in lines) == 1  # asked once
    assert fakes.llm.seen_messages[0][-1] == {"role": "user", "content": "ஆமா"}


@pytest.mark.xfail(strict=True, reason="GAP: names are spoken as stored; a lower-case 'ragul' is not title-cased")
def test_1_customer_name_is_spoken_in_title_case(client, auth):
    assert _preview(client, auth, customer_name="ragul")["identity_question"] == IDENTITY


@pytest.mark.xfail(strict=True, reason="GAP: the Thaara Tamil flow has no identity.reask, so the English "
                                       "'Sorry, am I speaking with ...?' is spoken in a Tamil call")
def test_1_identity_reask_is_tamil(client, auth):
    assert "Sorry, am I speaking with" not in _preview(client, auth)["identity_reask"]


# ------------------------------------------------------------------ 2. "ஆமா" -> introduction + permission
def test_2_amma_after_identity_goes_to_the_script_with_the_permission_line(client, auth, fakes, prompts):
    _, lines = _converse(client, auth, fakes, TO_PERMISSION, llm_replies=[PERMISSION])
    assert fakes.llm.seen_messages[0][-1]["content"] == "ஆமா"  # not dropped, not scripted
    assert PERMISSION in prompts[0]  # prompt: the exact introduction + permission line
    assert lines[2] == PERMISSION


# ------------------------------------------------------------------ 3. lone filler after the permission question
@pytest.mark.parametrize("filler", ["ம்", "ஆ", "ஹ்ம்", "ஊ"])
def test_3_lone_filler_is_not_permission_reasked_once_then_ignored(client, auth, fakes, sync_engine, enforce, filler):
    call_id, lines = _converse(client, auth, fakes, TO_PERMISSION + [(filler, True), (filler, False)],
                               llm_replies=[PERMISSION, PERMISSION])
    assert len(fakes.llm.seen_messages) == 2  # one re-ask; the second filler never reaches the AI
    assert fakes.llm.seen_messages[1][-1]["content"] == vf.FILLER_NOTE.format(text=filler)
    assert [e["reason"] for e in _events(sync_engine, call_id, "turn_rejected")] == ["filler"]
    assert lines[-1] == PERMISSION  # nothing moved on by itself


def test_3_in_log_mode_today_a_filler_still_reaches_the_ai(client, auth, fakes, sync_engine):
    # VOICE_FOCUS_MODE=log is the shipped default: it only records what it would drop.
    call_id, _ = _converse(client, auth, fakes, TO_PERMISSION + [("ம்", True)], llm_replies=[PERMISSION, PERMISSION])
    assert fakes.llm.seen_messages[1][-1]["content"] == "ம்"
    assert [e["reason"] for e in _events(sync_engine, call_id, "turn_would_reject")] == ["filler"]


# ------------------------------------------------------------------ 4. real permission words
@pytest.mark.parametrize("said", ["ஆமா", "சரி", "சொல்லுங்க", "Okay"])
def test_4_permission_words_reach_the_script_unchanged(client, auth, fakes, enforce, prompts, said):
    _converse(client, auth, fakes, TO_PERMISSION + [(said, True)], llm_replies=[PERMISSION, INTRO])
    assert fakes.llm.seen_messages[1][-1]["content"] == said
    assert not vf.is_lone_filler(said)
    assert f'"{said}"' in _block("positive_permission")  # the flow lists it as permission
    assert INTRO in prompts[1]  # prompt: the exact company introduction comes next


# ------------------------------------------------------------------ 5. interest question
def test_5_filler_after_the_interest_question_reasks_and_yes_moves_on(client, auth, fakes, enforce, prompts):
    _converse(client, auth, fakes, TO_PERMISSION + [("சரி", True), ("ம்", True), ("ஆமா", True)],
              llm_replies=[PERMISSION, INTRO, INTRO, MAIN_QUESTION])
    assert fakes.llm.seen_messages[2][-1]["content"] == vf.FILLER_NOTE.format(text="ம்")
    assert fakes.llm.seen_messages[3][-1]["content"] == "ஆமா"
    assert MAIN_QUESTION in prompts[3]  # prompt: a yes leads to the main business question
    assert "Ask only after the customer says yes to the interest question" in _block("main_question")


# ------------------------------------------------------------------ 6. "சரி" to the main question
@pytest.mark.xfail(strict=True, reason="GAP: the flow has no rule for a bare 'சரி' to the main question "
                                       "(one easy follow-up with examples)")
def test_6_bare_sari_to_the_main_question_gets_a_follow_up_with_examples():
    main = _block("main_question") + _block("after_company_intro")
    assert "சரி" in _block("main_question") and "example" in main.lower()


def test_6_sari_is_an_answer_word_not_a_filler():
    assert not vf.is_lone_filler("சரி")


# ------------------------------------------------------------------ 7. closings, outcomes, DNC (prompt)
@pytest.mark.parametrize("block,closing,outcome", [
    ("busy", "பரவாயில்ல sir. உங்க time-க்கு நன்றி. Have a nice day.", "busy"),
    ("not_interested", "சரி, no problem sir. உங்க time-க்கு ரொம்ப நன்றி. Have a nice day.", "not_interested"),
    ("end_call_request", "சரிங்க, உங்க time-க்கு thanks. Have a nice day.", None),
])
def test_7_closing_lines_and_outcomes_are_in_the_prompt(client, auth, block, closing, outcome):
    prompt = _preview(client, auth)["system_prompt"]
    assert closing in prompt
    if outcome:
        assert f"Outcome: `{outcome}`" in _block(block)


def test_7_triggers_are_listed_in_the_flow():
    assert "இப்போ busy" in _block("busy") and "வேண்டாம்" in _block("not_interested") and '"Bye"' in _block("end_call_request")


def test_7_dnc_and_wrong_person_rules_are_in_the_prompt_and_dnc_comes_first(client, auth):
    prompt = _preview(client, auth)["system_prompt"]
    assert "do_not_call" in prompt and "wrong_person" in prompt
    assert prompt.index("DO NOT CALL") < prompt.index("WRONG PERSON") < prompt.index("COMPANY INTRODUCTION")


def test_7_romanised_tamil_dnc_at_the_opening_goes_to_the_script():
    assert needs_script_at_opening("ini call pannadheenga")


@pytest.mark.xfail(strict=True, reason="GAP: the opening's do-not-call check only knows romanised Tamil, "
                                       "not Tamil script as Sarvam codemix writes it")
def test_7_tamil_script_dnc_at_the_opening_goes_to_the_script():
    assert needs_script_at_opening("இனி call பண்ணாதீங்க")


# ------------------------------------------------------------------ 8. unclear audio
def test_8_one_clarification_then_close_is_in_the_prompt():
    rule = _block("unclear_audio")
    assert "கொஞ்சம் சத்தமா பேசுவீங்களா?" in rule and "ஒரு தடவை திரும்ப சொல்லுவீங்களா?" in rule
    assert "never a third" in rule and "பரவாயில்ல. உங்க time-க்கு thanks. Have a nice day." in rule


def test_8_stt_failure_speaks_the_tamil_fallback(client, auth, fakes, monkeypatch, sync_engine):
    real = fakes.stt.transcribe

    async def flaky(audio_data, *a, **k):
        if fakes.stt.calls == 2:  # the reply to the identity question
            fakes.stt.calls += 1
            raise STTError("timeout", "test")
        return await real(audio_data, *a, **k)

    monkeypatch.setattr(fakes.stt, "transcribe", flaky)
    call_id, _ = _converse(client, auth, fakes, [("Hello?", True), ("Hello", True), ("ஆமா", True)])
    with sync_engine.connect() as c:
        agent_lines = c.execute(text("select text from transcripts where call_id = :id and speaker = 'agent' order by id"),
                                {"id": call_id}).scalars().all()
    assert agent_lines[-1] == fallback_reply("ta")  # played as its own (pre-rendered) line
    assert fakes.llm.seen_messages == []


# ------------------------------------------------------------------ 9. silence (system)
def test_9_silence_one_hello_then_the_closing(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "IDENTITY_SILENCE_WAIT_SECONDS", 0.3)
    monkeypatch.setattr(settings, "GREETING_WAIT_SECONDS", 0.2)
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 0.6)
    call_id, token = _tamil_call(client, auth, name="Ragul")
    fakes.stt.replies = ["Hello?"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _ack(ws, _until(ws, "checkpoint"))  # greeting
        _ack(ws, _until(ws, "checkpoint"))  # identity question
        for _ in range(3):  # its one repeat, the one hello, the closing
            _ack(ws, _until(ws, "checkpoint"))
        deadline = time.time() + 5
        while not fakes.plivo.hangups and time.time() < deadline:
            time.sleep(0.05)
    lines = [" ".join(s.texts) for s in fakes.tts.streams]
    assert lines == [GREETING, IDENTITY, IDENTITY, REPROMPT, CLOSING]
    assert lines.count(REPROMPT) == 1 and fakes.plivo.hangups and fakes.llm.seen_messages == []


# ------------------------------------------------------------------ 10. interested closing (prompt)
@pytest.mark.parametrize("team", [False, True])
def test_10_interested_closing_follows_team_follow_up(client, auth, monkeypatch, team):
    monkeypatch.setattr(settings, "TEAM_FOLLOWUP_ENABLED", team)
    prompt = _preview(client, auth)["system_prompt"]
    assert f'"team_follow_up_configured": {str(team).lower()}' in prompt
    rule = _block("interested_close")
    assert "ONLY when the customer answers the interest question with yes" in rule
    assert "If `team_follow_up_configured` is false, say only" in rule
    assert "Never invent a demo, meeting, callback, appointment or follow-up time" in rule


# ------------------------------------------------------------------ 11. phantom turns (system)
def _agent_speaking(client, auth, fakes, ws):
    """Up to the permission line, which then keeps playing (not acknowledged)."""
    fakes.tts.chunks_per_sentence = 20
    _start(ws)
    for _ in range(2):
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _ack(ws, _until(ws, "checkpoint"))
        time.sleep(0.5)
    _send(ws, tone_mulaw(400) + silence_mulaw(900))
    _until(ws, "checkpoint")  # permission line queued, still playing


def test_11_breath_after_a_question_makes_no_turn(client, auth, fakes, sync_engine, enforce, monkeypatch):
    monkeypatch.setattr(audio, "make_webrtc_classifier", lambda *a, **k: (lambda f: audio.rms(f) > 200))
    call_id, token = _tamil_call(client, auth)
    fakes.stt.replies = ["Hello?", "Hello", "ஆமா", "சரி"]
    fakes.llm.reply = PERMISSION
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _ in range(3):
            _send(ws, tone_mulaw(400) + silence_mulaw(900))
            _ack(ws, _until(ws, "checkpoint"))
            time.sleep(0.5)
        _send(ws, audio.pcm16_to_mulaw(noise_pcm(500, 1500, seed=4)) + silence_mulaw(900))  # a breath
        time.sleep(1.0)
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.2)
    assert fakes.stt.calls == 3 and len(fakes.llm.seen_messages) == 1
    assert [e["reason"] for e in _events(sync_engine, call_id, "turn_rejected")] == ["no_voice_pitch"]


def test_11_steady_noise_makes_no_turn(client, auth, fakes, enforce, monkeypatch):
    monkeypatch.setattr(audio, "make_webrtc_classifier", lambda *a, **k: (lambda f: audio.rms(f) > 200))
    call_id, token = _tamil_call(client, auth)
    fakes.stt.replies = ["சரி"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, audio.pcm16_to_mulaw(noise_pcm(3000, 350)) + silence_mulaw(900))
        time.sleep(0.5)
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.stt.calls == 0 and fakes.llm.seen_messages == []


@pytest.mark.parametrize("heard,event", [("ம்", "barge_in_ignored"),
                                         ("Kexo AI and Automation-ல இருந்து", "echo_ignored")])
def test_11_filler_or_echo_under_the_agent_never_interrupts(client, auth, fakes, sync_engine, enforce, heard, event):
    call_id, token = _tamil_call(client, auth)
    fakes.stt.replies = ["Hello?", "Hello", "ஆமா", heard]
    fakes.llm.reply = PERMISSION
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_speaking(client, auth, fakes, ws)
        _send(ws, tone_mulaw(800) + silence_mulaw(900))
        deadline = time.time() + 5
        while not _events(sync_engine, call_id, event) and time.time() < deadline:
            time.sleep(0.05)
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.2)
    assert _events(sync_engine, call_id, event)
    assert not _events(sync_engine, call_id, "barge_in") and len(fakes.llm.seen_messages) == 1


def test_11_short_sound_under_the_agent_is_ignored_and_a_real_barge_in_works(client, auth, fakes, sync_engine, enforce):
    call_id, token = _tamil_call(client, auth)
    fakes.stt.replies = ["Hello?", "Hello", "ஆமா", "ஒரு நிமிஷம், யாரு பேசுறது?"]
    fakes.llm.reply = PERMISSION
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _agent_speaking(client, auth, fakes, ws)
        _send(ws, tone_mulaw(300) + silence_mulaw(900))  # too short to be an interruption
        time.sleep(0.6)
        assert fakes.stt.calls == 3
        _send(ws, tone_mulaw(900) + silence_mulaw(900))  # a real sentence
        msgs = []
        while not msgs or msgs[-1]["event"] != "checkpoint":
            msgs.append(ws.receive_json())
        ws.send_text(json.dumps({"event": "stop"}))
    assert {"event": "clearAudio", "streamId": "s-k"} in msgs
    assert fakes.llm.seen_messages[-1][-1]["content"] == "ஒரு நிமிஷம், யாரு பேசுறது?"
    assert [e["reason"] for e in _events(sync_engine, call_id, "turn_rejected")] == ["agent_speaking"]


# ------------------------------------------------------------------ 12. soft and loud "ஆமா" (system)
@pytest.mark.parametrize("amplitude", [1500, 30000])  # quiet but clear / loud
def test_12_soft_and_loud_amma_count_and_stt_gets_the_audio_unclipped(client, auth, fakes, enforce, monkeypatch, amplitude):
    heard = []
    real = fakes.stt.transcribe

    async def keep(audio_data, *a, **k):
        heard.append(audio_data)
        return await real(audio_data, *a, **k)

    monkeypatch.setattr(fakes.stt, "transcribe", keep)
    call_id, token = _tamil_call(client, auth)
    fakes.stt.replies = ["Hello?", "Hello", "ஆமா"]
    fakes.llm.reply = PERMISSION
    sent = tone_mulaw(300, amplitude)
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for i in range(3):
            _send(ws, (sent if i == 2 else tone_mulaw(400)) + silence_mulaw(900))
            _ack(ws, _until(ws, "checkpoint"))
            time.sleep(0.5)
        ws.send_text(json.dumps({"event": "stop"}))
    assert fakes.llm.seen_messages[-1][-1]["content"] == "ஆமா"
    with wave.open(io.BytesIO(heard[2])) as w:
        got = w.readframes(w.getnframes())
    peak_in = audio.audioop.max(audio.mulaw_to_pcm16(sent), 2)
    assert abs(audio.audioop.max(got, 2) - peak_in) <= 0.05 * peak_in  # same level: not boosted, not clipped


# ------------------------------------------------------------------ 13. Tanglish, Kexo, other languages
def test_13_tanglish_rules_and_brand_are_in_the_prompt(client, auth):
    prompt = _preview(client, auth)["system_prompt"]
    assert llm.language_instruction("ta") in prompt
    assert "Write Tamil words in Tamil script" in prompt and "Keep everyday English words in English letters" in prompt
    assert "Never switch to Hindi or another language" in prompt
    assert "Sorry, எனக்கு Tamil, English மட்டும் தான் பேச வரும். உங்க time-க்கு thanks. Have a nice day." in prompt
    assert 'always say "Kexo"' in prompt and llm.brand_spoken("ta") in prompt


def test_13_kexo_is_spoken_the_tamil_way(client, auth, fakes):
    from app.services.tts import apply_pronunciations  # what SarvamTTS applies to every Tamil line

    _, lines = _converse(client, auth, fakes, TO_PERMISSION, llm_replies=[PERMISSION])
    assert "Kexo" in lines[2]  # the text sent to TTS
    spoken = apply_pronunciations(lines[2], "ta")
    assert "Kexo" not in spoken and "கெக்ஸோ" in spoken


# ------------------------------------------------------------------ 14. system lines word for word
def test_14_system_lines_are_the_flows_own_words(client, auth):
    body = _preview(client, auth)
    assert body["greeting"] == GREETING
    assert body["identity_question"] == IDENTITY
    assert (body["silence_reprompt"], body["silence_closing"]) == (REPROMPT, CLOSING)
    for line in (PERMISSION, INTRO):  # spoken by the AI: the prompt says them exactly
        assert line in body["system_prompt"]
    assert "say exactly" in _block("company_intro")


# ------------------------------------------------------------------ 15. safety tail
def test_15_safety_rules_are_in_the_prompt(client, auth):
    prompt = _preview(client, auth)["system_prompt"]
    assert "say honestly that you are an AI assistant calling on behalf of the company. Never claim to be human." in prompt
    assert "no invented prices, discounts, savings" in prompt
    assert "Never invent a price." in prompt and "Never invent a percentage." in prompt
    assert "another person's contact details" in prompt


@pytest.mark.xfail(strict=True, reason="GAP: the Tamil flow's blocks have no line break between them, so 40 "
                                       "headings are glued to the previous line ('...Outcome: `interested`# PRICE QUESTION')")
def test_15_every_heading_starts_on_its_own_line(client, auth):
    prompt = _preview(client, auth)["system_prompt"]
    assert "`interested`# PRICE QUESTION" not in prompt and ".# SAVINGS QUESTION" not in prompt


# ------------------------------------------------------------------ 16. other languages untouched
def test_16_protected_files_are_hashed():
    assert {p.parent.name for p in PROTECTED} >= {"builtin", "hi", "kn", "callflows"}
