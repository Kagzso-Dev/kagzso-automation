"""Training Studio quality fixes (Phase 11, from the Phase 10 mock evaluation): meaningful Q&A matching,
do-not-call first, negation, the "uncertain" situation, refusal over objection, the language-aware cap and
Q&A de-duplication. Pure functions plus the mock endpoint: no provider is asked and no call is placed."""
import copy

import pytest

from app.flows import training as tr
from tests.test_flows import nila_copy

EN, TA = "english", "mixed"


def ph(i, situation, text, style=EN):
    return {"id": f"ph{i}", "status": "active", "situation": situation, "style": style, "text": text}


def qa(i, topic, questions, text):
    return {"id": f"q{i}", "status": "active", "kind": "qa", "topic": topic, "questions": questions, "text": text}


PHRASES = [ph(1, "reask", "Sorry, could you say that again?"), ph(2, "agree", "Sure."),
           ph(3, "closing", "Have a nice day."), ph(4, "objection", "That makes sense."),
           ph(5, "uncertain", "Of course, take your time."), ph(6, "identity", "This is Thaara from Kexo."),
           ph(7, "acknowledge", "Okay, I understand."), ph(8, "empathy", "I understand, that takes time.")]
QA = [qa(1, "what we do", ["what do you do", "what does your company do"], "We help businesses automate repetitive work."),
      qa(2, "price", ["how much does it cost", "what is the price"], "The exact cost depends on your requirements."),
      qa(3, "existing provider", ["we already use another provider"], "Replacing it isn't necessarily the goal.")]
EXAMPLES = [{"id": "e1", "status": "active", "kind": "good", "customer": "Remove me from your list please",
             "agent": "Sure, I understand."}]


def payload(language="en", style=None, cap=900, phrases=PHRASES, knowledge=QA, examples=EXAMPLES):
    training = tr.FlowTraining.model_validate({"enabled": True, "token_cap": cap, "phrases": copy.deepcopy(phrases),
                                               "knowledge": copy.deepcopy(knowledge),
                                               "examples": copy.deepcopy(examples)})
    return tr.runtime_payload(training, language, style)


# ------------------------------------------------------------------ 1. Q&A false matches
@pytest.mark.parametrize("message,question,match", [
    ("Who is this? Which company are you calling from?", "what does your company do", False),
    ("I want to know about your company website and pricing details", "what does your company do", False),
    ("What does your company do exactly?", "what does your company do", True),
    ("How much does it cost?", "how much does it cost", True),
    ("Okay but how much would it cost us monthly for a restaurant", "how much does it cost", True),
    ("Price?", "price", True),
    ("idhukku evlo aagum?", "evlo aagum", True),
    ("இதுக்கு எவ்வளவு ஆகும்?", "இதுக்கு எவ்வளவு ஆகும்", True),
])
def test_a_single_shared_word_is_not_a_strong_match_in_a_longer_message(message, question, match):
    assert (tr.similarity(message, question) >= tr.QA_THRESHOLD) is match


def test_the_identity_question_is_no_longer_answered_with_what_we_do():
    p = payload()
    picked = tr.compile_training(p, "Who is this? Which company are you calling from?").selected
    assert not any("what we do" in line for line in picked)
    assert any("This is Thaara from Kexo." in line for line in picked)
    assert tr.mock_reply(p, "Who is this? Which company are you calling from?") == "This is Thaara from Kexo."


# ------------------------------------------------------------------ 2. do-not-call first
@pytest.mark.parametrize("message", [
    "Don't call me again. Remove my number.", "Stop calling me", "remove my number please",
    "inime call pannadheenga", "number remove pannunga", "இனிமே call பண்ணாதீங்க, என் number-ஐ remove பண்ணுங்க",
    "phone mat karo",
])
def test_a_do_not_call_request_offers_only_closing_never_a_reask(message):
    p = payload()
    assert tr.is_do_not_call_request(message)
    assert tr.matched_situations(message) == ["closing"]
    out = tr.compile_training(p, message)
    assert out.selected[0] == tr.DNC_LINE
    assert any('"Have a nice day."' in line for line in out.selected)
    assert not any("again?" in line or "If asked about" in line or "example" in line.lower() for line in out.selected)
    assert tr.mock_reply(p, message) == tr.MOCK_DNC


def test_dont_call_me_now_is_busy_not_do_not_call():
    # Same rule as DNC_ENFORCE (call_service.is_do_not_call): "not now / later" is not a do-not-call request.
    assert not tr.is_do_not_call_request("Don't call me now, call in the evening")
    assert "closing" not in tr.matched_situations("Don't call me now, call in the evening")


def test_the_dnc_hint_never_breaks_the_cap():
    p = payload(cap=tr.MIN_TOKEN_CAP)
    out = tr.compile_training(p, "Don't call me again")
    assert out.tokens <= tr.MIN_TOKEN_CAP


