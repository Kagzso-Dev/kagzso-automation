"""The guided flow runner (app/flows/runner.py): the LLM proposes, the runner decides, and state only moves on
what the customer heard. Text only: no provider, no call."""
import json
from pathlib import Path

import pytest

from app.flows.guided import parse_guided_flow
from app.flows.runner import (DECISION_FORMAT, FlowRunner, RunnerState, Safety, default_safety, parse_model_output)
from app.services.llm_service import render_first_message

BACKEND = Path(__file__).resolve().parents[1]
RAW = json.loads((BACKEND / "app/flows/guided_examples/business_executive.en.json").read_text(encoding="utf-8"))
FLOW = parse_guided_flow(RAW)
VARS = {"customer_name": "Ragul", "gender": "male"}
# Plain detectors so each test says exactly what is detected (default_safety is tested separately).
SAFETY = Safety(do_not_call=lambda t: "never call" in t.lower(), ai_question=lambda t: "robot" in t.lower())

PERMISSION = "Could you give me just one minute?"
WHO = "Thank you, sir. This is Thaara from Kexo AI and Automation. We help businesses automate their daily repetitive work using AI."
BUSINESS_Q = "What kind of business do you run?"
PROCESS_Q = "How does your team handle repetitive work like follow-ups, data entry or reports today?"
INTEREST_Q = "Do you think something like this could be useful for your business?"


def runner(**kw):
    return FlowRunner(kw.pop("flow", FLOW), safety=kw.pop("safety", SAFETY),
                      render=lambda t: render_first_message(t, VARS), **kw)


def out(intent, next_="stay", captured=None, asks=None, reply="Okay."):
    return json.dumps({"intent": intent, "captured": captured or {}, "next": next_, "asks": asks}) + "\n" + reply


def at(stage, collected=None, said=None):
    """A state in `stage` with the given answers (from the customer) and statements already heard."""
    s = RunnerState(stage=stage, said=list(said if said is not None else ["intro.who_we_are"]))
    for name, value in (collected or {}).items():
        s.collected[name] = {"value": value, "source": "customer", "stage": stage, "question": "", "heard_in_stage": stage, "turn": 0}
    return s


def kinds(plan):
    return [(s.kind, s.text) for s in plan.segments]


# ------------------------------------------------------------------ exact statements and the opening
def test_opening_says_the_statement_and_the_exact_question_word_for_word():
    r = runner()
    plan = r.opening(r.initial_state())
    assert kinds(plan) == [("statement", WHO), ("question", PERMISSION)]
    assert all(s.exact for s in plan.segments) and plan.status == "opening"
    state = r.commit(r.initial_state(), plan)
    assert state.said == ["intro.who_we_are"] and state.asked == {"custom_permission": 1} and state.turn == 0


def test_the_only_change_to_exact_text_is_variable_rendering():
    plain = FlowRunner(FLOW, safety=SAFETY).opening(RunnerState(stage="intro"))
    assert plain.segments[0].text == RAW["stages"][0]["mandatory"][0]["text"]  # without variables: byte for byte


# ------------------------------------------------------------------ required fields, branching, transitions
def test_a_required_field_cannot_be_skipped():
    r = runner()
    plan = r.plan(at("discover"), "Sure.", out("answered", next_="relate", reply="Great, let me tell you how we help."))
    assert plan.status == "recovered" and "unauthorized_transition" in plan.issues
    assert kinds(plan) == [("question", BUSINESS_Q)]  # the LLM's text is not spoken
    assert r.commit(at("discover"), plan).stage == "discover"


def test_an_unauthorized_closing_is_refused():
    plan = runner().plan(at("discover"), "Okay.", out("answered", next_="close:interested"))
    assert plan.status == "recovered" and "unauthorized_closing" in plan.issues and plan.closing is None


def test_a_closing_the_llm_did_not_propose_cannot_be_invented_either():
    plan = runner().plan(at("relate"), "Okay.", out("answered", next_="close:meeting"))
    assert plan.status == "recovered" and plan.closing is None


def test_branch_follows_the_rules_on_intent():
    r = runner()
    for intent, closing in (("interested", "interested"), ("meeting_request", "meeting"), ("uncertain", "uncertain")):
        plan = r.plan(at("relate"), "...", out(intent, next_=f"close:{closing}", captured={"interest_level": "x"}))
        assert plan.status == "closing" and plan.closing == closing


