"""Unit tests for server.flows.repair.decide_repair — pure function, no DB."""

from __future__ import annotations

import pytest

from server.core.domain import P2vResult, RepairAction, RepairConfig
from server.flows.repair import decide_repair


def _fail_result(chunk_id: str = "chunk-01", char_ratio: float = 0.5) -> P2vResult:
    """Convenience factory for a failed P2vResult."""
    return P2vResult(
        chunk_id=chunk_id,
        verdict="fail",
        char_ratio=char_ratio,
        transcript_uri="s3://bucket/transcript.json",
        transcribed_text="transcribed",
        original_text="original",
    )


DEFAULT_PARAMS = {"temperature": 0.7, "top_p": 0.7}


class TestDecideRepair:
    """7 test cases covering L0/L1 strategy + edge cases."""

    def test_l0_first_attempt_returns_retry_level0(self):
        """L0 first attempt: should retry at level 0, no param changes."""
        config = RepairConfig()  # defaults: [2, 2, 1], max_total=5
        result = decide_repair(
            attempt=1, level=0, p2v_result=_fail_result(),
            config=config, current_params=DEFAULT_PARAMS,
        )
        assert result.action == "retry"
        assert result.level == 0
        assert result.params_override is None

    def test_l0_exhausted_escalates_to_l1(self):
        """L0 budget used up: should escalate to L1 with temperature=0.3."""
        config = RepairConfig()  # L0 budget = 2
        result = decide_repair(
            attempt=2, level=0, p2v_result=_fail_result(),
            config=config, current_params=DEFAULT_PARAMS,
        )
        assert result.action == "retry"
        assert result.level == 1
        assert result.params_override is not None
        assert result.params_override["temperature"] == 0.3

    def test_l1_second_attempt_lowers_top_p(self):
        """L1 second attempt: should lower top_p to 0.5."""
        config = RepairConfig()  # L0=2, L1=2
        # After 2 L0 + 1 L1 = attempt 3, level already at 1
        result = decide_repair(
            attempt=3, level=1, p2v_result=_fail_result(),
            config=config, current_params={**DEFAULT_PARAMS, "temperature": 0.3},
        )
        assert result.action == "retry"
        assert result.level == 1
        assert result.params_override is not None
        assert result.params_override["top_p"] == 0.5

    def test_l1_exhausted_stops_when_l2_disabled(self):
        """L1 budget used up + L2 disabled: should stop."""
        config = RepairConfig()  # L2 disabled by default
        # L0=2, L1=2 → L1 exhausted at attempt=4
        result = decide_repair(
            attempt=4, level=1, p2v_result=_fail_result(),
            config=config, current_params=DEFAULT_PARAMS,
        )
        assert result.action == "stop"

    def test_max_total_attempts_forces_stop(self):
        """Total attempt ceiling reached: always stop."""
        config = RepairConfig(max_total_attempts=3)
        result = decide_repair(
            attempt=3, level=0, p2v_result=_fail_result(),
            config=config, current_params=DEFAULT_PARAMS,
        )
        assert result.action == "stop"
        assert "max total attempts" in result.reason

    def test_all_levels_disabled_stops_immediately(self):
        """All levels disabled: should stop on first failure."""
        config = RepairConfig(
            level_0_enabled=False,
            level_1_enabled=False,
            level_2_enabled=False,
        )
        result = decide_repair(
            attempt=1, level=0, p2v_result=_fail_result(),
            config=config, current_params=DEFAULT_PARAMS,
        )
        assert result.action == "stop"

    def test_custom_config_small_budgets(self):
        """Custom config [1, 1, 0]: L0 exhausted after 1, L1 after 1."""
        config = RepairConfig(
            max_attempts_per_level=[1, 1, 0],
            max_total_attempts=5,
        )
        # attempt=1, level=0 → L0 budget=1, already at limit → escalate to L1
        r1 = decide_repair(
            attempt=1, level=0, p2v_result=_fail_result(),
            config=config, current_params=DEFAULT_PARAMS,
        )
        assert r1.action == "retry"
        assert r1.level == 1
        assert r1.params_override is not None

        # attempt=2, level=1 → L1 budget=1, l1_used = 2-1=1 → exhausted → stop
        r2 = decide_repair(
            attempt=2, level=1, p2v_result=_fail_result(),
            config=config, current_params=DEFAULT_PARAMS,
        )
        assert r2.action == "stop"
