"""Call recording (CALL_RECORDING_ENABLED, off by default).

One stereo 8 kHz 16-bit WAV per answered call:
  left  = the customer exactly as the line delivered it (raw inbound frames, before noise suppression)
  right = only the agent audio that actually played

Both tracks are kept in memory as 8 kHz mu-law while the call runs (bounded by
RECORDING_MAX_SECONDS); nothing touches the disk until the call has ended, so recording can
never delay a reply. The customer's inbound frame count is the clock: frame n is at n x 20 ms.
Agent audio is placed where Plivo starts playing it - after the audio already queued, or "now"
- and everything placed after "now" is cut when Plivo's queue is cleared (barge-in) or the call
ends, because it never played. Accuracy: within about the network / Plivo buffer delay (~250 ms).

When the call ends the tracks are merged in a worker thread, written to a temp file, synced,
renamed into place and checked; only then is the row marked `completed`. Any failure marks the
row `failed` with a short reason and is logged without numbers, paths or audio; the call itself
is never affected.
"""
from __future__ import annotations

import asyncio
import base64
import errno
import io
import os
import re
import uuid
import wave
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select

from app.core.config import Settings
from app.core.logging import get_logger
from app.db.database import session_factory
from app.db.models import CallRecording, utcnow
from app.services import audio_service as audio

log = get_logger("voice.recording")

SAMPLE_RATE = 8000
FRAME_BYTES = 160  # 20 ms of 8 kHz mu-law
MULAW_SILENCE = b"\xff"
MAGIC = b"KGZREC1\n"  # encrypted file header (followed by a 12-byte nonce and the AES-GCM ciphertext)
FORMAT_WAV = "wav"
FORMAT_ENCRYPTED = "wav+aesgcm"
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.wav(\.enc)?$")
CALL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class RecordingError(Exception):
    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


# --------------------------------------------------------------------------- storage helpers
def recordings_dir(cfg: Settings) -> Optional[Path]:
    raw = (cfg.RECORDINGS_DIR or "").strip()
    return Path(raw).expanduser().resolve() if raw else None


def storage_path(cfg: Settings, storage_key: str) -> Path:
    """The file for `storage_key`, always inside RECORDINGS_DIR (no paths from outside)."""
    base = recordings_dir(cfg)
    if base is None:
        raise RecordingError("storage_not_configured")
    if not _KEY_RE.match(storage_key or ""):
        raise RecordingError("bad_storage_key")
    path = (base / storage_key).resolve()
    if path.parent != base:
        raise RecordingError("bad_storage_key")
    return path


def encryption_key(cfg: Settings) -> Optional[bytes]:
    raw = cfg.RECORDING_ENCRYPTION_KEY.get_secret_value().strip()
    if not raw:
        return None
    try:
        key = base64.b64decode(raw, validate=True)
    except ValueError:
        raise RecordingError("bad_encryption_key") from None
    if len(key) != 32:
        raise RecordingError("bad_encryption_key")
    return key


def encrypt(data: bytes, key: bytes) -> bytes:
    nonce = os.urandom(12)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, data, MAGIC)


def decrypt(blob: bytes, key: bytes) -> bytes:
    if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + 12 + 16:
        raise RecordingError("unreadable_file")
    nonce = blob[len(MAGIC):len(MAGIC) + 12]
    try:
        return AESGCM(key).decrypt(nonce, blob[len(MAGIC) + 12:], MAGIC)
    except Exception:
        raise RecordingError("unreadable_file") from None


def _write_atomic(base: Path, path: Path, data: bytes, encrypted: bool) -> None:
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.part")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    # Checked before the row can say "completed".
    if path.stat().st_size != len(data):
        raise RecordingError("write_check_failed")
    if not encrypted:
        with wave.open(str(path), "rb") as w:
            if w.getnchannels() != 2 or w.getframerate() != SAMPLE_RATE:
                raise RecordingError("write_check_failed")


def _storage_error(exc: OSError) -> str:
    return "disk_full" if exc.errno == errno.ENOSPC else "storage_error"


