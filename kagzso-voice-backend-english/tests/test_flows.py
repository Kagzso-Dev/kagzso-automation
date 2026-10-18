"""Call flows: the built-in flows reproduce the old prompts exactly, flow validation,
variable rendering, fallback to the default agent, and version pinning."""
import copy
import json
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import text

from app.core.config import settings
from app.flows import loader
from app.flows.schema import LOCKED_BLOCKS, CallFlow, render_blocks
from app.services import llm_service as llm, status_callback
from tests.test_nila_flow import _start, _until

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = json.loads((FIXTURES / "golden_prompts.json").read_text(encoding="utf-8"))
PHONE = "+919876543210"


def nila_copy(**changes):
    flow = loader.BUILTIN_FLOWS["nila"].model_dump(mode="json")
    flow.update(changes)
    return flow


def _outbound(client, auth, **extra):
    body = {"phone_number": PHONE, "customer_name": "Ragul", "gender": "male", "agent_name": "Nila", **extra}
    return client.post("/api/calls/outbound", json=body, headers=auth)


def _call_row(sync_engine):
    with sync_engine.connect() as c:
        rows = c.execute(text("select c.id, c.variables, a.name, a.system_prompt, a.first_message "
                              "from calls c join agents a on a.id = c.agent_id order by c.created_at")).all()
    return [(r.id, json.loads(r.variables) if isinstance(r.variables, str) else r.variables, r.name,
             r.system_prompt, r.first_message) for r in rows]


def _events(sync_engine):
    with sync_engine.connect() as c:
        return [(r[0], json.loads(r[1]) if isinstance(r[1], str) else r[1])
                for r in c.execute(text("select event_type, payload from call_events order by id"))]


# ------------------------------------------------------------------ regression: default == old behaviour
@pytest.mark.parametrize("base,legacy", [("nila", "legacy_nila.md"), ("followup", "legacy_followup.md")])
def test_builtin_flow_rebuilds_the_old_prompt_byte_for_byte(base, legacy):
    assert render_blocks(loader.BUILTIN_FLOWS[base]) == (FIXTURES / legacy).read_text(encoding="utf-8")


@pytest.mark.parametrize("agent", [llm.NILA_AGENT, llm.FOLLOWUP_AGENT], ids=["Nila", "Follow-up"])
def test_builtin_agents_match_the_frozen_agents(agent):
    golden = GOLDEN[agent["name"]]
    assert agent["system_prompt"] == golden["system_prompt"]
    assert agent["first_message"] == golden["first_message"]
    assert agent["voice_id"] == golden["voice_id"]


@pytest.mark.parametrize("agent_name", ["Nila", "Follow-up"])
@pytest.mark.parametrize("case", range(4))
def test_default_prompt_is_unchanged_apart_from_the_safety_layer(agent_name, case):
    agent = llm.NILA_AGENT if agent_name == "Nila" else llm.FOLLOWUP_AGENT
    golden = GOLDEN[agent_name]["cases"][case]
    prompt = llm.build_system_prompt(agent["system_prompt"], golden["variables"], "en")
    assert prompt.count(llm.SAFETY_RULES) == 1
    assert llm.VOICE_RULES + llm.SAFETY_RULES in prompt  # appended right after the fixed phone rules
    assert prompt.replace(llm.SAFETY_RULES, "", 1) == golden["system_prompt"]
    assert llm.render_first_message(agent["first_message"], golden["variables"]) == golden["first_message"]


def test_safety_layer_discloses_ai_and_honours_do_not_call():
    rules = llm.SAFETY_RULES
    assert "you are an AI assistant" in rules and "Never claim to be human" in rules
    assert "not to be called again" in rules and llm.END_CALL_TOKEN in rules


def test_call_without_a_flow_uses_the_default_agent_unchanged(client, auth, fakes, sync_engine):
    assert _outbound(client, auth).status_code == 200
    (_, variables, agent_name, prompt, first), = _call_row(sync_engine)
    assert agent_name == "Nila" and prompt == GOLDEN["Nila"]["system_prompt"] and first == GOLDEN["Nila"]["first_message"]
    assert not any(k.startswith("flow_") for k in variables)
    assert fakes.plivo.time_limits == [None]  # MAX_CALL_DURATION_SECONDS, as before
    assert not [e for e, _ in _events(sync_engine) if e.startswith("flow:")]


