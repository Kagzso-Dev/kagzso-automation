"""AI provider settings from the admin page (Dispatch -> AI providers), for this voice backend's language.

Each language runs its own voice backend with its own database, so each language has its own
settings. Nothing changes for calls until an admin switches "Use for live calls" on: until then -
and whenever the saved settings can't be read - every call uses the .env providers exactly as before.

* LLM: Groq, Sarvam and Anthropic in the admin's fallback order (ChainLLMProvider). Only providers
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
from app.core.logging import get_logger, redact_secret
from app.core.voices import VOICE_IDS
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
    ProviderSpec("sarvam_stt", "stt", "Sarvam speech-to-text", "sarvam", ("saaras:v3", "saaras:v4")),
    ProviderSpec("sarvam_tts", "tts", "Sarvam text-to-speech", "sarvam", ("bulbul:v3", "bulbul:v4-flash")),
)}
LLM_IDS = tuple(pid for pid, s in CATALOG.items() if s.kind == "llm")
DEFAULT_LLM_MODELS = {"sarvam_llm": "sarvam-105b-conversations", "anthropic_llm": "claude-opus-5-5"}
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
    model = (row.model if row is not None and row.model else None) or default_model(pid, cfg)
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
    row = rows.get(pid) or AiProviderSetting(id=pid, enabled=False, updated_at=utcnow())
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
                    row = rows[pid] = AiProviderSetting(id=pid, enabled=False, updated_at=utcnow())
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
    mid-stream: audio that already played is not repeated."""

    name = "fallback"

    def __init__(self, primary: TTSProvider, fallback: TTSProvider):
        self.primary, self.fallback = primary, fallback

    async def synthesize(self, text: str, pace: Optional[float] = None) -> bytes:
        try:
            return await self.primary.synthesize(text, pace=pace)
        except TTSError as exc:
            log.warning("TTS %s failed (%s) - using the fallback voice", getattr(self.primary, "voice_id", "?"), exc.kind)
            return await self.fallback.synthesize(text, pace=pace)

    async def open_stream(self, pace: Optional[float] = None) -> TTSStream:
        try:
            return await self.primary.open_stream(pace=pace)
        except TTSError as exc:
            log.warning("TTS stream failed to open (%s) - using the fallback voice", exc.kind)
            return await self.fallback.open_stream(pace=pace)

    async def synthesize_preview(self, text: str) -> bytes:
        try:
            return await self.primary.synthesize_preview(text)  # type: ignore[attr-defined]
        except TTSError:
            return await self.fallback.synthesize_preview(text)  # type: ignore[attr-defined]


@lru_cache(maxsize=None)
def _call_providers_class():
    from app.services.call_service import Providers

    @dataclass
    class CallProviders(Providers):
        """One call's providers. fixed_tts: an admin-chosen voice for another model, used for every line
        (the flow's bulbul:v3 voice is its fallback)."""

        fixed_tts: Optional[TTSProvider] = None

        def tts_for_voice(self, voice_id: Optional[str]) -> TTSProvider:
            base = super().tts_for_voice(voice_id)
            return FallbackTTS(self.fixed_tts, base) if self.fixed_tts is not None else base

    return CallProviders


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


async def test_provider(db: AsyncSession, pid: str, actor: Optional[str], cfg: Settings = default_settings) -> Dict[str, Any]:
    """One small real request to the provider (uses a little API credit; only on an admin's click)."""
    spec = CATALOG.get(pid)
    if spec is None:
        raise ProviderSettingsError(404, "Unknown provider", "not_found")
    rows = await _rows(db)
    row = rows.get(pid)
    key, _ = key_for(row, pid, cfg)
    model = (row.model if row is not None and row.model else None) or default_model(pid, cfg) or ""
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
        row = AiProviderSetting(id=pid, enabled=False, updated_at=utcnow())
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
