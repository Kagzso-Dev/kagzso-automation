"""Kagzso Voice Backend - FastAPI entry point.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api import agents, calls, dev_tests, flows, health, twilio_webhooks, voices, webhooks
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.db import repositories as repo
from app.db.database import dispose_engine, session_factory
from app.services.llm_service import BUILTIN_AGENTS, DEFAULT_AGENT
from app.websocket import plivo_stream, twilio_stream

configure_logging(settings.LOG_LEVEL, settings.secret_values())
log = get_logger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    problems = settings.validate_secrets()
    if problems:
        if settings.is_production:
            raise RuntimeError("Invalid production configuration: " + "; ".join(problems))
        for p in problems:
            log.warning("Config: %s", p)

    try:
        async with session_factory()() as db:
            agent = await repo.ensure_default_agent(db, DEFAULT_AGENT)
            log.info("Default agent ready: id=%s name=%s", agent.id, agent.name)
            for fields in BUILTIN_AGENTS:  # flow files in app/flows/builtin are the source of truth
                agent = await repo.upsert_agent_by_name(db, fields)
                log.info("Agent ready: id=%s name=%s", agent.id, agent.name)
    except Exception as exc:
        log.warning("Could not seed default agent (%s). Is MySQL up and have you run 'alembic upgrade head'?",
                    type(exc).__name__)

    log.info("%s started (env=%s, llm=%s)", settings.APP_NAME, settings.APP_ENV, settings.LLM_PROVIDER)
    yield

    from app.services import call_service

    if plivo_stream._CLOSING:  # let in-flight call teardowns finish writing to MySQL
        await asyncio.wait(set(plivo_stream._CLOSING), timeout=20)
    if call_service._providers is not None:
        await call_service._providers.aclose()
    await dispose_engine()


app = FastAPI(
    title=settings.APP_NAME,
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None,
    openapi_url=None if settings.is_production else "/openapi.json",
)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-API-Key"],
    )

app.include_router(health.router)
app.include_router(calls.router)
app.include_router(agents.router)
app.include_router(flows.router)
app.include_router(voices.router)
app.include_router(webhooks.router)
app.include_router(dev_tests.router)
app.include_router(plivo_stream.router)
app.include_router(twilio_webhooks.router)
app.include_router(twilio_stream.router)

# Operator dashboard (static, no build step). It calls the API with the X-API-Key
# the operator types in, so serving the files themselves needs no auth.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/ui", StaticFiles(directory=FRONTEND_DIR, html=True), name="ui")

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse("/ui/")
