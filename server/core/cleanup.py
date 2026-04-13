"""Storage cleanup — delete oldest unlocked episodes when quota exceeded.

Best-effort: failures are logged but never propagate to callers.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .repositories import EpisodeRepo
from .storage import MinIOStorage

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


async def cleanup_storage(
    session: AsyncSession,
    storage: MinIOStorage,
    quota_bytes: int,
    target_bytes: int,
) -> list[str]:
    """Delete oldest unlocked episodes until storage drops below *target_bytes*.

    Returns list of deleted episode IDs.
    """
    current = await storage.get_bucket_size_bytes()
    if current <= quota_bytes:
        _log.debug("storage %d bytes <= quota %d, skip cleanup", current, quota_bytes)
        return []

    _log.info("storage %d bytes > quota %d, starting cleanup (target %d)", current, quota_bytes, target_bytes)

    repo = EpisodeRepo(session)
    candidates = await repo.list_unlocked_oldest_first()

    deleted_ids: list[str] = []
    for ep in candidates:
        if current <= target_bytes:
            break
        prefix = f"episodes/{ep.id}/"
        n = await storage.delete_prefix(prefix)
        await repo.delete(ep.id)
        await session.flush()
        _log.info("cleaned up episode %s (%d objects)", ep.id, n)
        deleted_ids.append(ep.id)
        current = await storage.get_bucket_size_bytes()

    if deleted_ids:
        await session.commit()

    return deleted_ids


# ---------------------------------------------------------------------------
# Fire-and-forget trigger (called from create_episode route)
# ---------------------------------------------------------------------------

_GB = 1024 ** 3


async def cleanup_if_needed(
    session_factory: async_sessionmaker[AsyncSession],
    storage: MinIOStorage,
) -> None:
    """Run cleanup check. Swallows all exceptions (best-effort)."""
    try:
        quota = int(float(os.environ.get("STORAGE_QUOTA_GB", "5")) * _GB)
        target = int(float(os.environ.get("STORAGE_TARGET_GB", "4")) * _GB)
        async with session_factory() as session:
            deleted = await cleanup_storage(session, storage, quota, target)
            if deleted:
                _log.info("cleanup deleted %d episodes: %s", len(deleted), deleted)
    except Exception:
        _log.exception("cleanup_if_needed failed (best-effort, continuing)")
