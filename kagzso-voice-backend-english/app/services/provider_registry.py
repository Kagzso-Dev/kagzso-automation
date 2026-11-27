"""AI provider settings from the admin page (Dispatch -> AI providers), for this voice backend's language.

Each language runs its own voice backend with its own database, so each language has its own
settings. Nothing changes for calls until an admin switches "Use for live calls" on: until then -
and whenever the saved settings can't be read - every call uses the .env providers exactly as before.

* LLM: Groq, Sarvam, Anthropic and Google Gemini in the admin's fallback order (ChainLLMProvider). Only providers
  that are enabled and have a key are used; a key is the one saved on the page (encrypted, see
  provider_secrets) or, for the provider .env already uses, the .env key. No usable provider = the
  .env LLM.
* STT (Sarvam Saaras) and TTS (Sarvam Bulbul) are chosen independently of the LLM. Enabled = use
  these model / key / speaker settings instead of .env; the .env speech setup stays the fallback.
  Groq has no speech-to-text integration here, so none is offered.
* In production only speech models known to work (saaras:v3, bulbul:v3, plus VERIFIED_SPEECH_MODELS)
  can be selected; the others are refused when saved and ignored by calls.
* Every call takes one snapshot when it starts and keeps it to the end (concurrent calls never see
  each other's change); a saved change applies to the calls that start after it.
"""
from __future__ import annotations

import asyncio
import io
import re
import time
import wave
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

import httpx
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, settings as default_settings
from app.core.logging import call_id_var, get_logger, redact_secret
from app.core.voices import VOICE_IDS, voice_gender
from app.db.database import session_factory
from app.db.models import AiProviderAudit, AiProviderSelection, AiProviderSetting, utcnow
from app.services import provider_secrets as secrets
from app.services.llm_service import PROVIDERS, ChainLLMProvider, LLMError, LLMProvider
from app.services.sarvam_stt import SarvamSTT, STTError
from app.services.sarvam_tts import SarvamTTS
from app.services.tts import TTSError, TTSProvider, TTSStream

log = get_logger("providers")


# ------------------------------------------------------------------ catalogue
@dataclass(frozen=True)
class ProviderSpec:
    id: str
    kind: str  # llm | stt | tts
    label: str
    provider: str  # llm_service.PROVIDERS name, or "sarvam" for speech
    models: Tuple[str, ...]  # suggestions shown on the page (LLM: any model id may be typed)
    priority: int = 0


