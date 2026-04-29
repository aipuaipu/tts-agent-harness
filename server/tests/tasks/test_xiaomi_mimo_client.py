from __future__ import annotations

import base64
import json

import httpx
import pytest

from server.core.domain import XiaomiMimoTTSParams
from server.core.xiaomi_mimo_client import (
    XIAOMI_MIMO_TTS_URL,
    XiaomiMimoAuthError,
    XiaomiMimoClientError,
    XiaomiMimoRateLimitError,
    XiaomiMimoServerError,
    XiaomiMimoTTSClient,
)


def _make_client(handler) -> XiaomiMimoTTSClient:
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport)
    return XiaomiMimoTTSClient(api_key="mimo-key", http_client=http)


async def test_synthesize_success_returns_bytes():
    wav_bytes = b"RIFF\x00\x00\x00\x00WAVEfake"
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["api-key"] = request.headers.get("api-key")
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"audio": {"data": base64.b64encode(wav_bytes).decode("utf-8")}}}]},
        )

    client = _make_client(handler)
    try:
        result = await client.synthesize(
            "你好",
            XiaomiMimoTTSParams(voice="Chloe", style_prompt="Warm and upbeat."),
        )
    finally:
        await client.aclose()

    assert result == wav_bytes
    assert captured["url"] == XIAOMI_MIMO_TTS_URL
    assert captured["api-key"] == "mimo-key"
    assert captured["body"] == {
        "model": "mimo-v2.5-tts",
        "messages": [
            {"role": "user", "content": "Warm and upbeat."},
            {"role": "assistant", "content": "你好"},
        ],
        "audio": {"format": "wav", "voice": "Chloe"},
    }


async def test_synthesize_401_raises_auth_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    client = _make_client(handler)
    try:
        with pytest.raises(XiaomiMimoAuthError):
            await client.synthesize("你好", XiaomiMimoTTSParams())
    finally:
        await client.aclose()


async def test_synthesize_429_raises_rate_limit_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow down")

    client = _make_client(handler)
    try:
        with pytest.raises(XiaomiMimoRateLimitError):
            await client.synthesize("你好", XiaomiMimoTTSParams())
    finally:
        await client.aclose()


async def test_synthesize_500_raises_server_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal")

    client = _make_client(handler)
    try:
        with pytest.raises(XiaomiMimoServerError):
            await client.synthesize("你好", XiaomiMimoTTSParams())
    finally:
        await client.aclose()


async def test_synthesize_requires_audio_data_field():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {}}]})

    client = _make_client(handler)
    try:
        with pytest.raises(XiaomiMimoClientError, match="audio.data"):
            await client.synthesize("你好", XiaomiMimoTTSParams())
    finally:
        await client.aclose()
