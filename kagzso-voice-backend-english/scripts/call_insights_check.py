"""Real-model check of call insights and customer questions (app/services/customer_questions.py).

The pytest suite uses a fake LLM, so it proves what the code checks, not what the model reads. This sends synthetic
call transcripts (English, Tamil, Tanglish, Hindi, Kannada) to the LLM provider set in the env file, with the same
prompt and the same checks a finished Autonomous AI Agent call uses, and checks what is kept:

  * sentiment and interest, kept apart: asking questions (even about price) is exploring, never interested; a
    polite "no" is not interested with a calm sentiment; changes during the call show in start / end
  * the reason a customer wasn't interested, only when they said one
  * the same question in other words or languages matches the known question; a new one gets an answer only from
    the approved information, else none
  * private details (name, business, number, place, turnover) never stay in questions or insights

Places no call and writes nothing to a database. Transcripts and knowledge are synthetic. It DOES call the LLM provider
in the env file (two requests per scenario, as a real call: questions ~2,500 and insights ~700 input tokens), so
nothing is sent without --run. From
kagzso-voice-backend-english:

    .venv/Scripts/python scripts/call_insights_check.py              # prints what would be sent
    .venv/Scripts/python scripts/call_insights_check.py --run        # the English backend's provider (.env)
    .venv/Scripts/python scripts/call_insights_check.py --run --only kn

The checks are heuristics: read the printed results too.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--env", default=".env", help="env file whose LLM provider is used (default .env)")
parser.add_argument("--run", action="store_true", help="call the LLM provider (uses tokens)")
parser.add_argument("--only", help="run only the scenarios whose name contains this")
args = parser.parse_args()
os.environ.setdefault("KAGZSO_ENV_FILE", args.env)

from app.services import customer_questions as cq  # noqa: E402
from app.services.llm_service import create_llm_provider  # noqa: E402

# Synthetic knowledge: stands in for an agent's approved items, states nothing about the real company.
TRAINING = {
    "facts": [
        {"topic": "Services", "text": "Kagzso automates billing follow-ups, payment reminders and WhatsApp messages for small businesses.", "always": True},
        {"topic": "Languages", "text": "The AI assistant can talk with customers in English, Tamil, Hindi and Kannada.", "always": False},
        {"topic": "WhatsApp reminders", "text": "Payment and appointment reminders are sent automatically on WhatsApp using approved templates.", "always": False},
        {"topic": "Data safety", "text": "Customer data is stored securely and never shared with third parties.", "always": False},
    ],
    "qa": [{"topic": "Pricing", "questions": ["How much does it cost?"], "text": "It depends on the business's requirements, and the team confirms it."}],
}
KNOWN = [{"id": "svc", "question": "What services does the company offer?"},
         {"id": "price", "question": "How much does it cost?"},
         {"id": "data", "question": "Is our data safe with you?"},
         {"id": "lang", "question": "Which languages does the AI support?"}]
PRIVATE = {"customer_name": "Ravi Shankar", "customer_business": "Sri Murugan Stores"}
NOT_KNOWN = "I don't have that detail right now; it needs confirmation from the Kagzso team."
A = "Agent"
C = "Customer"
GOOD = {"positive"}
CALM = {"positive", "neutral"}
INTERESTED = {"interested", "highly_interested"}
CURIOUS = {"exploring", "unclear"}

# name, lines, outcome (as the call's outcome classifier would set it), and what must hold:
#   interest     allowed interest levels (kept, after the code's checks)
#   end          allowed sentiment at the end (or overall when no end)
#   start        allowed sentiment at the start (only where a change is the point)
#   reason       the not-interested reason's type, or None = there must be none
#   known        known question ids that must be matched
#   new          True: a new question must be found; False: none; None: either
#   drafted      for new questions: "none" = no answer may be drafted (nothing approved answers it)
#   forbid       text that must not appear anywhere kept
SCENARIOS: List[Dict[str, Any]] = [
    {"name": "en 1: interested customer asks how it works",
     "lines": [(A, "Hello, this is Thaara from Kagzso. We help businesses automate payment reminders."),
               (C, "Oh nice, that would actually help us. How do the WhatsApp reminders work?"),
               (A, "Reminders go out automatically on WhatsApp using approved templates."),
               (C, "That's useful. I like it.")],
     # "How do the reminders work" may be grouped with the services question (the committed prompt does that too).
     "outcome": "interested", "interest": INTERESTED, "end": GOOD, "known": [], "new": None},
    {"name": "en 2: services, wording A",
     "lines": [(A, "Hello, this is Thaara from Kagzso."), (C, "Okay. What exactly does your company do?"),
               (A, "We automate billing follow-ups and WhatsApp messages."), (C, "Alright.")],
     "outcome": "completed", "interest": CURIOUS, "end": CALM, "known": ["svc"], "new": False},
    {"name": "tanglish 3: services, wording B",
     "lines": [(A, "Vanakkam, naan Thaara, Kagzso-la irundhu."), (C, "Neenga enna business pannreenga?"),
               (A, "Billing follow-up, WhatsApp message automate pannrom."), (C, "Hmm okay.")],
     "outcome": "completed", "interest": CURIOUS, "end": CALM, "known": ["svc"], "new": False},
    {"name": "hi 4: services, wording C",
     "lines": [(A, "नमस्ते, मैं Thaara, Kagzso से."), (C, "आप लोग किस चीज़ की सर्विस देते हैं?"),
               (A, "हम billing और WhatsApp के काम automate करते हैं."), (C, "अच्छा, ठीक है.")],
     "outcome": "completed", "interest": CURIOUS, "end": CALM, "known": ["svc"], "new": False},
    {"name": "kn 5: services, wording D",
     "lines": [(A, "ನಮಸ್ಕಾರ, ನಾನು Thaara, Kagzso ಕಡೆಯಿಂದ."), (C, "ನಿಮ್ಮ ಕಂಪನಿ ಯಾವ ಸೇವೆಗಳನ್ನು ಕೊಡುತ್ತದೆ?"),
               (A, "ನಾವು billing ಮತ್ತು WhatsApp ಕೆಲಸಗಳನ್ನು automate ಮಾಡುತ್ತೇವೆ."), (C, "ಸರಿ.")],
     "outcome": "completed", "interest": CURIOUS, "end": CALM, "known": ["svc"], "new": False},
    {"name": "ta 6: positive customer, a question approved knowledge answers (languages)",
     "lines": [(A, "வணக்கம், நான் Thaara, Kagzso-ல இருந்து பேசறேன்."), (C, "நல்லா இருக்கு. என் customers கிட்ட தமிழ்ல பேசுமா?"),
               (A, "ஆமா, தமிழ், English, Hindi, Kannada எல்லாத்துலயும் பேசும்."), (C, "சூப்பர், இது எங்களுக்கு useful-ஆ இருக்கும்.")],
     "outcome": "interested", "interest": INTERESTED, "end": GOOD, "known": ["lang"], "new": False},
    {"name": "en 7: positive customer, a question nothing approved answers (Tally)",
     "lines": [(A, "Hello, this is Thaara from Kagzso."), (C, "Sounds good. Does it connect with Tally?"), (A, NOT_KNOWN),
               (C, "Okay, no problem.")],
     "outcome": "completed", "interest": CURIOUS | INTERESTED, "end": CALM, "known": [], "new": True, "drafted": "none"},
    {"name": "en 8: neutral customer asks the price: exploring, not interested",
     "lines": [(A, "Hello, this is Thaara from Kagzso."), (C, "How much does your automation cost?"),
               (A, "It depends on your requirements; the team confirms it."), (C, "Okay.")],
     "outcome": "completed", "interest": CURIOUS, "end": CALM, "known": ["price"], "new": False},
    {"name": "tanglish 9: price in Tanglish: still exploring",
     "lines": [(A, "Vanakkam, naan Thaara, Kagzso-la irundhu."), (C, "Idhuku evlo cost aagum?"),
               (A, "Unga requirement poruthu, team confirm pannuvanga."), (C, "Sari.")],
     "outcome": "completed", "interest": CURIOUS, "end": CALM, "known": ["price"], "new": False},
    {"name": "en 10: negative, unhappy about the call",
     "lines": [(A, "Hello, this is Thaara from Kagzso."), (C, "You people keep calling me every week. This is really annoying."),
               (A, "I'm sorry for the trouble. I'll let you go."), (C, "Please stop calling.")],
     "outcome": "not_interested", "interest": {"not_interested"}, "end": {"negative", "frustrated"}, "reason": "other",
     "known": [], "new": False},
    {"name": "ta 11: not interested, already has a system",
     "lines": [(A, "வணக்கம், நான் Thaara, Kagzso-ல இருந்து பேசறேன்."), (C, "வேண்டாம், எங்க கிட்ட already ஒரு billing software இருக்கு."),
               (A, "புரியுது, நேரம் ஒதுக்கியதுக்கு நன்றி."), (C, "சரி, நன்றி.")],
     "outcome": "not_interested", "interest": {"not_interested"}, "end": CALM, "reason": "existing_system", "known": [], "new": False},
    {"name": "hi 12: not interested, too expensive",
     "lines": [(A, "नमस्ते, मैं Thaara, Kagzso से."), (C, "कितने का है?"), (A, "आपकी ज़रूरत पर depend करता है, team confirm करेगी."),
               (C, "नहीं, हमारे लिए ये बहुत महंगा होगा. Interest नहीं है.")],
     "outcome": "not_interested", "interest": {"not_interested"}, "end": CALM | {"hesitant", "negative"}, "reason": "pricing",
     "known": ["price"], "new": False},
    {"name": "en 13: neutral at first, interested by the end",
     "lines": [(A, "Hello, this is Thaara from Kagzso."), (C, "Yes, who is this? I'm busy, make it quick."),
               (A, "We automate payment reminders on WhatsApp."), (C, "Wait, payment reminders? We lose a lot on late payments."),
               (A, "Reminders go out automatically, so fewer payments are missed."), (C, "That would really help us. Tell me more.")],
     "outcome": "interested", "interest": INTERESTED, "start": {"neutral", "hesitant", "negative", "frustrated"}, "end": GOOD,
     "known": [], "new": None},
    {"name": "tanglish 14: interested at first, not interested by the end",
     "lines": [(A, "Vanakkam, naan Thaara, Kagzso-la irundhu."), (C, "Oh nice, WhatsApp reminders ah? Interesting."),
               (A, "Aama, payment reminders automatic-a pogum."), (C, "Evlo aagum?"), (A, "Requirement poruthu, team confirm pannuvanga."),
               (C, "Illa, ippo budget illa. Venam, thanks.")],
     "outcome": "not_interested", "interest": {"not_interested"}, "start": GOOD | {"neutral"}, "end": CALM | {"hesitant", "negative"},
     "reason": "pricing", "known": ["price"], "new": None},
    {"name": "en 15: a follow-up question about the earlier answer",
     "lines": [(A, "Hello, this is Thaara from Kagzso. We automate WhatsApp payment reminders."),
               (C, "Okay. And that WhatsApp thing you mentioned, can it send the messages in Tamil?"),
               (A, "Yes, it supports Tamil, English, Hindi and Kannada."), (C, "Good.")],
     "outcome": "completed", "interest": CURIOUS | INTERESTED, "end": CALM, "known": ["lang"], "new": None},
    {"name": "en 16: private business details stay out",
     "lines": [(A, "Hello, this is Thaara from Kagzso."),
               (C, "I'm Ravi from Sri Murugan Stores in Anna Nagar, my number is 98400 12345. Our turnover is 2 crore and we use Zoho. "
                   "Can you send payment reminders to my shop's customers?"),
               (A, "Yes, payment reminders on WhatsApp are one of the things we automate."), (C, "Good, that's what we need.")],
     "outcome": "interested", "interest": INTERESTED | CURIOUS, "end": CALM, "known": [], "new": None,
     "forbid": ["Ravi", "Murugan", "98400", "Anna Nagar", "crore", "Zoho"]},
    {"name": "kn 17: wants a demo: highly interested",
     "lines": [(A, "ನಮಸ್ಕಾರ, ನಾನು Thaara, Kagzso ಕಡೆಯಿಂದ."), (C, "ಇದು ನಮಗೆ ತುಂಬಾ ಉಪಯೋಗ ಆಗುತ್ತೆ. ನಾವು ಬೇಗ ಶುರು ಮಾಡಬೇಕು, demo ತೋರಿಸ್ತೀರಾ?"),
               (A, "ತಂಡದವರು ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತಾರೆ."), (C, "ಸರಿ, ಧನ್ಯವಾದ.")],
     "outcome": "interested", "interest": {"highly_interested"}, "end": GOOD, "known": [], "new": None},
    {"name": "hi 18: many questions, no stated interest: exploring",
     "lines": [(A, "नमस्ते, मैं Thaara, Kagzso से."), (C, "आपकी कंपनी क्या करती है?"), (A, "हम billing और WhatsApp automate करते हैं."),
               (C, "डेटा safe रहता है?"), (A, "हाँ, डेटा सुरक्षित रहता है और किसी से share नहीं होता."), (C, "किन भाषाओं में बात करता है?"),
               (A, "English, Tamil, Hindi और Kannada में."), (C, "ठीक है.")],
     "outcome": "completed", "interest": CURIOUS, "end": CALM, "known": ["svc", "data", "lang"], "new": False},
    {"name": "en 19: confused customer",
     "lines": [(A, "Hello, this is Thaara from Kagzso. We provide AI calling automation."),
               (C, "Sorry, I don't understand. What is this AI thing? Is it a person or a machine? I'm confused."),
               (A, "It's an assistant that calls customers and sends reminders for businesses."), (C, "I still don't really get it.")],
     "outcome": "completed", "interest": CURIOUS, "end": {"confused", "hesitant", "neutral"}, "known": [], "new": None},
    {"name": "tanglish 20: hesitant, will think about it",
     "lines": [(A, "Vanakkam, naan Thaara, Kagzso-la irundhu."), (C, "Hmm, theriyala. Ippo konjam doubt ah irukku."),
               (A, "Paravala, enna doubt nu sollunga."), (C, "Yosichu solren. Aprom paakalam.")],
     "outcome": "completed", "interest": CURIOUS, "end": {"hesitant", "neutral", "confused"}, "known": [], "new": False},
]


def checks(s: Dict[str, Any], questions: List[Dict[str, Any]], ins: Optional[Dict[str, Any]]) -> List[str]:
    problems: List[str] = []
    if ins is None:
        return ["no insights kept"]
    if ins["interest"] not in s["interest"]:
        problems.append(f"interest {ins['interest']} (expected {sorted(s['interest'])})")
    end = ins["sentiment_end"] or ins["sentiment"]
    if end not in s["end"]:
        problems.append(f"sentiment at the end {end} (expected {sorted(s['end'])})")
    if "start" in s and ins["sentiment_start"] not in s["start"]:
        problems.append(f"sentiment at the start {ins['sentiment_start']} (expected {sorted(s['start'])})")
    reason = ins["not_interested_reason"]
    if s.get("reason") and (not reason or reason["type"] != s["reason"]):
        problems.append(f"reason {reason} (expected type {s['reason']})")
    if "reason" not in s and reason:
        problems.append(f"a reason the customer gave none for? {reason}")
    matched = {q["known_id"] for q in questions if q["known_id"]}
    for k in s["known"]:
        if k not in matched:
            problems.append(f"known question '{k}' not matched")
    new = [q for q in questions if not q["known_id"]]
    if s["new"] is True and not new:
        problems.append("the new question was not found")
    if s["new"] is False and new:
        problems.append(f"unexpected new question(s): {[q['question'] for q in new]}")
    if s.get("drafted") == "none" and any(q["answer"] for q in new):
        problems.append("an answer was drafted though nothing approved answers it")
    kept = json.dumps({"questions": questions, "insights": ins}, ensure_ascii=False).lower()
    for word in s.get("forbid", []):
        if word.lower() in kept:
            problems.append(f"kept text contains '{word}'")
    return problems


async def main() -> int:
    scenarios = [s for s in SCENARIOS if not args.only or args.only in s["name"]]
    variables = {"flow_training": json.dumps(TRAINING), **PRIVATE}
    terms = cq.private_terms(variables)
    llm = create_llm_provider() if args.run else None
    failed = 0
    for s in scenarios:
        transcript = "\n".join(f"{who}: {said}" for who, said in s["lines"])
        customer = " ".join(said for who, said in s["lines"] if who == C)
        info = cq.approved_info(variables, customer)
        body = cq.user_text(KNOWN, info, transcript)
        print(f"\n=== {s['name']}")
        if llm is None:
            continue
        raw = await llm.complete_raw(cq.QUESTIONS_SYSTEM, body)  # the questions request, as on a real call
        raw_insights = await llm.complete_raw(cq.INSIGHTS_SYSTEM, cq.insights_text(transcript))  # and the insights one
        questions = cq.parse(raw, KNOWN, info, terms)
        ins = cq.parse_insights(raw_insights, terms, s["outcome"])
        model = (cq.parse_insights(raw_insights) or {}).get("interest")  # the model's own word, before the outcome guard
        print("insights:", json.dumps(ins, ensure_ascii=False))
        print(f"model's own interest: {model}")
        print("questions:", json.dumps([{k: q[k] for k in ("question", "known_id", "answered", "answer", "sentiment") if k in q}
                                        for q in questions], ensure_ascii=False))
        problems = checks(s, questions, ins)
        if s["outcome"] == "not_interested" and model != "not_interested":
            problems.append(f"the model said {model}; only the outcome guard made it not_interested")
        failed += bool(problems)
        print("PASS" if not problems else "FAIL: " + "; ".join(problems))
    if llm is not None:
        await llm.aclose()
        print(f"\n{len(scenarios) - failed}/{len(scenarios)} passed (heuristic checks: read the results above)")
    else:
        print(f"\n{len(scenarios)} scenarios. Nothing was sent. Add --run to call the LLM provider (uses tokens).")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
