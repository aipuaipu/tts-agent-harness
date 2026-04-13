"""Phase 1: LLM prompt validation for Agent review nodes.

Tests LLM's ability to identify TTS pronunciation risks (P1r) and
transcription mismatches (P2r) using real data from pronunciation tests.

Requires Ollama running at localhost:11434 with qwen3.5:9b.

Run:
    .venv-server/bin/python -m pytest server/tests/tasks/test_llm_review.py -v -s
"""

from __future__ import annotations

import json
import re

import httpx
import pytest

OLLAMA_URL = "http://localhost:11434"
MODEL = "qwen3.5:9b"


def _ollama_available() -> bool:
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


skip_no_ollama = pytest.mark.skipif(
    not _ollama_available(), reason="Ollama not running"
)


async def _chat(prompt: str, system: str = "") -> str:
    async with httpx.AsyncClient(timeout=60, proxy=None) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/v1/chat/completions",
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
            },
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


def _parse_json_from_response(text: str) -> list[dict]:
    """Extract JSON array from LLM response (may contain markdown fences)."""
    # Try direct parse first
    text = text.strip()
    # Remove thinking tags if present (qwen3.5 may output <think>...</think>)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    # Remove markdown code fences
    text = re.sub(r"```json\s*", "", text)
    text = re.sub(r"```\s*", "", text)
    text = text.strip()
    try:
        result = json.loads(text)
        return result if isinstance(result, list) else [result]
    except json.JSONDecodeError:
        # Try to find JSON array in text
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if match:
            return json.loads(match.group())
        return []


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

P1R_SYSTEM = """你是 TTS 发音审查助手。用户给你一段要交给中文 TTS 引擎朗读的文本。
你的任务：识别其中可能发音不准的英文单词、缩写、数字组合。

只关注发音风险，不要修改中文内容。

输出 JSON 数组，每项：
{"token": "原文中的词", "issue": "问题描述", "suggestion": "修改建议"}

如果没有发音风险，输出空数组 []。不要输出任何其他内容。"""

P2R_SYSTEM = """你是 TTS 转写比对助手。用户给你原文和 ASR 转写结果。
你的任务：找出转写中与原文不一致的英文/数字词，判断是否为发音错误。

注意：中文同音字替换（如"的"→"得"）不算发音错误，忽略。
只关注英文/数字/缩写的发音偏差。

输出 JSON 数组，每项：
{"token": "原文中的词", "transcribed": "转写结果", "issue": "问题描述", "suggestion": "修改建议"}

如果没有发音偏差，输出空数组 []。不要输出任何其他内容。"""


# ---------------------------------------------------------------------------
# P1r tests: script review
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.asyncio
@skip_no_ollama
async def test_p1r_detects_english_tokens():
    """LLM should flag English brand names / abbreviations as pronunciation risks."""
    text = "Mac 跑本地模型，之前一直很尴尬。装了 Ollama，跑个小模型还行。最近我在做一个 RAG 项目。"

    prompt = f"文本：{text}"
    raw = await _chat(prompt, P1R_SYSTEM)
    suggestions = _parse_json_from_response(raw)

    print(f"\n  LLM raw: {raw[:200]}")
    print(f"  Parsed: {json.dumps(suggestions, ensure_ascii=False, indent=2)}")

    flagged_tokens = {s["token"].lower() for s in suggestions}
    expected = {"mac", "ollama", "rag"}

    hits = flagged_tokens & expected
    false_positives = flagged_tokens - expected

    print(f"\n  Expected: {expected}")
    print(f"  Flagged:  {flagged_tokens}")
    print(f"  Hits:     {hits} ({len(hits)}/{len(expected)})")
    print(f"  FP:       {false_positives}")

    assert len(hits) >= 2, f"Should detect at least 2 of {expected}, got {hits}"
    assert len(false_positives) <= 2, f"Too many false positives: {false_positives}"


@pytest.mark.live
@pytest.mark.asyncio
@skip_no_ollama
async def test_p1r_no_false_positive():
    """Pure Chinese text should produce zero suggestions."""
    text = "最近天气不错，适合出门散步。周末打算去公园走走。"

    prompt = f"文本：{text}"
    raw = await _chat(prompt, P1R_SYSTEM)
    suggestions = _parse_json_from_response(raw)

    print(f"\n  LLM raw: {raw[:200]}")
    print(f"  Suggestions: {suggestions}")

    assert len(suggestions) == 0, f"Pure Chinese should have 0 suggestions, got {suggestions}"


