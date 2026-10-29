"""AI provider settings for this voice backend's language (X-API-Key; called only by Dispatch, which
checks that the user is an admin and sends their e-mail in X-Actor for the audit log).

    GET  /api/admin/ai-providers                        settings, masked: never a key, only key_configured / key_source
    PUT  /api/admin/ai-providers/providers/{id}         {enabled?, model?, options?, api_key?, remove_key?, confirm?}
    PUT  /api/admin/ai-providers/selection              {live?, llm_order?, confirm?}
    POST /api/admin/ai-providers/providers/{id}/test    one small real request (uses a little API credit)
    POST /api/admin/ai-providers/reencrypt              saved keys -> the current PROVIDER_SECRETS_KEY

An empty or missing api_key never erases a saved key; remove_key does. Errors never contain a key:
the key is checked here, not by the request model (a validation error would echo it back).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import rate_limit, require_api_key
from app.db.database import get_db
from app.services import provider_registry as registry

router = APIRouter(prefix="/api/admin/ai-providers", tags=["ai-providers"], dependencies=[Depends(require_api_key)])


class ProviderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: Optional[bool] = None
    model: Optional[str] = Field(None, max_length=100)
    options: Optional[Dict[str, Optional[str]]] = None
    api_key: Optional[Any] = None  # checked by the registry, never echoed
    remove_key: bool = False
    confirm: bool = False


class SelectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    live: Optional[bool] = None
    llm_order: Optional[List[str]] = Field(None, max_length=10)
    confirm: bool = False


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


async def _run(coro) -> Dict[str, Any]:
    try:
        return await coro
    except registry.ProviderSettingsError as exc:
        raise HTTPException(exc.status, {"message": exc.message, "code": exc.code}) from None


@router.get("")
async def get_settings(response: Response, db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    _no_store(response)
    return await registry.settings_view(db)


@router.put("/providers/{provider_id}")
async def update_provider(provider_id: str, body: ProviderUpdate, response: Response,
                          actor: Optional[str] = Header(None, alias="X-Actor"),
                          db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    _no_store(response)
    change = body.model_dump(exclude_none=True)
    key = change.get("api_key")
    if key is not None and not isinstance(key, str):
        raise HTTPException(422, {"message": "The API key must be text", "code": "invalid"})
    return await _run(registry.update_provider(db, provider_id, change, actor))


@router.put("/selection")
async def update_selection(body: SelectionUpdate, response: Response,
                           actor: Optional[str] = Header(None, alias="X-Actor"),
                           db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    _no_store(response)
    return await _run(registry.update_selection(db, body.model_dump(exclude_none=True), actor))


@router.post("/providers/{provider_id}/test", dependencies=[Depends(rate_limit(10))])
async def test_provider(provider_id: str, response: Response, actor: Optional[str] = Header(None, alias="X-Actor"),
                        db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    _no_store(response)
    return await _run(registry.test_provider(db, provider_id, actor))


@router.post("/reencrypt")
async def reencrypt(response: Response, actor: Optional[str] = Header(None, alias="X-Actor"),
                    db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    _no_store(response)
    return await _run(registry.reencrypt_keys(db, actor))