def test_the_rules_decide_even_when_the_llm_proposed_to_stay():
    plan = runner().plan(at("relate"), "Yes, useful.", out("interested", next_="stay"))
    assert plan.closing == "interested" and "closing_not_proposed" in plan.issues


def test_moving_on_once_every_required_field_is_collected():
    r = runner()
    state = at("discover", {"business_type": "hotel"})
    plan = r.plan(state, "All manual, in Excel.", out("answered", next_="relate", reply="That's a lot of manual work.",
                                                      captured={"current_process": "manual, Excel"}))
    assert plan.status == "accepted"
    assert kinds(plan) == [("reply", "That's a lot of manual work."), ("question", INTEREST_Q)]
    after = r.commit(state, plan)
    assert after.stage == "relate" and after.completed == ["discover"] and after.collected["current_process"]["value"] == "manual, Excel"


def test_optional_fields_never_hold_the_call():
    plan = runner().plan(at("discover", {"business_type": "hotel"}), "Manual.",
                         out("answered", next_="relate", captured={"current_process": "manual"}))
    assert plan.status == "accepted" and plan.segments[-1].text == INTEREST_Q  # existing_software / pain_points skipped


def test_a_move_the_llm_missed_still_happens_and_keeps_a_reply_that_asks_nothing():
    plan = runner().plan(at("discover", {"business_type": "hotel"}), "Manual.",
                         out("answered", next_="stay", captured={"current_process": "manual"}, reply="I see."))
    assert plan.status == "corrected" and "transition_not_proposed" in plan.issues
    assert kinds(plan) == [("reply", "I see."), ("question", INTEREST_Q)]


def test_a_bridge_that_asks_something_is_dropped_on_a_stage_change():
    plan = runner().plan(at("discover", {"business_type": "hotel"}), "Manual.",
                         out("answered", next_="relate", captured={"current_process": "manual"}, asks="pain_points",
                             reply="Which part takes longest?"))
    assert "bridge_asked" in plan.issues and kinds(plan) == [("question", INTEREST_Q)]


def test_natural_questions_may_be_asked_in_the_ais_words():
    plan = runner().plan(at("discover", {"business_type": "hotel"}), "A hotel.",
                         out("answered", asks="current_process", reply="How do you manage billing and follow-ups today?"))
    assert kinds(plan) == [("reply", "How do you manage billing and follow-ups today?")]
    assert plan.segments[0].effects == (("asked", "current_process"),)


def test_exact_questions_are_never_asked_by_the_llm():
    plan = runner().plan(at("intro"), "Hmm?", out("question", asks="custom_permission", reply="Got a minute?"))
    assert plan.status == "recovered" and "asked_exact_field" in plan.issues and kinds(plan) == [("question", PERMISSION)]


def test_asking_about_an_unknown_or_answered_field_is_refused():
    r = runner()
    assert "asks_unknown_field" in r.plan(at("discover"), "x", out("answered", asks="interest_level")).issues
    assert "asks_unknown_field" in r.plan(at("discover", {"business_type": "x"}), "x", out("answered", asks="business_type")).issues


def test_an_optional_question_is_the_turns_one_question():
    plan = runner().plan(at("discover"), "We sell clothes online.",
                         out("answered", asks="existing_software", reply="Do you use any software for orders?"))
    assert len(plan.segments) == 1  # business_type stays pending; not a second question in the same breath


# ------------------------------------------------------------------ detours, objections, interruptions
def test_a_question_is_answered_then_the_pending_question_comes_back():
    reply = "The exact cost depends on your requirements and the automation scope."
    plan = runner().plan(at("discover"), "How much does it cost?", out("question", reply=reply))
    assert plan.status == "accepted" and kinds(plan) == [("reply", reply), ("question", BUSINESS_Q)]


def test_an_objection_keeps_the_flow_position():
    r = runner()
    state = at("intro")
    plan = r.plan(state, "We already have staff.", out("objection", reply="Replacing employees is not the goal."))
    assert kinds(plan)[-1] == ("question", PERMISSION)
    assert r.commit(state, plan).stage == "intro"


def test_an_unheard_statement_is_said_again():
    r = runner()
    state = r.commit(r.initial_state(), r.opening(r.initial_state()), heard=0)
    assert state.said == [] and state.asked == {}
    plan = r.plan(state, "Who is this?", out("question", reply="This is Thaara."))
    assert kinds(plan) == [("reply", "This is Thaara."), ("statement", WHO), ("question", PERMISSION)]


