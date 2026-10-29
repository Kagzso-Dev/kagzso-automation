"""Model bake-off: the same fixed Tamil, Tanglish and English test turns through each candidate model.

Places no call and sends no audio or customer data: the turns are synthetic (customer "Ragul", male)
and the system prompt is the real Thaara flow prompt. It DOES call the LLM providers you list, so it
uses tokens. Run it from kagzso-voice-backend-english:

    .venv/bin/python scripts/llm_bakeoff.py --candidates sarvam:sarvam-105b-conversations,sarvam:sarvam-105b
    .venv/bin/python scripts/llm_bakeoff.py --candidates groq:<model>,gemini:<model> --runs 3
    .venv/bin/python scripts/llm_bakeoff.py --candidates ... --ollama-rate llama3.1:8b   (optional local rating)

Keys and base URLs: BAKEOFF_<PROVIDER>_API_KEY / BAKEOFF_<PROVIDER>_BASE_URL in the environment, else
LLM_API_KEY / LLM_BASE_URL when the provider is LLM_PROVIDER, else LLM_FALLBACK2_* when it is
LLM_FALLBACK2_PROVIDER. Keys are never printed.

Per model: first-token time (median / 90th percentile), full reply time, failures, and rule checks per
turn (exact key line, one question at most, short, no markdown, Tamil script, end-of-call marker,
no invented prices). The optional Ollama pass rates each reply 1-5 locally; it is off by default.
"""
from __future__ import annotations

import argparse
import asyncio
import difflib
import json
import os
import re
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
VARIABLES = {"customer_name": "Ragul", "gender": "male", "phone_number": "", "time_greeting": "Good morning"}
_TAMIL = re.compile(r"[஀-௿]")
_MARKDOWN = re.compile(r"[*#`]|^\s*[-•]\s", re.MULTILINE)
_PRICE = re.compile(r"₹|\brs\.?\s*\d|\brupees?\b|\d{3,}|ரூபாய்", re.IGNORECASE)
END = "[[END_CALL]]"


@dataclass
class Case:
    id: str
    language: str  # ta | en (which flow prompt)
    history: List[Dict[str, str]]
    said: str
    exact: Optional[str] = None  # the reply must be this line (similarity >= 0.9)
    end_call: Optional[bool] = None  # True: must end the call; False: must not
    contains: Tuple[str, ...] = ()  # one of these must appear (lower-case match)
    no_price: bool = False


@dataclass
class Result:
    first_ms: Optional[int] = None
    total_ms: Optional[int] = None
    reply: str = ""
    error: Optional[str] = None
    failed_checks: List[str] = field(default_factory=list)
    rating: Optional[int] = None


def _flow_lines() -> Dict[str, Dict[str, str]]:
    from app.services.llm_service import render_first_message
    from app.services.reply_speed import quoted_line

    out = {}
    for lang, name in (("ta", "thaara-tamil.json"), ("en", "thaara-natural.json")):
        flow = json.loads((ROOT / "deploy/callflows" / name).read_text(encoding="utf-8"))
        blocks = {b.get("id"): b.get("text", "") for b in flow["blocks"]}
        lines = {"greeting": render_first_message(flow["greeting"]["text"], VARIABLES)}
        if flow.get("identity"):
            lines["identity"] = render_first_message(flow["identity"]["question"], VARIABLES)
        for key, bid in (("permission", "permission"), ("intro", "company_intro")):
            line = quoted_line(blocks.get(bid, ""))
            if line:
                lines[key] = render_first_message(line, VARIABLES)
        out[lang] = lines
    return out


