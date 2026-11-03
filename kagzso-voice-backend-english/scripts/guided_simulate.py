"""Print a guided conversation, text only: mocked customer turns and mocked LLM outputs through the real runner.

No provider, no call, no database. Run it from kagzso-voice-backend-english:

    .venv/bin/python scripts/guided_simulate.py tests/fixtures/guided/conversations/hotel_happy_path.json
    .venv/bin/python scripts/guided_simulate.py <conversation.json> --flow <guided-flow.json> --state
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.flows.simulator import simulate_file  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("conversation")
    ap.add_argument("--flow", default=None, help="guided flow JSON (default: the conversation's example flow)")
    ap.add_argument("--state", action="store_true", help="also print the final runner state")
    a = ap.parse_args()
    result = simulate_file(a.conversation, a.flow)
    print(result.transcript())
    print("\nanswers:", json.dumps({k: v and v["value"] if isinstance(v, dict) else v for k, v in result.answers.items()},
                                   ensure_ascii=False, indent=1))
    if a.state:
        print("\nstate:", json.dumps(result.final.to_dict(), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