# ------------------------------------------------------------------ variable rendering
def test_name_alias_renders_like_customer_name():
    v = {"customer_name": "Karthick G", "gender": "female"}
    assert llm.render_first_message("Hi {{name}}, is this {{ honorific }} {{name}}?", v) == "Hi Karthick, is this Ms. Karthick?"
    assert llm.render_prompt("Talk to {{name}}.", {}) == "Talk to the customer."


@pytest.mark.parametrize("gender,expected", [("male", "Thank you sir."), ("female", "Thank you madam."), ("unknown", "Thank you.")])
def test_title_variable_only_from_the_given_gender(gender, expected):
    assert llm.render_first_message("Thank you {{title}}.", {"customer_name": "Priya", "gender": gender}) == expected


def test_flow_text_cannot_use_phone_number_or_unknown_variables():
    for bad in ("Call {{phone_number}}", "Hi {{customer}}", "Hi {{ name.upper }}"):
        with pytest.raises(loader.FlowError) as exc:
            loader.parse_flow(nila_copy(greeting={"text": bad}))
        assert exc.value.reason == "invalid" and "unknown variable" in " ".join(exc.value.errors)


# ------------------------------------------------------------------ validation
def _errors(flow):
    with pytest.raises(loader.FlowError) as exc:
        loader.parse_flow(flow)
    return " | ".join(exc.value.errors)


def test_builtin_flows_are_valid():
    for flow in loader.BUILTIN_FLOWS.values():
        CallFlow.model_validate(flow.model_dump(mode="json"))


def test_unknown_fields_are_rejected():
    assert "extra" in _errors(nila_copy(script="free text")).lower()
    flow = nila_copy()
    flow["blocks"][0]["note"] = "x"
    assert _errors(flow)
    flow = nila_copy(silence={"reprompt": "Hello?", "closing": "Bye.", "retries": 3})
    assert "extra" in _errors(flow).lower()


def test_lengths_and_single_line_fields():
    flow = nila_copy()
    flow["blocks"][0]["text"] = "x" * 8001
    assert "8000" in _errors(flow)
    assert _errors(nila_copy(greeting={"text": "x" * 301}))
    assert "single line" in _errors(nila_copy(greeting={"text": "Hi,\nis this {{name}}?"}))
    assert _errors(nila_copy(limits={"max_duration_sec": 10}))


def test_script_cannot_contain_the_hangup_marker():
    flow = nila_copy()
    flow["blocks"][0]["text"] += "\nSay bye [[END_CALL]]"
    assert "[[END_CALL]]" in _errors(flow)


def test_locked_blocks_cannot_be_removed_swapped_or_duplicated():
    flow = nila_copy()
    flow["blocks"] = [b for b in flow["blocks"] if b.get("locked") != "nila_do_not_call"]
    assert "missing nila_do_not_call" in _errors(flow)

    flow = nila_copy()
    flow["blocks"].append({"id": "extra_lock", "locked": "followup_situations"})
    assert "not allowed for base 'nila'" in _errors(flow)

    flow = nila_copy()
    flow["blocks"].append({"id": "dnc_again", "locked": "nila_do_not_call"})
    assert "exactly once" in _errors(flow)

    flow = nila_copy()
    flow["blocks"].append({"id": "x", "locked": "no_such_block"})
    assert "unknown locked block" in _errors(flow)


def test_locked_block_text_always_comes_from_code():
    flow = nila_copy()
    for b in flow["blocks"]:
        if b.get("locked") == "nila_do_not_call":
            b["text"] = "Keep pitching."  # a locked block carries no text
    assert _errors(flow)


def test_duplicate_ids_language_and_transfer():
    flow = nila_copy()
    flow["blocks"][1]["id"] = flow["blocks"][0]["id"]
    assert "duplicate block id" in _errors(flow)
    assert _errors(nila_copy(language="ta"))
    assert _errors(nila_copy(transfer={"enabled": True, "number": "+919876543210"}))
    assert loader.parse_flow(nila_copy(transfer={"enabled": False, "number": "+919876543210"})).transfer.number


def test_editable_blocks_can_be_reworded_and_reordered():
    flow = nila_copy(name="Shorter intro")
    flow["blocks"][0]["text"] = "# PERSONA\n\nYou are Nila from Kagzso.\n\n---\n\n"
    flow["blocks"][2], flow["blocks"][3] = flow["blocks"][3], flow["blocks"][2]
    parsed = loader.parse_flow(flow)
    rendered = render_blocks(parsed)
    assert rendered.startswith("# PERSONA") and LOCKED_BLOCKS["nila_do_not_call"] in rendered