# --------------------------------------------------------------------------- the recorder
class CallRecorder:
    """Two in-memory 8 kHz mu-law tracks for one call. Every method is cheap and never raises."""

    def __init__(self, call_id: str, max_seconds: int):
        self.call_id = call_id
        self.storage_key = f"{call_id}.wav"
        self.customer = bytearray()
        self.agent = bytearray()
        self.limit = max(1, int(max_seconds)) * SAMPLE_RATE
        self.full = False
        self.registered: Optional[asyncio.Task] = None
        self.row_ok = False

    def add_customer(self, mulaw: bytes) -> None:
        """A raw inbound frame, in arrival order (this is the recording's clock)."""
        if self.full:
            return
        self.customer += mulaw[: self.limit - len(self.customer)]
        if len(self.customer) >= self.limit:
            self.full = True
            log.warning("Recording reached RECORDING_MAX_SECONDS - the rest of this call is not recorded")

    def add_agent(self, mulaw: bytes) -> None:
        """Agent audio just sent to Plivo: it plays after the audio already queued, or now."""
        if self.full:
            return
        start = max(len(self.customer), len(self.agent))
        if start > len(self.agent):
            self.agent += MULAW_SILENCE * (start - len(self.agent))
        self.agent += mulaw
        if len(self.agent) > self.limit:
            del self.agent[self.limit:]

    def cut_agent(self) -> None:
        """Plivo's queue was cleared (barge-in) or the call ended: audio placed after now never played."""
        del self.agent[len(self.customer):]

    @property
    def duration_ms(self) -> int:
        return len(self.customer) * 1000 // SAMPLE_RATE

    def to_wav(self) -> bytes:
        self.cut_agent()
        n = len(self.customer)
        left = np.frombuffer(audio.mulaw_to_pcm16(bytes(self.customer)), dtype="<i2")
        right = np.frombuffer(audio.mulaw_to_pcm16(bytes(self.agent) + MULAW_SILENCE * (n - len(self.agent))), dtype="<i2")
        stereo = np.empty(2 * n, dtype="<i2")
        stereo[0::2] = left
        stereo[1::2] = right
        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(stereo.tobytes())
        return out.getvalue()


# --------------------------------------------------------------------------- database
async def _set(call_id: str, **fields) -> None:
    async with session_factory()() as db:
        row = (await db.execute(select(CallRecording).where(CallRecording.call_id == call_id))).scalar_one_or_none()
        if row is None:
            return
        for k, v in fields.items():
            setattr(row, k, v)
        await db.commit()


async def _register(rec: CallRecorder, encrypted: bool) -> None:
    try:
        async with session_factory()() as db:
            db.add(CallRecording(call_id=rec.call_id, storage_key=rec.storage_key,
                                 format=FORMAT_ENCRYPTED if encrypted else FORMAT_WAV, status="processing"))
            await db.commit()
        rec.row_ok = True
    except Exception as exc:  # e.g. the migration isn't applied yet: the call goes on unrecorded
        log.warning("Recording not started (%s)", type(exc).__name__)


def start(call_id: str, cfg: Settings) -> Optional[CallRecorder]:
    """A recorder for a connected call, or None when recording is off. Never raises."""
    if not cfg.CALL_RECORDING_ENABLED:
        return None
    try:
        encrypted = encryption_key(cfg) is not None
    except RecordingError:
        encrypted = False  # reported (and the row failed) when the call ends
    rec = CallRecorder(call_id, cfg.RECORDING_MAX_SECONDS)
    if encrypted:
        rec.storage_key += ".enc"
    rec.registered = asyncio.get_running_loop().create_task(_register(rec, encrypted))
    return rec


async def finalize(rec: CallRecorder, cfg: Settings) -> None:
    """Write the recording when the call ends. Never raises; the row ends completed or failed."""
    try:
        if rec.registered is not None:
            await asyncio.wait_for(asyncio.shield(rec.registered), timeout=10)
    except Exception:
        pass
    if not rec.row_ok:
        return
    try:
        if not rec.customer:
            raise RecordingError("no_audio")
        base = recordings_dir(cfg)
        if base is None:
            raise RecordingError("storage_not_configured")
        key = encryption_key(cfg)
        path = storage_path(cfg, rec.storage_key)
        wav = await asyncio.to_thread(rec.to_wav)
        data = encrypt(wav, key) if key else wav
        await asyncio.to_thread(_write_atomic, base, path, data, key is not None)
        await _set(rec.call_id, status="completed", duration_ms=rec.duration_ms, size_bytes=len(data),
                   completed_at=utcnow(), error=None)
        log.info("Recording saved: %.1f s, %d KB%s", rec.duration_ms / 1000, len(data) // 1024,
                 " (encrypted)" if key else "")
    except Exception as exc:
        reason = exc.kind if isinstance(exc, RecordingError) else _storage_error(exc) if isinstance(exc, OSError) \
            else "error"
        log.warning("Recording failed (%s) - the call was not affected", reason)
        try:
            await _set(rec.call_id, status="failed", error=reason)
        except Exception:
            log.warning("Could not mark the recording failed")


