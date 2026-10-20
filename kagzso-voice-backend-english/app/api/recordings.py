"""Call recordings (X-API-Key protected; Dispatch is the only client and checks ADMIN itself).

    GET    /api/recordings?call_ids=a,b    status of each call's recording (call list badges)
    GET    /api/recordings/settings          counts, space used, free disk, retention (Settings page)
    PUT    /api/recordings/settings          {retention_days} - 0 keeps recordings forever
    GET    /api/recordings/{call_id}         one recording's metadata
    GET    /api/recordings/{call_id}/audio   the WAV (HTTP Range supported for seeking)
    DELETE /api/recordings/{call_id}         remove the file and mark the recording deleted

Files are looked up by call id only; the storage key comes from the database and is checked
to stay inside RECORDINGS_DIR. No path, URL or directory listing is ever exposed.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import settings
from app.core.logging import get_logger
from app.core.security import require_api_key
from app.db.database import session_factory
from app.services import recording

log = get_logger("voice.api")
router = APIRouter(prefix="/api/recordings", tags=["recordings"], dependencies=[Depends(require_api_key)])

CallId = Path(..., pattern=r"^[A-Za-z0-9_-]{1,64}$")
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


@router.get("")
async def list_recordings(call_ids: str = Query("", max_length=8000)) -> Dict[str, Any]:
    ids = [c for c in (s.strip() for s in call_ids.split(",")) if c][:200]
    if any(not recording.CALL_ID_RE.match(c) for c in ids):
        raise HTTPException(422, "Invalid call id")
    async with session_factory()() as db:
        rows = await recording.get_many(db, ids)
    return {"enabled": settings.CALL_RECORDING_ENABLED, "items": [recording.describe(r) for r in rows]}


class RetentionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    retention_days: int = Field(..., ge=0, le=recording.MAX_RETENTION_DAYS)


# Declared before /{call_id}, so "settings" is never read as a call id.
@router.get("/settings")
async def recording_settings() -> Dict[str, Any]:
    async with session_factory()() as db:
        return await recording.summary(db, settings)


@router.put("/settings")
async def update_recording_settings(body: RetentionUpdate) -> Dict[str, Any]:
    try:
        await asyncio.to_thread(recording.set_retention_days, settings, body.retention_days)
    except recording.RecordingError as exc:
        if exc.kind == "storage_not_configured":
            raise HTTPException(409, "Set RECORDINGS_DIR on the voice backend first") from None
        raise HTTPException(422, "Invalid retention") from None
    except OSError:
        log.warning("Retention setting not saved (storage_error)")
        raise HTTPException(500, "The retention setting could not be saved") from None
    log.info("Recording retention set to %d days", body.retention_days)
    async with session_factory()() as db:
        return await recording.summary(db, settings)


@router.get("/{call_id}")
async def get_recording(call_id: str = CallId) -> Dict[str, Any]:
    async with session_factory()() as db:
        row = await recording.get(db, call_id)
    return {"enabled": settings.CALL_RECORDING_ENABLED, "recording": recording.describe(row)}


def _byte_range(header: Optional[str], size: int) -> Optional[tuple]:
    """(start, end) inclusive for a single "bytes=a-b" range; None = the whole file."""
    if not header:
        return None
    m = _RANGE_RE.match(header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        raise HTTPException(416, "Unsupported range", headers={"Content-Range": f"bytes */{size}"})
    if m.group(1):
        start = int(m.group(1))
        end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
    else:  # "bytes=-500": the last 500 bytes
        start, end = max(0, size - int(m.group(2))), size - 1
    if start >= size or start > end:
        raise HTTPException(416, "Range not satisfiable", headers={"Content-Range": f"bytes */{size}"})
    return start, end


@router.get("/{call_id}/audio")
async def recording_audio(call_id: str = CallId, range_header: Optional[str] = Header(None, alias="Range")) -> Response:
    async with session_factory()() as db:
        row = await recording.get(db, call_id)
    if row is None:
        raise HTTPException(404, "No recording for this call")
    if row.status != "completed":
        raise HTTPException(409 if row.status == "processing" else 404, f"Recording is {row.status}")
    try:
        data = await asyncio.to_thread(recording.read_audio, settings, row)
    except recording.RecordingError as exc:
        log.warning("Recording unavailable (%s)", exc.kind)
        raise HTTPException(404 if exc.kind == "file_missing" else 500, "Recording file is unavailable") from None
    size = len(data)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    span = _byte_range(range_header, size)
    if span is None:
        return Response(content=data, media_type="audio/wav", headers=headers)
    start, end = span
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return Response(content=data[start:end + 1], status_code=206, media_type="audio/wav", headers=headers)


@router.delete("/{call_id}")
async def delete_recording(call_id: str = CallId) -> Dict[str, Any]:
    async with session_factory()() as db:
        row = await recording.get(db, call_id)
        if row is None:
            raise HTTPException(404, "No recording for this call")
        try:
            await recording.delete(db, settings, row)
        except recording.RecordingError as exc:
            log.warning("Recording delete failed (%s)", exc.kind)
            raise HTTPException(500, "Recording could not be deleted") from None
        except OSError:
            log.warning("Recording delete failed (storage_error)")
            raise HTTPException(500, "Recording could not be deleted") from None
        return {"ok": True, "recording": recording.describe(row)}