def cases() -> List[Case]:
    lines = _flow_lines()
    ta, en = lines["ta"], lines["en"]
    ta_open = [{"role": "assistant", "content": ta["greeting"]}, {"role": "user", "content": "Hello"},
               {"role": "assistant", "content": ta["identity"]}]
    ta_perm = ta_open + [{"role": "user", "content": "ஆமா"}, {"role": "assistant", "content": ta["permission"]}]
    ta_intro = ta_perm + [{"role": "user", "content": "சரி"}, {"role": "assistant", "content": ta["intro"]}]
    en_open = [{"role": "assistant", "content": en["greeting"]}]
    en_perm = en_open + [{"role": "user", "content": "Yes, speaking."}, {"role": "assistant", "content": en["permission"]}]
    return [
        Case("ta-identity-yes", "ta", ta_open, "ஆமா", exact=ta["permission"], end_call=False),
        Case("ta-permission-yes", "ta", ta_perm, "சரி, சொல்லுங்க", exact=ta["intro"], end_call=False),
        Case("ta-interest-yes", "ta", ta_intro, "ஆமா, useful-ஆ இருக்கும்", end_call=False),
        Case("tanglish-price", "ta", ta_intro, "Idhuku evlo cost aagum?", no_price=True, end_call=False),
        Case("tanglish-what", "ta", ta_perm, "Neenga enna company?", end_call=False),
        Case("ta-busy", "ta", ta_perm, "இப்போ busy-ஆ இருக்கேன்", end_call=True),
        Case("ta-dnc", "ta", ta_perm, "இனிமே call பண்ணாதீங்க", end_call=True),
        Case("ta-bot", "ta", ta_perm, "நீங்க robot-ஆ?", contains=("ai",)),
        Case("en-identity-yes", "en", en_open, "Yes, speaking.", exact=en["permission"], end_call=False),
        Case("en-what", "en", en_perm, "Sure. What does your company do?", end_call=False),
        Case("en-price", "en", en_perm, "How much does it cost?", no_price=True, end_call=False),
        Case("en-bot", "en", en_perm, "Wait, am I talking to a robot?", contains=("ai",)),
        Case("en-busy", "en", en_perm, "I'm busy right now.", end_call=True),
        Case("en-dnc", "en", en_perm, "Please don't call me again.", end_call=True),
    ]


def check(case: Case, reply: str) -> List[str]:
    """Rule checks on one reply; returns the names of the failed ones."""
    failed = []
    text = reply.replace(END, " ").strip()
    if not text:
        return ["empty"]
    if _MARKDOWN.search(text):
        failed.append("markdown")
    if text.count("?") > 1:
        failed.append("two_questions")
    if case.exact is None and len(re.findall(r"[.!?।]+(\s|$)", text)) > 3:
        failed.append("too_long")
    if case.language == "ta" and not _TAMIL.search(text):
        failed.append("no_tamil_script")
    if case.exact is not None:
        ratio = difflib.SequenceMatcher(None, " ".join(case.exact.split()), " ".join(text.split())).ratio()
        if ratio < 0.9:
            failed.append(f"not_exact({ratio:.2f})")
    if case.end_call is True and END not in reply:
        failed.append("no_end_call")
    if case.end_call is False and END in reply:
        failed.append("ended_call")
    if case.contains and not any(c in text.lower() for c in case.contains):
        failed.append("missing:" + "/".join(case.contains))
    if case.no_price and _PRICE.search(text):
        failed.append("price_claim")
    return failed


def _provider(spec: str):
    from app.services.llm_service import PROVIDERS

    name, _, model = spec.partition(":")
    name = name.strip().lower()
    if name not in PROVIDERS or not model:
        raise SystemExit(f"bad candidate {spec!r}: use provider:model with provider in {', '.join(PROVIDERS)}")
    up = name.upper()
    key = os.environ.get(f"BAKEOFF_{up}_API_KEY")
    base = os.environ.get(f"BAKEOFF_{up}_BASE_URL")
    if key is None and name == settings.LLM_PROVIDER.lower():
        key, base = settings.LLM_API_KEY.get_secret_value(), base or settings.LLM_BASE_URL
    if key is None and name == settings.LLM_FALLBACK2_PROVIDER.strip().lower():
        key, base = settings.LLM_FALLBACK2_API_KEY.get_secret_value(), base or settings.LLM_FALLBACK2_BASE_URL
    cfg = settings.model_copy(update={"LLM_PROVIDER": name, "LLM_MODEL": model, "LLM_API_KEY": key or "",
                                      "LLM_BASE_URL": base or "", "LLM_FALLBACK_MODEL": "", "LLM_TURN_MODEL": ""})
    return PROVIDERS[name](cfg)


def system_prompt(language: str) -> str:
    """The prompt a live call sends: the flow's blocks (locked text from code) plus the fixed rules."""
    from app.flows.schema import LOCKED_BLOCKS
    from app.services.llm_service import build_system_prompt

    name = "thaara-tamil.json" if language == "ta" else "thaara-natural.json"
    flow = json.loads((ROOT / "deploy/callflows" / name).read_text(encoding="utf-8"))
    body = "".join(LOCKED_BLOCKS[b["locked"]] if b.get("locked") else b.get("text", "") for b in flow["blocks"])
    return build_system_prompt(body, VARIABLES, language)


