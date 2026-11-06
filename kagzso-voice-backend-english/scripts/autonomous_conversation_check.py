"""Real-model check of Autonomous AI Agent conversations: scripted customers talk to the configured LLM.

The pytest suite uses a fake LLM, so it proves what the model is given and what the backend enforces, not how the
model actually talks. This does: each scenario goes turn by turn through the same prompt and provider a live call
uses, then simple checks run over the replies and the whole conversation is printed for a person to read.

Places no call and sends no audio. The customers and the knowledge are synthetic, but it DOES call the LLM provider
set in the env file, so it uses tokens: about 40 replies per language at about 5,000 input tokens each. Nothing
runs without --run. Compile the fixture first when the compiler changed (UPDATE_FIXTURES=1 in aiAgentCompile.test.ts).
Run it from kagzso-voice-backend-english:

    .venv/Scripts/python scripts/autonomous_conversation_check.py --language en --run
    .venv/Scripts/python scripts/autonomous_conversation_check.py --language ta --run --report ta.json

The checks are keyword heuristics, so a pass is not proof and Tamil replies NEED A NATIVE SPEAKER'S REVIEW.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--language", choices=["en", "ta"], default="en")
parser.add_argument("--run", action="store_true", help="call the LLM provider (uses tokens)")
parser.add_argument("--report", help="also write the conversations and checks to this JSON file")
parser.add_argument("--only", help="run only the scenarios whose name contains this")
args = parser.parse_args()
os.environ.setdefault("KAGZSO_ENV_FILE", ".env.ta" if args.language == "ta" else ".env")

from app.flows.loader import parse_flow  # noqa: E402
from app.flows.schema import render_blocks  # noqa: E402
from app.flows.training import runtime_json  # noqa: E402
from app.services.call_service import AGENT_GREETING_INSTRUCTION  # noqa: E402
from app.services.llm_service import (Message, build_call_variables, clean_spoken_text, create_llm_provider,  # noqa: E402
                                      extract_end_call)

# Synthetic knowledge: it stands in for an agent's approved items and states nothing about the real company.
KNOWLEDGE: List[Tuple[str, str, str, List[str]]] = [
    ("fact", "Hospital", "For hospitals the system automates patient registration, appointment booking, billing and reports.", []),
    ("fact", "Hotel", "For hotels and restaurants the system handles billing, kitchen order management and daily sales reports.", []),
    ("fact", "School", "For schools the system handles attendance, administration and timetables.", []),
    ("qa", "Appointments", "Patients book a slot, the system confirms it and the front desk sees the day's list on one screen.",
     ["How does appointment booking work?"]),
    ("qa", "Existing software", "It works alongside the software the customer already uses.", ["Will it replace our software?"]),
]

MONEY = r"\d|₹|rupee|ரூபாய்|லட்சம்|ஆயிரம்|\blakh\b|\bthousand\b"
TIME_GREETING = r"good (morning|afternoon|evening)|காலை வணக்கம்|மாலை வணக்கம்"
IDENTITY_CHECK = r"am i speaking|speaking with|பேசறேனா|பேசுகிறேனா"
ROUTINE_PERMISSION = r"have a (minute|moment)|good time to|பேசலாமா|நிமிஷம் (கிடைக்குமா|இருக்கா)"
REACH_YOU = r"(best way|how can we|how do we) (to )?reach you|your (number|email|contact)"
CONTACT_PROMISE = (r"(team|we|i|someone|our).{0,40}(will|shall|'ll).{0,20}(call|contact|reach|get in touch|send|whatsapp|email|mail)"
                   r"|call back|callback|கால் பண்ணுவ|call பண்ணுவ|contact பண்ணுவ|தொடர்பு கொள்வ|அனுப்பு(வ|கிற|றேன்|றோம்)|send பண்ணு(வ|றேன்|றோம்)")
SENT_CLAIM = r"(i|we)('ve| have)? sent|அனுப்பிட்டேன்|அனுப்பினேன்|send பண்ணிட்டேன்"
INVENTED = r"(we|our team) (already )?(work|worked|are working) with|our (clients|customers) (include|like)|\d+ ?%|percent"
OBJECTIVE = "Understand their business and find out whether the company can help."

# name, customer turns (None = silent pick-up), then checks: (turn or "any", regex that must NOT match / ENDED).
Scenario = Dict[str, object]
SCENARIOS: Dict[str, List[Scenario]] = {
    "en": [
        {"name": "opening", "turns": [None], "not": [TIME_GREETING, IDENTITY_CHECK], "has": [r"Thaara", r"Kagzso|Kexo"]},
        {"name": "the customer speaks first", "first": True, "turns": ["Hello? Who is this?"],
         "not": [TIME_GREETING, IDENTITY_CHECK, r"how are you"], "has": [r"Thaara"]},
        {"name": "the example: who, what, hospital, how",
         "turns": ["Yes, tell me, who is this?", "What kind of automation?", "We are running a hospital.", "How does appointment booking work?"],
         "not": [TIME_GREETING, IDENTITY_CHECK, INVENTED], "has_last": [r"slot|book|confirm|front desk|list"]},
        {"name": "hotel, not the configured hospital",
         "turns": ["Who is this?", "We don't run a hospital. We run a hotel.", "What can you do for us?"],
         "has_last": [r"kitchen|billing|sales"], "not_last": [r"patient"]},
        {"name": "school", "turns": ["Who's calling?", "I run a school. What can you do?"],
         "has_last": [r"attendance|timetable|administration"], "not_last": [r"patient"]},
        {"name": "already told: no repeat question",
         "turns": ["We run a hospital and billing takes most of our time. What do you do?", "Okay, go on."],
         "not_last": [r"what (kind of|type of) business", r"what business"]},
        {"name": "price not in the knowledge", "turns": ["Who is this?", "How much does it cost?"], "not_last": [MONEY]},
        {"name": "a feature not in the knowledge", "turns": ["Who is this?", "Does it connect with Tally and do you have an office in Dubai?"],
         "has_last": [r"confirm|don't have|do not have|not sure"], "not_last": [r"\byes\b.{0,30}tally"]},
        {"name": "already has software", "turns": ["We already have billing software. Will it replace it?"],
         "has_last": [r"alongside|replace|work with|along with"]},
        {"name": "not interested", "turns": ["Who is this?", "Not interested, thank you."], "end": True, "not_last": [CONTACT_PROMISE]},
        {"name": "busy", "turns": ["I'm in a meeting right now, call me later."], "end": True, "not_last": [CONTACT_PROMISE]},
        {"name": "whatsapp request", "turns": ["Who is this?", "Just send me the details on WhatsApp."], "not_last": [CONTACT_PROMISE, SENT_CLAIM]},
        {"name": "AI question", "turns": ["Are you a real person or a robot?"], "has_last": [r"\bAI\b|artificial"]},
        {"name": "wrong person", "turns": ["Sorry, there is no Ragul here, this is his driver."], "not_last": [r"patient|billing|automat"]},
    ],
    "ta": [
        {"name": "opening", "turns": [None], "not": [TIME_GREETING, IDENTITY_CHECK], "has": [r"Thaara"]},
        {"name": "the example: who, what, hospital, how",
         "turns": ["சொல்லுங்க, யார் பேசுறீங்க?", "எப்படிப்பட்ட automation?", "நாங்க hospital நடத்துறோம்.", "Appointment booking எப்படி வேலை செய்யும்?"],
         "not": [TIME_GREETING, IDENTITY_CHECK]},
        {"name": "hotel, not the configured hospital",
         "turns": ["யார் பேசுறீங்க?", "எங்களுக்கு hospital இல்ல, நாங்க hotel நடத்துறோம்.", "எங்களுக்கு என்ன பண்ண முடியும்?"],
         "has_last": [r"kitchen|billing|sales|கிச்சன்|பில்லிங்"], "not_last": [r"patient|நோயாளி"]},
        {"name": "school", "turns": ["யாரு?", "நான் ஒரு school நடத்துறேன். என்ன பண்ண முடியும்?"],
         "has_last": [r"attendance|timetable|administration|வருகை|அட்டவணை"], "not_last": [r"patient|நோயாளி"]},
        {"name": "price not in the knowledge", "turns": ["யார் பேசுறீங்க?", "இதுக்கு எவ்வளவு செலவாகும்?"], "not_last": [MONEY]},
        {"name": "a feature not in the knowledge", "turns": ["யார் பேசுறீங்க?", "Tally கூட connect ஆகுமா? Dubai-ல office இருக்கா?"],
         "has_last": [r"confirm|தெரியல|இல்ல|உறுதி|team"]},
        {"name": "already has software", "turns": ["எங்ககிட்ட ஏற்கனவே billing software இருக்கு. அதை replace பண்ணுமா?"],
         "has_last": [r"alongside|replace|கூட|சேர்ந்து|மாற்ற|மாத்த|பக்கத்துல"]},
        {"name": "not interested", "turns": ["யார் பேசுறீங்க?", "எனக்கு வேண்டாம், thanks."], "end": True, "not_last": [CONTACT_PROMISE]},
        {"name": "busy", "turns": ["நான் இப்போ meeting-ல இருக்கேன், அப்புறம் பேசலாம்."], "end": True, "not_last": [CONTACT_PROMISE]},
        {"name": "whatsapp request", "turns": ["யார் பேசுறீங்க?", "Details-ஐ WhatsApp-ல அனுப்புங்க."], "not_last": [CONTACT_PROMISE, SENT_CLAIM]},
        {"name": "AI question", "turns": ["நீங்க உண்மையான ஆளா இல்ல robot-ஆ?"], "has_last": [r"\bAI\b|ஏஐ|செயற்கை"]},
        # A real call: the customer only ever gave one word, and the agent kept pitching, then promised a team call.
        {"name": "short answers only", "turns": ["ஆ", "ஆமா", "சரி இல்ல sir", "சரி சரி சரி", "சரி", "ஆமா"],
         "not": [TIME_GREETING, IDENTITY_CHECK, CONTACT_PROMISE, SENT_CLAIM]},
    ],
}


def agent_flow():
    """The compiled fixture without its sample admin instructions and objective: those are compiler test data ("mention
    that we already work with clinics"), and the model would rightly follow them."""
    data = json.loads((BACKEND / "tests" / "fixtures" / "autonomous" / f"{args.language}.json").read_text(encoding="utf-8"))
    data["blocks"] = [b for b in data["blocks"] if b.get("id") != "ai_instructions"]
    for block in data["blocks"]:
        if block.get("id") == "agent":
            block["text"] = re.sub(r"\*\*Calling objective:\*\*[^\n]*", f"**Calling objective:** {OBJECTIVE}", block["text"])
    data["training"]["knowledge"] = [
        {"id": f"k{i}", "status": "active", "kind": kind, "topic": topic, "always": False, "questions": questions, "text": text}
        for i, (kind, topic, text, questions) in enumerate(KNOWLEDGE, 1)]
    return parse_flow(data)


async def reply(llm, prompt: str, history: List[Message], said: str, variables: Dict[str, Optional[str]]) -> Tuple[str, bool]:
    text = "".join([d async for d in llm.stream_response(prompt, history, said, variables)])
    spoken, ended = extract_end_call(text)
    return clean_spoken_text(spoken), ended


async def run_scenario(llm, prompt: str, base: Dict[str, Optional[str]], scenario: Scenario) -> dict:
    history: List[Message] = []
    lines: List[str] = []
    ended = False
    # A call starts with the agent's opening, then the customer answers it (unless they speak first).
    turns = list(scenario["turns"])  # type: ignore[call-overload]
    if turns[0] is not None and not scenario.get("first"):
        turns.insert(0, None)
    for i, customer in enumerate(turns):
        variables = {**base, "call_elapsed_sec": str(i * 12)}
        said = AGENT_GREETING_INSTRUCTION if customer is None else customer
        text, ended = await reply(llm, prompt, history, said, variables)
        lines.append(text)
        if customer is not None:
            history.append({"role": "user", "content": customer})
        history.append({"role": "assistant", "content": text})
    last, everything = lines[-1], "\n".join(lines)
    problems = [f"said /{p}/" for p in [*scenario.get("not", []), ROUTINE_PERMISSION, REACH_YOU]  # type: ignore[misc]
                if re.search(p, everything, re.I)]
    problems += [f"last reply said /{p}/" for p in scenario.get("not_last", []) if re.search(p, last, re.I)]  # type: ignore[union-attr]
    problems += [f"missing /{p}/" for p in scenario.get("has", []) if not re.search(p, everything, re.I)]  # type: ignore[union-attr]
    problems += [f"last reply missing /{p}/" for p in scenario.get("has_last", []) if not re.search(p, last, re.I)]  # type: ignore[union-attr]
    if scenario.get("end") and not ended:
        problems.append("the call was not ended")
    if len(set(lines)) != len(lines):
        problems.append("a reply was repeated")
    return {"name": scenario["name"], "turns": turns, "replies": lines, "ended": ended, "problems": problems}


async def main() -> int:
    scenarios = [s for s in SCENARIOS[args.language] if not args.only or args.only in str(s["name"])]
    print(f"{len(scenarios)} scenarios, language {args.language}, env {os.environ['KAGZSO_ENV_FILE']}")
    if not args.run:
        print("Nothing was called. Add --run to call the LLM provider (uses tokens).")
        return 0
    flow = agent_flow()
    prompt = render_blocks(flow)
    base = dict(build_call_variables("Ragul", "male", "+919876543210"))
    base.update(flow_target_sec=str(flow.autonomous.target_duration_sec), flow_max_sec=str(flow.limits.max_duration_sec),
                flow_natural_lines="true", flow_training=runtime_json(flow.training, flow.language, flow.language_style))
    llm = create_llm_provider()
    results = []
    for scenario in scenarios:
        result = await run_scenario(llm, prompt, base, scenario)
        results.append(result)
        print(f"\n=== {result['name']}  [{'ok' if not result['problems'] else 'CHECK'}]")
        for customer, line in zip(result["turns"], result["replies"]):
            print(f"  customer: {customer if customer is not None else '(silent pick-up)'}\n  thaara:   {line}")
        print(f"  ended: {result['ended']}")
        for problem in result["problems"]:
            print(f"  !! {problem}")
    if args.report:
        Path(args.report).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    failed = sum(1 for r in results if r["problems"])
    print(f"\n{len(results) - failed}/{len(results)} scenarios passed the keyword checks. Read the conversations too.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
