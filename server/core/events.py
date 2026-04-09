"""Event persistence + Postgres LISTEN/NOTIFY bridge.

The business-side events are written to the ``events`` table (see ADR-001
§5.1). On Postgres we additionally fire ``pg_notify('episode_events', ...)``
**inside the same transaction**, so that a ``LISTEN episode_events`` client
(the FastAPI SSE endpoint) wakes up exactly when the row becomes visible to
other sessions.

On SQLite (dev / CI), ``pg_notify`` is a no-op — the row is still written so
that repository-level tests can assert on ``events`` contents without Postgres.

The canonical channel name is ``episode_events`` and the payload JSON shape
is ``{"ep": <episode_id>, "id": <event row id>}`` — this matches ADR-001 §5.1
("FastAPI 收到通知后用 id 反查具体 payload").
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Event

NOTIFY_CHANNEL = "episode_events"


def _is_postgres(session: AsyncSession) -> bool:
    bind = session.get_bind()
    return bind.dialect.name == "postgresql"


async def write_event(
    session: AsyncSession,
    *,
    episode_id: str,
    chunk_id: str | None,
    kind: str,
    payload: dict[str, Any],
) -> int:
    """Insert an event row and (on Postgres) fire ``pg_notify`` in the same tx.

    The caller owns the transaction boundary: this function does not commit.
    Returns the newly-assigned event ``id``.
    """
    row = Event(
        episode_id=episode_id,
        chunk_id=chunk_id,
        kind=kind,
        payload=payload,
    )
    session.add(row)
    await session.flush()  # materialise the autoincrement id

    if _is_postgres(session):
        notify_payload = json.dumps({"ep": episode_id, "id": row.id})
        # NOTE: ``pg_notify`` is a builtin function — this is the only place
        # where we touch a SQL function by name, and it is explicitly allowed
        # because LISTEN/NOTIFY has no ORM equivalent.
        await session.execute(
            text("SELECT pg_notify(:channel, :payload)"),
            {"channel": NOTIFY_CHANNEL, "payload": notify_payload},
        )

    return row.id


__all__ = ["write_event", "NOTIFY_CHANNEL"]
