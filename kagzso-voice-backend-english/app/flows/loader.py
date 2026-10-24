"""Call flow loader: built-in flows, and turning a flow sent by Dispatch into an agent.

Each flow version becomes its own row in `agents` ("flow:<id>@v<n>"), so the rest
of the call path (prompt build, pre-rendered greeting, every LLM turn) is exactly
the one built-in agents use. Published versions are immutable: if a request sends
different content for a version that already has an agent row, the call falls back
to the requested default agent. Drafts (test calls only) are keyed by content hash.

A flow that is missing or fails validation never blocks a call: it falls back to the
agent Dispatch asked for (agent_id / agent_name), i.e. today's behaviour.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db import repositories as repo
from app.db.models import Agent
from app.flows.schema import BUILTIN_DIR, CallFlow, render_blocks

log = get_logger("flows")


def load_builtin(base: str) -> CallFlow:
    return CallFlow.model_validate_json((BUILTIN_DIR / f"{base}.json").read_text(encoding="utf-8"))


BUILTIN_FLOWS: Dict[str, CallFlow] = {base: load_builtin(base) for base in ("nila", "followup")}


class FlowError(Exception):
    def __init__(self, reason: str, errors: Optional[List[str]] = None):
        super().__init__(reason)
        self.reason = reason  # missing | invalid | version_conflict
        self.errors = errors or []


def validation_messages(exc: ValidationError, limit: int = 20) -> List[str]:
    out = []
    for e in exc.errors()[:limit]:
        loc = ".".join(str(p) for p in e.get("loc", ()) if p not in ("LockedBlock", "TextBlock"))
        out.append(f"{loc}: {e.get('msg')}" if loc else str(e.get("msg")))
    return out


def parse_flow(raw: Mapping[str, Any]) -> CallFlow:
    try:
        return CallFlow.model_validate(raw)
    except ValidationError as exc:
        raise FlowError("invalid", validation_messages(exc)) from None


def flow_hash(flow: CallFlow) -> str:
    data = flow.model_dump(mode="json")
    for optional in ("pauses", "recording_notice", "identity"):  # flows without them keep the hash they always had
        if data.get(optional) is None:
            data.pop(optional, None)
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def agent_name_for(flow_id: str, version: int, draft: bool, digest: str) -> str:
    return f"flow:{flow_id}@v{version}" + (f"-draft-{digest[:12]}" if draft else "")


def agent_fields(flow: CallFlow, name: str, version: int, digest: str) -> Dict[str, Any]:
    builtin = BUILTIN_FLOWS[flow.base]
    return {
        "name": name,
        "description": f"Call flow '{flow.name}' v{version} sha256:{digest}"[:500],
        "system_prompt": render_blocks(flow),
        "first_message": flow.greeting.text,
        "language": flow.language,
        "stt_provider": "sarvam",
        "llm_provider": "gemini",
        "tts_provider": "sarvam",
        "voice_id": flow.voice_id or builtin.voice_id,
        "active": True,
    }


_COMPARED = ("system_prompt", "first_message", "voice_id")


@dataclass
class ResolvedFlow:
    agent: Agent
    flow: CallFlow
    digest: str
    info: Dict[str, Optional[str]] = field(default_factory=dict)


async def resolve_flow_agent(
    db: AsyncSession, flow_id: str, version: int, draft: bool, raw: Optional[Mapping[str, Any]]
) -> ResolvedFlow:
    """The agent row for this flow version (created on first use). Raises FlowError."""
    if raw is None:
        raise FlowError("missing", ["no flow definition was sent"])
    flow = parse_flow(raw)
    digest = flow_hash(flow)
    name = agent_name_for(flow_id, version, draft, digest)
    wanted = agent_fields(flow, name, version, digest)
    agent = await repo.get_agent_by_name(db, name)
    if agent is None:
        agent = await repo.create_agent(db, **wanted)
        log.info("Flow agent created: %s", name)
    elif any(getattr(agent, k) != wanted[k] for k in _COMPARED):
        raise FlowError("version_conflict", [f"{name} already exists with different content (published versions are immutable)"])
    info: Dict[str, Optional[str]] = {
        "flow_id": flow_id,
        "flow_version": str(version),
        "flow_draft": "true" if draft else "false",
        "flow_hash": digest,
    }
    return ResolvedFlow(agent=agent, flow=flow, digest=digest, info=info)
