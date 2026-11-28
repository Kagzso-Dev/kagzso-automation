"""TAMIL_AGENT_IGNORE_CALL_FLOWS (2026-11-28): a Tamil AI Agent flow this backend rejects refuses the call instead of
dialling with the backend's own agent (Nila: its script, voice and facts).

    off (default)          exactly as before: the call goes out with the requested agent, "flow_fallback" saved
    on, Tamil, agent flow  409 agent_flow_rejected, nothing dialled, no call row
    on, ordinary flow      as before (only an AI Agent's flow - one with `autonomous` - is refused)
    on, another language   as before (only a Tamil backend reads the switch)

Fake STT / LLM / TTS / Plivo: nothing real is called."""
from __future__ import annotations

import json

import pytest

from app.core.config import settings
from tests.test_autonomous_conversation import _flow
from tests.test_call_policy import _rows
from tests.test_nila_flow import PHONE, _nila_id


def _rejected(flow: dict) -> dict:
    """The flow with a key this backend doesn't know (the strict schema rejects it) - as after deploying Dispatch
    before the voice backend."""
    return {**flow, "a_setting_from_a_newer_dispatch": True}


def _place(client, auth, flow, flow_id="kayal"):
    body = {"phone_number": PHONE, "customer_name": "Ragul", "gender": "male", "agent_id": _nila_id(client, auth),
            "flow_id": flow_id, "flow_version": 1, "flow": flow}
    return client.post("/api/calls/outbound", headers=auth, json=body)


def _call_count(sync_engine) -> int:
    from sqlalchemy import text
    with sync_engine.connect() as conn:
        return conn.execute(text("select count(*) from calls")).scalar_one()


def _variables(sync_engine, call_id) -> dict:
    raw = _rows(sync_engine, "select variables from calls where id = :id", call_id)[0][0]
    return json.loads(raw) if isinstance(raw, str) else raw


@pytest.fixture
def tamil_agent_flow(monkeypatch):
    return _flow("ta", monkeypatch)  # CALL_LANGUAGE=ta; the compiled Tamil agent (it has `autonomous`)


def test_off_by_default_a_rejected_agent_flow_falls_back_exactly_as_before(client, auth, fakes, sync_engine, tamil_agent_flow):
    assert settings.TAMIL_AGENT_IGNORE_CALL_FLOWS is False  # the default
    r = _place(client, auth, _rejected(tamil_agent_flow))
    assert r.status_code == 200, r.text
    variables = _variables(sync_engine, r.json()["call_id"])
    assert variables["flow_fallback"] == "invalid" and "flow_agent_voice" not in variables
    assert fakes.plivo.placed == [PHONE]


def test_on_a_rejected_tamil_agent_flow_refuses_the_call(client, auth, fakes, sync_engine, monkeypatch, tamil_agent_flow, caplog):
    monkeypatch.setattr(settings, "TAMIL_AGENT_IGNORE_CALL_FLOWS", True)
    before = _call_count(sync_engine)
    r = _place(client, auth, _rejected(tamil_agent_flow))
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "agent_flow_rejected"
    assert detail["message"] == "The AI agent's flow was refused by the voice backend (invalid) - publish the agent again"
    assert fakes.plivo.placed == [] and fakes.plivo.time_limits == []  # nothing dialled
    assert _call_count(sync_engine) == before  # no call row: never "Nila" in the agent's place
    assert any("AI agent flow kayal v1 refused (invalid) - call not placed" in rec.getMessage() for rec in caplog.records)


def test_on_a_valid_tamil_agent_flow_calls_normally(client, auth, fakes, sync_engine, monkeypatch, tamil_agent_flow):
    monkeypatch.setattr(settings, "TAMIL_AGENT_IGNORE_CALL_FLOWS", True)
    r = _place(client, auth, tamil_agent_flow)
    assert r.status_code == 200, r.text
    variables = _variables(sync_engine, r.json()["call_id"])
    assert "flow_fallback" not in variables and variables["flow_natural_lines"] == "true"
    assert fakes.plivo.placed == [PHONE]


def test_on_an_ordinary_tamil_flow_still_falls_back_as_before(client, auth, fakes, sync_engine, monkeypatch, tamil_agent_flow):
    monkeypatch.setattr(settings, "TAMIL_AGENT_IGNORE_CALL_FLOWS", True)
    ordinary = {k: v for k, v in tamil_agent_flow.items() if k not in ("autonomous", "training")}
    r = _place(client, auth, _rejected(ordinary), flow_id="abc_thaara")
    assert r.status_code == 200, r.text
    assert _variables(sync_engine, r.json()["call_id"])["flow_fallback"] == "invalid"


@pytest.mark.parametrize("lang", ["en", "hi", "kn"])
def test_on_but_another_language_backend_falls_back_as_before(client, auth, fakes, sync_engine, monkeypatch, lang):
    flow = _flow(lang, monkeypatch)  # that language's compiled agent flow; CALL_LANGUAGE=lang
    monkeypatch.setattr(settings, "TAMIL_AGENT_IGNORE_CALL_FLOWS", True)
    r = _place(client, auth, _rejected(flow))
    assert r.status_code == 200, r.text
    assert _variables(sync_engine, r.json()["call_id"])["flow_fallback"] == "invalid"
