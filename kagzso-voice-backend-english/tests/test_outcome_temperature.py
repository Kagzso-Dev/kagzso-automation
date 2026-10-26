"""Outcome classification runs at temperature 0, so the same transcript always gets the same outcome
(at LLM_TEMPERATURE a short "Yes" call came back "unknown" one time and "callback_requested" the
next). The conversation keeps LLM_TEMPERATURE, even while a classification runs at the same moment."""
from __future__ import annotations

import asyncio
import json

import httpx

from app.core.config import settings
from app.services import llm_service as llm
from tests.test_llm import _provider

GEMINI_REPLY = 'data: {"candidates":[{"content":{"parts":[{"text":"{\\"outcome\\": \\"unknown\\"}"}]}}]}\n\n'
OPENAI_REPLY = 'data: {"choices":[{"delta":{"content":"{\\"outcome\\": \\"unknown\\"}"}}]}\n\ndata: [DONE]\n\n'


def _recording(bodies, reply, delay=0.0):
    async def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        await asyncio.sleep(delay)
        return httpx.Response(200, text=reply)

    return handler


async def test_gemini_classifies_at_temperature_0_and_replies_keep_the_setting(monkeypatch):
    monkeypatch.setattr(settings, "LLM_TEMPERATURE", 0.6)
    bodies = []
    p = _provider(llm.GeminiProvider, _recording(bodies, GEMINI_REPLY))
    assert llm.parse_outcome(await p.complete_raw(llm.OUTCOME_SYSTEM, "Customer: Yes"))[0] == "unknown"
    await p.generate_response("x", [], "hi", {})
    await p.complete_raw(llm.OUTCOME_SYSTEM, "Customer: Yes", temperature=None)  # None = LLM_TEMPERATURE
    assert [b["generationConfig"]["temperature"] for b in bodies] == [0.0, 0.6, 0.6]


async def test_sarvam_classifies_at_temperature_0(monkeypatch):
    monkeypatch.setattr(settings, "LLM_TEMPERATURE", 0.6)
    bodies = []
    p = _provider(llm.SarvamProvider, _recording(bodies, OPENAI_REPLY))
    await p.complete_raw(llm.OUTCOME_SYSTEM, "Customer: Yes")
    await p.generate_response("x", [], "hi", {})
    assert [b["temperature"] for b in bodies] == [0.0, 0.6]


async def test_a_reply_streaming_during_a_classification_keeps_its_temperature(monkeypatch):
    monkeypatch.setattr(settings, "LLM_TEMPERATURE", 0.6)
    bodies = []
    p = _provider(llm.GeminiProvider, _recording(bodies, GEMINI_REPLY, delay=0.05))  # both in flight together
    await asyncio.gather(p.complete_raw(llm.OUTCOME_SYSTEM, "Customer: Yes"), p.generate_response("x", [], "hi", {}))
    by_kind = {("outcome" if b["systemInstruction"]["parts"][0]["text"] == llm.OUTCOME_SYSTEM else "reply"):
               b["generationConfig"]["temperature"] for b in bodies}
    assert by_kind == {"outcome": 0.0, "reply": 0.6}
