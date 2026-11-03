"""Text-only guided conversations end to end (app/flows/simulator.py): the sample conversations in
tests/fixtures/guided/conversations through the real runner, with mocked customer turns and LLM outputs.
No provider, no call, no database."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.flows.guided import parse_guided_flow
from app.flows.simulator import SimTurn, simulate, simulate_file

BACKEND = Path(__file__).resolve().parents[1]
CONV = BACKEND / "tests/fixtures/guided/conversations"
FLOW = parse_guided_flow(json.loads((BACKEND / "app/flows/guided_examples/business_executive.en.json").read_text(encoding="utf-8")))


def run(name):
    return simulate_file(str(CONV / f"{name}.json"))


def agent_lines(result):
    return [line for line in result.lines if line.speaker == "agent"]


def test_every_sample_conversation_runs():
    names = sorted(p.stem for p in CONV.glob("*.json"))
    assert names == ["detour_question", "do_not_call", "hotel_happy_path", "interruption", "malformed_decision",
                     "meeting_requested", "objection_and_refusal", "retries"]
    for name in names:
        result = run(name)
        assert result.lines[0].speaker == "agent" and result.transcript()


def test_hotel_happy_path_follows_the_flow_in_order():
    result = run("hotel_happy_path")
    assert result.final.ended and result.final.outcome == "interested"
    assert result.final.completed == ["intro", "discover", "relate"][:2] and result.final.stage == "relate"
    stages = [s["stage"] for s in result.states]
    assert stages == ["intro", "discover", "discover", "relate", "relate"]  # never back, never skipped
    answers = {k: (v["value"] if isinstance(v, dict) else v) for k, v in result.answers.items()}
    assert answers["business_type"] == "hotel, about forty rooms" and answers["current_process"] == "manually in Excel and on paper"
    assert answers["pain_points"] == "front desk spends hours on manual work" and answers["interest_level"] == "interested"
    assert answers["requirements"] is None and answers["meeting_requested"] is False and answers["call_outcome"] == "interested"
    assert result.answers["business_type"]["source"] == "customer" and result.answers["business_type"]["stage"] == "discover"
    last = agent_lines(result)[-1].meta["segments"]
    assert last == [{"kind": "closing", "text": "Thank you, sir. You can find full details on kagzso.com. Have a nice day.", "ref": "interested"}]


def test_exact_lines_are_word_for_word_in_every_conversation():
    exact = {s.text for st in FLOW.stages for s in st.mandatory} | {c.question for st in FLOW.stages for c in st.collect}
    exact |= {c.text for c in FLOW.closings.values()} | {FLOW.disclosures.ai, FLOW.clarify_line}
    exact = {t.replace("{{title_to_use}}", "sir") for t in exact}
    for path in CONV.glob("*.json"):
        for line in agent_lines(simulate_file(str(path))):
            for seg in line.meta["segments"]:
                if seg["kind"] in ("statement", "question", "disclosure", "clarify"):
                    assert seg["text"] in exact, (path.stem, seg)
                elif seg["kind"] == "closing":
                    assert seg["text"].replace(" Our team will get in touch with you.", "") in exact, (path.stem, seg)


def test_a_detour_returns_to_the_pending_question():
    lines = agent_lines(run("detour_question"))
    detour = lines[2].meta["segments"]
    assert detour[0]["kind"] == "reply" and "depends on your requirements" in detour[0]["text"]
    assert detour[1] == {"kind": "question", "text": "What kind of business do you run?", "ref": "business_type"}
    assert run("detour_question").final.outcome == "busy"


def test_objections_keep_the_position_and_a_refusal_ends_the_call():
    result = run("objection_and_refusal")
    lines = agent_lines(result)
    assert [l.meta["segments"][-1]["text"] for l in lines[1:3]] == ["Could you give me just one minute?"] * 2
    assert result.final.outcome == "not_interested" and result.final.completed == []


def test_do_not_call_wins_over_the_llm():
    result = run("do_not_call")
    assert result.final.outcome == "do_not_call" and result.answers["call_outcome"] == "do_not_call"
    assert "one quick question" not in result.transcript()


def test_a_malformed_decision_never_reaches_the_customer():
    result = run("malformed_decision")
    text = result.transcript()
    assert "5000" not in text and "demo" not in text
    assert agent_lines(result)[1].meta["segments"] == [
        {"kind": "question", "text": "Could you give me just one minute?", "ref": "custom_permission"}]
    assert result.final.stage == "discover" and result.final.intents[0]["status"] == "recovered"


def test_interruptions_only_count_what_was_heard():
    result = run("interruption")
    lines = agent_lines(result)
    assert lines[0].meta["heard"] == [False, False]
    assert [s["kind"] for s in lines[1].meta["segments"]] == ["reply", "statement", "question"]  # said again
    assert lines[2].meta["heard"] == [True, False]  # the stage change was cut off ...
    assert result.states[2]["stage"] == "intro"  # ... so the call stayed in intro
    assert result.states[3]["stage"] == "discover" and result.final.collected["business_type"]["value"] == "school"


def test_retries_end_politely():
    result = run("retries")
    assert result.final.outcome == "completed" and result.final.closing == "no_response"


def test_meeting_is_an_outcome_and_the_team_line_needs_team_follow_up():
    on = run("meeting_requested")
    assert on.final.outcome == "meeting_requested" and on.answers["meeting_requested"] is True
    assert agent_lines(on)[-1].text.endswith("Our team will get in touch with you.")
    conv = json.loads((CONV / "meeting_requested.json").read_text(encoding="utf-8"))
    off = simulate(FLOW, [SimTurn.from_dict(t) for t in conv["turns"]], team_followup=False)
    assert "Our team" not in agent_lines(off)[-1].text and off.final.outcome == "meeting_requested"


def test_the_command_line_simulator_prints_a_transcript():
    env = {**os.environ, "KAGZSO_ENV_FILE": str(BACKEND / "no-such.env"), "PYTHONIOENCODING": "utf-8"}
    out = subprocess.run([sys.executable, "scripts/guided_simulate.py", str(CONV / "hotel_happy_path.json"), "--state"],
                         cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "CUSTOMER: We run a hotel in Madurai" in out.stdout and '"call_outcome": "interested"' in out.stdout