# ------------------------------------------------------------------ fallback to the default
def test_invalid_flow_falls_back_to_the_requested_agent(client, auth, sync_engine):
    bad = nila_copy(greeting={"text": "Call {{phone_number}}"})
    r = _outbound(client, auth, flow_id="flow_a", flow_version=1, flow=bad)
    assert r.status_code == 200, r.text
    (_, variables, agent_name, prompt, _), = _call_row(sync_engine)
    assert agent_name == "Nila" and prompt == GOLDEN["Nila"]["system_prompt"]
    assert variables["flow_fallback"] == "invalid" and variables["flow_id"] == "flow_a"
    fallback = [p for e, p in _events(sync_engine) if e == "flow:fallback"]
    assert fallback and fallback[0]["errors"]


def test_missing_flow_definition_falls_back(client, auth, sync_engine):
    assert _outbound(client, auth, flow_id="flow_a", flow_version=2).status_code == 200
    (_, variables, agent_name, _, _), = _call_row(sync_engine)
    assert agent_name == "Nila" and variables["flow_fallback"] == "missing"


def test_flow_fields_must_come_together(client, auth):
    assert _outbound(client, auth, flow_id="flow_a").status_code == 422
    assert _outbound(client, auth, flow_version=1).status_code == 422
    assert _outbound(client, auth, flow=nila_copy()).status_code == 422
    assert _outbound(client, auth, flow_id="bad id!", flow_version=1).status_code == 422


# ------------------------------------------------------------------ flows on real calls + version pinning
def test_published_flow_becomes_its_own_agent(client, auth, fakes, sync_engine):
    flow = nila_copy(name="Short", limits={"max_duration_sec": 90})
    flow["greeting"] = {"text": "Hello {{name}}, is this a good time?"}
    assert _outbound(client, auth, flow_id="flow_b", flow_version=3, flow=flow).status_code == 200
    (_, variables, agent_name, prompt, first), = _call_row(sync_engine)
    assert agent_name == "flow:flow_b@v3" and first == "Hello {{name}}, is this a good time?"
    assert prompt == GOLDEN["Nila"]["system_prompt"]  # script blocks untouched
    assert variables["flow_version"] == "3" and variables["flow_draft"] == "false" and len(variables["flow_hash"]) == 64
    assert fakes.plivo.time_limits == [90]
    assert [e for e, _ in _events(sync_engine) if e.startswith("flow:")] == ["flow:selected"]


def test_flow_duration_is_capped_by_the_server_limit(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "MAX_CALL_DURATION_SECONDS", 120)
    assert _outbound(client, auth, flow_id="flow_c", flow_version=1,
                     flow=nila_copy(limits={"max_duration_sec": 600})).status_code == 200
    assert fakes.plivo.time_limits == [120]


def test_version_is_pinned_and_published_versions_are_immutable(client, auth, sync_engine):
    v1 = nila_copy(name="Pinned")
    assert _outbound(client, auth, flow_id="flow_d", flow_version=1, flow=v1).status_code == 200
    assert _outbound(client, auth, flow_id="flow_d", flow_version=1, flow=copy.deepcopy(v1)).status_code == 200
    changed = nila_copy(name="Pinned", greeting={"text": "Hi {{name}}, different greeting?"})
    assert _outbound(client, auth, flow_id="flow_d", flow_version=1, flow=changed).status_code == 200
    v2 = changed
    assert _outbound(client, auth, flow_id="flow_d", flow_version=2, flow=v2).status_code == 200

    rows = _call_row(sync_engine)
    assert [r[2] for r in rows] == ["flow:flow_d@v1", "flow:flow_d@v1", "Nila", "flow:flow_d@v2"]
    assert rows[2][1]["flow_fallback"] == "version_conflict"
    assert rows[0][4] == "Hi {{title_to_use}}, {{time_greeting}}." and rows[3][4] == "Hi {{name}}, different greeting?"
    with sync_engine.connect() as c:
        assert c.execute(text("select count(*) from agents where name = 'flow:flow_d@v1'")).scalar() == 1


def test_drafts_are_keyed_by_content(client, auth, sync_engine):
    a = nila_copy(name="Draft")
    b = nila_copy(name="Draft", greeting={"text": "Hi {{name}}, quick one?"})
    for flow in (a, b, a):
        assert _outbound(client, auth, flow_id="flow_e", flow_version=4, flow_draft=True, flow=flow).status_code == 200
    names = [r[2] for r in _call_row(sync_engine)]
    assert names[0] == names[2] != names[1] and all(n.startswith("flow:flow_e@v4-draft-") for n in names)
    assert not any("flow_fallback" in r[1] for r in _call_row(sync_engine))


