"""A full Tamil AI Conversation Instructions box (7,000 characters in 350 short lines, 2026-11-28): Dispatch's compiler
splits the quoted text into "ai_instructions" and "ai_instructions_2" at a line break, because one block holds at most
MAX_BLOCK_CHARS. This backend accepts the flow, and the prompt joins the parts back into one continuous instructions
section: every character of the box, in order, nothing between the parts, then the rest of the flow as before.

The flow is the compiler's own output (tests/fixtures/autonomous/ta_long_instructions.json, written by
apps/api/test/aiAgentCompile.test.ts). Fake STT / LLM / TTS / Plivo: nothing real is called."""
from __future__ import annotations

import json
from pathlib import Path

from app.core.config import settings
from app.flows.loader import parse_flow
from app.flows.schema import MAX_BLOCK_CHARS, MAX_PROMPT_CHARS, render_blocks
from app.services import llm_service as llm
from tests.test_autonomous_agent import _capture_systems
from tests.test_autonomous_conversation import _dial
from tests.test_call_policy import _rows

FIXTURE = Path(__file__).parent / "fixtures" / "autonomous" / "ta_long_instructions.json"
HEADER = "# AI CONVERSATION INSTRUCTIONS (FROM THE ADMIN)"
NEXT = "# THE CUSTOMER'S BUSINESS AND WHAT YOU MAY SAY"


def _data(monkeypatch) -> dict:
    monkeypatch.setattr(settings, "CALL_LANGUAGE", "ta")
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _box_lines(data: dict) -> list:
    """The box's own lines, from the parts joined (each quoted with "> ")."""
    joined = "".join(b["text"] for b in data["blocks"] if b.get("id", "").startswith("ai_instructions"))
    return [ln[2:] for ln in joined.split("\n") if ln.startswith("> ")]


def test_the_split_flow_is_valid_and_each_part_fits_a_block(monkeypatch):
    data = _data(monkeypatch)
    parts = [b for b in data["blocks"] if b.get("id", "").startswith("ai_instructions")]
    assert [b["id"] for b in parts] == ["ai_instructions", "ai_instructions_2"]
    assert all(len(b["text"]) <= MAX_BLOCK_CHARS for b in parts)
    assert sum(len(b["text"]) for b in parts) > MAX_BLOCK_CHARS  # it could not have been one block
    flow = parse_flow(data)
    assert len(render_blocks(flow)) <= MAX_PROMPT_CHARS
    box = "\n".join(_box_lines(data))
    assert len(box) == 7000 and box.count("\n") == 349  # the whole box: 7,000 characters, 350 lines


def test_the_prompt_has_one_continuous_instructions_section(monkeypatch):
    data = _data(monkeypatch)
    parts = "".join(b["text"] for b in data["blocks"] if b.get("id", "").startswith("ai_instructions"))
    prompt = render_blocks(parse_flow(data))
    start, end = prompt.index(HEADER), prompt.index(NEXT)
    assert prompt[start:end] == parts  # exactly the parts, end to end: nothing added, lost or repeated between them
    assert prompt.count(HEADER) == 1
    system = llm.build_system_prompt(prompt, {"customer_name": "Ragul", "gender": "male",
                                              "flow_target_sec": "60", "flow_natural_lines": "true",
                                              "flow_instructions_lead": "true"}, "ta")
    assert parts in system and system.index(HEADER) < system.index("--- Safety rules")


def test_a_call_with_it_reads_the_whole_box(client, auth, fakes, sync_engine, monkeypatch):
    data = _data(monkeypatch)
    systems = _capture_systems(fakes)
    call_id, _ = _dial(client, auth, data, flow_id="kayal_long", customer_name="Ragul")
    stored = _rows(sync_engine, "select a.system_prompt from calls c join agents a on a.id = c.agent_id where c.id = :id",
                   call_id)[0][0]
    joined = "".join(b["text"] for b in data["blocks"] if b.get("id", "").startswith("ai_instructions"))
    assert joined in stored  # the agent row the call uses carries every line of the box
    assert all(f"> {ln}" in stored for ln in _box_lines(data)[-3:])  # ...to the very last line
    assert systems == []  # placing the call asks the LLM nothing
