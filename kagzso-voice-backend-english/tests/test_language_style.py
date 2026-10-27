"""Call Flows "Language style": a non-English flow speaks mixed (Tanglish / Hinglish / Kanglish, what every
call did before the setting) or pure. Flows saved before it (no style) stay mixed; English has no style; the
safety rules, the Kexo line and [[END_CALL]] are the same in both styles; speech recognition keeps
SARVAM_STT_MODE unless SARVAM_STT_MODE_PURE is set (then only Pure flows use it)."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import text

from app.core.config import settings
from app.flows import loader
from app.flows.schema import CallFlow, render_blocks
from app.schemas.calls import normalize_gender
from app.services import llm_service as llm
from app.services.call_service import identity_after_greeting, identity_lines, stt_for_call
from app.services.sarvam_stt import SarvamSTT


def _flow_dict(monkeypatch, language="ta", **extra):
    monkeypatch.setattr(settings, "CALL_LANGUAGE", language)
    data = loader.load_builtin("nila").model_dump(mode="json", exclude_none=True)
    return {**data, **extra}


def test_flows_saved_before_the_setting_are_mixed(monkeypatch):
    old = CallFlow.model_validate(_flow_dict(monkeypatch))
    assert old.language_style is None  # = mixed, as every call before
    assert CallFlow.model_validate(_flow_dict(monkeypatch, language_style="pure")).language_style == "pure"
    with pytest.raises(ValidationError):
        CallFlow.model_validate(_flow_dict(monkeypatch, language_style="loud"))


def test_an_english_flow_has_no_style(monkeypatch):
    assert CallFlow.model_validate(_flow_dict(monkeypatch, language="en")).language_style is None
    with pytest.raises(ValidationError, match="English flow has no language style"):
        CallFlow.model_validate(_flow_dict(monkeypatch, language="en", language_style="mixed"))


@pytest.mark.parametrize("lang,name", [("ta", "Tamil"), ("hi", "Hindi"), ("kn", "Kannada")])
def test_mixed_is_todays_rule_word_for_word_and_pure_has_its_own(lang, name):
    today = llm.language_instruction(lang)
    assert llm.language_instruction(lang, "mixed") == today and llm.language_instruction(lang, None) == today
    assert "code-mixed with English" in today
    pure = llm.language_instruction(lang, "pure")
    assert pure != today and f"simple, natural spoken {name}" in pure and "code-mixed" not in pure
    assert "One call, one language" in pure and "NEVER transliterate English words" in pure


def test_english_gets_no_language_rule_in_either_style():
    assert llm.language_instruction("en") == llm.language_instruction("en", "pure") == ""


def test_the_preview_prompt_follows_the_style_and_keeps_every_rule(client, auth, monkeypatch):
    def prompt(style=None):
        flow = _flow_dict(monkeypatch, **({"language_style": style} if style else {}))
        r = client.post("/api/flows/preview", headers=auth, json={"flow": flow, "sample": {"customer_name": "Ragul", "gender": "male"}})
        assert r.status_code == 200 and r.json()["valid"], r.text
        return r.json()["system_prompt"]

    old, mixed, pure = prompt(), prompt("mixed"), prompt("pure")
    assert old == mixed  # no style = mixed, unchanged
    assert llm.language_instruction("ta") in mixed and llm.language_instruction("ta", "pure") in pure
    for p in (mixed, pure):  # safety rules, Kexo and the hang-up marker are untouched by the style
        assert llm.SAFETY_RULES in p and llm.VOICE_RULES in p and llm.END_CALL_TOKEN in p
        assert "pronounced \"Kexo\"" in p and llm.brand_spoken("ta") in p
    assert pure.replace(llm.language_instruction("ta", "pure"), "") == mixed.replace(llm.language_instruction("ta"), "")


def test_speech_recognition_mode_per_style(monkeypatch):
    shared = SarvamSTT(settings)
    pure, mixed = {"flow_language_style": "pure"}, {}
    monkeypatch.setattr(settings, "SARVAM_STT_MODE", "codemix")
    assert stt_for_call(shared, pure, settings) is shared  # SARVAM_STT_MODE_PURE empty (default): unchanged

    monkeypatch.setattr(settings, "SARVAM_STT_MODE_PURE", "transcribe")
    own = stt_for_call(shared, pure, settings)
    assert own is not shared and own._client is shared._client  # same connection pool
    assert own._form("saaras:v3")["mode"] == "transcribe"
    assert stt_for_call(shared, mixed, settings) is shared  # mixed flows (and calls without a flow) as before
    assert shared._form("saaras:v3")["mode"] == "codemix" and settings.SARVAM_STT_MODE == "codemix"


NOON_UTC = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)  # the clock BEFORE was recorded with (a fixed "Good evening")
BEFORE = json.loads((Path(__file__).parent / "fixtures" / "language_calls_before_style.json").read_text(encoding="utf-8"))


def _call(flow, variables):
    """What a call with this flow uses: prompt, spoken lines, voice and speech recognition (as the preview / a call)."""
    q, r = (identity_lines(variables, flow.identity.question if flow.identity else None, flow.identity.reask if flow.identity else None)
            if identity_after_greeting(flow.greeting.text) else (None, None))
    return {
        "system_prompt": llm.build_system_prompt(render_blocks(flow), variables),
        "greeting": llm.render_first_message(flow.greeting.text, variables),
        "identity": [q, r],
        "silence": [llm.render_first_message(flow.silence.reprompt, variables), llm.render_first_message(flow.silence.closing, variables)],
        "voice": flow.voice_id or settings.tts_speaker,
        "stt": stt_for_call(SarvamSTT(settings), variables, settings)._form(settings.SARVAM_STT_MODEL),
    }


@pytest.mark.parametrize("lang", ["ta", "hi", "kn"])
@pytest.mark.parametrize("style", [None, "mixed"])
def test_existing_and_mixed_flows_call_exactly_as_before_the_setting(client, auth, sync_engine, monkeypatch, lang, style):
    # BEFORE was recorded from the commit before Language style (5d2b6b8), same flow and customer.
    monkeypatch.setattr(settings, "SARVAM_STT_MODE", "codemix")
    monkeypatch.setattr(settings, "SARVAM_STT_MODE_PURE", "transcribe")  # even with the switch on
    flow = CallFlow.model_validate(_flow_dict(monkeypatch, lang, **({"language_style": style} if style else {})))
    r = client.post("/api/calls/outbound", headers=auth, json={"phone_number": "+919876543210", "customer_name": "Ragul",
                    "gender": "male", "agent_name": "Nila", "flow_id": "flow_old", "flow_version": 1,
                    "flow": flow.model_dump(mode="json", exclude_none=True)})
    assert r.status_code == 200, r.text
    with sync_engine.connect() as c:
        stored = json.loads(c.execute(text("select variables from calls order by created_at desc")).scalar())
    assert "flow_language_style" not in stored  # a call's variables carry nothing new

    variables = llm.build_call_variables("Ragul", normalize_gender("male"), "+910000000000", now=NOON_UTC)
    assert _call(flow, variables) == BEFORE[lang]

    pure = _call(CallFlow.model_validate(_flow_dict(monkeypatch, lang, language_style="pure")), {**variables, "flow_language_style": "pure"})
    assert pure["system_prompt"] != BEFORE[lang]["system_prompt"] and pure["stt"]["mode"] == "transcribe"  # only Pure changes
    assert {k: pure[k] for k in ("greeting", "identity", "silence", "voice")} == {k: BEFORE[lang][k] for k in ("greeting", "identity", "silence", "voice")}


def test_a_test_fake_recogniser_is_never_replaced(fakes, monkeypatch):
    monkeypatch.setattr(settings, "SARVAM_STT_MODE_PURE", "transcribe")
    assert stt_for_call(fakes.stt, {"flow_language_style": "pure"}, settings) is fakes.stt