async def get(db, call_id: str) -> Optional[CallRecording]:
    return (await db.execute(select(CallRecording).where(CallRecording.call_id == call_id))).scalar_one_or_none()


async def get_many(db, call_ids: Sequence[str]) -> List[CallRecording]:
    if not call_ids:
        return []
    return list((await db.execute(select(CallRecording).where(CallRecording.call_id.in_(list(call_ids))))).scalars())


def read_audio(cfg: Settings, row: CallRecording) -> bytes:
    """The playable WAV bytes of a completed recording (decrypted when stored encrypted)."""
    path = storage_path(cfg, row.storage_key)
    if not path.is_file():
        raise RecordingError("file_missing")
    data = path.read_bytes()
    if row.format == FORMAT_ENCRYPTED:
        key = encryption_key(cfg)
        if key is None:
            raise RecordingError("encryption_key_missing")
        data = decrypt(data, key)
    return data


def _remove_file(cfg: Settings, storage_key: str) -> None:
    path = storage_path(cfg, storage_key)  # never anything outside RECORDINGS_DIR
    if path.is_file():
        path.unlink()


async def delete(db, cfg: Settings, row: CallRecording) -> None:
    """Remove the file and mark the row deleted (safe to repeat)."""
    if row.status != "deleted":
        try:
            await asyncio.to_thread(_remove_file, cfg, row.storage_key)
        except RecordingError as exc:
            if exc.kind != "storage_not_configured":
                raise
        row.status, row.deleted_at = "deleted", utcnow()
        await db.commit()


async def mark_interrupted() -> int:
    """At startup: recordings left `processing` by a restart or crash can't be completed any more."""
    async with session_factory()() as db:
        rows = list((await db.execute(select(CallRecording).where(CallRecording.status == "processing"))).scalars())
        for row in rows:
            row.status, row.error = "failed", "interrupted"
        await db.commit()
    if rows:
        log.info("Recordings interrupted by a restart marked failed: %d", len(rows))
    return len(rows)


async def purge_expired(cfg: Settings, now: Optional[datetime] = None) -> int:
    """Delete completed recordings older than RECORDING_RETENTION_DAYS. Idempotent."""
    if cfg.RECORDING_RETENTION_DAYS <= 0 or recordings_dir(cfg) is None:
        return 0
    cutoff = (now or utcnow()) - timedelta(days=cfg.RECORDING_RETENTION_DAYS)
    done = 0
    async with session_factory()() as db:
        rows = list((await db.execute(select(CallRecording).where(
            CallRecording.status == "completed", CallRecording.created_at < cutoff))).scalars())
        for row in rows:
            try:
                await delete(db, cfg, row)
                done += 1
            except Exception as exc:
                log.warning("Retention: a recording could not be deleted (%s)", type(exc).__name__)
    if done:
        log.info("Retention: %d recording(s) older than %d days deleted", done, cfg.RECORDING_RETENTION_DAYS)
    return done


async def retention_loop(cfg: Settings, every_seconds: int = 3600) -> None:
    while True:
        try:
            await purge_expired(cfg)
        except Exception as exc:
            log.warning("Retention run failed (%s)", type(exc).__name__)
        await asyncio.sleep(every_seconds)


def describe(row: Optional[CallRecording]) -> Optional[Dict[str, object]]:
    if row is None:
        return None
    return {
        "call_id": row.call_id,
        "status": row.status,
        "format": row.format,
        "duration_ms": row.duration_ms,
        "size_bytes": row.size_bytes,
        "error": row.error,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "completed_at": row.completed_at.isoformat() if row.completed_at else None,
        "deleted_at": row.deleted_at.isoformat() if row.deleted_at else None,
    }
