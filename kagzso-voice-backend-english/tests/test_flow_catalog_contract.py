"""Contract with Dispatch: the built-in flow catalog (GET /api/flows/builtin) exactly as each language's voice
backend serves it - including the optional settings it sends as null (language_style, autonomous).

tests/fixtures/catalog/<lang>.json holds that output ("language" and "flows"; the rest depends on the server's
.env). Dispatch's tests read them (apps/api/test/callFlowCatalog.test.ts, aiAgentsHttp.test.ts), so a change
in what a voice backend serves must show up here first: refresh with UPDATE_FIXTURES=1 and rerun Dispatch's tests.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from app.api import flows as api_flows
from app.core.config import settings
from app.flows.loader import load_builtin
from app.flows.schema import FLOW_BASES

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "catalog"
LANGUAGES = ("en", "ta", "hi", "kn")


def _served(lang: str, monkeypatch) -> dict:
    """GET /api/flows/builtin of a backend whose CALL_LANGUAGE is `lang` (built-ins localised as at its start)."""
    monkeypatch.setattr(settings, "CALL_LANGUAGE", lang)
    monkeypatch.setattr(api_flows, "BUILTIN_FLOWS", {base: load_builtin(base) for base in FLOW_BASES})
    data = asyncio.run(api_flows.builtin_flows())
    return json.loads(json.dumps({"language": data["language"], "flows": data["flows"]}, ensure_ascii=False))


@pytest.mark.parametrize("lang", LANGUAGES)
def test_catalog_fixture_matches_what_the_backend_serves(lang, monkeypatch):
    served = _served(lang, monkeypatch)
    path = FIXTURES / f"{lang}.json"
    if os.environ.get("UPDATE_FIXTURES") == "1":
        FIXTURES.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(served, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assert path.exists(), "run with UPDATE_FIXTURES=1 to write the catalog fixtures"
    assert json.loads(path.read_text(encoding="utf-8")) == served, (
        "the built-in catalog changed: refresh with UPDATE_FIXTURES=1, then run Dispatch's catalog tests")


@pytest.mark.parametrize("lang", LANGUAGES)
def test_catalog_flows_are_in_the_backends_language(lang, monkeypatch):
    served = _served(lang, monkeypatch)
    assert served["language"] == lang
    assert set(served["flows"]) == set(FLOW_BASES)
    assert all(flow["language"] == lang for flow in served["flows"].values())
