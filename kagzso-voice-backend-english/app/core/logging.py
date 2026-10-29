"""Structured logging with a per-call correlation ID and secret redaction.

Every log line carries `[CALL <id>]` when emitted inside a call context:

    2026-10-06 10:00:00 INFO  [CALL 3f2a...] voice.pipeline: STT completed: 420ms

Secret values from settings are scrubbed from every message as a last line
of defence - code should still never log secrets in the first place.
"""
from __future__ import annotations

import contextvars
import logging
import sys
from contextlib import contextmanager
from typing import Iterable, Iterator, Optional

call_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("call_id", default="-")


def set_call_id(call_id: Optional[str]) -> contextvars.Token:
    return call_id_var.set(call_id or "-")


@contextmanager
def call_context(call_id: Optional[str]) -> Iterator[None]:
    token = set_call_id(call_id)
    try:
        yield
    finally:
        try:
            call_id_var.reset(token)
        except ValueError:  # generator closed from another context (task GC)
            call_id_var.set("-")


class CallContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "call_id"):
            record.call_id = call_id_var.get()
        return True


class RedactSecretsFilter(logging.Filter):
    def __init__(self, secrets: Iterable[str]):
        super().__init__()
        self._secrets = sorted({s for s in secrets if s}, key=len, reverse=True)

    def add(self, secret: str) -> None:
        if secret and len(secret) >= 4 and secret not in self._secrets:
            self._secrets = sorted({*self._secrets, secret}, key=len, reverse=True)

    def filter(self, record: logging.LogRecord) -> bool:
        if not self._secrets:
            return True
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover - malformed log args
            return True
        redacted = msg
        for s in self._secrets:
            if s in redacted:
                redacted = redacted.replace(s, "****")
        if redacted != msg:
            record.msg, record.args = redacted, None
        return True


def configure_logging(level: str = "INFO", secrets: Iterable[str] = ()) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-5s [CALL %(call_id)s] %(name)s: %(message)s")
    )
    handler.addFilter(CallContextFilter())
    handler.addFilter(RedactSecretsFilter(secrets))

    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # Uvicorn's access log includes query strings (which contain our signed
    # media-stream token); keep it at WARNING to avoid leaking it.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    for noisy in ("httpx", "httpcore", "websockets", "plivo", "urllib3", "aiomysql"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def redact_secret(secret: str) -> None:
    """Scrub a secret that is only known at runtime (an API key saved in the admin settings) from logs."""
    for handler in logging.getLogger().handlers:
        for f in handler.filters:
            if isinstance(f, RedactSecretsFilter):
                f.add(secret)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