def test_a_stage_is_entered_only_when_its_first_line_was_heard():
    r = runner()
    state = at("intro")
    plan = r.plan(state, "Okay.", out("agreed", next_="discover", reply="Thank you.", captured={"custom_permission": "yes"}))
    cut = r.commit(state, plan, heard=1)  # the reply was heard, the business question was not
    assert cut.stage == "intro" and cut.collected["custom_permission"]["value"] == "yes"  # the answer is kept
    full = r.commit(state, plan)
    assert full.stage == "discover" and full.completed == ["intro"] and full.asked == {"business_type": 1}


def test_a_cut_off_closing_does_not_end_the_call_but_do_not_call_always_does():
    r = runner()
    plan = r.plan(at("discover"), "I'm busy.", out("busy"))
    assert not r.commit(at("discover"), plan, heard=0).ended
    dnc = r.plan(at("discover"), "Never call me again.", out("answered"))
    ended = r.commit(at("discover"), dnc, heard=0)
    assert ended.ended and ended.outcome == "do_not_call"


# ------------------------------------------------------------------ safety, refusals
@pytest.mark.parametrize("intent, closing, text", [
    ("not_interested", "not_interested", "Okay, no problem. Thank you so much for your time. Have a nice day."),
    ("busy", "busy", "No problem. Thanks for your time. Have a nice day."),
    ("end_request", "end_request", "Sure, thank you for your time. Have a nice day."),
])
def test_refusals_close_with_the_exact_line(intent, closing, text):
    plan = runner().plan(at("discover"), "...", out(intent, next_="stay", reply="But wait, one more thing!"))
    assert kinds(plan) == [("closing", text)] and plan.closing == closing


def test_do_not_call_detected_in_code_overrides_the_llm():
    plan = runner().plan(at("relate"), "Never call me again.", out("interested", next_="close:interested", reply="Great!"))
    assert plan.status == "safety" and kinds(plan) == [("closing", "Understood. I respect your request. Thank you.")]


def test_do_not_call_from_the_llm_also_ends_the_call():
    plan = runner().plan(at("discover"), "Remove me.", out("do_not_call", reply="Sure, but first..."))
    assert plan.closing == "do_not_call" and plan.forced == (("close", "do_not_call"),)


def test_the_ai_question_gets_the_exact_disclosure_then_the_flow_goes_on():
    plan = runner().plan(at("discover"), "Am I talking to a robot?", out("question", reply="No, I'm Thaara, a person."))
    assert plan.status == "safety"
    assert kinds(plan) == [("disclosure", "I'm an AI assistant calling on behalf of Kexo AI and Automation."), ("question", BUSINESS_Q)]


def test_the_ai_question_from_the_llm_is_handled_the_same_way():
    plan = runner().plan(at("discover"), "Are you real?", out("ai_question", reply="Yes."))
    assert plan.segments[0].kind == "disclosure" and "Yes." not in plan.text


# ------------------------------------------------------------------ malformed decisions
@pytest.mark.parametrize("model, problem", [
    (None, "missing_decision"), ("", "missing_decision"),
    ("Sure, our plan is Rs 5000.", "malformed_decision"),
    ('["answered"]\nOkay.', "malformed_decision"),
    ('{"intent": "happy", "next": "stay"}\nOkay.', "invalid_intent"),
    ('{"intent": "answered", "next": "Relate!"}\nOkay.', "invalid_next"),
    ('{"intent": "answered", "captured": ["hotel"]}\nOkay.', "invalid_captured"),
    ('{"intent": "answered", "asks": 5}\nOkay.', "invalid_asks"),
])
def test_a_bad_decision_never_lets_the_llm_text_through(model, problem):
    r = runner()
    plan = r.plan(at("discover"), "We run a hotel.", model)
    assert plan.status == "recovered" and plan.issues == [problem] and plan.invalid
    assert kinds(plan) == [("question", BUSINESS_Q)] and "5000" not in plan.text
    after = r.commit(at("discover"), plan)
    assert after.collected == {} and after.invalid_streak == 1 and after.intents[-1]["status"] == "recovered"


def test_markup_in_the_reply_is_never_spoken():
    plan = runner().plan(at("discover"), "Hotel.", out("answered", reply="Okay [[END_CALL]]"))
    assert plan.status == "recovered" and "reply_markup" in plan.issues and "END_CALL" not in plan.text


def test_the_decision_line_may_carry_a_label():
    decision, reply, problem = parse_model_output('DECISION: {"intent": "agreed", "next": "discover"}\nThank you.')
    assert problem is None and decision.intent == "agreed" and reply == "Thank you." and "First line" in DECISION_FORMAT


