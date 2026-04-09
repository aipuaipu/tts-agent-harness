"""Repository unit tests — SQLite in-memory.

Coverage target: every public method of every repo, at least 3 cases each
(happy path / boundary / error) where a meaningful error path exists.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from server.core.domain import (
    ChunkEdit,
    ChunkInput,
    EpisodeCreate,
    TakeAppend,
)
from server.core.repositories import (
    ChunkRepo,
    EpisodeRepo,
    EventRepo,
    StageRunRepo,
    TakeRepo,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_episode(session, ep_id="ep-demo") -> str:
    repo = EpisodeRepo(session)
    await repo.create(
        EpisodeCreate(
            id=ep_id,
            title="Demo Episode",
            description="desc",
            script_uri=f"s3://tts-harness/episodes/{ep_id}/script.json",
            config={"p2": {"speed": 1.15}},
            metadata={"owner": "alex"},
        )
    )
    await session.commit()
    return ep_id


async def _make_chunks(session, ep_id: str, n: int = 3) -> list[str]:
    repo = ChunkRepo(session)
    chunks = [
        ChunkInput(
            id=f"{ep_id}:shot01:{i}",
            episode_id=ep_id,
            shot_id="shot01",
            idx=i,
            text=f"text {i}",
            text_normalized=f"text {i}",
            char_count=len(f"text {i}"),
            metadata={},
        )
        for i in range(n)
    ]
    await repo.bulk_insert(chunks)
    await session.commit()
    return [c.id for c in chunks]


# ---------------------------------------------------------------------------
# EpisodeRepo
# ---------------------------------------------------------------------------


class TestEpisodeRepo:
    async def test_create_and_get(self, session):
        repo = EpisodeRepo(session)
        ep = await repo.create(
            EpisodeCreate(
                id="ep1",
                title="T",
                script_uri="s3://b/k",
            )
        )
        await session.commit()
        assert ep.id == "ep1"
        fetched = await repo.get("ep1")
        assert fetched is not None
        assert fetched.title == "T"
        assert fetched.status == "empty"

    async def test_list_excludes_archived_by_default(self, session):
        repo = EpisodeRepo(session)
        await repo.create(EpisodeCreate(id="a", title="A", script_uri="s3://b/a"))
        await repo.create(EpisodeCreate(id="b", title="B", script_uri="s3://b/b"))
        await session.commit()
        await repo.archive("a")
        await session.commit()

        active = await repo.list()
        assert {e.id for e in active} == {"b"}
        all_ = await repo.list(include_archived=True)
        assert {e.id for e in all_} == {"a", "b"}

    async def test_delete_missing_returns_false(self, session):
        repo = EpisodeRepo(session)
        assert (await repo.delete("nope")) is False

    async def test_set_status_transitions(self, session):
        repo = EpisodeRepo(session)
        await repo.create(EpisodeCreate(id="ep1", title="T", script_uri="s3://b/k"))
        await session.commit()
        ok = await repo.set_status("ep1", "running")
        assert ok is True
        ep = await repo.get("ep1")
        assert ep is not None and ep.status == "running"
        assert (await repo.set_status("missing", "done")) is False


# ---------------------------------------------------------------------------
# ChunkRepo
# ---------------------------------------------------------------------------


class TestChunkRepo:
    async def test_bulk_insert_and_list(self, session):
        ep = await _make_episode(session)
        ids = await _make_chunks(session, ep, n=3)
        repo = ChunkRepo(session)
        chunks = await repo.list_by_episode(ep)
        assert [c.id for c in chunks] == ids

    async def test_apply_edits_atomic(self, session):
        ep = await _make_episode(session)
        ids = await _make_chunks(session, ep, n=2)
        repo = ChunkRepo(session)
        await repo.apply_edits(
            [
                ChunkEdit(chunk_id=ids[0], text_normalized="hello world"),
                ChunkEdit(chunk_id=ids[1], subtitle_text="sub"),
            ]
        )
        await session.commit()
        c0 = await repo.get(ids[0])
        c1 = await repo.get(ids[1])
        assert c0 is not None and c0.text_normalized == "hello world"
        assert c0.char_count == len("hello world")
        assert c0.last_edited_at is not None
        assert c1 is not None and c1.subtitle_text == "sub"

    async def test_apply_edits_rollback_on_missing_id(self, session):
        ep = await _make_episode(session)
        ids = await _make_chunks(session, ep, n=1)
        repo = ChunkRepo(session)
        with pytest.raises(LookupError):
            await repo.apply_edits(
                [
                    ChunkEdit(chunk_id=ids[0], text_normalized="ok"),
                    ChunkEdit(chunk_id="missing", text_normalized="nope"),
                ]
            )
        # The savepoint rolled back — no edit should have landed.
        c0 = await repo.get(ids[0])
        assert c0 is not None
        assert c0.text_normalized == "text 0"
        assert c0.last_edited_at is None

    async def test_set_status_and_selected_take(self, session):
        ep = await _make_episode(session)
        ids = await _make_chunks(session, ep, n=1)
        repo = ChunkRepo(session)
        assert await repo.set_status(ids[0], "synth_done")
        assert await repo.set_selected_take(ids[0], "take-xyz")
        c = await repo.get(ids[0])
        assert c is not None
        assert c.status == "synth_done"
        assert c.selected_take_id == "take-xyz"


# ---------------------------------------------------------------------------
# TakeRepo
# ---------------------------------------------------------------------------


class TestTakeRepo:
    async def test_append_and_list(self, session):
        ep = await _make_episode(session)
        ids = await _make_chunks(session, ep, n=1)
        repo = TakeRepo(session)
        for i in range(3):
            await repo.append(
                TakeAppend(
                    id=f"take-{i}",
                    chunk_id=ids[0],
                    audio_uri=f"s3://b/{i}.wav",
                    duration_s=1.5 + i,
                )
            )
        await session.commit()
        rows = await repo.list_by_chunk(ids[0])
        assert [r.id for r in rows] == ["take-0", "take-1", "take-2"]

    async def test_select_missing_returns_none(self, session):
        repo = TakeRepo(session)
        assert (await repo.select("nope")) is None

    async def test_remove(self, session):
        ep = await _make_episode(session)
        ids = await _make_chunks(session, ep, n=1)
        repo = TakeRepo(session)
        await repo.append(
            TakeAppend(id="t1", chunk_id=ids[0], audio_uri="s3://b/t.wav", duration_s=1.0)
        )
        await session.commit()
        assert (await repo.remove("t1")) is True
        assert (await repo.remove("t1")) is False


# ---------------------------------------------------------------------------
# StageRunRepo
# ---------------------------------------------------------------------------


class TestStageRunRepo:
    async def test_upsert_creates_then_updates(self, session):
        ep = await _make_episode(session)
        ids = await _make_chunks(session, ep, n=1)
        repo = StageRunRepo(session)
        started = datetime.now(timezone.utc)
        row = await repo.upsert(
            chunk_id=ids[0],
            stage="p2",
            status="running",
            started_at=started,
            attempt=1,
        )
        await session.commit()
        assert row.status == "running"
        row2 = await repo.upsert(
            chunk_id=ids[0], stage="p2", status="ok", duration_ms=1234
        )
        await session.commit()
        assert row2.status == "ok"
        assert row2.duration_ms == 1234
        # Still attempt=1 (not overridden).
        assert row2.attempt == 1

    async def test_get_missing_returns_none(self, session):
        repo = StageRunRepo(session)
        assert (await repo.get("nope", "p2")) is None

    async def test_list_by_chunk(self, session):
        ep = await _make_episode(session)
        ids = await _make_chunks(session, ep, n=1)
        repo = StageRunRepo(session)
        for stage in ("p2", "p3", "p5"):
            await repo.upsert(chunk_id=ids[0], stage=stage, status="ok")
        await session.commit()
        rows = await repo.list_by_chunk(ids[0])
        assert [r.stage for r in rows] == ["p2", "p3", "p5"]


# ---------------------------------------------------------------------------
# EventRepo
# ---------------------------------------------------------------------------


class TestEventRepo:
    async def test_write_and_list_since(self, session):
        ep = await _make_episode(session)
        repo = EventRepo(session)
        id1 = await repo.write(
            episode_id=ep,
            chunk_id=None,
            kind="episode_created",
            payload={"title": "demo"},
        )
        id2 = await repo.write(
            episode_id=ep,
            chunk_id=f"{ep}:shot01:0",
            kind="stage_started",
            payload={"stage": "p2"},
        )
        await session.commit()
        assert id1 > 0 and id2 > id1
        rows = await repo.list_since(ep, after_id=0)
        assert [r.kind for r in rows] == ["episode_created", "stage_started"]
        partial = await repo.list_since(ep, after_id=id1)
        assert [r.id for r in partial] == [id2]

    async def test_count(self, session):
        ep = await _make_episode(session)
        repo = EventRepo(session)
        for _ in range(5):
            await repo.write(
                episode_id=ep, chunk_id=None, kind="stage_started", payload={}
            )
        await session.commit()
        assert await repo.count(ep) == 5
        assert await repo.count("other") == 0

    async def test_write_is_noop_for_notify_on_sqlite(self, session):
        """On SQLite, NOTIFY is skipped — the row is still written cleanly."""
        ep = await _make_episode(session)
        repo = EventRepo(session)
        new_id = await repo.write(
            episode_id=ep,
            chunk_id=None,
            kind="stage_finished",
            payload={"result": "ok"},
        )
        await session.commit()
        rows = await repo.list_since(ep, after_id=0)
        assert len(rows) == 1
        assert rows[0].id == new_id
