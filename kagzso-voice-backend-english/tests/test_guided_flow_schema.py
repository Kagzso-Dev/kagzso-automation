"""Guided flows (schema_version 2): the schema, its semantic checks, and the same verdicts as the TypeScript
validator (packages/shared/src/guidedFlows.ts runs tests/fixtures/guided/validation_cases.json too).
Version-1 flows are a different format: neither validator accepts the other's flows."""
import copy
import json
import re
from pathlib import Path

import pytest

from app.flows import loader
from app.flows.guided import (INTENTS, ISSUE_CODES, LANGUAGES, OUTCOMES, REQUIRED_CLOSINGS, RUNNER_FIELDS,
                              STANDARD_FIELDS, GuidedFlow, check_guided_flow, parse_guided_flow)
from app.flows.schema import CallFlow

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
EXAMPLE = json.loads((BACKEND / "app/flows/guided_examples/business_executive.en.json").read_text(encoding="utf-8"))
CASES = json.loads((BACKEND / "tests/fixtures/guided/validation_cases.json").read_text(encoding="utf-8"))["cases"]
TS = (ROOT / "packages/shared/src/guidedFlows.ts").read_text(encoding="utf-8")


def _key(part: str):
    return int(part) if part.isdigit() else part


def apply_ops(definition: dict, ops: list) -> dict:
    """The fixture's edit operations (the TypeScript test has the same few lines)."""
    out = copy.deepcopy(definition)
    for op in ops:
        *parents, last = [_key(p) for p in op["path"].split(".")]
        target = out
        for p in parents:
            target = target[p]
        last_key = _key(str(last)) if isinstance(target, list) else last
        if op["op"] == "set":
            target[last_key] = copy.deepcopy(op["value"])
        elif op["op"] == "delete":
            del target[last_key]
        elif op["op"] == "append":
            target[last_key].append(copy.deepcopy(op["value"]))
        elif op["op"] == "insert":
            target[last_key].insert(op["index"], copy.deepcopy(op["value"]))
    return out


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_validation_cases(case):
    issues = check_guided_flow(apply_ops(EXAMPLE, case["ops"]))
    assert sorted({i.code for i in issues}) == sorted(case["codes"]), [f"{i.code} {i.path}: {i.message}" for i in issues]
    assert all(i.code in ISSUE_CODES for i in issues)


def test_the_cases_cover_every_issue_code():
    assert {code for c in CASES for code in c["codes"]} == set(ISSUE_CODES)


def test_the_example_parses():
    flow = parse_guided_flow(EXAMPLE)
    assert isinstance(flow, GuidedFlow) and flow.start == "intro"
    assert [s.id for s in flow.stages] == ["intro", "discover", "relate"]
    assert set(REQUIRED_CLOSINGS) <= set(flow.closings)


def test_an_invalid_flow_names_every_issue():
    with pytest.raises(ValueError) as exc:
        parse_guided_flow(apply_ops(EXAMPLE, [{"op": "set", "path": "start", "value": "x"},
                                              {"op": "delete", "path": "closings.busy"}]))
    assert "unknown_start" in str(exc.value) and "missing_closing" in str(exc.value)
    with pytest.raises(ValueError):
        GuidedFlow.model_validate(apply_ops(EXAMPLE, [{"op": "set", "path": "start", "value": "x"}]))


# ------------------------------------------------------------------ version 1 untouched
@pytest.mark.parametrize("base", ["nila", "followup", "executive"])
def test_version_1_flows_are_not_guided_flows(base):
    v1 = loader.BUILTIN_FLOWS[base].model_dump(mode="json")
    assert [i.code for i in check_guided_flow(v1)] == ["schema"]


def test_a_guided_flow_is_not_a_version_1_flow():
    with pytest.raises(Exception):
        CallFlow.model_validate(EXAMPLE)
    with pytest.raises(loader.FlowError):  # Phase 1: a call can't run one (Dispatch only sends version 1)
        loader.parse_flow(EXAMPLE)


def test_nothing_in_the_call_path_uses_guided_flows_yet():
    for path in ("app/services/call_service.py", "app/services/llm_service.py", "app/flows/loader.py",
                 "app/flows/schema.py", "app/api/flows.py", "app/api/calls.py"):
        source = (BACKEND / path).read_text(encoding="utf-8")
        assert "guided" not in source and "runner" not in source.replace("Runner", ""), path


# ------------------------------------------------------------------ Python and TypeScript share the vocabulary
def _ts_list(name: str) -> list:
    m = re.search(rf"export const {name} = \[(.*?)\] as const;", TS, re.S)
    assert m, name
    return re.findall(r'"([^"]+)"', m.group(1))


@pytest.mark.parametrize("name, values", [
    ("GUIDED_LANGUAGES", LANGUAGES), ("GUIDED_STANDARD_FIELDS", STANDARD_FIELDS), ("GUIDED_RUNNER_FIELDS", RUNNER_FIELDS),
    ("GUIDED_INTENTS", INTENTS), ("GUIDED_OUTCOMES", OUTCOMES), ("GUIDED_REQUIRED_CLOSINGS", REQUIRED_CLOSINGS),
    ("GUIDED_ISSUE_CODES", ISSUE_CODES),
])
def test_typescript_lists_match(name, values):
    assert _ts_list(name) == list(values)
