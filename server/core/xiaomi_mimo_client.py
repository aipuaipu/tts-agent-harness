"""Direct client for Xiaomi MiMo's official server-side TTS HTTP API.

Official docs reference:
  POST https://api.xiaomimimo.com/v1/chat/completions
  Header: api-key: <MIMO_API_KEY>
  Body: { model, messages, audio }

For non-streaming requests the audio is returned in:
  choices[0].message.audio.data
as base64-encoded bytes.
"""

from __future__ import annotations

import base64
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx

from .domain import XiaomiMimoTTSParams

XIAOMI_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"
XIAOMI_MIMO_TTS_URL = f"{XIAOMI_MIMO_BASE_URL}/chat/completions"
DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)


class XiaomiMimoTTSError(Exception):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class XiaomiMimoAuthError(XiaomiMimoTTSError):
    """401 / 403."""


class XiaomiMimoRateLimitError(XiaomiMimoTTSError):
    """429."""


class XiaomiMimoServerError(XiaomiMimoTTSError):
    """5xx."""


class XiaomiMimoClientError(XiaomiMimoTTSError):
    """Other client-side or malformed-response failures."""


class XiaomiMimoTTSClient:
    def __init__(
        self,
        *,
        api_key: str,
        http_client: httpx.AsyncClient | None = None,
        url: str = XIAOMI_MIMO_TTS_URL,
    ) -> None:
        if not api_key.strip():
            raise ValueError("XiaomiMimoTTSClient requires a non-empty api_key")
        self._api_key = api_key.strip()
        self._url = url
        self._http = http_client
        self._owns_http = http_client is None

    async def aclose(self) -> None:
        if self._owns_http and self._http is not None:
            await self._http.aclose()
            self._http = None

    @asynccontextmanager
    async def _client(self) -> AsyncIterator[httpx.AsyncClient]:
        if self._http is not None:
            yield self._http
            return
        self._http = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)
        yield self._http

    def build_payload(self, text: str, params: XiaomiMimoTTSParams) -> dict[str, Any]:
        messages: list[dict[str, str]] = []
        if params.style_prompt:
            messages.append({"role": "user", "content": params.style_prompt})
        messages.append({"role": "assistant", "content": text})
        return {
            "model": params.model,
            "messages": messages,
            "audio": {
                "format": params.format,
                "voice": params.voice,
            },
        }

    async def synthesize(self, text: str, params: XiaomiMimoTTSParams) -> bytes:
        if not text or not text.strip():
            raise XiaomiMimoClientError("cannot synthesize empty text")

        headers = {
            "api-key": self._api_key,
            "Content-Type": "application/json",
        }

        try:
            async with self._client() as http:
                response = await http.post(
                    self._url,
                    json=self.build_payload(text, params),
                    headers=headers,
                )
        except Exception as exc:
            detail = str(exc) or type(exc).__name__
            raise XiaomiMimoClientError(
                f"Failed to connect to Xiaomi MiMo TTS at {self._url}: {detail}"
            ) from exc

        return self._handle_response(response)

    def _handle_response(self, response: httpx.Response) -> bytes:
        status = response.status_code
        if 200 <= status < 300:
            try:
                data = response.json()
            except Exception as exc:
                raise XiaomiMimoClientError(
                    "Xiaomi MiMo returned non-JSON success response",
                    status_code=status,
                ) from exc

            try:
                encoded = data["choices"][0]["message"]["audio"]["data"]
            except Exception as exc:
                raise XiaomiMimoClientError(
                    "Xiaomi MiMo response is missing choices[0].message.audio.data",
                    status_code=status,
                ) from exc

            if not encoded:
                raise XiaomiMimoClientError(
                    "Xiaomi MiMo returned empty audio payload",
                    status_code=status,
                )
            try:
                return base64.b64decode(encoded)
            except Exception as exc:
                raise XiaomiMimoClientError(
                    "Xiaomi MiMo returned invalid base64 audio payload",
                    status_code=status,
                ) from exc

        detail = response.text[:500]
        if status in (401, 403):
            raise XiaomiMimoAuthError(
                f"Xiaomi MiMo auth error {status}: {detail}",
                status_code=status,
            )
        if status == 429:
            raise XiaomiMimoRateLimitError(
                f"Xiaomi MiMo rate limited: {detail}",
                status_code=status,
            )
        if 500 <= status < 600:
            raise XiaomiMimoServerError(
                f"Xiaomi MiMo server error {status}: {detail}",
                status_code=status,
            )
        raise XiaomiMimoClientError(
            f"Xiaomi MiMo client error {status}: {detail}",
            status_code=status,
        )


__all__ = [
    "XIAOMI_MIMO_BASE_URL",
    "XIAOMI_MIMO_TTS_URL",
    "XiaomiMimoTTSClient",
    "XiaomiMimoTTSError",
    "XiaomiMimoAuthError",
    "XiaomiMimoRateLimitError",
    "XiaomiMimoServerError",
    "XiaomiMimoClientError",
]
