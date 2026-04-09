"""Storage wrapper tests — require docker (testcontainers MinIO)."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from .conftest import requires_docker


@requires_docker
async def test_upload_bytes_and_download(minio_client):
    key = "episodes/ep1/script.json"
    uri = await minio_client.upload_bytes(key, b'{"hello": 1}', content_type="application/json")
    assert uri == f"s3://{minio_client.bucket}/{key}"

    data = await minio_client.download_bytes(key)
    assert data == b'{"hello": 1}'


@requires_docker
async def test_upload_file_roundtrip(tmp_path: Path, minio_client):
    src = tmp_path / "audio.wav"
    src.write_bytes(b"RIFFxxxxWAVE")
    key = "episodes/ep1/chunks/c1/takes/t1.wav"
    uri = await minio_client.upload_file(key, src)
    assert key in uri
    data = await minio_client.download_bytes(key)
    assert data == b"RIFFxxxxWAVE"


@requires_docker
async def test_exists(minio_client):
    key = "episodes/ep1/logs/c1/p2.log"
    assert (await minio_client.exists(key)) is False
    await minio_client.upload_bytes(key, b"log\n")
    assert (await minio_client.exists(key)) is True


@requires_docker
async def test_presigned_url(minio_client):
    key = "episodes/ep1/final/episode.wav"
    await minio_client.upload_bytes(key, b"fake-wav")
    url = await minio_client.get_presigned_url(key, expires=timedelta(minutes=5))
    assert url.startswith("http://") or url.startswith("https://")
    assert minio_client.bucket in url


@requires_docker
async def test_delete(minio_client):
    key = "episodes/ep1/chunks/c1/transcript.json"
    await minio_client.upload_bytes(key, b"{}")
    assert await minio_client.exists(key)
    await minio_client.delete(key)
    assert (await minio_client.exists(key)) is False


def test_path_helpers_match_adr():
    from server.core.storage import (
        chunk_log_key,
        chunk_subtitle_key,
        chunk_take_key,
        chunk_transcript_key,
        episode_script_key,
        final_srt_key,
        final_wav_key,
    )

    assert episode_script_key("ep1") == "episodes/ep1/script.json"
    assert (
        chunk_take_key("ep1", "c1", "t1")
        == "episodes/ep1/chunks/c1/takes/t1.wav"
    )
    assert chunk_transcript_key("ep1", "c1") == "episodes/ep1/chunks/c1/transcript.json"
    assert chunk_subtitle_key("ep1", "c1") == "episodes/ep1/chunks/c1/subtitle.srt"
    assert final_wav_key("ep1") == "episodes/ep1/final/episode.wav"
    assert final_srt_key("ep1") == "episodes/ep1/final/episode.srt"
    assert chunk_log_key("ep1", "c1", "p2") == "episodes/ep1/logs/c1/p2.log"