# ------------------------------------------------------------------ 3. negation
@pytest.mark.parametrize("message,absent", [
    ("I'm not sure", "agree"), ("I'm not interested", "agree"), ("No problem, go ahead", "empathy"),
    ("I'm not busy, tell me", "busy"), ("சரி இல்ல", "agree"), ("seri illa", "agree"),
])
def test_a_negated_cue_does_not_count(message, absent):
    assert absent not in tr.matched_situations(message)


def test_positive_interest_still_counts_as_agreement():
    assert tr.matched_situations("Okay, that sounds interesting. Tell me more.") == ["agree"]
    assert "agree" in tr.matched_situations("Yes, I'm interested")


# ------------------------------------------------------------------ 4. uncertain
@pytest.mark.parametrize("message", [
    "I'm not sure. I need some time to think about it.", "maybe later, let me think", "I don't know yet",
    "தெரியல, கொஞ்சம் யோசிச்சு சொல்றேன்", "theriyala, konjam yosichu solren", "paakalam, aprom solren",
])
def test_uncertainty_is_recognised_in_english_tamil_and_tanglish(message):
    assert tr.matched_situations(message)[0] == "uncertain"


def test_an_unsure_customer_is_offered_uncertain_phrases_not_agreement():
    out = tr.compile_training(payload(), "I'm not sure. I need some time to think about it.")
    assert any("Of course, take your time." in line for line in out.selected)
    assert not any('"Sure."' in line for line in out.selected)
    assert "uncertain" in tr.SITUATION_LABELS and "never push" in tr.SITUATION_LABELS["uncertain"]


# ------------------------------------------------------------------ 5. refusal over objection
@pytest.mark.parametrize("message", [
    "Stop wasting my time, I'm not interested.", "We already have someone, not interested",
    "என் time waste பண்ணாதீங்க, வேண்டாம்", "time waste pannadheenga, vendam", "already irukku, vendam",
])
def test_a_refusal_comes_first_and_drops_the_situations_that_keep_talking(message):
    ranked = tr.matched_situations(message)
    assert ranked[0] == "closing"
    assert not set(ranked) & tr.REFUSAL_SUPPRESSES
    picked = tr.compile_training(payload(), message).selected
    assert not any("That makes sense." in line for line in picked)
    assert tr.mock_reply(payload(), message) == "Have a nice day."


# ------------------------------------------------------------------ 6. language-aware cap
def test_new_trainings_in_indic_flows_start_with_a_larger_cap_english_stays_900():
    assert tr.default_token_cap("en") == tr.DEFAULT_TOKEN_CAP == 900
    assert tr.default_token_cap("ta") == tr.default_token_cap("hi-IN") == tr.INDIC_DEFAULT_TOKEN_CAP == 1200
    assert tr.INDIC_DEFAULT_TOKEN_CAP <= tr.MAX_TOKEN_CAP


TA_PHRASES = [ph(i, s, t, TA) for i, (s, t) in enumerate([
    ("greeting", "Phone எடுத்ததுக்கு thank you."), ("acknowledge", "சரி, புரியுது."), ("acknowledge", "Okay, சரிங்க."),
    ("agree", "கண்டிப்பா."), ("empathy", "புரியுது, அதுக்கு நிறைய time ஆகும்."), ("busy", "பரவாயில்லைங்க."),
    ("clarify", "Simple-ஆ சொல்றேன்."), ("price", "Exact cost உங்க requirement-ஐ பொறுத்து இருக்கும்."),
    ("objection", "அது சரிதான்."), ("objection", "நல்ல point."), ("identity", "நான் Kexo-ல இருந்து Thaara பேசுறேன்."),
    ("disclosure", "நான் ஒரு AI assistant, Kexo சார்பா call பண்றேன்."), ("thanks", "உங்க time-க்கு thank you."),
    ("closing", "Have a nice day.")], start=1)]
TA_QA = [qa(1, "price", ["இதுக்கு எவ்வளவு ஆகும்", "evlo aagum"],
            "Exact cost உங்க requirement, automation scope-ஐ பொறுத்து இருக்கும்; process புரிஞ்சதுக்கு அப்புறம் சொல்ல முடியும்."),
         qa(2, "what we do", ["நீங்க என்ன பண்றீங்க", "enna panreenga"], "Businesses-ல repetitive work-ஐ AI வச்சு automate பண்ண help பண்றோம்."),
         qa(3, "existing provider", ["ஏற்கனவே வேற company use பண்றோம்"], "பரவாயில்லைங்க, அதை replace பண்றது goal இல்ல; இன்னும் manual steps இருக்கலாம்."),
         qa(4, "website", ["website இருக்கா"], "இருக்கு, kagzso.com-ல எல்லா details-உம் இருக்கு.")]


