"""MinIO (S3-compatible) object storage wrapper.

The ``minio`` package is synchronous; we run every call through
``asyncio.to_thread`` so repositories and Prefect tasks can await it without
blocking the loop. The surface intentionally mirrors the shape that higher
layers need — no generic "list objects" or "create bucket" plumbing beyond
the bucket auto-provisioning helper.

Path helpers (``*_key`` functions) enforce the MinIO layout frozen in
ADR-002 §3.3. Callers **must** use these helpers instead of hand-crafted
strings; otherwise a future layout migration becomes a grep-and-pray.
"""

from __future__ import annotations

import asyncio
import io
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from minio import Minio
from minio.error import S3Error


# ---------------------------------------------------------------------------
# Path helpers (ADR-002 §3.3)
# ---------------------------------------------------------------------------


def episode_script_key(episode_id: str) -> str:
    return f"episodes/{episode_id}/script.json"


def chunk_take_key(episode_id: str, chunk_id: str, take_id: str) -> str:
    return f"episodes/{episode_id}/chunks/{chunk_id}/takes/{take_id}.wav"


def chunk_transcript_key(episode_id: str, chunk_id: str) -> str:
    return f"episodes/{episode_id}/chunks/{chunk_id}/transcript.json"


def chunk_subtitle_key(episode_id: str, chunk_id: str) -> str:
    return f"episodes/{episode_id}/chunks/{chunk_id}/subtitle.srt"


def final_wav_key(episode_id: str) -> str:
    return f"episodes/{episode_id}/final/episode.wav"


def final_srt_key(episode_id: str) -> str:
    return f"episodes/{episode_id}/final/episode.srt"


def chunk_log_key(episode_id: str, chunk_id: str, stage: str) -> str:
    return f"episodes/{episode_id}/logs/{chunk_id}/{stage}.log"


# ---------------------------------------------------------------------------
# Storage wrapper
# ---------------------------------------------------------------------------


@dataclass
class MinIOSettings:
    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    secure: bool = False


class MinIOStorage:
    """Async-friendly facade around the sync ``minio`` client.

    All I/O methods are coroutines; they delegate to ``asyncio.to_thread`` so
    we do not block the event loop. Bucket provisioning happens lazily on
    first use via :meth:`ensure_bucket`.
    """

    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        *,
        secure: bool = False,
    ) -> None:
        self._client = Minio(
            endpoint,
            access_key=access_key,
            secret_key=secret_key,
            secure=secure,
        )
        self._bucket = bucket
        self._bucket_ready = False

    # --- bucket lifecycle ------------------------------------------------

    async def ensure_bucket(self) -> None:
        if self._bucket_ready:
            return

        def _ensure() -> None:
            if not self._client.bucket_exists(self._bucket):
                self._client.make_bucket(self._bucket)

        await asyncio.to_thread(_ensure)
        self._bucket_ready = True

    @property
    def bucket(self) -> str:
        return self._bucket

    def s3_uri(self, key: str) -> str:
        return f"s3://{self._bucket}/{key}"

    # --- uploads ---------------------------------------------------------

    async def upload_bytes(
        self,
        key: str,
        data: bytes,
        content_type: str | None = None,
    ) -> str:
        await self.ensure_bucket()

        def _put() -> None:
            self._client.put_object(
                self._bucket,
                key,
                io.BytesIO(data),
                length=len(data),
                content_type=content_type or "application/octet-stream",
            )

        await asyncio.to_thread(_put)
        return self.s3_uri(key)

    async def upload_file(self, key: str, path: Path) -> str:
        await self.ensure_bucket()
        p = Path(path)

        def _fput() -> None:
            self._client.fput_object(self._bucket, key, str(p))

        await asyncio.to_thread(_fput)
        return self.s3_uri(key)

    # --- reads -----------------------------------------------------------

    async def download_bytes(self, key: str) -> bytes:
        await self.ensure_bucket()

        def _get() -> bytes:
            response = None
            try:
                response = self._client.get_object(self._bucket, key)
                return response.read()
            finally:
                if response is not None:
                    response.close()
                    response.release_conn()

        return await asyncio.to_thread(_get)

    async def exists(self, key: str) -> bool:
        await self.ensure_bucket()

        def _stat() -> bool:
            try:
                self._client.stat_object(self._bucket, key)
                return True
            except S3Error as exc:
                if exc.code in ("NoSuchKey", "NoSuchObject", "NotFound"):
                    return False
                raise

        return await asyncio.to_thread(_stat)

    async def get_presigned_url(
        self, key: str, expires: timedelta = timedelta(hours=1)
    ) -> str:
        await self.ensure_bucket()

        def _sign() -> str:
            return self._client.presigned_get_object(
                self._bucket, key, expires=expires
            )

        return await asyncio.to_thread(_sign)

    async def delete(self, key: str) -> None:
        await self.ensure_bucket()

        def _del() -> None:
            self._client.remove_object(self._bucket, key)

        await asyncio.to_thread(_del)

    async def get_bucket_size_bytes(self) -> int:
        """Return total size of all objects in the bucket (bytes)."""
        await self.ensure_bucket()

        def _sum() -> int:
            total = 0
            for obj in self._client.list_objects(self._bucket, recursive=True):
                total += obj.size or 0
            return total

        return await asyncio.to_thread(_sum)

    async def delete_prefix(self, prefix: str) -> int:
        """Delete all objects under *prefix*. Returns count of deleted objects."""
        await self.ensure_bucket()

        def _del_prefix() -> int:
            objects = list(self._client.list_objects(self._bucket, prefix=prefix, recursive=True))
            for obj in objects:
                self._client.remove_object(self._bucket, obj.object_name)
            return len(objects)

        return await asyncio.to_thread(_del_prefix)


__all__ = [
    "MinIOSettings",
    "MinIOStorage",
    "episode_script_key",
    "chunk_take_key",
    "chunk_transcript_key",
    "chunk_subtitle_key",
    "final_wav_key",
    "final_srt_key",
    "chunk_log_key",
]
