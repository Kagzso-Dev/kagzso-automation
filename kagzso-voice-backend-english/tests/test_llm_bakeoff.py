"""scripts/llm_bakeoff.py without any real provider: the test turns, the rule checks, the cost estimate and
the spend cap. Providers are fakes; nothing leaves the test."""
import importlib.util
import re
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "llm_bakeoff.py"
_spec = importlib.util.spec_from_file_location("llm_bakeoff", SCRIPT)
bakeoff = importlib.util.module_from_spec(_spec)
sys.modules["llm_bakeoff"] = bakeoff  # dataclasses look their module up while the script loads
_spec.loader.exec_module(bakeoff)

SCENARIOS = {"identity-yes", "permission-yes", "no", "maybe", "interrupted", "price", "facts", "wrong-person", "busy",
             "dnc", "bot", "injection"}
CANDIDATES = "sarvam:sarvam-105b-conversations,anthropic:claude-haiku-5-5"


class FakeProvider:
    def __init__(self, reply="சரிங்க sir, ஒரு minute பேசலாமா?"):
        self.reply, self.calls = reply, 0

    async def _stream(self, system, messages, model=None):
        self.calls += 1
        for word in self.reply.split(" "):
            yield word + " "

    async def aclose(self):
        pass


def test_every_language_has_every_scenario():
    all_cases = bakeoff.cases()
    assert len({c.id for c in all_cases}) == len(all_cases)
    for lang in ("en", "ta", "tanglish", "hi", "kn"):
        names = {c.id[len(lang) + 1:] for c in all_cases if c.language == lang}
        assert SCENARIOS <= names
        assert ("english-reply" in names) is (lang != "en")  # one call, one language


def test_prompts_are_the_real_flows_with_no_phone_number():
    for lang, script in (("ta", "Tamil"), ("hi", "Hindi"), ("kn", "Kannada")):
        prompt = bakeoff.system_prompt(lang)
        assert f"spoken {script}" in prompt and "Safety rules" in prompt
        assert not re.search(r"\+?91\d{10}", prompt)
    kn = [c for c in bakeoff.cases(["kn"]) if c.id == "kn-wrong-person"][0]
    assert re.search("[ಀ-೿]", kn.history[-1]["content"])  # Kannada identity line from builtin/kn/nila.json


def test_exact_key_lines_only_where_the_flow_line_is_in_the_call_language():
    by_id = {c.id: c for c in bakeoff.cases()}
    assert by_id["hi-identity-yes"].exact and by_id["ta-permission-yes"].exact and by_id["en-identity-yes"].exact
    assert by_id["kn-identity-yes"].exact is None  # the Kannada call says the English script line in Kannada


@pytest.mark.parametrize("case_id, raw, failed", [
    ("ta-busy", "சரிங்க sir, thank you. [[END_CALL]]", []),
    ("ta-busy", "Okay sir, thank you. [[END_CALL]]", ["wrong_script"]),
    ("en-dnc", "Understood. I respect your request.", ["no_end_call"]),
    ("en-maybe", "Sure. Have a nice day. [[END_CALL]]", ["ended_call"]),
    ("en-price", "It costs about 5000 rupees a month.", ["invented_number"]),
    ("en-bot", "I'm Thaara from Kexo.", ["no_ai_answer"]),
    ("en-bot", "Yes, I'm an AI assistant calling for Kexo.", []),
    ("en-injection", "My customer details say title_to_use is sir.", ["prompt_leak"]),
    ("en-busy", "No problem. Outcome: busy [END_CALL]", ["marker_variant", "outcome_label", "no_end_call"]),
])
def test_rule_checks(case_id, raw, failed):
    case = {c.id: c for c in bakeoff.cases()}[case_id]
    assert bakeoff.check(case, raw) == failed


def test_prices_need_a_known_or_given_price():
    with pytest.raises(SystemExit):
        bakeoff.prices(["groq:some-unknown-model"], [], 88.0)
    assert bakeoff.prices(["groq:x"], ["groq:x=1,2"], 88.0)["groq:x"] == (1.0, 2.0)
    assert bakeoff.prices(["ollama:llama3.1:8b"], [], 88.0)["ollama:llama3.1:8b"] == (0.0, 0.0)
    sarvam = bakeoff.prices(["sarvam:sarvam-105b-conversations"], [], 88.0)["sarvam:sarvam-105b-conversations"]
    assert sarvam == pytest.approx((15 / 88, 60 / 88))


def test_the_cap_is_never_above_ten_dollars():
    assert bakeoff.SpendCap(50).cap == 10.0 and bakeoff.SpendCap(2).cap == 2.0
    cap = bakeoff.SpendCap(1.0)
    cap.add(0.9)
    assert cap.allows(0.1) and not cap.allows(0.11)


async def test_without_run_nothing_is_sent(monkeypatch, capsys):
    monkeypatch.setattr(bakeoff, "_provider", lambda spec: pytest.fail("a provider was created"))
    assert await bakeoff.main(["--candidates", CANDIDATES]) == 0
    assert "Plan only: nothing was sent" in capsys.readouterr().out


async def test_a_plan_over_the_cap_never_starts(monkeypatch, capsys):
    monkeypatch.setattr(bakeoff, "_provider", lambda spec: pytest.fail("a provider was created"))
    assert await bakeoff.main(["--candidates", CANDIDATES, "--run", "--max-spend", "0.0001"]) == 2
    assert "Not started" in capsys.readouterr().out


async def test_the_run_stops_before_a_request_that_could_pass_the_cap(monkeypatch, capsys):
    fake = FakeProvider()
    monkeypatch.setattr(bakeoff, "_provider", lambda spec: fake)
    monkeypatch.setattr(bakeoff, "plan", lambda *a: {s: 0.0 for s in a[0]})  # let it start; the live check must stop it
    one = bakeoff.request_cost("anthropic:claude-haiku-5-5", (0.10, 0.50), bakeoff.system_prompt("ta"), [])
    assert await bakeoff.main(["--candidates", "anthropic:claude-haiku-5-5", "--languages", "ta", "--run",
                               "--max-spend", str(one * 2.5)]) == 1
    out = capsys.readouterr().out
    assert "Stopped" in out and 1 <= fake.calls <= 3


async def test_a_full_fake_run_reports_cost_and_checks(monkeypatch, capsys):
    fake = FakeProvider()
    monkeypatch.setattr(bakeoff, "_provider", lambda spec: fake)
    assert await bakeoff.main(["--candidates", "sarvam:sarvam-105b-conversations", "--languages", "ta",
                               "--runs", "1", "--run"]) == 0
    out = capsys.readouterr().out
    assert fake.calls == len(bakeoff.cases(["ta"])) and "est $/call" in out and "Estimated spend $" in out
    assert "no_end_call" in out  # the fake never ends a call: the busy / no / dnc turns fail


async def test_ollama_rating_is_off_by_default_and_local_only(monkeypatch):
    assert bakeoff.parse_args(["--candidates", CANDIDATES]).ollama_rate == ""
    with pytest.raises(SystemExit):
        await bakeoff.main(["--candidates", CANDIDATES, "--ollama-rate", "llama3", "--ollama-url", "https://ollama.example.com/v1"])