TA_PERSONA = {"status": "active", "agent_name": "Thaara", "company": "Kagzso AI and Automation",
              "business_type": "AI and automation services",
              "objective": "Introduce our AI automation services and find out whether the customer is interested",
              "call_purpose": "A short introduction to how we help businesses with repetitive work",
              "target_customer": "Owners and managers of small and mid-size businesses",
              "intro": "We help businesses automate their daily repetitive work using AI.",
              "desired_outcome": "The customer says it could be useful", "english_mix": "medium",
              "role": "Professional business development executive",
              "avoid": ["slang", "exaggeration", "pushiness", "jargon"]}
TA_FACT = {"id": "f1", "status": "active", "kind": "fact", "topic": "company", "always": True,
           "text": "Kagzso AI and Automation helps businesses automate daily repetitive work using AI."}
TA_EXAMPLES = [{"id": "e1", "status": "active", "kind": "good", "situation": "uncertain",
                "customer": "கொஞ்சம் யோசிச்சு சொல்றேன்", "agent": "கண்டிப்பா, உங்க time எடுத்துக்கோங்க. Details kagzso.com-ல இருக்கு."},
               {"id": "e2", "status": "active", "kind": "bad", "customer": "வேண்டாம்",
                "agent": "Sir, இன்னும் ரெண்டு நிமிஷம் மட்டும் கேளுங்க", "reason": "pushes after a clear no",
                "better": "சரிங்க, பரவாயில்லை. உங்க time-க்கு thank you."}]


def test_a_realistic_tamil_training_fits_the_tamil_default_but_not_900():
    # The Phase 10 evaluation set: refused at 900 (it needs ~966), fits the Tamil default.
    def worst(cap):
        training = tr.FlowTraining.model_validate({"enabled": True, "token_cap": cap, "persona": TA_PERSONA,
                                                   "phrases": TA_PHRASES, "knowledge": [TA_FACT] + TA_QA,
                                                   "examples": TA_EXAMPLES})
        return tr.cap_issue(training, "ta", None)

    assert worst(900) is not None and "over the cap of 900" in worst(900)
    assert worst(tr.default_token_cap("ta")) is None


def test_the_block_never_exceeds_the_cap_and_reports_what_was_left_out():
    p = payload("ta", None, cap=tr.MIN_TOKEN_CAP, phrases=TA_PHRASES, knowledge=TA_QA, examples=[])
    for message in ("இதுக்கு எவ்வளவு ஆகும்?", "யாரு பேசுறது?", "ok seri"):
        out = tr.compile_training(p, message)
        assert out.tokens <= tr.MIN_TOKEN_CAP
        assert not any(line in out.text for line in out.dropped)


# ------------------------------------------------------------------ 7. Q&A de-duplication
def test_an_answer_given_in_the_previous_reply_is_not_offered_word_for_word_again():
    p = payload()
    first = tr.compile_training(p, "How much does it cost?")
    assert any("answer: \"The exact cost depends on your requirements.\"" in line for line in first.selected)
    again = tr.compile_training(p, "but how much does it cost?", last_reply="The exact cost depends on your requirements.")
    assert not any("answer: \"The exact cost" in line for line in again.selected)
    assert any("You just gave the approved answer about price" in line for line in again.selected)
    # A reworded previous reply with the same meaning counts too (its words, in any order).
    assert tr.just_answered("The exact cost depends on your requirements.",
                            f" {tr._norm('Your requirements decide the exact cost, it depends.')} ")
    assert tr.mock_reply(p, "how much does it cost", "The exact cost depends on your requirements.") != \
        "The exact cost depends on your requirements."


# ------------------------------------------------------------------ English unchanged where it was right
@pytest.mark.parametrize("message,first", [
    ("How much does it cost?", "price"), ("Am I talking to a real person or a robot?", "disclosure"),
    ("We already use another provider for this.", "objection"), ("Who is this? Which company are you calling from?", "identity"),
])
def test_english_scenarios_that_passed_still_point_at_the_same_situation(message, first):
    assert tr.matched_situations(message)[0] == first


# ------------------------------------------------------------------ mock labels
def test_mock_texts_say_they_are_simulated(client, auth):
    for text in (tr.MOCK_WITHOUT, tr.MOCK_NO_MATCH, tr.MOCK_DNC):
        assert text.startswith("(simulated - not an AI reply)")
    training = {"enabled": True, "phrases": [ph(1, "closing", "Have a nice day.")]}
    body = {"flow": nila_copy(training=training), "message": "Don't call me again"}
    out = client.post("/api/flows/training-test", json=body, headers=auth).json()
    assert out["mode"] == "mock" and out["with"]["reply"] == tr.MOCK_DNC and out["selected"][0] == tr.DNC_LINE
