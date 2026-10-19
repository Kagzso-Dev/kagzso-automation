"""REPEAT_QUESTION_GUARD: a question the agent already asked in this call is not spoken again
when the model tacks it onto an answer (e.g. "Do you feel this could be useful for your
business?" after every reply). The first time a question is asked it is untouched, a reply
that is only a question is never emptied, and the guard can be switched off."""
from app.core.config import settings
from app.services.call_service import asked_questions, is_repeated_question
from tests.test_opening_flow import INTRO, PERMISSION, _turns

INTEREST = "Do you feel this could be useful for your business?"
HOW = "It depends on your business. We first understand your workflow, then suggest the right solution."
PRICE = "The exact cost depends on your requirements. We can give a price only after understanding your process."
OPENING = [("Hello?", None), ("Good afternoon", None), ("Yes, speaking", PERMISSION), ("Go ahead", INTRO)]


def test_matching_rule():
    asked = asked_questions(["Thank you. Could you give me just one minute? I'll be quick. Is that okay?", INTEREST])
    assert is_repeated_question(INTEREST, asked)
    assert is_repeated_question("Could you give me just one minute to hear more?", asked)  # same question, reworded
    assert not is_repeated_question("Is that okay?", asked)  # too short to judge
    assert not is_repeated_question("Does your team handle many customer follow-ups?", asked)  # a new question
    assert not is_repeated_question("Do you feel this could be useful for your business.", asked)  # not a question
    assert not is_repeated_question(INTEREST, [])


def test_repeated_interest_question_is_dropped_but_the_first_one_kept(client, auth, fakes):
    spoken = _turns(client, auth, fakes, OPENING + [
        ("How does it work?", f"{HOW} {INTEREST}"),
        ("How much does it cost?", f"{PRICE} {INTEREST}"),
    ])
    assert spoken[4] == f"{HOW} {INTEREST}"  # first time: asked
    assert spoken[5] == PRICE  # second time: the answer only
    assert sum(INTEREST in s for s in spoken) == 1


def test_main_question_is_not_tacked_on_again(client, auth, fakes):
    main_q = "Does your team spend a lot of time on repetitive work every day?"
    assert main_q in INTRO  # asked in the introduction
    spoken = _turns(client, auth, fakes, OPENING + [("Where is your office?", f"I don't have that information right now. {main_q}")])
    assert spoken[4] == "I don't have that information right now."


def test_a_reply_that_is_only_a_question_is_never_emptied(client, auth, fakes):
    spoken = _turns(client, auth, fakes, OPENING + [
        ("How does it work?", f"{HOW} {INTEREST}"),
        ("Hmm", INTEREST),
    ])
    assert spoken[5] == INTEREST


def test_guard_off_speaks_the_reply_exactly(client, auth, fakes, monkeypatch):
    monkeypatch.setattr(settings, "REPEAT_QUESTION_GUARD", False)
    spoken = _turns(client, auth, fakes, OPENING + [
        ("How does it work?", f"{HOW} {INTEREST}"),
        ("How much does it cost?", f"{PRICE} {INTEREST}"),
    ])
    assert spoken[5] == f"{PRICE} {INTEREST}"
