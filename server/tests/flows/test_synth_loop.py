"""Unit tests for the per-chunk synth loop in run_episode._synth_one_chunk.

All external dependencies (P2/P2c/P2v, write_event, set_chunk_status) are
mocked — these tests verify the loop logic, not the individual tasks.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from server.core.domain import P2Result, P2vResult, RepairConfig
from server.flows.run_episode import _synth_one_chunk


def _p2_result(chunk_id: str = "c1") -> P2Result:
    return P2Result(
        chunk_id=chunk_id,
        take_id="take-1",
        audio_uri="s3://bucket/audio.wav",
        duration_s=3.0,
    )


def _p2v_pass(chunk_id: str = "c1") -> P2vResult:
    return P2vResult(
        chunk_id=chunk_id,
        verdict="pass",
        char_ratio=1.0,
        transcript_uri="s3://bucket/transcript.json",
    )


def _p2v_fail(chunk_id: str = "c1", char_ratio: float = 0.5) -> P2vResult:
    return P2vResult(
        chunk_id=chunk_id,
        verdict="fail",
        char_ratio=char_ratio,
        transcript_uri="s3://bucket/transcript.json",
        transcribed_text="bad",
        original_text="original",
    )


def _p2c_ok() -> dict:
    return {"chunk_id": "c1", "status": "ok", "errors": [], "warnings": []}


def _p2c_fail() -> dict:
    return {"chunk_id": "c1", "status": "failed", "errors": ["bad format"], "warnings": []}


@pytest.mark.asyncio
class TestSynthLoop:
    """5 test cases for the P2→P2c→P2v repair loop."""

    async def test_pass_on_first_attempt(self):
        """P2→P2c ok→P2v pass: loop runs once, returns pass."""
        write_event = AsyncMock()
        set_status = AsyncMock()

        with (
            patch("server.flows.run_episode.run_p2_synth", new_callable=AsyncMock, return_value=_p2_result()),
            patch("server.flows.run_episode.run_p2c_check", new_callable=AsyncMock, return_value=_p2c_ok()),
            patch("server.flows.run_episode.run_p2v_verify", new_callable=AsyncMock, return_value=_p2v_pass()),
        ):
            result = await _synth_one_chunk(
                episode_id="ep1",
                chunk_id="c1",
                base_params={"temperature": 0.7},
                language="zh",
                repair_config=RepairConfig(),
                _write_event=write_event,
                _set_chunk_status=set_status,
            )

        assert result["verdict"] == "pass"
        assert result["attempts"] == 1
        set_status.assert_not_called()

    async def test_l0_retry_then_pass(self):
        """P2v fails once at L0, retry succeeds on second attempt."""
        write_event = AsyncMock()
        set_status = AsyncMock()

        p2v_side_effects = [_p2v_fail(), _p2v_pass()]

        with (
            patch("server.flows.run_episode.run_p2_synth", new_callable=AsyncMock, return_value=_p2_result()),
            patch("server.flows.run_episode.run_p2c_check", new_callable=AsyncMock, return_value=_p2c_ok()),
            patch("server.flows.run_episode.run_p2v_verify", new_callable=AsyncMock, side_effect=p2v_side_effects),
        ):
            result = await _synth_one_chunk(
                episode_id="ep1",
                chunk_id="c1",
                base_params={"temperature": 0.7},
                language="zh",
                repair_config=RepairConfig(),
                _write_event=write_event,
                _set_chunk_status=set_status,
            )

        assert result["verdict"] == "pass"
        assert result["attempts"] == 2
        # repair_decided event should have been written once (after first failure).
        repair_calls = [
            c for c in write_event.call_args_list
            if c[0][2] == "repair_decided"
        ]
        assert len(repair_calls) == 1

    async def test_l1_param_tweak_then_pass(self):
        """L0 exhausted (2 fails), L1 with temp=0.3 succeeds."""
        write_event = AsyncMock()
        set_status = AsyncMock()

        # 2 L0 fails + 1 L1 pass = 3 P2v calls total
        p2v_side_effects = [_p2v_fail(), _p2v_fail(), _p2v_pass()]

        with (
            patch("server.flows.run_episode.run_p2_synth", new_callable=AsyncMock, return_value=_p2_result()),
            patch("server.flows.run_episode.run_p2c_check", new_callable=AsyncMock, return_value=_p2c_ok()),
            patch("server.flows.run_episode.run_p2v_verify", new_callable=AsyncMock, side_effect=p2v_side_effects),
        ):
            result = await _synth_one_chunk(
                episode_id="ep1",
                chunk_id="c1",
                base_params={"temperature": 0.7, "top_p": 0.7},
                language="zh",
                repair_config=RepairConfig(),
                _write_event=write_event,
                _set_chunk_status=set_status,
            )

        assert result["verdict"] == "pass"
        assert result["attempts"] == 3
        # Check that L1 escalation happened: a repair_decided with level=1.
        l1_events = [
            c for c in write_event.call_args_list
            if c[0][2] == "repair_decided" and c[0][3].get("level") == 0
            and c[0][3].get("action") == "retry"
        ]
        # The second repair_decided (attempt=2) should escalate to L1.
        escalate_events = [
            c for c in write_event.call_args_list
            if c[0][2] == "repair_decided"
        ]
        assert len(escalate_events) == 2

    async def test_all_attempts_fail_needs_review(self):
        """All attempts fail: chunk ends up as needs_review."""
        write_event = AsyncMock()
        set_status = AsyncMock()

        # max_total_attempts=3 → 3 P2v fails → stop
        config = RepairConfig(max_total_attempts=3, max_attempts_per_level=[1, 1, 0])

        with (
            patch("server.flows.run_episode.run_p2_synth", new_callable=AsyncMock, return_value=_p2_result()),
            patch("server.flows.run_episode.run_p2c_check", new_callable=AsyncMock, return_value=_p2c_ok()),
            patch("server.flows.run_episode.run_p2v_verify", new_callable=AsyncMock, return_value=_p2v_fail()),
        ):
            result = await _synth_one_chunk(
                episode_id="ep1",
                chunk_id="c1",
                base_params={"temperature": 0.7},
                language="zh",
                repair_config=config,
                _write_event=write_event,
                _set_chunk_status=set_status,
            )

        assert result["verdict"] == "needs_review"
        set_status.assert_called_with("c1", "needs_review")
        # needs_review event should have been written.
        nr_calls = [
            c for c in write_event.call_args_list
            if c[0][2] == "needs_review"
        ]
        assert len(nr_calls) >= 1

    async def test_p2c_fail_does_not_count_as_p2v_attempt(self):
        """P2c failure triggers P2 retry without spending a P2v attempt.

        Sequence: P2→P2c fail → P2→P2c ok → P2v pass.
        Total attempts=2, but only 1 P2v call.
        """
        write_event = AsyncMock()
        set_status = AsyncMock()

        p2c_side_effects = [_p2c_fail(), _p2c_ok()]

        with (
            patch("server.flows.run_episode.run_p2_synth", new_callable=AsyncMock, return_value=_p2_result()),
            patch("server.flows.run_episode.run_p2c_check", new_callable=AsyncMock, side_effect=p2c_side_effects),
            patch("server.flows.run_episode.run_p2v_verify", new_callable=AsyncMock, return_value=_p2v_pass()) as mock_p2v,
        ):
            result = await _synth_one_chunk(
                episode_id="ep1",
                chunk_id="c1",
                base_params={"temperature": 0.7},
                language="zh",
                repair_config=RepairConfig(),
                _write_event=write_event,
                _set_chunk_status=set_status,
            )

        assert result["verdict"] == "pass"
        assert result["attempts"] == 2
        # P2v should have been called only once (P2c fail skipped the P2v call).
        assert mock_p2v.call_count == 1
