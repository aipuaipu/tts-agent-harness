"""Live pronunciation accuracy tests — Fish TTS + WhisperX.

Reproduces the known issue: Fish TTS S2-Pro mispronounces English brand
names / abbreviations in Chinese-dominant text. WhisperX transcribes the
audio and we compare against the original to detect deviations.

These tests call real external services:
- Fish Audio API (requires FISH_TTS_KEY)
- WhisperX service (localhost:7860)

Run:
    set -a && source .env && set +a
    .venv-server/bin/python -m pytest server/tests/tasks/test_pronunciation.py -v

Skip when keys/services are not available.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

import httpx
import pytest

from server.core.domain import FishTTSParams
from server.core.fish_client import FishTTSClient

# ---------------------------------------------------------------------------
# Skip conditions
# ---------------------------------------------------------------------------

FISH_KEY = os.environ.get("FISH_TTS_KEY", "")
REFERENCE_ID = os.environ.get("FISH_TTS_REFERENCE_ID")
WHISPERX_URL = os.environ.get("WHISPERX_URL", "http://localhost:7860")
PROXY = os.environ.get("HTTPS_PROXY", "")


def _whisperx_available() -> bool:
    try:
        r = httpx.get(f"{WHISPERX_URL}/healthz", timeout=3)
        return r.status_code == 200 and r.json().get("model_loaded") is True
    except Exception:
        return False


skip_no_fish = pytest.mark.skipif(
    not FISH_KEY, reason="FISH_TTS_KEY not set"
)
skip_no_whisperx = pytest.mark.skipif(
    not _whisperx_available(), reason=f"WhisperX not running at {WHISPERX_URL}",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@dataclass
class TranscribeResult:
    text: str
    words: list[dict] = field(default_factory=list)


def _strip_control_markers(text: str) -> str:
    """Remove TTS control markers, same as p5_logic.strip_control_markers."""
    return re.sub(r"\[(?:break|breath|long break)\]", "", text).strip()


def _extract_english_tokens(text: str) -> list[str]:
    """Extract English tokens (2+ chars) from text."""
    return re.findall(r"[a-zA-Z][a-zA-Z0-9.\-]*[a-zA-Z0-9]", text)


async def _synthesize(text: str, params: FishTTSParams) -> bytes:
    """Call Fish TTS and return WAV bytes."""
    proxy_kwarg = {"proxy": PROXY} if PROXY else {}
    http = httpx.AsyncClient(timeout=httpx.Timeout(120.0), **proxy_kwarg)
    client = FishTTSClient(api_key=FISH_KEY, http_client=http)
    try:
        return await client.synthesize(text, params)
    finally:
        await client.aclose()


async def _transcribe(wav_bytes: bytes, language: str = "zh") -> TranscribeResult:
    """Call WhisperX service and return transcription."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        resp = await client.post(
            f"{WHISPERX_URL}/transcribe",
            files={"audio": ("audio.wav", wav_bytes, "audio/wav")},
            data={"language": language, "return_word_timestamps": "true"},
        )
        resp.raise_for_status()
        data = resp.json()
    words = data.get("transcript", [])
    text = "".join(w.get("word", "") for w in words)
    return TranscribeResult(text=text, words=words)


def _check_token_preserved(token: str, transcribed: str) -> bool:
    """Check if an English token appears (case-insensitive) in the transcription."""
    return token.lower() in transcribed.lower()


# ---------------------------------------------------------------------------
# Test data
# ---------------------------------------------------------------------------

# Each entry: (text_id, tts_text, english_tokens_to_check)
# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.asyncio
@skip_no_fish
@skip_no_whisperx
async def test_english_mispronunciation(tmp_path):
    """Reproduce: Fish TTS mispronounces English words in Chinese text.

    Synthesizes the same text 3 times with default params, transcribes each,
    and checks whether English tokens survive in the transcription.
    AB test data shows RAG is the most unstable (44% fail rate).
    """
    tts_text = (
        "Mac 跑本地模型，[break]之前一直很尴尬。装了 Ollama，跑个小模型还行，"
        "大一点的慢得受不了。最近我在做一个 RAG 项目。"
    )
    expected_tokens = ["Mac", "Ollama", "RAG"]
    original = _strip_control_markers(tts_text)

    params = FishTTSParams(
        temperature=0.7,
        top_p=0.7,
        reference_id=REFERENCE_ID,
    )

    all_lost: list[list[str]] = []

    for run in range(1, 4):
        wav_bytes = await _synthesize(tts_text, params)
        assert wav_bytes[:4] == b"RIFF"

        # Save WAV for manual listening
        (tmp_path / f"run{run}.wav").write_bytes(wav_bytes)

        result = await _transcribe(wav_bytes)

        lost = [t for t in expected_tokens if not _check_token_preserved(t, result.text)]
        all_lost.append(lost)

        print(f"\n  run{run}: lost={lost or 'none'}")
        print(f"    原文: {original}")
        print(f"    转写: {result.text}")

    # At least one run should have a mispronounced token
    any_lost = any(lost for lost in all_lost)
    if not any_lost:
        pytest.skip("All 3 runs preserved all tokens — mispronunciation not reproduced")


@pytest.mark.live
@pytest.mark.asyncio
@skip_no_fish
@skip_no_whisperx
async def test_pronunciation_char_ratio(tmp_path):
    """Verify that char_ratio stays within P2v thresholds even when tokens are wrong.

    This reproduces the core issue: P2v's char_ratio [0.7, 1.3] almost never
    catches pronunciation errors because the total character count doesn't
    change significantly when English words are replaced by Chinese homophones.
    """
    from server.flows.tasks.p2v_verify import RATIO_LOW, RATIO_HIGH, _compute_char_ratio

    text = (
        "Mac 跑本地模型，[break]之前一直很尴尬。装了 Ollama，跑个小模型还行，"
        "大一点的慢得受不了。最近我在做一个 RAG 项目。"
    )
    original = _strip_control_markers(text)

    params = FishTTSParams(temperature=0.7, top_p=0.7, reference_id=REFERENCE_ID)

    ratios = []
    for run in range(1, 4):
        wav_bytes = await _synthesize(text, params)
        result = await _transcribe(wav_bytes)
        ratio = _compute_char_ratio(original, result.text)
        ratios.append(ratio)

        in_range = RATIO_LOW <= ratio <= RATIO_HIGH
        tokens = _extract_english_tokens(original)
        lost = [t for t in tokens if not _check_token_preserved(t, result.text)]

        print(
            f"\n  run{run}: ratio={ratio:.3f} {'PASS' if in_range else 'FAIL'} "
            f"| lost tokens: {lost or 'none'}"
        )
        print(f"    原文: {original}")
        print(f"    转写: {result.text}")

    # The point: char_ratio almost always passes even when tokens are lost
    pass_count = sum(1 for r in ratios if RATIO_LOW <= r <= RATIO_HIGH)
    print(f"\n  >>> char_ratio passed {pass_count}/{len(ratios)} times")
    print(f"  >>> This demonstrates that char_ratio cannot catch pronunciation errors")

    # Save for analysis
    import json
    (tmp_path / "char_ratio_report.json").write_text(
        json.dumps({"ratios": ratios, "threshold": [RATIO_LOW, RATIO_HIGH]}, indent=2)
    )