@pytest.mark.live
@pytest.mark.asyncio
@skip_no_ollama
async def test_p1r_suggestion_format():
    """Suggestions should have required fields."""
    text = "NVIDIA 发布了 H100 GPU，FP8 算力达到 3958 TFLOPS。"

    prompt = f"文本：{text}"
    raw = await _chat(prompt, P1R_SYSTEM)
    suggestions = _parse_json_from_response(raw)

    print(f"\n  LLM raw: {raw[:200]}")
    print(f"  Parsed: {json.dumps(suggestions, ensure_ascii=False, indent=2)}")

    assert len(suggestions) > 0, "Should have suggestions for tech text"
    for s in suggestions:
        assert "token" in s, f"Missing 'token' in {s}"
        assert "issue" in s, f"Missing 'issue' in {s}"
        assert "suggestion" in s, f"Missing 'suggestion' in {s}"


# ---------------------------------------------------------------------------
# P2r tests: transcription comparison
# ---------------------------------------------------------------------------


@pytest.mark.live
@pytest.mark.asyncio
@skip_no_ollama
async def test_p2r_detects_mispronunciation():
    """LLM should detect when English tokens are mistranscribed."""
    original = "Mac 跑本地模型，之前一直很尴尬。装了 Ollama，跑个小模型还行。最近我在做一个 RAG 项目。"
    transcribed = "卖个跑本地模型之前一直很尴尬装了欧拉玛跑个小模型还行最近我再做一个Lag项目"

    prompt = f"原文：{original}\n转写：{transcribed}"
    raw = await _chat(prompt, P2R_SYSTEM)
    suggestions = _parse_json_from_response(raw)

    print(f"\n  LLM raw: {raw[:300]}")
    print(f"  Parsed: {json.dumps(suggestions, ensure_ascii=False, indent=2)}")

    flagged = {s["token"].lower() for s in suggestions}
    # Mac→卖个, Ollama→欧拉玛, RAG→Lag are real mismatches
    expected = {"mac", "ollama", "rag"}
    hits = flagged & expected

    print(f"\n  Expected: {expected}")
    print(f"  Flagged:  {flagged}")
    print(f"  Hits:     {hits}")

    assert len(hits) >= 2, f"Should detect at least 2 of {expected}, got {hits}"

    # Should NOT flag Chinese homophone differences
    cn_false = {s["token"] for s in suggestions if not re.search(r"[a-zA-Z]", s["token"])}
    print(f"  CN false positives: {cn_false}")


@pytest.mark.live
@pytest.mark.asyncio
@skip_no_ollama
async def test_p2r_no_false_positive_on_match():
    """When transcription matches original, should produce zero suggestions."""
    original = "最近天气不错，适合出门散步。"
    transcribed = "最近天气不错适合出门散步"

    prompt = f"原文：{original}\n转写：{transcribed}"
    raw = await _chat(prompt, P2R_SYSTEM)
    suggestions = _parse_json_from_response(raw)

    print(f"\n  LLM raw: {raw[:200]}")
    print(f"  Suggestions: {suggestions}")

    assert len(suggestions) == 0, f"Matching text should have 0 suggestions, got {suggestions}"


@pytest.mark.live
@pytest.mark.asyncio
@skip_no_ollama
async def test_p2r_with_real_ab_data():
    """Use real AB test transcription data."""
    # From AB test: A_default run2 — RAG was read as "IG"
    original = "Mac 跑本地模型，之前一直很尴尬。装了 Ollama，跑个小模型还行，大一点的慢得受不了，玩两下就吃灰了。最近我在做一个 RAG 项目，需要大量跑测试，重新研究了一下，发现情况变了。"
    transcribed = "麦克跑本地模型之前一直很尴尬装了欧拉玛跑个小模型还行大一点的慢的受不了玩两下就吃灰了最近我在做一个IG项目需要大量跑测试重新研究了一下发现情况变了"

    prompt = f"原文：{original}\n转写：{transcribed}"
    raw = await _chat(prompt, P2R_SYSTEM)
    suggestions = _parse_json_from_response(raw)

    print(f"\n  LLM raw: {raw[:300]}")
    print(f"  Parsed: {json.dumps(suggestions, ensure_ascii=False, indent=2)}")

    # RAG→IG is the most obvious error
    flagged = {s["token"].lower() for s in suggestions}
    print(f"\n  Flagged tokens: {flagged}")

    assert "rag" in flagged, f"Should detect RAG→IG mismatch, flagged: {flagged}"