def test_no_words_is_fine_when_the_systems_own_lines_follow():
    plan = runner().plan(at("discover"), "Yes, speaking.", json.dumps({"intent": "answered", "next": "stay"}))
    assert plan.status == "accepted" and kinds(plan) == [("question", BUSINESS_Q)]


def test_no_words_and_nothing_to_say_falls_back_safely():
    state = at("relate", {"interest_level": "maybe"})  # nothing pending, no statement left
    plan = runner().plan(state, "Hmm.", json.dumps({"intent": "answered", "next": "stay"}))
    assert plan.status == "recovered" and "empty_reply" in plan.issues
    assert runner().plan(at("discover"), "Hmm.", json.dumps({"intent": "answered", "asks": "current_process"})).status == "recovered"


def test_another_stage_only_once_this_one_is_complete():
    r = runner()
    unsaid = at("intro", {"custom_permission": "yes"}, said=[])  # the intro statement was never heard
    plan = r.plan(unsaid, "Yes.", out("agreed", next_="discover"))
    assert plan.status == "recovered" and "stage_incomplete" in plan.issues
    assert kinds(plan) == [("statement", WHO)]
    no_answer = r.plan(at("intro"), "Sure.", out("agreed", next_="discover"))  # permission not captured
    assert "stage_incomplete" in no_answer.issues and kinds(no_answer) == [("question", PERMISSION)]
    assert r.plan(at("intro"), "Busy.", out("busy")).closing == "busy"  # closings stay open


def test_a_decision_in_a_code_block_is_read():
    decision, reply, problem = parse_model_output('```json\n{"intent": "agreed", "next": "stay"}\n```\nThank you.')
    assert problem is None and decision.intent == "agreed" and reply == "Thank you."


def test_the_prompt_state_lists_what_the_system_says_next():
    p = runner().prompt_state(at("intro", said=[]))
    assert p["system_says_after_your_words"] == [WHO, PERMISSION]


# ------------------------------------------------------------------ retries
def test_one_clarification_then_the_no_response_closing():
    r = runner()
    state = at("discover")
    first = r.plan(state, "the...", out("unclear", reply="Sorry, could you say that again?"))
    assert kinds(first) == [("reply", "Sorry, could you say that again?")] and first.retry_stage == "discover"
    state = r.commit(state, first)
    second = r.plan(state, "...", out("unclear"))
    assert second.closing == "no_response" and "retry_limit" in second.issues


def test_a_clear_answer_resets_the_retry_count():
    r = runner()
    state = r.commit(at("discover"), r.plan(at("discover"), "the...", out("unclear")))
    state = r.commit(state, r.plan(state, "A hotel.", out("answered", captured={"business_type": "hotel"}, asks="current_process",
                                                       reply="How do you handle reports today?")))
    assert state.retries["discover"] == 0
    assert r.plan(state, "the...", out("unclear")).closing is None


def test_a_configured_clarification_line_is_exact_and_retry_then_is_used():
    raw = json.loads(json.dumps(RAW))
    raw["stages"][1]["retries"] = {"unclear": 0, "line": "Sorry, what kind of business is it?", "then": "close:end_request"}
    r = runner(flow=parse_guided_flow(raw))
    assert r.plan(at("discover"), "...", out("unclear")).closing == "end_request"
    raw["stages"][1]["retries"]["unclear"] = 1
    r = runner(flow=parse_guided_flow(raw))
    assert kinds(r.plan(at("discover"), "...", out("unclear", reply="Huh?"))) == [("clarify", "Sorry, what kind of business is it?")]


def test_unclear_without_a_usable_reply_uses_the_flows_clarify_line():
    plan = runner().plan(at("discover"), "...", out("unclear", next_="relate"))
    assert kinds(plan) == [("clarify", "Sorry, I didn't catch that. Could you say it again?")]


# ------------------------------------------------------------------ collected answers
def test_answers_are_checked_before_they_are_kept():
    r = runner()
    plan = r.plan(at("discover"), "Hotel, call me on 98765 43210.", out("answered", asks="current_process", reply="How?", captured={
        "business_type": "  hotel   with 40 rooms ", "budget": "1 lakh", "custom_permission": {"value": "x", "source": "guess"},
        "existing_software": {"value": "call 98765 43210", "source": "customer"}}))
    assert plan.captured["business_type"]["value"] == "hotel with 40 rooms"
    assert set(plan.captured) == {"business_type"}
    assert {"undeclared_field:budget", "invalid_value:custom_permission",
            "personal_data_dropped:existing_software"} <= set(plan.issues)  # a phone number is never kept


