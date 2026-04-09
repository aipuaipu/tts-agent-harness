"""Pydantic v2 schemas — the single source of truth for API + flow contracts.

This module MUST NOT contain business logic. Only data shapes. All models use
``ConfigDict(from_attributes=True)`` so that they can be produced directly from
SQLAlchemy ORM instances via ``Model.model_validate(orm_obj)``.

Naming convention
-----------------
- ``*Input`` / ``*Create`` / ``*Edit`` / ``*Append`` — write-side payloads
- ``*View``                                            — read-side projections
- ``P{n}Result``                                       — pipeline stage results
- ``StageEvent``                                       — SSE / NOTIFY payload
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Common type aliases
# ---------------------------------------------------------------------------

EpisodeStatus = Literal["empty", "ready", "running", "failed", "done"]
ChunkStatus = Literal["pending", "synth_done", "transcribed", "failed"]
StageName = Literal["p1", "p2", "check2", "p3", "check3", "p5", "p6"]
StageStatus = Literal["pending", "running", "ok", "failed"]
EventKind = Literal[
    "stage_started",
    "stage_finished",
    "stage_failed",
    "stage_retry",
    "take_appended",
    "take_finalized",
    "chunk_edited",
    "episode_created",
    "episode_status_changed",
]


class _ORM(BaseModel):
    """Base class for ORM-backed read models."""

    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Write-side payloads
# ---------------------------------------------------------------------------


class EpisodeCreate(BaseModel):
    """Input for creating a new episode."""

    id: str
    title: str
    description: str | None = None
    script_uri: str
    config: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ChunkInput(BaseModel):
    """Shape consumed by P1 → DB (one row per chunk)."""

    id: str
    episode_id: str
    shot_id: str
    idx: int
    text: str
    text_normalized: str
    subtitle_text: str | None = None
    char_count: int
    boundary_hash: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ChunkEdit(BaseModel):
    """User edit applied to a chunk. All fields optional — sparse update."""

    chunk_id: str
    text: str | None = None
    text_normalized: str | None = None
    subtitle_text: str | None = None
    metadata: dict[str, Any] | None = None


class TakeAppend(BaseModel):
    """Payload for appending a new take after a P2 synth."""

    id: str
    chunk_id: str
    audio_uri: str
    duration_s: float
    params: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Read-side views
# ---------------------------------------------------------------------------


class TakeView(_ORM):
    id: str
    chunk_id: str
    audio_uri: str
    duration_s: float
    params: dict[str, Any]
    created_at: datetime


class StageRunView(_ORM):
    chunk_id: str
    stage: str
    status: StageStatus
    attempt: int
    started_at: datetime | None
    finished_at: datetime | None
    duration_ms: int | None
    error: str | None
    log_uri: str | None
    prefect_task_run_id: UUID | None
    stale: bool


class ChunkView(_ORM):
    id: str
    episode_id: str
    shot_id: str
    idx: int
    text: str
    text_normalized: str
    subtitle_text: str | None
    status: ChunkStatus
    selected_take_id: str | None
    boundary_hash: str | None
    char_count: int
    last_edited_at: datetime | None
    extra_metadata: dict[str, Any] = Field(alias="extra_metadata")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class EpisodeView(_ORM):
    id: str
    title: str
    description: str | None
    status: EpisodeStatus
    script_uri: str
    config: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None
    extra_metadata: dict[str, Any] = Field(alias="extra_metadata")

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class EpisodeSummary(BaseModel):
    """Aggregated view for listing pages."""

    id: str
    title: str
    status: EpisodeStatus
    chunk_count: int
    done_count: int
    failed_count: int
    updated_at: datetime


# ---------------------------------------------------------------------------
# Pipeline stage results (flow-task contracts)
# ---------------------------------------------------------------------------


class P1Result(BaseModel):
    episode_id: str
    chunks: list[ChunkInput]


class P2Result(BaseModel):
    chunk_id: str
    take_id: str
    audio_uri: str
    duration_s: float
    params: dict[str, Any] = Field(default_factory=dict)


class P3Result(BaseModel):
    chunk_id: str
    transcript_uri: str
    word_count: int


class P5Result(BaseModel):
    chunk_id: str
    subtitle_uri: str


class P6Result(BaseModel):
    episode_id: str
    final_audio_uri: str
    final_subtitle_uri: str
    duration_s: float


# ---------------------------------------------------------------------------
# Events (SSE payload)
# ---------------------------------------------------------------------------


class StageEvent(BaseModel):
    """Event broadcast on the `episode_events` NOTIFY channel.

    The ``id`` field is assigned by the DB (bigserial); the producer code
    sets it after insert for convenience.
    """

    id: int | None = None
    episode_id: str
    chunk_id: str | None = None
    kind: EventKind
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


__all__ = [
    # aliases
    "EpisodeStatus",
    "ChunkStatus",
    "StageName",
    "StageStatus",
    "EventKind",
    # write
    "EpisodeCreate",
    "ChunkInput",
    "ChunkEdit",
    "TakeAppend",
    # read
    "TakeView",
    "StageRunView",
    "ChunkView",
    "EpisodeView",
    "EpisodeSummary",
    # stages
    "P1Result",
    "P2Result",
    "P3Result",
    "P5Result",
    "P6Result",
    # events
    "StageEvent",
]
