"""Read-only latency report from call_latency_metrics (writes nothing, places no call).

    .venv/bin/python scripts/latency_report.py               last 20 calls that have timing rows
    .venv/bin/python scripts/latency_report.py --calls 50
    .venv/bin/python scripts/latency_report.py --call <id>   one call, turn by turn (e.g. your test call)

Per step: average, 90th percentile and worst, over AI-reply turns (reply_source = llm) and over
all turns. Steps that need migration 0005 (eos_wait, tts_wait, reply_delay) show "-" for older
calls. Prints numbers only - no transcript text, phone numbers or names.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import bindparam, create_engine, text  # noqa: E402

from app.core.config import settings  # noqa: E402

STEPS = [
    ("eos_wait_ms", "End-of-speech wait (VAD silence)"),
    ("stt_ms", "STT: speech end -> final text"),
    ("llm_first_token_ms", "LLM: first token"),
    ("llm_ms", "LLM: full reply"),
    ("tts_wait_ms", "TTS connection wait"),
    ("tts_first_byte_ms", "TTS: first audio"),
    ("total_response_ms", "Speech end detected -> audio"),
    ("reply_delay_ms", "Pause the customer hears"),
]


def stats(vals: list[int]) -> str:
    if not vals:
        return f"{'-':>6} {'-':>6} {'-':>6} {'0':>5}"
    vals = sorted(vals)
    p90 = vals[min(len(vals) - 1, int(round(0.9 * (len(vals) - 1))))]
    return f"{sum(vals) // len(vals):>6} {p90:>6} {vals[-1]:>6} {len(vals):>5}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--calls", type=int, default=20)
    ap.add_argument("--call", help="one call id, turn by turn")
    a = ap.parse_args()

    engine = create_engine(settings.database_url(sync=True))
    with engine.connect() as c:
        cols = {r[0] for r in c.execute(text("SELECT column_name FROM information_schema.columns "
                                              "WHERE table_schema = DATABASE() AND table_name = 'call_latency_metrics'"))}
        extra = [k for k in ("eos_wait_ms", "tts_wait_ms", "reply_delay_ms", "reply_source") if k in cols]
        select = ", ".join(["m.call_id", "m.turn_index", "m.stt_ms", "m.llm_ms", "m.llm_first_token_ms",
                            "m.tts_first_byte_ms", "m.total_response_ms", *[f"m.{k}" for k in extra]])
        if a.call:
            calls = [a.call]
        else:
            calls = [r[0] for r in c.execute(text(
                "SELECT call_id FROM call_latency_metrics GROUP BY call_id ORDER BY MAX(created_at) DESC LIMIT :n"),
                {"n": a.calls})]
        if not calls:
            print("No calls with timing rows yet.")
            return
        rows = [dict(r._mapping) for r in c.execute(
            text(f"SELECT {select} FROM call_latency_metrics m WHERE m.call_id IN :ids ORDER BY m.call_id, m.turn_index")
            .bindparams(bindparam("ids", expanding=True)), {"ids": calls})]

    if a.call:
        print(f"Call {a.call}: {len(rows)} turns")
        print("turn source       " + " ".join(f"{k.replace('_ms', ''):>12}" for k, _ in STEPS))
        for r in rows:
            print(f"{r['turn_index']:>4} {str(r.get('reply_source') or '-'):<12} "
                  + " ".join(f"{(r.get(k) if r.get(k) is not None else '-'):>12}" for k, _ in STEPS))
        print()

    llm = [r for r in rows if r.get("reply_source") == "llm"]
    print(f"{len(calls)} call(s), {len(rows)} turns ({len(llm)} AI replies"
          f"{'' if 'reply_source' in extra else '; reply source not recorded before migration 0005'})\n")
    for title, subset in (("AI-reply turns (LLM)", llm), ("All turns", rows)):
        if not subset:
            continue
        print(f"{title:<36} {'avg':>6} {'p90':>6} {'worst':>6} {'n':>5}   (ms)")
        for key, label in STEPS:
            print(f"  {label:<34} {stats([r[key] for r in subset if r.get(key) is not None])}")
        print()


if __name__ == "__main__":
    main()
