"""E2E pronunciation test — creates episode via real API, runs pipeline, results visible in UI.

Hits the RUNNING API server (localhost:8100), which uses dev mode (in-process
P2 → P2c → P2v). Fish TTS and WhisperX are real. After the test, open
http://localhost:3010 to see the episode, listen to audio, and inspect
transcription results.

Run:
    set -a && source .env && set +a
    .venv-server/bin/python -m pytest server/tests/e2e/test_pronunciation_e2e.py -v -s
"""

from __future__ import annotations

import asyncio
import json
import os

import httpx
import pytest
import pytest_asyncio

API_URL = os.environ.get("NEXT_PUBLIC_API_URL", "http://localhost:8100")
FISH_KEY = os.environ.get("FISH_TTS_KEY", "")


def _api_available() -> bool:
    try:
        r = httpx.get(f"{API_URL}/healthz", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


skip_no_api = pytest.mark.skipif(not _api_available(), reason=f"API not running at {API_URL}")
skip_no_fish = pytest.mark.skipif(not FISH_KEY, reason="FISH_TTS_KEY not set")

SCRIPT = {
    "title": "发音测试 — 中英文混合",
    "segments": [
        {
            "id": 1,
            "type": "content",
            "text": "Mac 跑本地模型，[break]之前一直很尴尬。装了 Ollama，跑个小模型还行，"
                    "大一点的慢得受不了。最近我在做一个 RAG 项目。",
        },
    ],
}


@pytest_asyncio.fixture()
async def client():
    async with httpx.AsyncClient(base_url=API_URL, timeout=120, proxy=None) as c:
        yield c


@pytest.mark.e2e
@pytest.mark.live
@pytest.mark.asyncio
@skip_no_api
@skip_no_fish
async def test_pronunciation_via_pipeline(client: httpx.AsyncClient):
    """Create episode → run pipeline → verify results in DB (and UI)."""
    ep_id = "pronunciation-test"

    # Cleanup any previous run
    await client.delete(f"/episodes/{ep_id}")

    # 1. Create episode
    script_bytes = json.dumps(SCRIPT, ensure_ascii=False).encode()
    resp = await client.post(
        "/episodes",
        files={"script": ("script.json", script_bytes, "application/json")},
        data={"id": ep_id, "title": SCRIPT["title"]},
    )
    assert resp.status_code == 201, resp.text
    print(f"\n  ✓ Episode created: {ep_id}")

    # 2. Run pipeline (dev mode: chunk_only first, then synthesize)
    resp = await client.post(f"/episodes/{ep_id}/run", json={"mode": "chunk_only"})
    assert resp.status_code == 200, resp.text
    print("  ✓ P1 chunk_only started")

    # Wait for P1 to finish
    await _wait_for_status(client, ep_id, target="ready", timeout=15)
    print("  ✓ P1 done → status=ready")

    # 3. Synthesize (P2 → P2c → P2v → P5 → P6)
    resp = await client.post(f"/episodes/{ep_id}/run", json={"mode": "synthesize"})
    assert resp.status_code == 200, resp.text
    print("  ✓ synthesize started (P2 → P2c → P2v → P5 → P6)")

    # Wait for pipeline to finish (Fish API + WhisperX can take a while)
    final_status = await _wait_for_status(
        client, ep_id, target=("done", "failed"), timeout=120
    )
    print(f"  ✓ pipeline finished → status={final_status}")

    # 4. Fetch episode detail and print results
    resp = await client.get(f"/episodes/{ep_id}")
    assert resp.status_code == 200
    data = resp.json()

    print(f"\n  Episode: {data['id']} — status={data['status']}")
    for chunk in data.get("chunks", []):
        print(f"\n  Chunk {chunk['id']}:")
        print(f"    status: {chunk['status']}")
        print(f"    text: {chunk['text']}")

        # Show takes
        for take in chunk.get("takes", []):
            selected = " ★" if take["id"] == chunk.get("selectedTakeId") else ""
            print(f"    take {take['id']}: duration={take.get('durationS', '?')}s{selected}")

        # Show stage runs
        for sr in chunk.get("stageRuns", []):
            print(f"    stage {sr['stage']}: {sr['status']}", end="")
            if sr.get("error"):
                print(f" — {sr['error']}", end="")
            print()

    # 5. Check events for verify results
    resp = await client.get(f"/episodes/{ep_id}/logs", params={"tail": 50})
    if resp.status_code == 200:
        lines = resp.json().get("lines", [])
        for line in lines:
            if "verify" in line.lower() or "char_ratio" in line.lower():
                print(f"  LOG: {line}")

    print(f"\n  >>> Open http://localhost:3010 to see results in UI")
    print(f"  >>> Episode ID: {ep_id}")


async def _wait_for_status(
    client: httpx.AsyncClient,
    ep_id: str,
    target: str | tuple[str, ...],
    timeout: int = 60,
) -> str:
    """Poll episode status until it reaches target or timeout."""
    if isinstance(target, str):
        target = (target,)

    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        resp = await client.get(f"/episodes/{ep_id}")
        if resp.status_code == 200:
            status = resp.json()["status"]
            if status in target:
                return status
        await asyncio.sleep(2)

    resp = await client.get(f"/episodes/{ep_id}")
    actual = resp.json().get("status", "unknown") if resp.status_code == 200 else "fetch_failed"
    pytest.fail(f"Episode {ep_id} did not reach {target} within {timeout}s (current: {actual})")