CATALOG: Dict[str, ProviderSpec] = {s.id: s for s in (
    ProviderSpec("groq_llm", "llm", "Groq", "groq", ("openai/gpt-oss-120b", "openai/gpt-oss-20b"), 1),
    ProviderSpec("sarvam_llm", "llm", "Sarvam AI", "sarvam", ("sarvam-105b-conversations", "sarvam-105b"), 2),
    ProviderSpec("anthropic_llm", "llm", "Anthropic Claude", "anthropic",
                 ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"), 3),
    ProviderSpec("gemini_llm", "llm", "Google Gemini", "gemini",
                 ("gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash"), 4),
    ProviderSpec("sarvam_stt", "stt", "Sarvam speech-to-text", "sarvam", ("saaras:v3", "saaras:v4")),
    ProviderSpec("sarvam_tts", "tts", "Sarvam text-to-speech", "sarvam", ("bulbul:v3", "bulbul:v4-flash")),
)}
LLM_IDS = tuple(pid for pid, s in CATALOG.items() if s.kind == "llm")
# The model of an LLM entry saved without one (entries saved before ANTHROPIC_DEFAULT_MODEL keep this).
DEFAULT_LLM_MODELS = {"sarvam_llm": "sarvam-105b-conversations", "anthropic_llm": "claude-opus-5-5",
                      "gemini_llm": "gemini-3.6-flash"}
PROVEN_SPEECH_MODELS = frozenset({"saaras:v3", "bulbul:v3"})
STT_MODES = ("transcribe", "codemix", "verbatim", "translit")  # saaras:v3 only; "translate" would change the language

_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$")
_PERSONA_RE = re.compile(r"^[a-z]+(?:_[a-z0-9]+){1,3}$")  # bulbul:v4-flash: <name>_<language>_<style>
_ACTOR_RE = re.compile(r"[^\w.@+\- ]")


class ProviderSettingsError(Exception):
    def __init__(self, status: int, message: str, code: str = "invalid"):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code


def speech_model_allowed(model: str, cfg: Settings = default_settings) -> bool:
    if model in PROVEN_SPEECH_MODELS or not cfg.is_production:
        return True
    return model in {m.strip() for m in cfg.VERIFIED_SPEECH_MODELS.split(",") if m.strip()}


def clean_actor(actor: Optional[str]) -> Optional[str]:
    """The admin's e-mail as sent by Dispatch, for the audit log only (no control characters)."""
    return _ACTOR_RE.sub("", actor or "")[:120] or None


# ------------------------------------------------------------------ keys
def env_key(pid: str, cfg: Settings) -> Optional[str]:
    """The .env key a provider already has (bootstrap), or None."""
    spec = CATALOG[pid]
    llm_env = cfg.LLM_PROVIDER.strip().lower()
    if spec.kind == "llm":
        if llm_env == spec.provider and cfg.LLM_API_KEY.get_secret_value():
            return cfg.LLM_API_KEY.get_secret_value()
        if cfg.LLM_FALLBACK2_PROVIDER.strip().lower() == spec.provider and cfg.LLM_FALLBACK2_API_KEY.get_secret_value():
            return cfg.LLM_FALLBACK2_API_KEY.get_secret_value()
        if pid != "sarvam_llm":
            return None
    return cfg.SARVAM_API_KEY.get_secret_value() or None  # one Sarvam subscription key for LLM, STT and TTS


def key_for(row: Optional[AiProviderSetting], pid: str, cfg: Settings) -> Tuple[Optional[str], str]:
    """(key, source): source = saved | environment | none | unreadable. The key never leaves the server."""
    if row is not None and row.encrypted_key:
        try:
            key = secrets.decrypt(row.encrypted_key, pid, cfg)
        except secrets.SecretsError:
            return None, "unreadable"
        redact_secret(key)
        return key, "saved"
    key = env_key(pid, cfg)
    return (key, "environment") if key else (None, "none")


def default_model(pid: str, cfg: Settings) -> Optional[str]:
    spec = CATALOG[pid]
    if spec.kind == "stt":
        return cfg.SARVAM_STT_MODEL
    if spec.kind == "tts":
        return cfg.SARVAM_TTS_MODEL
    if cfg.LLM_PROVIDER.strip().lower() == spec.provider and cfg.LLM_MODEL:
        return cfg.LLM_MODEL  # e.g. the Groq / Sarvam model .env already uses
    return DEFAULT_LLM_MODELS.get(pid)


def new_entry_model(pid: str, cfg: Settings) -> Optional[str]:
    """The model an LLM entry that is not saved yet starts with: as default_model, except that a new
    Anthropic entry gets ANTHROPIC_DEFAULT_MODEL (stored when the entry is created, see _start_row)."""
    if pid == "anthropic_llm" and cfg.LLM_PROVIDER.strip().lower() != "anthropic":
        return cfg.ANTHROPIC_DEFAULT_MODEL.strip() or default_model(pid, cfg)
    return default_model(pid, cfg)


def _start_row(pid: str, cfg: Settings) -> AiProviderSetting:
    """A new settings row. A new Anthropic entry stores its starting model, so a later change of the
    default never changes it; other entries keep following .env / DEFAULT_LLM_MODELS as before."""
    row = AiProviderSetting(id=pid, enabled=False, updated_at=utcnow())
    model = new_entry_model(pid, cfg)
    if pid == "anthropic_llm" and model and model != default_model(pid, cfg):
        row.model = model
    return row


# ------------------------------------------------------------------ reading
async def _rows(db: AsyncSession) -> Dict[str, AiProviderSetting]:
    return {r.id: r for r in (await db.execute(select(AiProviderSetting))).scalars().all() if r.id in CATALOG}


async def _selection(db: AsyncSession) -> AiProviderSelection:
    sel = await db.get(AiProviderSelection, 1)
    if sel is None:
        sel = AiProviderSelection(id=1, live=False, updated_at=utcnow())
        db.add(sel)
    return sel


def llm_order(rows: Dict[str, AiProviderSetting]) -> List[str]:
    def prio(pid: str) -> Tuple[int, int]:
        row = rows.get(pid)
        return (row.priority if row is not None and row.priority else CATALOG[pid].priority, CATALOG[pid].priority)

    return sorted(LLM_IDS, key=prio)


def usable_llm(rows: Dict[str, AiProviderSetting], cfg: Settings) -> List[str]:
    return [pid for pid in llm_order(rows) if rows.get(pid) is not None and rows[pid].enabled
            and key_for(rows[pid], pid, cfg)[0]]


def _status(row: Optional[AiProviderSetting], has_key: bool) -> str:
    if row is None or not row.enabled:
        return "disabled"
    if not has_key:
        return "missing_key"
    return "error" if row.last_test_status == "error" else "configured"


def _view(pid: str, row: Optional[AiProviderSetting], cfg: Settings) -> Dict[str, Any]:
    spec = CATALOG[pid]
    key, source = key_for(row, pid, cfg)
    model = (row.model if row is not None and row.model else None) or (
        new_entry_model(pid, cfg) if row is None else default_model(pid, cfg))
    return {
        "id": pid, "kind": spec.kind, "label": spec.label, "provider": spec.provider,
        "enabled": bool(row is not None and row.enabled),
        "model": model, "models": list(spec.models),
        "options": dict(row.options or {}) if row is not None else {},
        "key_configured": key is not None, "key_source": source,
        "needs_reencrypt": bool(row is not None and row.encrypted_key and secrets.needs_reencrypt(row.encrypted_key, cfg)),
        "priority": (row.priority if row is not None and row.priority else spec.priority) if spec.kind == "llm" else None,
        "status": _status(row, key is not None),
        "untested_model": spec.kind != "llm" and bool(model) and model not in PROVEN_SPEECH_MODELS,
        "model_allowed": spec.kind == "llm" or not model or speech_model_allowed(model, cfg),
        "last_test": None if row is None or row.last_test_at is None else {
            "status": row.last_test_status, "message": row.last_test_message,
            "at": row.last_test_at.isoformat() + "Z"},
    }


async def settings_view(db: AsyncSession, cfg: Settings = default_settings) -> Dict[str, Any]:
    rows = await _rows(db)
    sel = await db.get(AiProviderSelection, 1)
    live = bool(sel is not None and sel.live)
    usable = usable_llm(rows, cfg)
    warnings: List[str] = []
    env_llm = f"{cfg.LLM_PROVIDER}:{cfg.LLM_MODEL}" if cfg.LLM_MODEL else cfg.LLM_PROVIDER
    if not usable:
        warnings.append(f"No LLM provider is enabled with a key: live calls use the server's .env LLM ({env_llm}).")
    secrets_problem = secrets.ready(cfg)
    if secrets_problem:
        warnings.append(f"API keys can't be saved: {secrets_problem}. Add it to this voice backend's .env and restart it.")
    for pid in ("sarvam_stt", "sarvam_tts"):
        v = _view(pid, rows.get(pid), cfg)
        if v["enabled"] and not v["model_allowed"]:
            warnings.append(f"{v['label']}: {v['model']} is not verified for production - calls use the .env speech settings.")
    return {
        "language": cfg.call_language, "live": live,
        "secrets_ready": secrets_problem is None,
        "env_llm": env_llm,
        "llm_order": llm_order(rows), "usable_llm": usable,
        "providers": [_view(pid, rows.get(pid), cfg) for pid in CATALOG],
        "stt_providers": ["sarvam_stt"],  # Groq speech-to-text is not integrated in this project
        "warnings": warnings,
    }


# ------------------------------------------------------------------ changes
def _audit(db: AsyncSession, actor: Optional[str], action: str, provider: Optional[str], detail: Optional[dict]) -> None:
    db.add(AiProviderAudit(actor=clean_actor(actor), action=action, provider=provider, detail=detail, created_at=utcnow()))


def _validate_model(spec: ProviderSpec, model: str, cfg: Settings) -> None:
    if spec.kind == "llm":
        if not _MODEL_RE.match(model):
            raise ProviderSettingsError(422, "Model ID may contain letters, digits and . _ : / - only (max 100)")
        return
    if model not in spec.models:
        raise ProviderSettingsError(422, f"Choose one of: {', '.join(spec.models)}")
    if not speech_model_allowed(model, cfg):
        raise ProviderSettingsError(
            422, f"{model} is not verified for production calls yet. Benchmark it first, then add it to "
                 "VERIFIED_SPEECH_MODELS on this voice backend.", "unverified_model")


def _validate_options(spec: ProviderSpec, model: str, options: Dict[str, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for name, value in options.items():
        value = str(value or "").strip()
        if spec.kind == "stt" and name == "mode":
            if value and value not in STT_MODES:
                raise ProviderSettingsError(422, f"Mode must be one of: {', '.join(STT_MODES)}")
        elif spec.kind == "tts" and name == "speaker":
            if model == "bulbul:v4-flash":
                if not _PERSONA_RE.match(value):
                    raise ProviderSettingsError(
                        422, "bulbul:v4-flash needs a persona voice id like name_language_style "
                             "(bulbul:v3 names such as roopa don't work with it)")
            elif value and value not in VOICE_IDS:
                raise ProviderSettingsError(422, f"Choose one of this backend's voices: {', '.join(VOICE_IDS)}")
        else:
            raise ProviderSettingsError(422, f"Unknown option: {name[:40]}")
        if value:
            out[name] = value
    if spec.kind == "tts" and model == "bulbul:v4-flash" and "speaker" not in out:
        raise ProviderSettingsError(422, "bulbul:v4-flash needs a persona voice id")
    return out


def _validate_key(key: str) -> str:
    key = key.strip()
    if not 8 <= len(key) <= 512 or any(c.isspace() for c in key) or not key.isprintable():
        raise ProviderSettingsError(422, "That doesn't look like an API key (8-512 characters, no spaces)")
    return key


async def update_provider(db: AsyncSession, pid: str, change: Dict[str, Any], actor: Optional[str],
                          cfg: Settings = default_settings) -> Dict[str, Any]:
    spec = CATALOG.get(pid)
    if spec is None:
        raise ProviderSettingsError(404, "Unknown provider", "not_found")
    rows = await _rows(db)
    usable_before = usable_llm(rows, cfg) if spec.kind == "llm" else []
    row = rows.get(pid) or _start_row(pid, cfg)
    fields: List[str] = []
    detail: Dict[str, Any] = {}

    model = (change.get("model") or "").strip() if change.get("model") is not None else None
    if model is not None and model != (row.model or ""):
        _validate_model(spec, model, cfg)
        row.model, fields = model, fields + ["model"]
    if "options" in change and change["options"] is not None:
        options = _validate_options(spec, row.model or default_model(pid, cfg) or "", change["options"])
        if options != (row.options or {}):
            row.options, fields = options or None, fields + ["options"]
    elif spec.kind == "tts" and model is not None:  # a new model: the saved speaker must suit it
        _validate_options(spec, model, row.options or {})

    key = change.get("api_key")
    if change.get("remove_key"):
        if row.encrypted_key:
            row.encrypted_key, row.key_updated_at = None, utcnow()
            row.last_test_status = row.last_test_message = row.last_test_at = None
            detail["key"] = "removed"
    elif key:  # an empty field never erases a saved key
        key = _validate_key(key)
        try:
            row.encrypted_key = secrets.encrypt(key, pid, cfg)
        except secrets.SecretsError as exc:
            raise ProviderSettingsError(503, f"Keys can't be saved: {exc}", "secrets_not_configured") from None
        redact_secret(key)
        row.key_updated_at = utcnow()
        row.last_test_status = row.last_test_message = row.last_test_at = None
        detail["key"] = "replaced"

    if change.get("enabled") is not None and bool(change["enabled"]) != bool(row.enabled):
        row.enabled, fields = bool(change["enabled"]), fields + ["enabled"]

    if spec.kind == "llm":
        sel = await db.get(AiProviderSelection, 1)
        after = dict(rows, **{pid: row})
        if sel is not None and sel.live and usable_before and not usable_llm(after, cfg) and not change.get("confirm"):
            raise ProviderSettingsError(
                409, "This leaves no usable LLM provider: live calls would use the server's .env LLM. Confirm to continue.",
                "would_leave_no_llm")
    if not fields and not detail:
        return await settings_view(db, cfg)
    if pid not in rows:
        db.add(row)
        if row.model and "model" not in fields:
            fields.append("model")  # the new entry's starting model (ANTHROPIC_DEFAULT_MODEL), for the audit log
    row.updated_at = utcnow()
    if fields:
        detail["fields"] = fields
    _audit(db, actor, "provider_updated", pid, detail)
    await db.commit()
    invalidate()
    log.info("AI provider %s updated (%s)", pid, ", ".join(fields + ([f"key {detail['key']}"] if "key" in detail else [])))
    return await settings_view(db, cfg)


async def update_selection(db: AsyncSession, change: Dict[str, Any], actor: Optional[str],
                           cfg: Settings = default_settings) -> Dict[str, Any]:
    rows = await _rows(db)
    sel = await _selection(db)
    detail: Dict[str, Any] = {}
    order = change.get("llm_order")
    if order is not None:
        if sorted(order) != sorted(LLM_IDS):
            raise ProviderSettingsError(422, f"The LLM order must list each of {', '.join(LLM_IDS)} once")
        if list(order) != llm_order(rows):
            for i, pid in enumerate(order, start=1):
                row = rows.get(pid)
                if row is None:
                    row = rows[pid] = _start_row(pid, cfg)
                    db.add(row)
                row.priority, row.updated_at = i, utcnow()
            detail["llm_order"] = list(order)
    live = change.get("live")
    if live is not None and bool(live) != bool(sel.live):
        if live and not usable_llm(rows, cfg) and not change.get("confirm"):
            raise ProviderSettingsError(
                409, "No LLM provider is enabled with a key: live calls would keep using the server's .env LLM. "
                     "Confirm to switch on anyway.", "no_usable_llm")
        sel.live = bool(live)
        detail["live"] = sel.live
    if not detail:
        return await settings_view(db, cfg)
    sel.updated_at = utcnow()
    _audit(db, actor, "selection_updated", None, detail)
    await db.commit()
    invalidate()
    log.info("AI provider selection updated (%s)", ", ".join(detail))
    return await settings_view(db, cfg)


async def reencrypt_keys(db: AsyncSession, actor: Optional[str], cfg: Settings = default_settings) -> Dict[str, Any]:
    """Every saved key re-encrypted with the current PROVIDER_SECRETS_KEY (after a rotation)."""
    moved = []
    for pid, row in (await _rows(db)).items():
        if row.encrypted_key and secrets.needs_reencrypt(row.encrypted_key, cfg):
            try:
                row.encrypted_key = secrets.encrypt(secrets.decrypt(row.encrypted_key, pid, cfg), pid, cfg)
            except secrets.SecretsError as exc:
                raise ProviderSettingsError(503, f"Re-encryption failed for {pid}: {exc}", "secrets_error") from None
            moved.append(pid)
    if moved:
        _audit(db, actor, "keys_reencrypted", None, {"providers": moved})
        await db.commit()
        invalidate()
    return await settings_view(db, cfg)


# ------------------------------------------------------------------ building providers
_LLM_CLIENTS: Dict[str, httpx.AsyncClient] = {}


def _llm_client(name: str, cfg: Settings) -> httpx.AsyncClient:
    client = _LLM_CLIENTS.get(name)
    if client is None or client.is_closed:
        client = _LLM_CLIENTS[name] = httpx.AsyncClient(timeout=httpx.Timeout(cfg.LLM_TIMEOUT_SECONDS, connect=5.0),
                                                        limits=cfg.http_limits())
    return client


def build_llm(pid: str, model: str, key: str, cfg: Settings) -> LLMProvider:
    """One provider of the chain: its own model and key, none of .env's failover (the chain does that)."""
    name = CATALOG[pid].provider
    link_cfg = cfg.model_copy(update={
        "LLM_PROVIDER": name, "LLM_MODEL": model, "LLM_API_KEY": SecretStr(key), "LLM_BASE_URL": "",
        "LLM_FALLBACK_MODEL": "", "LLM_TURN_MODEL": "", "LLM_HEDGE_AFTER_SECONDS": 0.0, "LLM_FALLBACK2_PROVIDER": "",
    })
    return PROVIDERS[name](link_cfg, client=_llm_client(name, cfg))


def _speech_cfg(cfg: Settings, key: str, **update: Any) -> Settings:
    return cfg.model_copy(update={"SARVAM_API_KEY": SecretStr(key), **update})


def build_stt(row: AiProviderSetting, key: str, cfg: Settings, client: Optional[httpx.AsyncClient]) -> SarvamSTT:
    model = row.model or cfg.SARVAM_STT_MODEL
    update: Dict[str, Any] = {"SARVAM_STT_MODEL": model}
    if (row.options or {}).get("mode"):
        update["SARVAM_STT_MODE"] = row.options["mode"]
    # The .env model (today's working one) stays the fallback for a failed request.
    update["STT_FALLBACK_MODEL"] = cfg.SARVAM_STT_MODEL if cfg.SARVAM_STT_MODEL != model else cfg.STT_FALLBACK_MODEL
    return SarvamSTT(_speech_cfg(cfg, key, **update), client=client)


class FallbackTTS(TTSProvider):
    """A new TTS setup (e.g. bulbul:v4-flash) backed by the working one: a request that fails before
    any audio (wrong persona, no account access, timeout) is made again with the fallback. Never
    mid-stream: audio that already played is not repeated. Made per call (CallProviders.tts_for_voice,
    with_clone_fallback): once the fallback voice has spoken, the rest of that call keeps it, so the
    voice never flips between sentences. (sticky=False - each request trying the primary again - is
    no longer used by any call.)"""

    name = "fallback"

    def __init__(self, primary: TTSProvider, fallback: TTSProvider, sticky: bool = True):
        self.primary, self.fallback = primary, fallback
        self.sticky = sticky
        self._on_fallback = False

    def _fell_back(self, what: str, exc: TTSError) -> None:
        log.warning("VOICE FALLBACK (call %s): %s with voice %s failed (%s) - %s the voice %s", call_id_var.get(), what,
                    getattr(self.primary, "voice_id", "?"), exc.kind,
                    "the rest of this call speaks in" if self.sticky else "this line is said in",
                    getattr(self.fallback, "voice_id", "?"))
        self._on_fallback = self.sticky

    async def synthesize(self, text: str, pace: Optional[float] = None) -> bytes:
        if self._on_fallback:
            return await self.fallback.synthesize(text, pace=pace)
        try:
            return await self.primary.synthesize(text, pace=pace)
        except TTSError as exc:
            self._fell_back("one-shot synthesis", exc)
            return await self.fallback.synthesize(text, pace=pace)

    async def open_stream(self, pace: Optional[float] = None) -> TTSStream:
        if self._on_fallback:
            return await self.fallback.open_stream(pace=pace)
        try:
            return await self.primary.open_stream(pace=pace)
        except TTSError as exc:
            self._fell_back("opening the stream", exc)
            return await self.fallback.open_stream(pace=pace)

    async def synthesize_preview(self, text: str) -> bytes:
        try:
            return await self.primary.synthesize_preview(text)  # type: ignore[attr-defined]
        except TTSError:
            return await self.fallback.synthesize_preview(text)  # type: ignore[attr-defined]


class ClonedVoiceFallback(FallbackTTS):
    """One call's cloned voice (SARVAM_TTS_VOICE_<LANG>_*) backed by a stock voice of the same gender
    (SARVAM_TTS_FALLBACK_VOICE_*): a request the cloned voice fails before any audio is said again with the stock
    voice, and the rest of the call stays on it, so the customer hears at most one switch. Made per call
    (with_clone_fallback): one failed call never moves other calls off the cloned voice."""

    def __init__(self, primary: TTSProvider, fallback: TTSProvider, sticky: bool = True):  # always sticky
        super().__init__(primary, fallback, sticky=True)

    def _warn(self, what: str, exc: TTSError) -> None:
        self._on_fallback = True
        log.warning("CLONED VOICE FALLBACK (call %s): %s with cloned voice %s failed (%s%s: %s) - this call continues in "
                    "the stock voice %s", call_id_var.get(), what, getattr(self.primary, "voice_id", "?"), exc.kind,
                    f" {exc.status_code}" if exc.status_code else "", str(exc)[:200],
                    getattr(self.fallback, "voice_id", "?"))

    async def synthesize(self, text: str, pace: Optional[float] = None) -> bytes:
        if not self._on_fallback:
            try:
                return await self.primary.synthesize(text, pace=pace)
            except TTSError as exc:
                self._warn("one-shot synthesis", exc)
        return await self.fallback.synthesize(text, pace=pace)

    async def open_stream(self, pace: Optional[float] = None) -> TTSStream:
        if not self._on_fallback:
            try:
                return _ClonedStream(await self.primary.open_stream(pace=pace), self, pace)
            except TTSError as exc:
                self._warn("opening the stream", exc)
        return await self.fallback.open_stream(pace=pace)


class V4VoiceFallback(ClonedVoiceFallback):
    """One call's Bulbul v4 Flash persona (SARVAM_TTS_V4_VOICES) backed the same way by a stock bulbul voice: a v4
    request that fails before any audio (persona refused, no account access, no audio in time) is said again in the
    stock voice, and the rest of the call stays on it."""

    def _warn(self, what: str, exc: TTSError) -> None:
        self._on_fallback = True
        log.warning("V4 VOICE FALLBACK (call %s): %s with %s voice %s failed (%s%s: %s) - this call continues in the "
                    "stock voice %s", call_id_var.get(), what, getattr(self.primary, "model", "?"),
                    getattr(self.primary, "voice_id", "?"), exc.kind, f" {exc.status_code}" if exc.status_code else "",
                    str(exc)[:200], getattr(self.fallback, "voice_id", "?"))


_CLOSING_STREAMS: "set[asyncio.Task]" = set()  # abandoned cloned streams being closed (strong references)


class _ClonedStream(TTSStream):
    """A cloned voice's live stream that hands the reply to the stock voice until the cloned voice has spoken.

    A Sarvam error before its first audio (the socket refused or closed), or no audio SARVAM_TTS_CLONE_FIRST_AUDIO_SECONDS
    after the text was due to be spoken (a flush, the end of the reply, or SARVAM_TTS_MIN_BUFFER_CHARS of text), moves
    the call to the stock fallback voice ("CLONED VOICE FALLBACK" in the log). The reply goes on at once: a stock stream
    is opened and given everything sent so far (text, flushes, the end), anything sent later goes to it, and its audio
    is this stream's audio. The call never sees an error or a gap, and every later reply streams in the stock voice.
    Once the cloned voice has spoken, the reply stays with it (never two voices in one reply)."""

    def __init__(self, inner: TTSStream, owner: ClonedVoiceFallback, pace: Optional[float] = None):
        self.inner, self.owner, self._pace = inner, owner, pace
        self._active: TTSStream = inner
        cfg: Settings = getattr(owner.primary, "cfg", default_settings)
        self._limit = max(0.0, float(cfg.SARVAM_TTS_CLONE_FIRST_AUDIO_SECONDS or 0))
        self._buffer = min(200, max(30, cfg.SARVAM_TTS_MIN_BUFFER_CHARS))  # Sarvam's min_buffer_size for this stream
        # A stream that speaks each text at once (sarvam_tts.CloneSentenceStream): due from its first text.
        self._each_text = bool(getattr(inner, "speaks_each_text", False))
        self._ops: List[Tuple[str, Optional[str]]] = []  # what was sent, in order: replayed to the stock stream
        self._chars = 0
        self._due_at: Optional[float] = None  # when the cloned voice should have started to speak
        self._got_audio = False
        self._switched = False
        self._lock = asyncio.Lock()

    @staticmethod
    async def _apply(stream: TTSStream, kind: str, text: Optional[str]) -> None:
        if kind == "text":
            await stream.send_text(text or "")
        elif kind == "flush":
            await stream.flush()
        else:
            await stream.end_input()

    async def _switch(self, what: str, exc: TTSError) -> None:
        """Hand the reply to the stock voice (with self._lock held)."""
        self.owner._warn(what, exc)
        stock = await self.owner.fallback.open_stream(pace=self._pace)
        for kind, text in self._ops:
            await self._apply(stock, kind, text)
        self._active, self._switched = stock, True
        task = asyncio.ensure_future(self.inner.aclose())  # never waits on the cloned socket's close
        _CLOSING_STREAMS.add(task)
        task.add_done_callback(_CLOSING_STREAMS.discard)

    async def _send(self, kind: str, text: Optional[str] = None) -> None:
        async with self._lock:
            self._ops.append((kind, text))
            if kind == "text":
                self._chars += len(text or "")
            if self._due_at is None and (kind != "text" or self._each_text or self._chars >= self._buffer):
                self._due_at = time.monotonic()
            try:
                await self._apply(self._active, kind, text)
            except TTSError as exc:
                if self._switched or self._got_audio:
                    raise
                await self._switch("streaming", exc)  # this message too goes to the stock stream

    async def send_text(self, text: str) -> None:
        if text.strip():
            await self._send("text", text)

    async def flush(self) -> None:
        await self._send("flush")

    async def end_input(self) -> None:
        await self._send("end")

    def _overdue(self) -> bool:
        return self._limit > 0 and self._due_at is not None and time.monotonic() >= self._due_at + self._limit

    async def audio(self):
        it = self.inner.audio().__aiter__()
        pending: Optional[asyncio.Future] = None
        try:
            while not self._switched:
                pending = pending or asyncio.ensure_future(it.__anext__())
                # Short steps: a switch made by send_text (a refused message) is noticed at once too.
                done, _ = await asyncio.wait({pending}, timeout=0.05)
                if pending in done:
                    task, pending = pending, None
                    try:
                        chunk = task.result()
                    except StopAsyncIteration:
                        return
                    except TTSError as exc:
                        async with self._lock:
                            if not self._switched:
                                await self._switch("streaming", exc)
                        break
                    self._got_audio = True
                    yield chunk
                    async for chunk in it:  # the cloned voice speaks this reply: the rest of its audio
                        yield chunk
                    return
                if self._overdue():
                    async with self._lock:
                        if not self._switched:
                            await self._switch(f"no audio within {self._limit:g}s of the text",
                                               TTSError("timeout", "Sarvam voice clone stream sent no audio in time"))
        finally:
            if pending is not None and not pending.done():
                pending.cancel()
        async for chunk in self._active.audio():  # the stock voice, given the reply so far
            yield chunk

    async def set_pace(self, pace: float) -> None:
        self._pace = pace
        await self._active.set_pace(pace)

    async def cancel(self) -> None:
        await self._active.cancel()
        if self._active is not self.inner:
            await self.inner.cancel()

    async def aclose(self) -> None:
        await self._active.aclose()
        if self._active is not self.inner:
            await self.inner.aclose()

    def is_open(self) -> bool:
        # A warm stream (TTS_WARM_STREAM) opened before the call moved to the stock voice is not reused.
        return not self.owner._on_fallback and not self._switched and self.inner.is_open()

    def __getattr__(self, name: str):
        if name in ("inner", "_active"):  # not set yet: never recurse
            raise AttributeError(name)
        return getattr(self._active, name)  # anything else the call reads from the provider's stream


def start_on_fallback(tts: TTSProvider) -> bool:
    """A call whose voice already fell back before it connected (its greeting, rendered while the phone rang): the
    call's own TTS starts on the fallback voice too, so the greeting and every later line are one voice. True if
    `tts` has a fallback to start on."""
    if isinstance(tts, FallbackTTS):
        tts._on_fallback = True
        return True
    return False


def with_clone_fallback(tts: TTSProvider) -> TTSProvider:
    """A call's TTS: a cloned voice gets a stock voice of its gender (cfg.fallback_speaker: ishita / ratan by default;
    same settings, key and connection pool) as its fallback; any other TTS is returned unchanged. A stream that fails
    or stays silent after opening (before any audio) hands its reply to the stock voice itself (_ClonedStream)."""
    if isinstance(tts, ClonedVoiceFallback):
        return tts
    if isinstance(tts, FallbackTTS):
        return FallbackTTS(with_clone_fallback(tts.primary), with_clone_fallback(tts.fallback), sticky=tts.sticky)
    if isinstance(tts, SarvamTTS) and tts.cloned:
        gender = tts.cfg.cloned_voice_gender(tts.voice_id)  # its env slot (SARVAM_TTS_VOICE_<LANG>_FEMALE / _MALE_*)
        stock = tts.cfg.fallback_speaker(gender)
        if not gender:  # not one of this backend's slots: the fallback can't follow its gender
            log.warning("Cloned voice %s has no gender on this backend (not in SARVAM_TTS_VOICE_%s_*): its fallback is "
                        "the default voice %s, which may not match it", tts.voice_id, tts.cfg.call_language.upper(), stock)
        return ClonedVoiceFallback(tts, SarvamTTS(tts.cfg, voice_id=stock, client=tts._client, exact_voice=True))
    if isinstance(tts, SarvamTTS) and tts.v4_persona:
        # A Bulbul v4 Flash persona: the stock voice of its tagged gender (SARVAM_TTS_FALLBACK_VOICE_*) on
        # SARVAM_TTS_MODEL. Untagged (Sarvam states no gender): the default stock voice.
        gender = voice_gender(tts.voice_id)
        stock = tts.cfg.fallback_speaker(gender)
        if not gender:
            log.warning("Bulbul v4 voice %s has no gender in SARVAM_TTS_V4_VOICES: its fallback is the default voice %s, "
                        "which may not match it", tts.voice_id, stock)
        return V4VoiceFallback(tts, SarvamTTS(tts.cfg, voice_id=stock, client=tts._client, exact_voice=True))
    return tts


def agent_voice_settings(cfg: Settings, pace: Optional[float] = None) -> Dict[str, Any]:
    """The Autonomous AI Agent voice profile as Sarvam TTS settings (AGENT_TTS_*, clamped to Sarvam's ranges).
    pace: the agent's own voice speed, instead of AGENT_TTS_PACE."""
    return {
        "SARVAM_TTS_PACE": min(2.0, max(0.5, cfg.AGENT_TTS_PACE if pace is None else pace)),
        "SARVAM_TTS_TEMPERATURE": min(1.0, max(0.01, cfg.AGENT_TTS_TEMPERATURE)),
        "SARVAM_TTS_MIN_BUFFER_CHARS": min(200, max(30, cfg.AGENT_TTS_MIN_BUFFER_CHARS)),
    }


def with_agent_voice(tts: TTSProvider, pace: Optional[float] = None) -> TTSProvider:
    """A call's TTS with the Autonomous AI Agent voice profile: the same speaker, model and key, with the profile's
    pace (or the agent's own `pace`), temperature and synthesis chunk size for every request and stream; a fallback
    voice, once used, stays for the rest of the call. Any other provider (e.g. a test double) is returned unchanged."""
    if isinstance(tts, FallbackTTS):
        return type(tts)(with_agent_voice(tts.primary, pace), with_agent_voice(tts.fallback, pace), sticky=True)
    if isinstance(tts, SarvamTTS):
        return type(tts)(tts.cfg.model_copy(update=agent_voice_settings(tts.cfg, pace)), voice_id=tts.voice_id,
                         client=tts._client, exact_voice=True)
    return tts


@lru_cache(maxsize=None)
def _call_providers_class():
    from app.services.call_service import Providers

    @dataclass
    class CallProviders(Providers):
        """One call's providers. fixed_tts: an admin-chosen voice for another model, used for every line
        (the flow's bulbul:v3 voice is its fallback)."""

        fixed_tts: Optional[TTSProvider] = None
        source = "admin"

        def tts_for_voice(self, voice_id: Optional[str]) -> TTSProvider:
            base = super().tts_for_voice(voice_id)
            return FallbackTTS(self.fixed_tts, base) if self.fixed_tts is not None else base

        def tts_for_agent_voice(self, voice_id: str) -> TTSProvider:
            """An AI Agent's saved voice wins over the page's fixed speaker: that speaker is a persona of another
            model (bulbul:v4-flash), so the agent's bulbul:v3 voice can't be spoken by it. The call uses the
            agent's voice on the working bulbul:v3 setup for every line - one voice, never switching mid-call."""
            base = super().tts_for_voice(voice_id)
            if self.fixed_tts is not None:
                model = getattr(base, "model", "bulbul:v3")
                log.warning("AI Providers TTS %s / %s not used for this AI Agent call: the agent's saved voice %s "
                            "is a %s speaker (calls with it use %s)",
                            getattr(getattr(self.fixed_tts, "cfg", None), "SARVAM_TTS_MODEL", "?"),
                            getattr(self.fixed_tts, "voice_id", "?"), voice_id, model, model)
            return base

    return CallProviders


def _tts_view(tts: TTSProvider) -> Dict[str, Any]:
    if isinstance(tts, FallbackTTS):
        return {"primary": _tts_view(tts.primary), "fallback": _tts_view(tts.fallback),
                **({"sticky": True} if tts.sticky else {})}
    cfg = getattr(tts, "cfg", None)
    view: Dict[str, Any] = {"provider": getattr(tts, "name", type(tts).__name__)}
    if cfg is not None:
        view["model"] = "voice-clone" if getattr(tts, "cloned", False) else getattr(tts, "model", cfg.SARVAM_TTS_MODEL)
        if getattr(tts, "cloned", False):
            view["clone_stream"] = (cfg.SARVAM_TTS_CLONE_STREAM or "rest").strip().lower()
            view["first_audio_limit_s"] = cfg.SARVAM_TTS_CLONE_FIRST_AUDIO_SECONDS
    if getattr(tts, "voice_id", None):
        view["voice"] = tts.voice_id
    if cfg is not None and hasattr(tts, "_voice_settings"):
        vs = tts._voice_settings()  # type: ignore[attr-defined]
        view.update({k: vs[k] for k in ("pace", "temperature") if k in vs})
        view["chunk_chars"] = cfg.SARVAM_TTS_MIN_BUFFER_CHARS
    return view


def describe_call(providers: Any, stt: Any, tts: TTSProvider) -> Dict[str, Any]:
    """What one call uses, for its log line (the provider execution trace): where the setup comes from, the LLM
    chain in order (provider:model), the STT model / mode / language / fallback model and the TTS model / voice.
    Never a key or any other secret."""
    llm = providers.llm
    if isinstance(llm, ChainLLMProvider):
        llm_view: Any = llm.labels
    else:
        cfg = llm.cfg
        llm_view = [f"{getattr(llm, 'name', '?')}:{getattr(llm, 'model', '?')}"]
        if cfg.LLM_FALLBACK_MODEL:
            llm_view.append(f"{getattr(llm, 'name', '?')}:{cfg.LLM_FALLBACK_MODEL}")
        if cfg.LLM_FALLBACK2_PROVIDER:
            llm_view.append(f"{cfg.LLM_FALLBACK2_PROVIDER}:{cfg.LLM_FALLBACK2_MODEL or '?'}")
    scfg = getattr(stt, "cfg", None)
    stt_view: Dict[str, Any] = {"provider": getattr(stt, "name", type(stt).__name__)}
    if scfg is not None:
        model = scfg.SARVAM_STT_MODEL
        stt_view.update({"model": model, "language": scfg.sarvam_language_code,
                         "fallback_model": scfg.STT_FALLBACK_MODEL or None,
                         "streaming": bool(scfg.STT_STREAMING)})
        if model.startswith("saaras:v3"):
            stt_view["mode"] = scfg.SARVAM_STT_MODE
    return {"source": getattr(providers, "source", "env"), "llm": llm_view, "stt": stt_view, "tts": _tts_view(tts)}


async def build_call_providers(db: AsyncSession, cfg: Settings = default_settings):
    """The live-call providers from the saved settings, or None (switched off: use .env)."""
    from app.services.call_service import get_providers

    sel = await db.get(AiProviderSelection, 1)
    if sel is None or not sel.live:
        return None
    rows = await _rows(db)
    base = get_providers()
    llm: LLMProvider = base.llm
    links: List[Tuple[str, LLMProvider]] = []
    for pid in usable_llm(rows, cfg):
        key, _ = key_for(rows[pid], pid, cfg)
        model = rows[pid].model or default_model(pid, cfg)
        if key and model:
            links.append((CATALOG[pid].provider, build_llm(pid, model, key, cfg)))
    if links:
        llm = ChainLLMProvider(cfg, links)
    else:
        log.warning("No LLM provider enabled with a key in the AI provider settings - using the .env LLM")

    stt = base.stt
    row = rows.get("sarvam_stt")
    if row is not None and row.enabled:
        key, _ = key_for(row, "sarvam_stt", cfg)
        model = row.model or cfg.SARVAM_STT_MODEL
        if key and speech_model_allowed(model, cfg):
            stt = build_stt(row, key, cfg, getattr(base.stt, "_client", None))

    tts, fixed = base.tts, None
    row = rows.get("sarvam_tts")
    if row is not None and row.enabled:
        key, _ = key_for(row, "sarvam_tts", cfg)
        model = row.model or cfg.SARVAM_TTS_MODEL
        client = getattr(base.tts, "_client", None)
        if key and speech_model_allowed(model, cfg):
            speaker = (row.options or {}).get("speaker")
            if model == "bulbul:v3":
                update: Dict[str, Any] = {"SARVAM_TTS_MODEL": model}
                if speaker:
                    update["SARVAM_TTS_SPEAKER"] = speaker
                tts = SarvamTTS(_speech_cfg(cfg, key, **update), client=client)
            elif speaker:
                fixed = SarvamTTS(_speech_cfg(cfg, key, SARVAM_TTS_MODEL=model), voice_id=speaker, client=client,
                                  exact_voice=True)
    return _call_providers_class()(stt=stt, llm=llm, tts=tts, plivo=base.plivo, twilio=base.twilio, fixed_tts=fixed)


_STATE = {"version": 0}
_CACHE: Dict[str, Any] = {}
CACHE_SECONDS = 30.0  # another process (a second worker) picks up a change within this time


def invalidate() -> None:
    _STATE["version"] += 1
    _CACHE.clear()


async def providers_for_call(cfg: Settings = default_settings):
    """The providers a call starting now uses (one snapshot for the whole call)."""
    from app.services.call_service import get_providers

    now = time.monotonic()
    hit = _CACHE.get("entry")
    if hit is not None and hit[0] == _STATE["version"] and now - hit[1] < CACHE_SECONDS:
        return hit[2] or get_providers()
    try:
        async with session_factory()() as db:
            built = await build_call_providers(db, cfg)
    except Exception as exc:  # no table yet (migration not run), DB down, unreadable settings: today's behaviour
        log.warning("AI provider settings not used (%s) - using the .env providers", type(exc).__name__)
        built = None
    _CACHE["entry"] = (_STATE["version"], now, built)
    return built or get_providers()


# ------------------------------------------------------------------ connection test
_SAFE_MESSAGES = {
    "auth": "Authentication failed - check the API key",
    "rate_limit": "Rate limited by the provider - try again later",
    "timeout": "The provider did not answer in time",
    "invalid_request": "The provider rejected the request - check the model ID and voice",
    "not_configured": "No API key saved",
    "blocked": "The provider declined the test prompt",
    "invalid_audio": "The provider rejected the test audio",
    "provider": "The provider returned an error",
}


def safe_message(kind: str, status: Optional[int] = None) -> str:
    """What the page shows for a failure: the kind and status code only, never the provider's text."""
    msg = _SAFE_MESSAGES.get(kind, "The test failed")
    return f"{msg} ({status})" if status else msg


async def _test_llm(pid: str, model: str, key: str, cfg: Settings) -> None:
    link = build_llm(pid, model, key, cfg.model_copy(update={"LLM_MAX_OUTPUT_TOKENS": 16}))
    stream = link._stream("You are a connection test. Reply with OK.", [{"role": "user", "content": "Say OK."}], model)
    async for _ in stream:
        break  # the first text is enough
    await stream.aclose()


async def llm_for_test(db: AsyncSession, pid: str, cfg: Settings = default_settings) -> Tuple[LLMProvider, str]:
    """(provider, model) of one LLM that is switched on with a key - for the Training tab's test reply.
    Built like a link of the live chain; the key never leaves the server."""
    rows = await _rows(db)
    if pid not in usable_llm(rows, cfg):
        raise ProviderSettingsError(400, "Pick an LLM provider that is switched on and has a key", "not_enabled")
    key, _ = key_for(rows[pid], pid, cfg)
    model = rows[pid].model or default_model(pid, cfg)
    if not key or not model:
        raise ProviderSettingsError(400, "Set a model ID for this provider first", "not_enabled")
    return build_llm(pid, model, key, cfg), model


async def test_provider(db: AsyncSession, pid: str, actor: Optional[str], cfg: Settings = default_settings) -> Dict[str, Any]:
    """One small real request to the provider (uses a little API credit; only on an admin's click)."""
    spec = CATALOG.get(pid)
    if spec is None:
        raise ProviderSettingsError(404, "Unknown provider", "not_found")
    rows = await _rows(db)
    row = rows.get(pid)
    key, _ = key_for(row, pid, cfg)
    model = (row.model if row is not None and row.model else None) or (
        new_entry_model(pid, cfg) if row is None else default_model(pid, cfg)) or ""
    started = time.monotonic()
    status, message = "ok", "Connected"
    if not key:
        status, message = "error", safe_message("not_configured")
    elif not model:
        status, message = "error", "Set a model ID first"
    elif spec.kind != "llm" and not speech_model_allowed(model, cfg):
        status, message = "error", f"{model} is not verified for production calls"
    else:
        try:
            if spec.kind == "llm":
                await asyncio.wait_for(_test_llm(pid, model, key, cfg), timeout=20)
            elif spec.kind == "stt":
                stt = build_stt(row or AiProviderSetting(id=pid), key, cfg, None)
                try:
                    await asyncio.wait_for(stt.transcribe(_silence_wav()), timeout=20)
                finally:
                    await stt.aclose()
            else:
                speaker = (row.options or {}).get("speaker") if row is not None else None
                tts = SarvamTTS(_speech_cfg(cfg, key, SARVAM_TTS_MODEL=model), voice_id=speaker,
                                exact_voice=model != "bulbul:v3")
                try:
                    if not await asyncio.wait_for(tts.synthesize("Hello."), timeout=20):
                        raise TTSError("provider", "no audio")
                finally:
                    await tts.aclose()
        except (LLMError, STTError, TTSError) as exc:
            status, message = "error", safe_message(exc.kind, getattr(exc, "status_code", None))
        except asyncio.TimeoutError:
            status, message = "error", safe_message("timeout")
        except Exception as exc:  # never show internals
            log.warning("AI provider test %s failed unexpectedly (%s)", pid, type(exc).__name__)
            status, message = "error", "The test failed"
    elapsed = int((time.monotonic() - started) * 1000)
    log.info("AI provider test %s (%s): %s in %dms", pid, model, status, elapsed)
    if row is None:
        row = _start_row(pid, cfg)
        db.add(row)
    row.last_test_status, row.last_test_message, row.last_test_at = status, message[:200], utcnow()
    _audit(db, actor, "provider_tested", pid, {"status": status, "ms": elapsed})
    await db.commit()
    view = await settings_view(db, cfg)
    view["test"] = {"provider": pid, "status": status, "message": message, "latency_ms": elapsed}
    return view


def _silence_wav(ms: int = 500) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * (16 * ms))
    return out.getvalue()