async def run_case(provider, case: Case, timeout: float) -> Result:
    from app.services.llm_service import LLMProvider, clean_spoken_text

    system = system_prompt(case.language)
    messages = LLMProvider._messages(case.history, case.said)
    r = Result()
    started = time.monotonic()
    parts: List[str] = []
    try:
        async def consume():
            async for delta in provider._stream(system, messages):
                if r.first_ms is None:
                    r.first_ms = int((time.monotonic() - started) * 1000)
                parts.append(delta)
        await asyncio.wait_for(consume(), timeout)
        r.total_ms = int((time.monotonic() - started) * 1000)
    except asyncio.TimeoutError:
        r.error = "timeout"
    except Exception as exc:  # LLMError and connection errors: counted, never fatal
        r.error = getattr(exc, "kind", type(exc).__name__)
    raw = "".join(parts)
    r.reply = clean_spoken_text(raw) + (f" {END}" if END in raw else "")
    if r.error is None:
        r.failed_checks = check(case, r.reply)
    return r


async def rate_locally(model: str, url: str, case: Case, reply: str) -> Optional[int]:
    """Optional: a local Ollama model rates the reply 1-5. Sends only the synthetic turn and the reply."""
    import httpx

    prompt = (f"A phone sales assistant was told: {case.said!r}. It replied: {reply!r}. Rate the reply from 1 (bad) to "
              f"5 (excellent) for being natural, polite, short and on-topic for a phone call. Answer with one digit.")
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            resp = await c.post(f"{url.rstrip('/')}/chat/completions",
                                json={"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0})
            text = resp.json()["choices"][0]["message"]["content"]
        m = re.search(r"[1-5]", text)
        return int(m.group(0)) if m else None
    except Exception:
        return None


def _p90(vals: List[int]) -> int:
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(round(0.9 * (len(vals) - 1))))]


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--candidates", required=True, help="comma-separated provider:model")
    ap.add_argument("--runs", type=int, default=2, help="times each turn is sent to each model")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--only", default="", help="comma-separated case ids (default: all)")
    ap.add_argument("--show-replies", action="store_true")
    ap.add_argument("--ollama-rate", default="", help="local Ollama model to rate replies (off by default)")
    ap.add_argument("--ollama-url", default="http://localhost:11434/v1")
    a = ap.parse_args()

    selected = [c for c in cases() if not a.only or c.id in a.only.split(",")]
    summary = []
    for spec in [s.strip() for s in a.candidates.split(",") if s.strip()]:
        provider = _provider(spec)
        firsts, totals, failures, checks_failed, ratings = [], [], 0, 0, []
        print(f"\n=== {spec}")
        for case in selected:
            for _ in range(a.runs):
                r = await run_case(provider, case, a.timeout)
                if r.error:
                    failures += 1
                    print(f"  {case.id:<20} ERROR {r.error}")
                    continue
                firsts.append(r.first_ms or 0)
                totals.append(r.total_ms or 0)
                checks_failed += bool(r.failed_checks)
                if a.ollama_rate:
                    r.rating = await rate_locally(a.ollama_rate, a.ollama_url, case, r.reply)
                    if r.rating:
                        ratings.append(r.rating)
                status = "ok" if not r.failed_checks else "FAIL " + ",".join(r.failed_checks)
                rating = f" rating={r.rating}" if r.rating else ""
                print(f"  {case.id:<20} first={r.first_ms:>5}ms total={r.total_ms:>5}ms {status}{rating}")
                if a.show_replies:
                    print(f"      {r.reply}")
        await provider.aclose()
        n = len(selected) * a.runs
        summary.append((spec, firsts, totals, failures, checks_failed, n, ratings))

    print("\nmodel                                    first-token med/p90   full med   failures   rule-fails   rating")
    for spec, firsts, totals, failures, checks_failed, n, ratings in summary:
        ft = f"{int(statistics.median(firsts))}/{_p90(firsts)}" if firsts else "-"
        tt = f"{int(statistics.median(totals))}" if totals else "-"
        rt = f"{statistics.mean(ratings):.1f}" if ratings else "-"
        print(f"{spec:<40} {ft:>18}ms {tt:>8}ms {failures:>5}/{n:<4} {checks_failed:>6}/{n:<4} {rt:>6}")


if __name__ == "__main__":
    asyncio.run(main())
