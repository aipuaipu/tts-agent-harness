"""API-key management routes — store keys as encrypted httpOnly cookies."""

from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel

from server.core.crypto import decrypt_value, encrypt_value
from server.core.fish_client import fish_http_proxy

router = APIRouter(tags=["keys"])

_COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() != "false"
_COOKIE_MAX_AGE = 86400 * 365  # 1 year

FISH_VERIFY_URL = "https://api.fish.audio/wallet/self/api-credit"
FISH_MODELS_URL = "https://api.fish.audio/model"
GROQ_VERIFY_URL = "https://api.groq.com/openai/v1/models"


class KeysBody(BaseModel):
    fish_key: str | None = None
    groq_key: str | None = None


class KeysStatus(BaseModel):
    fish: bool
    groq: bool
    error: str | None = None


class FishVoice(BaseModel):
    id: str
    title: str
    description: str = ""
    visibility: str | None = None
    languages: list[str] = []
    tags: list[str] = []
    gender: str | None = None  # extracted from tags: "male" | "female" | None
    age: str | None = None  # extracted from tags: "young" | "middle-aged" | "old" | None
    preview_url: str | None = None


class FishVoicesResponse(BaseModel):
    items: list[FishVoice]
    total: int = 0
    has_more: bool = False


def _set_cookie(response: Response, name: str, value: str) -> None:
    response.set_cookie(
        key=name,
        value=encrypt_value(value),
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="strict",
        max_age=_COOKIE_MAX_AGE,
        path="/",
    )


async def _verify_fish(key: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(FISH_VERIFY_URL, headers={"Authorization": f"Bearer {key}"})
            return r.is_success
    except Exception:
        return False


def _fish_key_from_request(request: Request) -> str:
    enc = request.cookies.get("__fish_key")
    if enc:
        try:
            return decrypt_value(enc)
        except Exception:
            pass
    return os.environ.get("FISH_TTS_KEY", "")


async def _verify_groq(key: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(GROQ_VERIFY_URL, headers={"Authorization": f"Bearer {key}"})
            return r.is_success
    except Exception:
        return False


@router.post("/keys", response_model=KeysStatus)
async def save_keys(body: KeysBody, request: Request, response: Response) -> KeysStatus:
    errors: list[str] = []

    # Carry forward existing cookies for keys not being updated
    fish_ok = bool(request.cookies.get("__fish_key"))
    groq_ok = bool(request.cookies.get("__groq_key"))

    if body.fish_key:
        if await _verify_fish(body.fish_key):
            _set_cookie(response, "__fish_key", body.fish_key)
            fish_ok = True
        else:
            errors.append("Fish API Key 无效")

    if body.groq_key:
        if await _verify_groq(body.groq_key):
            _set_cookie(response, "__groq_key", body.groq_key)
            groq_ok = True
        else:
            errors.append("Groq API Key 无效")

    return KeysStatus(fish=fish_ok, groq=groq_ok, error="；".join(errors) if errors else None)


@router.get("/keys/status", response_model=KeysStatus)
async def keys_status(request: Request) -> KeysStatus:
    fish_ok = False
    enc = request.cookies.get("__fish_key")
    if enc:
        try:
            decrypt_value(enc)
            fish_ok = True
        except Exception:
            pass

    groq_ok = False
    enc = request.cookies.get("__groq_key")
    if enc:
        try:
            decrypt_value(enc)
            groq_ok = True
        except Exception:
            pass

    return KeysStatus(fish=fish_ok, groq=groq_ok)


@router.get("/tts/fish-voices", response_model=FishVoicesResponse)
async def list_fish_voices(
    request: Request,
    page_size: int = Query(default=100, ge=1, le=100),
    page_number: int = Query(default=1, ge=1),
    title: str | None = None,
    language: str | None = None,
) -> FishVoicesResponse:
    fish_key = _fish_key_from_request(request).strip()
    if not fish_key:
        raise HTTPException(status_code=401, detail="Fish API Key 未配置。请先在设置中填入 API Key。")

    params: dict[str, object] = {
        "page_size": page_size,
        "page_number": page_number,
        "sort_by": "task_count",
    }
    if title:
        params["title"] = title
    if language:
        params["language"] = language

    try:
        async with httpx.AsyncClient(timeout=15, proxy=fish_http_proxy()) as client:
            response = await client.get(
                FISH_MODELS_URL,
                headers={"Authorization": f"Bearer {fish_key}"},
                params=params,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"获取 Fish Audio 音色列表失败: {exc.response.text[:300]}",
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"获取 Fish Audio 音色列表失败: {type(exc).__name__}") from exc

    payload = response.json()
    def _extract_gender(tags: list[str]) -> str | None:
        lower_tags = [t.lower() for t in tags]
        if "female" in lower_tags:
            return "female"
        if "male" in lower_tags:
            return "male"
        return None

    def _extract_age(tags: list[str]) -> str | None:
        lower_tags = [t.lower() for t in tags]
        if "young" in lower_tags:
            return "young"
        if "middle-aged" in lower_tags:
            return "middle-aged"
        if "old" in lower_tags:
            return "old"
        return None

    items = [
        FishVoice(
            id=str(item.get("_id", "")),
            title=str(item.get("title") or item.get("_id") or "Untitled"),
            description=str(item.get("description") or ""),
            visibility=item.get("visibility"),
            languages=[str(value) for value in (item.get("languages") or [])],
            tags=[str(value) for value in (item.get("tags") or [])],
            gender=_extract_gender([str(value) for value in (item.get("tags") or [])]),
            age=_extract_age([str(value) for value in (item.get("tags") or [])]),
            preview_url=item.get("samples", [{}])[0].get("audio") if item.get("samples") else None,
        )
        for item in payload.get("items", [])
        if item.get("_id")
    ]
    return FishVoicesResponse(
        items=items,
        total=int(payload.get("total") or len(items)),
        has_more=bool(payload.get("has_more", False)),
    )


@router.delete("/keys", response_model=KeysStatus)
async def delete_keys(response: Response) -> KeysStatus:
    response.delete_cookie("__fish_key", path="/", httponly=True, secure=_COOKIE_SECURE, samesite="strict")
    response.delete_cookie("__groq_key", path="/", httponly=True, secure=_COOKIE_SECURE, samesite="strict")
    return KeysStatus(fish=False, groq=False)