def test_greeting_without_the_name_variable_needs_no_name(client, auth):
    flow = nila_copy(greeting={"text": "Hello, this is Thaara from Kagzso. Is this a good time?"})
    r = _outbound(client, auth, customer_name=None, flow_id="flow_f", flow_version=1, flow=flow)
    assert r.status_code == 200, r.text
    with_name = nila_copy(greeting={"text": "Hi {{name}}?"})
    assert _outbound(client, auth, customer_name=None, flow_id="flow_g", flow_version=1, flow=with_name).status_code == 422


def test_flow_silence_lines_are_spoken(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "GREETING_DELAY_MS", 100)
    monkeypatch.setattr(settings, "SILENCE_REPROMPT_SECONDS", 0.6)
    flow = nila_copy(silence={"reprompt": "{{name}}, are you still there?", "closing": "Okay, I'll let you go. Bye."})
    r = _outbound(client, auth, flow_id="flow_h", flow_version=1, flow=flow)
    call_id = r.json()["call_id"]
    xml = client.post(f"/api/webhooks/plivo/answer?call_id={call_id}", data={"CallUUID": "uuid-k", "CallStatus": "in-progress"}).text
    token = parse_qs(urlparse(ET.fromstring(xml.split("?>", 1)[1]).find("Stream").text).query)["token"][0]
    with client.websocket_connect(f"/ws/plivo/media?call_id={call_id}&token={token}") as ws:
        _start(ws)
        for _ in range(3):
            _until(ws, "checkpoint")
        texts = [" ".join(s.texts) for s in fakes.tts.streams]
        assert texts[:3] == ["Hi sir, Good morning.", "Ragul, are you still there?", "Okay, I'll let you go. Bye."]
        ws.send_text(json.dumps({"event": "stop"}))
    time.sleep(0.3)


def test_status_callback_carries_the_flow():
    call = SimpleNamespace(id="c1", provider_call_id=None, status="completed", outcome=None, summary=None,
                           hangup_cause=None, duration_seconds=None, ended_at=None,
                           variables={"log_id": "log_1", "flow_id": "flow_b", "flow_version": "3"})
    payload = status_callback.build_payload(call, "status")
    assert payload["flow_id"] == "flow_b" and payload["flow_version"] == "3" and payload["flow_fallback"] is None
    call.variables = {"log_id": "log_1"}
    assert "flow_id" not in status_callback.build_payload(call, "status")


# ------------------------------------------------------------------ /api/flows
def test_builtin_endpoint(client, auth):
    assert client.get("/api/flows/builtin").status_code == 401
    body = client.get("/api/flows/builtin", headers=auth).json()
    assert set(body["flows"]) == {"nila", "followup"} and "name" in body["variables"]
    assert "phone_number" not in body["variables"] and body["locked_blocks"] == LOCKED_BLOCKS
    assert body["limits"]["max_duration_sec"] == settings.MAX_CALL_DURATION_SECONDS


def test_preview_renders_like_a_call(client, auth):
    sample = {"customer_name": "Priya", "gender": "female", "follow_up_detail": "the quotation"}
    r = client.post("/api/flows/preview", headers=auth, json={"flow": nila_copy(), "sample": sample})
    body = r.json()
    assert body["valid"] and body["greeting"] == "Hi madam, Good morning."
    assert body["system_prompt"] == llm.build_system_prompt(llm.NILA_AGENT["system_prompt"], {
        "customer_name": "Priya", "contact_name": "Priya", "gender": "female", "phone_number": "+910000000000",
        "follow_up_detail": "the quotation", "company_name": None, "business_type": None})
    assert body["silence_reprompt"] == "Hello, can you hear me?"


def test_preview_reports_errors_and_forbids_unknown_fields(client, auth):
    r = client.post("/api/flows/preview", headers=auth, json={"flow": nila_copy(greeting={"text": "{{oops}}"})})
    assert r.status_code == 200 and not r.json()["valid"] and "oops" in " ".join(r.json()["errors"])
    assert client.post("/api/flows/preview", headers=auth, json={"flow": {}, "extra": 1}).status_code == 422
    assert client.post("/api/flows/preview", json={"flow": {}}).status_code == 401
