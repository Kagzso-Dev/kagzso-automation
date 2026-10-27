"""One voice backend per language (CALL_LANGUAGE): its voices (SARVAM_TTS_VOICES), its built-in
flows (English script + builtin/<lang>/ spoken lines), flows in other languages refused, one
language per call. English (the default) stays exactly as before."""
import pytest
from pydantic import ValidationError

from app.core.config import Settings, settings
from app.core.voices import offered_voices
from app.flows import loader
from app.flows.schema import CallFlow, render_blocks
from app.services import llm_service as llm
from app.services.call_service import fallback_reply, silence_closing, silence_reprompt
from app.services.tts import apply_pronunciations


def test_call_language_is_a_flow_code():
    assert Settings(CALL_LANGUAGE="ta-IN").call_language == "ta"
    assert Settings(CALL_LANGUAGE="Kn").call_language == "kn"
    assert Settings(CALL_LANGUAGE="auto").call_language == "en"
    assert Settings(CALL_LANGUAGE="").call_language == "en"
    assert settings.call_language == "en"  # test settings: the English backend


def test_english_voices_unchanged_without_sarvam_tts_voices():
    voices, default = offered_voices("", "roopa", "en")
    assert [v["id"] for v in voices] == ["roopa", "ritu", "simran", "ishita"] and default == "roopa"
    assert voices[0] == {"id": "roopa", "name": "Roopa", "gender": "female", "language": "English (India)"}


def test_a_language_backend_offers_its_own_voices():
    voices, default = offered_voices(" kavitha:female, mani:Male ,bad id,kavitha, Arvind ", "mani", "ta")
    assert voices == [
        {"id": "kavitha", "name": "Kavitha", "gender": "female", "language": "Tamil (India)"},
        {"id": "mani", "name": "Mani", "gender": "male", "language": "Tamil (India)"},
        {"id": "arvind", "name": "Arvind", "language": "Tamil (India)"},
    ]
    assert default == "mani"  # SARVAM_TTS_SPEAKER when listed
    assert offered_voices("kavitha,mani", "roopa", "ta")[1] == "kavitha"  # else the first voice
    # Nothing set: the same four speakers, labelled with the backend's language.
    voices, default = offered_voices("", "", "hi")
    assert [v["id"] for v in voices] == ["roopa", "ritu", "simran", "ishita"] and default == "roopa"
    assert {v["language"] for v in voices} == {"Hindi (India)"}


@pytest.mark.parametrize("lang,name", [("ta", "Tamil"), ("hi", "Hindi"), ("kn", "Kannada")])
def test_builtin_flows_in_another_language(monkeypatch, lang, name):
    english = {base: flow for base, flow in loader.BUILTIN_FLOWS.items()}
    monkeypatch.setattr(settings, "CALL_LANGUAGE", lang)
    nila, followup = loader.load_builtin("nila"), loader.load_builtin("followup")
    for own, en in ((nila, english["nila"]), (followup, english["followup"])):
        assert own.language == lang and name in own.name
        assert render_blocks(own) == render_blocks(en)  # the script blocks stay the English instructions
        assert own.silence.reprompt != en.silence.reprompt
    assert nila.greeting.text == english["nila"].greeting.text  # "Hi {{title_to_use}}, {{time_greeting}}."
    assert nila.identity and "{{customer_name}}" in nila.identity.question
    assert followup.greeting.text != english["followup"].greeting.text and "{{addressed_name}}" in followup.greeting.text


def test_english_builtins_unchanged():
    nila = loader.load_builtin("nila")
    assert nila.language == "en" and nila.identity is None
    assert nila.model_dump(mode="json") == loader.BUILTIN_FLOWS["nila"].model_dump(mode="json")


def test_a_flow_in_another_language_is_refused(monkeypatch):
    flow = loader.BUILTIN_FLOWS["nila"].model_dump(mode="json")
    with pytest.raises(ValidationError, match="calls in 'en'"):
        CallFlow.model_validate({**flow, "language": "ta"})
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "ta")
    with pytest.raises(ValidationError, match="calls in 'ta'"):
        CallFlow.model_validate(flow)  # an English flow sent to the Tamil backend
    assert CallFlow.model_validate({**flow, "language": "ta"}).language == "ta"


def test_catalog_says_which_language_the_backend_calls_in(client, auth):
    body = client.get("/api/flows/builtin", headers=auth).json()
    assert body["language"] == "en" and body["flows"]["nila"]["language"] == "en"
    assert client.get("/ready").json()["language"] == "en"


def test_one_call_one_language():
    rule = llm.language_instruction("ta")
    assert "One call, one language" in rule and "may switch to English" not in rule
    assert "keep every reply in Hindi" in llm.language_instruction("hi")
    assert llm.language_instruction("en") == ""


def test_fixed_lines_and_brand_for_hindi_and_kannada():
    for lang in ("hi", "kn"):
        assert fallback_reply(lang) != fallback_reply("en")
        assert silence_reprompt(lang) != silence_reprompt("en")
        assert silence_closing(lang).endswith("Have a nice day.")
    assert apply_pronunciations("मैं Kagzso से बोल रही हूँ", "hi") == "मैं केक्सो से बोल रही हूँ"
    assert apply_pronunciations("Visit kagzso.com", "kn") == "Visit ಕೆಕ್ಸೋ dot com"
    assert apply_pronunciations("This is Priya from Kagzso.", "en") == "This is Priya from Kexo."
