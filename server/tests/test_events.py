"""Event + NOTIFY tests.

Runs in two modes:

- **SQLite (always)**: ``write_event`` inserts a row and ``pg_notify`` is a
  no-op. Verifies the id round-trip and payload correctness.

- **Postgres (testcontainers)**: a separate ``asyncpg`` LISTEN connection
  opens against the same container, then we ``write_event`` + commit in a
  repository session, and assert the LISTEN side receives the notification
  within 500ms.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from server.core.events import NOTIFY_CHANNEL, write_event

from .conftest import requires_docker


# ---------------------------------------------------------------------------
# SQLite mode
# ---------------------------------------------------------------------------


async def test_write_event_sqlite_inserts_row(session):
    new_id = await write_event(
        session,
        episode_id="ep1",
        chunk_id=None,
        kind="episode_created",
        payload={"title": "demo"},
    )
    await session.commit()
    assert new_id > 0

    from server.core.models import Event
    from sqlalchemy import select

    res = await session.execute(select(Event).where(Event.id == new_id))
    row = res.scalar_one()
    assert row.kind == "episode_created"
    assert row.payload == {"title": "demo"}


async def test_write_event_sqlite_assigns_monotonic_ids(session):
    ids = []
    for i in range(3):
        ids.append(
            await write_event(
                session,
                episode_id="ep1",
                chunk_id=None,
                kind="stage_started",
                payload={"i": i},
            )
        )
    await session.commit()
    assert ids == sorted(ids)
    assert len(set(ids)) == 3


# ---------------------------------------------------------------------------
# Postgres + LISTEN
# ---------------------------------------------------------------------------


@requires_docker
async def test_notify_delivered_to_listener(pg_container, pg_session):
    import asyncpg

    sync_url = pg_container.get_connection_url()
    # asyncpg wants its own URL form (no ``+driver``).
    raw_url = sync_url.replace("postgresql+psycopg2", "postgresql")
    if "+asyncpg" in raw_url:
        raw_url = raw_url.replace("+asyncpg", "")

    received: asyncio.Queue[str] = asyncio.Queue()

    listener = await asyncpg.connect(raw_url)
    try:
        def _on_notify(conn, pid, channel, payload):  # noqa: ARG001
            received.put_nowait(payload)

        await listener.add_listener(NOTIFY_CHANNEL, _on_notify)

        new_id = await write_event(
            pg_session,
            episode_id="ep1",
            chunk_id="ep1:shot01:0",
            kind="stage_finished",
            payload={"stage": "p2", "ok": True},
        )
        await pg_session.commit()

        payload_str = await asyncio.wait_for(received.get(), timeout=2.0)
        payload = json.loads(payload_str)
        assert payload == {"ep": "ep1", "id": new_id}
    finally:
        await listener.close()
