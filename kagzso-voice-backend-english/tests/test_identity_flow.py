"""A call flow's own identity question / re-ask (the system-spoken lines after a time-of-day
opening). Absent = the built-in IDENTITY_QUESTION / IDENTITY_REASK, exactly as before, and the
flow keeps the hash it always had."""
import pytest

from app.flows import loader
from tests.test_flows import nila_copy
from tests.test_identity_reask import _converse

QUESTION = "Am I speaking with {{customer_name}}, {{title_to_use}}? This is Thaara."
REASK = "Sorry {{title_to_use}}, is this {{customer_name}}?"


def _flow_call(identity):
    flow = nila_copy(identity=identity) if identity is not None else nila_copy()
    return {"flow_id": "flow_t", "flow_version": 13, "flow": flow}


# ------------------------------------------------------------------ validation + hash
def test_identity_is_optional_and_keeps_old_hashes():
    old = loader.parse_flow(nila_copy())
    assert old.identity is None
    data = nila_copy()
    data.pop("identity", None)
    assert loader.flow_hash(loader.parse_flow(data)) == loader.flow_hash(old)  # absent == null
    with_identity = loader.parse_flow(nila_copy(identity={"question": QUESTION}))
    assert with_identity.identity.question == QUESTION and with_identity.identity.reask is None
    assert loader.flow_hash(with_identity) != loader.flow_hash(old)


@pytest.mark.parametrize("identity", [
    {"question": "Am I speaking with the owner?"},                     # no {{customer_name}}
    {"question": QUESTION, "reask": "Sorry, who is this?"},            # re-ask without the name
    {"question": "Is this {{customer_name}}, {{boss}}?"},              # unknown variable
    {"question": "Is this {{customer_name}}?\nSecond line"},           # not one line
    {"question": "   "},                                               # blank
    {"question": QUESTION, "extra": 1},                                # unknown field
])
def test_identity_rules(identity):
    with pytest.raises(loader.FlowError):
        loader.parse_flow(nila_copy(identity=identity))


def test_name_alias_is_accepted():
    assert loader.parse_flow(nila_copy(identity={"question": "Hello, is this {{name}}?"})).identity.question


# ------------------------------------------------------------------ spoken on a call
def test_flow_identity_question_and_reask_are_spoken(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Yes", "Hello"],
                       **_flow_call({"question": QUESTION, "reask": REASK}))
    assert spoken[0] == ["Hi sir, Good morning."]
    assert spoken[1] == ["Am I speaking with Karthick, sir?", "This is Thaara."]  # spoken sentence by sentence
    assert spoken[2] == ["Sorry sir, is this Karthick?"]
    assert fakes.llm.seen_messages == []  # system-spoken, no LLM involved


def test_flow_question_without_reask_keeps_the_builtin_reask(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Yes", "Hello"], **_flow_call({"question": QUESTION}))
    assert spoken[1] == ["Am I speaking with Karthick, sir?", "This is Thaara."]  # spoken sentence by sentence
    assert spoken[2] == ["Sorry, am I speaking with Karthick?"]


def test_flow_without_identity_speaks_the_builtin_lines(client, auth, fakes):
    spoken = _converse(client, auth, fakes, ["Hello?", "Yes", "Hello"], **_flow_call(None))
    assert spoken[1] == ["Am I speaking with Karthick, sir?"]
    assert spoken[2] == ["Sorry, am I speaking with Karthick?"]


# ------------------------------------------------------------------ editor live preview
def _preview(client, auth, flow, name="Priya"):
    sample = {"customer_name": name, "gender": "female"}
    return client.post("/api/flows/preview", headers=auth, json={"flow": flow, "sample": sample}).json()


def test_preview_shows_the_builtin_identity_lines(client, auth):
    body = _preview(client, auth, nila_copy())
    assert body["identity_question"] == "Am I speaking with Priya, madam?"
    assert body["identity_reask"] == "Sorry, am I speaking with Priya?"


def test_preview_shows_the_flows_identity_lines(client, auth):
    body = _preview(client, auth, nila_copy(identity={"question": QUESTION, "reask": REASK}))
    assert body["identity_question"] == "Am I speaking with Priya, madam? This is Thaara."
    assert body["identity_reask"] == "Sorry madam, is this Priya?"


def test_preview_no_identity_step_without_a_name_or_for_a_naming_opening(client, auth):
    assert _preview(client, auth, nila_copy(), name="")["identity_question"] is None
    naming = nila_copy(greeting={"text": "Hello, am I speaking with {{customer_name}}?"})
    assert _preview(client, auth, naming)["identity_question"] is None
