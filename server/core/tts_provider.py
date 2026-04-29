"""Provider resolution helpers for the P2 synthesis stage."""

from __future__ import annotations

import os
from typing import Any, Callable

from server.core.domain import FishTTSParams, TTSProvider, XiaomiMimoTTSParams
from server.core.fish_client import FishTTSClient, build_params_from_env as build_fish_params_from_env
from server.core.xiaomi_mimo_client import XiaomiMimoTTSClient

SUPPORTED_TTS_PROVIDERS: tuple[TTSProvider, ...] = ("fish", "xiaomi_mimo")


def resolve_tts_provider(overrides: dict[str, Any] | None = None) -> TTSProvider:
    raw = (
        (overrides or {}).get("provider")
        or os.environ.get("TTS_PROVIDER")
        or "xiaomi_mimo"
    )
    provider = str(raw).strip().lower().replace("xiaomi_bridge", "xiaomi_mimo")
    if provider not in SUPPORTED_TTS_PROVIDERS:
        supported = ", ".join(SUPPORTED_TTS_PROVIDERS)
        raise ValueError(f"unsupported TTS provider '{provider}', expected one of: {supported}")
    return provider  # type: ignore[return-value]


def build_tts_params_from_env(
    overrides: dict[str, Any] | None = None,
) -> tuple[TTSProvider, FishTTSParams | XiaomiMimoTTSParams]:
    provider = resolve_tts_provider(overrides)
    cleaned = {k: v for k, v in (overrides or {}).items() if v is not None}

    if provider == "fish":
        fish_overrides = {k: v for k, v in cleaned.items() if k != "provider"}
        return provider, build_fish_params_from_env(fish_overrides)

    base: dict[str, Any] = {
        "model": os.environ.get("XIAOMI_MIMO_TTS_MODEL", "mimo-v2.5-tts"),
        "format": os.environ.get("XIAOMI_TTS_FORMAT", "wav"),
        "voice": os.environ.get("XIAOMI_MIMO_TTS_VOICE", "mimo_default"),
    }
    xiaomi_overrides = {k: v for k, v in cleaned.items() if k != "provider"}
    if "voice_data_uri" in xiaomi_overrides and "voice" not in xiaomi_overrides:
        xiaomi_overrides["voice"] = xiaomi_overrides["voice_data_uri"]
    if "reference_id" in xiaomi_overrides and "voice" not in xiaomi_overrides:
        xiaomi_overrides["voice"] = xiaomi_overrides["reference_id"]
    base.update(xiaomi_overrides)
    return provider, XiaomiMimoTTSParams(**base)


def build_tts_client_factory(
    *,
    fish_api_key: str | None = None,
    xiaomi_mimo_api_key: str | None = None,
) -> Callable[[TTSProvider], Any]:
    def factory(provider: TTSProvider) -> Any:
        if provider == "fish":
            return FishTTSClient(api_key=(fish_api_key or "").strip())
        if provider == "xiaomi_mimo":
            return XiaomiMimoTTSClient(
                api_key=(xiaomi_mimo_api_key or os.environ.get("XIAOMI_MIMO_API_KEY", "")).strip(),
            )
        raise ValueError(f"unsupported TTS provider: {provider}")

    return factory


def provider_auth_required(provider: TTSProvider) -> bool:
    return provider in ("fish", "xiaomi_mimo")


def provider_auth_message(provider: TTSProvider) -> str:
    if provider == "fish":
        return "Fish API Key 未配置。请在设置中填入 API Key。"
    if provider == "xiaomi_mimo":
        return "Xiaomi MiMo API Key 未配置。请在服务端配置 XIAOMI_MIMO_API_KEY。"
    return ""


__all__ = [
    "SUPPORTED_TTS_PROVIDERS",
    "build_tts_client_factory",
    "build_tts_params_from_env",
    "provider_auth_message",
    "provider_auth_required",
    "resolve_tts_provider",
]
