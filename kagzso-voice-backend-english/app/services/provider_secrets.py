"""Encryption at rest for the provider API keys saved from the admin page.

AES-256-GCM with PROVIDER_SECRETS_KEY (base64 of 32 bytes, from the environment - never stored in
the database). A stored value is "v1:<key id>:<base64(nonce + ciphertext)>"; the key id (first 8 hex
of the key's SHA-256) picks the key for reading, so PROVIDER_SECRETS_OLD_KEYS can still read values
written before a rotation. The provider id is the associated data: a value copied onto another
provider's row does not decrypt.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import os
from typing import Dict, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import Settings

PREFIX = "v1"


class SecretsError(Exception):
    """kind: not_configured | bad_key | unreadable"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def _decode_key(raw: str) -> bytes:
    try:
        key = base64.b64decode(raw.strip(), validate=True)
    except (ValueError, binascii.Error):
        raise SecretsError("bad_key", "PROVIDER_SECRETS_KEY is not valid base64") from None
    if len(key) != 32:
        raise SecretsError("bad_key", "PROVIDER_SECRETS_KEY must be base64 of 32 bytes")
    return key


def key_id(key: bytes) -> str:
    return hashlib.sha256(key).hexdigest()[:8]


def current_key(cfg: Settings) -> bytes:
    raw = cfg.PROVIDER_SECRETS_KEY.get_secret_value()
    if not raw.strip():
        raise SecretsError("not_configured", "PROVIDER_SECRETS_KEY is not set on the voice backend")
    return _decode_key(raw)


def _keys(cfg: Settings) -> Dict[str, bytes]:
    keys: Dict[str, bytes] = {}
    for raw in cfg.PROVIDER_SECRETS_OLD_KEYS.get_secret_value().split(","):
        if raw.strip():
            k = _decode_key(raw)
            keys[key_id(k)] = k
    k = current_key(cfg)
    keys[key_id(k)] = k
    return keys


def ready(cfg: Settings) -> Optional[str]:
    """None when keys can be saved, else why not (no secret in the message)."""
    try:
        current_key(cfg)
    except SecretsError as exc:
        return str(exc)
    return None


def encrypt(plain: str, provider_id: str, cfg: Settings) -> str:
    key = current_key(cfg)
    nonce = os.urandom(12)
    sealed = AESGCM(key).encrypt(nonce, plain.encode("utf-8"), provider_id.encode("utf-8"))
    return f"{PREFIX}:{key_id(key)}:{base64.b64encode(nonce + sealed).decode('ascii')}"


def decrypt(stored: str, provider_id: str, cfg: Settings) -> str:
    try:
        prefix, kid, data = stored.split(":", 2)
        blob = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error):
        raise SecretsError("unreadable", "the saved key is unreadable") from None
    key = _keys(cfg).get(kid) if prefix == PREFIX else None
    if key is None:
        raise SecretsError("unreadable", "the saved key was encrypted with a key this server no longer has")
    try:
        return AESGCM(key).decrypt(blob[:12], blob[12:], provider_id.encode("utf-8")).decode("utf-8")
    except Exception:
        raise SecretsError("unreadable", "the saved key is unreadable") from None


def needs_reencrypt(stored: str, cfg: Settings) -> bool:
    """Written with an older key (still readable): "Re-encrypt keys" moves it to the current one."""
    try:
        return stored.split(":", 2)[1] != key_id(current_key(cfg))
    except (IndexError, SecretsError):
        return False