def test_answers_record_their_source_stage_and_question():
    r = runner()
    plan = r.plan(at("discover"), "We run a hotel, all billing is manual.", out("answered", asks="current_process", reply="How?", captured={
        "business_type": "hotel", "interest_level": {"value": "curious", "source": "inferred"}}))
    after = r.commit(at("discover"), plan)
    assert after.collected["business_type"] == {"value": "hotel", "source": "customer", "stage": "discover",
                                                 "question": BUSINESS_Q, "heard_in_stage": "discover", "turn": 1}
    assert after.collected["interest_level"]["source"] == "inferred" and after.collected["interest_level"]["stage"] == "relate"


def test_an_inferred_value_never_replaces_what_the_customer_said():
    r = runner()
    state = at("discover", {"business_type": "hotel"})
    plan = r.plan(state, "...", out("answered", asks="current_process", reply="How?",
                                    captured={"business_type": {"value": "restaurant", "source": "inferred"}}))
    assert "kept_customer_value:business_type" in plan.issues and r.commit(state, plan).collected["business_type"]["value"] == "hotel"


def test_unknown_answers_stay_null_and_outcome_fields_wait_for_the_end():
    r = runner()
    answers = r.answers(at("discover", {"business_type": "hotel"}))
    assert answers["business_type"]["value"] == "hotel" and answers["requirements"] is None
    assert answers["meeting_requested"] is None and answers["call_outcome"] is None
    ended = r.commit(at("relate"), r.plan(at("relate"), "Can your team meet us?", out("meeting_request", next_="close:meeting")))
    assert r.answers(ended)["meeting_requested"] is True and r.answers(ended)["call_outcome"] == "meeting_requested"


# ------------------------------------------------------------------ team follow-up, end, state
def test_the_team_line_is_said_only_with_team_follow_up_on():
    plan_off = runner().plan(at("relate"), "Yes.", out("interested"))
    plan_on = runner(team_followup=True).plan(at("relate"), "Yes.", out("interested"))
    assert "Our team will get in touch with you." not in plan_off.text
    assert plan_on.text.endswith("Our team will get in touch with you.")


def test_an_ended_call_plans_nothing():
    r = runner()
    ended = r.commit(at("discover"), r.plan(at("discover"), "Busy.", out("busy")))
    plan = r.plan(ended, "Hello?", out("answered"))
    assert plan.status == "ended" and plan.segments == [] and r.commit(ended, plan).to_dict() == ended.to_dict()


def test_state_survives_between_turns_and_plan_never_changes_it():
    r = runner()
    state = r.commit(r.initial_state(), r.opening(r.initial_state()))
    state = r.commit(state, r.plan(state, "Yes.", out("agreed", next_="discover", captured={"custom_permission": "yes"})))
    before = state.to_dict()
    restored = RunnerState.from_dict(json.loads(json.dumps(before)))  # e.g. saved as a call event, read back
    plan_live = r.plan(state, "Hotel.", out("answered", captured={"business_type": "hotel"}, asks="current_process", reply="How?"))
    plan_restored = r.plan(restored, "Hotel.", out("answered", captured={"business_type": "hotel"}, asks="current_process", reply="How?"))
    assert state.to_dict() == before  # planning is read-only
    assert kinds(plan_live) == kinds(plan_restored) and plan_live.captured == plan_restored.captured
    after = r.commit(restored, plan_restored)
    assert after.stage == "discover" and after.completed == ["intro"] and after.turn == 2
    assert [i["intent"] for i in after.intents] == ["agreed", "answered"]


def test_the_prompt_state_shows_the_position():
    p = runner().prompt_state(at("discover", {"business_type": "hotel"}))
    assert p["stage"] == "discover" and [f["field"] for f in p["pending_required"]] == ["current_process"]
    assert p["collected"] == {"business_type": "hotel"} and "relate" in p["allowed_next"]
    assert p["knowledge_topics"] == ["about_us", "price", "savings", "staff"]


def test_default_safety_uses_the_live_call_detectors():
    s = default_safety()
    assert s.do_not_call("Please don't call me again.") and not s.do_not_call("Don't call now, call me in the evening.")
    assert s.ai_question("Am I talking to a robot?") and not s.ai_question("We run a hotel.")
