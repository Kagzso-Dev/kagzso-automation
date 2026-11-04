"""Backend do-not-call detection in Kannada script (and "remove my number" in the other Indic scripts).

* unit: spelling and conversational variants, "not now" exceptions, look-alike words, and that every
  decision the detector made before (English always; anything it detected in any language) is unchanged;
* integration (fake STT / LLM / TTS / Plivo, nothing real is called): a compiled Kannada AI Agent call with
  DNC_ENFORCE off hangs up after its own Kannada do-not-call line at every stage of the call, without asking
  the LLM, and records do_not_call + Do-Not-Disturb; a normal (non-agent) flow is left to the AI, as before.

The phrases are a careful best effort and STILL NEED a native Kannada speaker's review (with real Sarvam STT
output) before Kannada autonomous calls go live.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import call_service as cs
from app.services.call_service import is_do_not_call
from tests.conftest import silence_mulaw, tone_mulaw
from tests.test_autonomous_agent import _capture_systems
from tests.test_call_policy import _agent_lines, _events, _finish, _rows, _say
from tests.test_nila_flow import _call, _send, _start, _until

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "autonomous"
KN_DNC_LINE = "ಸರಿ, ಅರ್ಥ ಆಯ್ತು. ನಿಮ್ಮ request-ಅನ್ನು ಗೌರವಿಸುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು."


def _before(text: str) -> bool:
    """The detector exactly as it was before the Kannada patterns (the regression reference)."""
    text = text.replace("’", "'")
    asked = cs._DO_NOT_CALL_RE.search(text) or cs._DO_NOT_CALL_INDIC_RE.search(text)
    return bool(asked) and not cs._NOT_NOW_RE.search(text)


# ------------------------------------------------------------------ Kannada: unit
KANNADA_DNC = [
    "ಕಾಲ್ ಮಾಡಬೇಡಿ",
    "ದಯವಿಟ್ಟು ಮತ್ತೆ ಕಾಲ್ ಮಾಡ್ಬೇಡಿ",
    "ಇನ್ನು ಮುಂದೆ ಕಾಲ್ ಮಾಡಬೇಡಿ",                # "from now on": not a "not now"
    "ಇನ್ಮುಂದೆ ಫೋನ್ ಮಾಡ್ಬೇಡ",
    "ನನಗೆ ಕರೆ ಮಾಡಬೇಡಿ",
    "Call ಮಾಡ್ಬೇಡಿ sir",                      # code-mixed STT
    "call ಮಾಡ್ ಬೇಡಿ",                          # STT splits the word
    "ಕಾಲ್ ಮಾಡಲೇಬೇಡಿ",
    "ಮತ್ತೆ ಕಾಲ್ ಮಾಡ್ಬ್ಯಾಡಿ",                    # north Karnataka ಬ್ಯಾಡ
    "ಕಾಲ್ ಮಾಡ್ಬೇಡ್ರಿ",
    "ಕಾಲ್ ಮಾಡೋದು ಬೇಡ",
    "ನನಗೆ ಕಾಲ್ ಮಾಡುವುದು ಬೇಡ",
    "ನನಗೆ ಕಾಲ್‌ಗಳು ಬೇಡ",                   # with ZWNJ
    "ನನಗೆ ಕಾಲ್ಸ್ ಬೇಡ",
    "ಕಾಲ್ ಮಾಡೋದನ್ನ ನಿಲ್ಲಿಸಿ",
    "ಈ ನಂಬರ್‌ಗೆ ಕಾಲ್ ಮಾಡಬಾರದು",
    "ಸಾರ್ ಈ ನಂಬರ್ ಗೆ ಮತ್ತೆ ಕಾಲ್ ಮಾಡಬೇಡಿ",
    "ನಾನು ಈಗಾಗಲೇ ಹೇಳಿದ್ದೀನಿ, ಕಾಲ್ ಮಾಡಬೇಡಿ",      # ಈಗಾಗಲೇ (already) is not ಈಗ (now)
    "ನನ್ನ ನಂಬರ್ ತೆಗೆದುಹಾಕಿ",
    "ನನ್ನ ನಂಬರ್ ತೆಗೆದು ಹಾಕಿ",
    "ನನ್ನ ನಂಬರನ್ನು ತೆಗೆದುಹಾಕಿ",
    "ನಂಬರ್ ಡಿಲೀಟ್ ಮಾಡಿ",
    "ಲಿಸ್ಟ್‌ನಿಂದ ತೆಗೆದುಹಾಕಿ",
    "ಈಗಲೇ ನನ್ನ ನಂಬರ್ ಡಿಲೀಟ್ ಮಾಡಿ",               # removal: "now" does not cancel it
    "ಮತ್ತೆ ಡಿಸ್ಟರ್ಬ್ ಮಾಡಬೇಡಿ",
    "ಇನ್ನು ಮುಂದೆ ತೊಂದರೆ ಕೊಡಬೇಡಿ",
    "call maadbedi",                           # romanised Kannada
    "phone madbeda",
    "Call maadabedi please",
]

KANNADA_NOT_DNC = [
    "ಈಗ ಕಾಲ್ ಮಾಡಬೇಡಿ, ಆಮೇಲೆ ಮಾಡಿ",              # not now
    "ಈಗ ಬ್ಯುಸಿ, ನಾಳೆ ಕಾಲ್ ಮಾಡಿ",
    "ನಾಳೆ ಬೆಳಿಗ್ಗೆ ಕಾಲ್ ಮಾಡಬೇಡಿ, ಸಂಜೆ ಮಾಡಿ",
    "ಸ್ವಲ್ಪ ಹೊತ್ತು ಬಿಟ್ಟು ಕಾಲ್ ಮಾಡಿ",
    "ಡಿಸ್ಟರ್ಬ್ ಮಾಡಬೇಡಿ ಈಗ",
    "call maadbedi iga",
    "ಸಂಜೆ ಕಾಲ್ ಮಾಡಿ",
    "ಸಕ್ಕರೆ ಬೇಡ",                              # sugar: contains ಕರೆ, not a call
    "ಕರೆಂಟ್ ಇಲ್ಲ",
    "ನನ್ನ ನಂಬರ್ ತೆಗೆದುಕೊಳ್ಳಿ",                   # "take my number" is not removal
    "ಹೌದು, ಹೇಳಿ",
    "ಬೇಡ",                                     # not interested is not do-not-call
    "ನನಗೆ ಇದು ಬೇಡ",
    "ಮಾಹಿತಿ ಬೇಡ",
    "ಕಾಲ್ ಮಾಡಿ",
    "ನಾನು ಡ್ರೈವ್ ಮಾಡ್ತಾ ಇದ್ದೀನಿ",
]


@pytest.mark.parametrize("said", KANNADA_DNC)
def test_kannada_do_not_call_is_recognised(said):
    assert is_do_not_call(said, "kn")


@pytest.mark.parametrize("said", KANNADA_NOT_DNC)
def test_kannada_not_now_and_ordinary_answers_are_not_do_not_call(said):
    assert not is_do_not_call(said, "kn")  # left to the AI (busy / callback / not interested / an answer)


def test_the_backend_language_is_the_default(monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "kn")
    assert is_do_not_call("ಕಾಲ್ ಮಾಡಬೇಡಿ")
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "en")
    assert not is_do_not_call("ಕಾಲ್ ಮಾಡಬೇಡಿ")  # the English backend decides exactly as before


# ------------------------------------------------------------------ the other languages: equivalents
EQUIVALENTS = [
    ("en", "Please don't call me again"), ("en", "Stop calling me"), ("en", "Remove my number"),
    ("en", "Take me off your list"), ("en", "No more calls please"),
    ("ta", "இனிமே கால் பண்ணாதீங்க"), ("ta", "கால் பண்ண வேண்டாம்"), ("ta", "நம்பர் ரிமூவ் பண்ணுங்க"),
    ("ta", "என் நம்பரை நீக்குங்க"), ("ta", "லிஸ்ட்ல இருந்து ரிமூவ் பண்ணுங்க"),
    ("hi", "मुझे दोबारा कॉल मत करो"), ("hi", "फोन मत करना"), ("hi", "मेरा नंबर हटा दो"),
    ("hi", "नंबर डिलीट कर दो"), ("hi", "लिस्ट से हटाओ"), ("hi", "अभी मेरा नंबर हटाओ"),
    ("te", "కాల్ చేయకండి"), ("te", "మళ్ళీ ఫోన్ చేయొద్దు"), ("te", "నా నంబర్ తీసేయండి"), ("te", "నంబర్ డిలీట్ చేయండి"),
]
NOT_EQUIVALENTS = [
    ("ta", "இப்போ கால் பண்ணாதீங்க"), ("ta", "என் நம்பரை எடுத்துக்கோங்க"),
    ("hi", "अभी कॉल मत करो"), ("hi", "मेरा नंबर लिख लो"), ("te", "నా నంబర్ తీసుకోండి"),
    ("en", "Don't call me now"), ("en", "Call me later"),
]


@pytest.mark.parametrize("lang,said", EQUIVALENTS)
def test_equivalent_requests_in_the_other_languages(lang, said):
    assert is_do_not_call(said, lang)


@pytest.mark.parametrize("lang,said", NOT_EQUIVALENTS)
def test_not_now_and_take_my_number_in_the_other_languages(lang, said):
    assert not is_do_not_call(said, lang)


# ------------------------------------------------------------------ nothing decided before changes
CORPUS = KANNADA_DNC + KANNADA_NOT_DNC + [s for _, s in EQUIVALENTS + NOT_EQUIVALENTS] + [
    "Don't call me again from now on", "I want the number removed now", "please number remove pannunga",
    "Yes, speaking", "We don't need it", "Hello?", "call mat karo", "call pannadheenga",
    "Who gave you my number?", "Can you remove the extra charges?", "Delete my number now",
    "இப்போ call பண்ணாதீங்க, சாயங்காலம் பேசலாம்", "திரும்ப கூப்பிடாதீங்க", "మళ్ళీ కాల్ చేయకండి",
]


@pytest.mark.parametrize("said", CORPUS)
def test_english_backend_decides_exactly_as_before(said):
    assert is_do_not_call(said, "en") is _before(said)


@pytest.mark.parametrize("lang", ["ta", "hi", "kn", "te"])
@pytest.mark.parametrize("said", CORPUS)
def test_anything_detected_before_is_still_detected(lang, said):
    if _before(said):
        assert is_do_not_call(said, lang)


# ------------------------------------------------------------------ integration: a compiled Kannada agent call
def _kn_agent(monkeypatch):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "kn")
    return json.loads((FIXTURES / "kn.json").read_text(encoding="utf-8"))


def _assert_dnc_recorded(sync_engine, fakes, call_id):
    assert fakes.plivo.hangups == ["uuid-k"]
    assert _rows(sync_engine, "select outcome from calls where id = :id", call_id)[0][0] == "do_not_call"
    assert _rows(sync_engine, "select c.dnd from contacts c join calls k on k.contact_id = c.id where k.id = :id",
                 call_id)[0][0]
    assert "do_not_call_detected" in _events(sync_engine, call_id)


@pytest.mark.parametrize("said", ["ದಯವಿಟ್ಟು ಮತ್ತೆ ಕಾಲ್ ಮಾಡ್ಬೇಡಿ", "ನನ್ನ ನಂಬರ್ ತೆಗೆದುಹಾಕಿ", "Call ಮಾಡ್ ಬೇಡಿ"])
def test_kannada_agent_mid_conversation(client, auth, fakes, sync_engine, monkeypatch, said):
    assert settings.DNC_ENFORCE is False
    flow = _kn_agent(monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = "ಧನ್ಯವಾದಗಳು. ನಾವು hospitals-ಗೆ billing follow-ups automate ಮಾಡ್ತೀವಿ."
    call_id, token = _call(client, auth, gender="male", flow_id="agent_kn", flow_version=1, flow=flow)
    fakes.stt.replies = ["Hello?", "ಹೌದು", "ನಿಮ್ಮ ಕಂಪನಿ ಏನು ಮಾಡುತ್ತೆ?", said]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # opening
        _say(ws)  # identity question
        _say(ws)  # the AI answers the question
        _finish(ws, _say(ws))  # do-not-call
    lines = _agent_lines(sync_engine, call_id)
    assert fakes.llm.reply in lines  # a real AI turn happened first
    assert lines[-1] == KN_DNC_LINE  # the agent's own Kannada line, word for word
    assert len(systems) == 1  # the LLM answered the question only: never asked about the do-not-call turn
    _assert_dnc_recorded(sync_engine, fakes, call_id)


def test_kannada_agent_dnc_answering_the_identity_question(client, auth, fakes, sync_engine, monkeypatch):
    flow = _kn_agent(monkeypatch)
    systems = _capture_systems(fakes)
    fakes.llm.reply = "ಧನ್ಯವಾದಗಳು."
    call_id, token = _call(client, auth, gender="female", flow_id="agent_kn", flow_version=1, flow=flow)
    fakes.stt.replies = ["Hello?", "ಹೌದು", "ಕಾಲ್ ಮಾಡಬೇಡಿ"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")  # opening
        _say(ws)  # identity question
        _finish(ws, _say(ws))  # "don't call" instead of an answer to the identity question
    lines = _agent_lines(sync_engine, call_id)
    assert lines[-1] == KN_DNC_LINE
    assert not systems
    _assert_dnc_recorded(sync_engine, fakes, call_id)


def test_kannada_agent_not_now_is_left_to_the_ai(client, auth, fakes, sync_engine, monkeypatch):
    flow = _kn_agent(monkeypatch)
    fakes.llm.reply = "ಸರಿ, ಯಾವಾಗ ಕಾಲ್ ಮಾಡಲಿ?"
    call_id, token = _call(client, auth, gender="male", flow_id="agent_kn", flow_version=1, flow=flow)
    fakes.stt.replies = ["Hello?", "ಹೌದು", "ಹೇಳಿ", "ಈಗ ಕಾಲ್ ಮಾಡಬೇಡಿ, ಆಮೇಲೆ ಮಾಡಿ"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        _say(ws)
        _say(ws)
        _finish(ws, _say(ws))
    assert _agent_lines(sync_engine, call_id)[-1] == "ಸರಿ, ಯಾವಾಗ ಕಾಲ್ ಮಾಡಲಿ?"
    assert "do_not_call_detected" not in _events(sync_engine, call_id)


def test_kannada_normal_flow_without_enforcement_is_unchanged(client, auth, fakes, sync_engine, monkeypatch):
    """A Kannada flow that is not an AI Agent's, with DNC_ENFORCE off (the default): the AI answers, as before."""
    flow = _kn_agent(monkeypatch)
    flow.pop("autonomous")
    fakes.llm.reply = "ಸರಿ."
    call_id, token = _call(client, auth, gender="male", flow_id="plain_kn", flow_version=1, flow=flow)
    fakes.stt.replies = ["Hello?", "ಹೌದು", "ಹೇಳಿ", "ಮತ್ತೆ ಕಾಲ್ ಮಾಡಬೇಡಿ"]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        _send(ws, tone_mulaw(400) + silence_mulaw(900))
        _until(ws, "checkpoint")
        _say(ws)
        _say(ws)
        _finish(ws, _say(ws))
    assert _agent_lines(sync_engine, call_id)[-1] == "ಸರಿ."
    assert "do_not_call_detected" not in _events(sync_engine, call_id)
