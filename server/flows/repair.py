"""Repair strategy decision — deterministic rules, no LLM dependency.

Given a P2v verification failure, this module decides what to do next:

- **Level 0 (L0)**: Plain retry — the same parameters, relying on Fish TTS
  randomness to produce a better take.
- **Level 1 (L1)**: Parameter tweak — lower temperature then top_p to reduce
  variance and increase pronunciation stability.
- **Level 2 (L2)**: Text rewrite — Phase 5 future work; currently returns stop.

The function :func:`decide_repair` is a pure function (no DB, no I/O).
"""

from __future__ import annotations

from server.core.domain import P2vResult, RepairAction, RepairConfig


def decide_repair(
    attempt: int,
    level: int,
    p2v_result: P2vResult,
    config: RepairConfig,
    current_params: dict,
) -> RepairAction:
    """Decide the next repair action based on attempt history and config.

    Parameters
    ----------
    attempt : int
        Total attempts so far (1-based, already includes the just-failed one).
    level : int
        Current repair level (0, 1, or 2).
    p2v_result : P2vResult
        The verification result that triggered this decision.
    config : RepairConfig
        Repair budget / feature flags.
    current_params : dict
        Current Fish TTS params dict (may already have L1 overrides).

    Returns
    -------
    RepairAction
        ``action="retry"`` with optional params_override, or ``action="stop"``.
    """
    # Hard ceiling — regardless of level.
    if attempt >= config.max_total_attempts:
        return RepairAction(
            action="stop",
            level=level,
            reason=f"max total attempts reached ({config.max_total_attempts})",
        )

    # --- Level 0: plain retry ---
    if level == 0:
        if not config.level_0_enabled:
            # L0 disabled — try escalating to L1.
            return _escalate_to_l1(attempt, config, current_params, p2v_result)

        l0_max = config.max_attempts_per_level[0] if len(config.max_attempts_per_level) > 0 else 0
        # `attempt` counts from 1 and includes the initial try.
        # L0 retries = attempts at level 0.  The very first attempt is L0 attempt #1.
        # We allow up to l0_max attempts *at L0*.  If attempt <= l0_max, retry.
        if attempt < l0_max:
            return RepairAction(
                action="retry",
                level=0,
                reason=f"L0 retry {attempt + 1}/{l0_max} (TTS randomness)",
            )
        # L0 budget exhausted — escalate.
        return _escalate_to_l1(attempt, config, current_params, p2v_result)

    # --- Level 1: parameter tweak ---
    if level == 1:
        if not config.level_1_enabled:
            return _escalate_to_l2(attempt, config, p2v_result)

        l1_max = config.max_attempts_per_level[1] if len(config.max_attempts_per_level) > 1 else 0
        # How many L1 attempts have we used?
        # L1 starts when level transitions from 0 → 1.  The first L1 call is
        # l1_attempt=1.  We track this externally; here we use a simpler model:
        # the caller bumps ``level`` when escalating, and keeps it at 1 for
        # subsequent L1 retries.  We count L1 attempts as
        #   l1_used = attempt - l0_budget
        l0_budget = config.max_attempts_per_level[0] if len(config.max_attempts_per_level) > 0 else 0
        l1_used = attempt - l0_budget  # 1-based within L1

        if l1_used < l1_max:
            override = _l1_params_for_attempt(l1_used, current_params)
            return RepairAction(
                action="retry",
                level=1,
                params_override=override,
                reason=f"L1 param tweak {l1_used + 1}/{l1_max}: {override}",
            )
        # L1 budget exhausted — escalate.
        return _escalate_to_l2(attempt, config, p2v_result)

    # --- Level 2: text rewrite (future) ---
    if level == 2:
        if not config.level_2_enabled:
            return RepairAction(
                action="stop",
                level=2,
                reason="L2 text rewrite not enabled (Phase 5)",
            )
        # Future: LLM-based text rewrite would go here.
        return RepairAction(
            action="stop",
            level=2,
            reason="L2 text rewrite not yet implemented",
        )

    # Unknown level — stop.
    return RepairAction(action="stop", level=level, reason=f"unknown level {level}")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _escalate_to_l1(
    attempt: int,
    config: RepairConfig,
    current_params: dict,
    p2v_result: P2vResult,
) -> RepairAction:
    """Try to escalate from L0 → L1."""
    if not config.level_1_enabled:
        return _escalate_to_l2(attempt, config, p2v_result)

    l1_max = config.max_attempts_per_level[1] if len(config.max_attempts_per_level) > 1 else 0
    if l1_max <= 0:
        return _escalate_to_l2(attempt, config, p2v_result)

    override = _l1_params_for_attempt(0, current_params)
    return RepairAction(
        action="retry",
        level=1,
        params_override=override,
        reason=f"escalate L0→L1, param tweak 1/{l1_max}: {override}",
    )


def _escalate_to_l2(
    attempt: int,
    config: RepairConfig,
    p2v_result: P2vResult,
) -> RepairAction:
    """Try to escalate from L1 → L2."""
    if not config.level_2_enabled:
        return RepairAction(
            action="stop",
            level=2,
            reason="L1 exhausted, L2 disabled — needs human review",
        )
    # L2 placeholder for Phase 5.
    return RepairAction(
        action="stop",
        level=2,
        reason="L2 text rewrite not yet implemented",
    )


def _l1_params_for_attempt(l1_index: int, current_params: dict) -> dict:
    """Return Fish TTS parameter overrides for the given L1 attempt index.

    - l1_index 0: lower temperature  (0.7 → 0.3)
    - l1_index 1: lower top_p        (0.7 → 0.5)
    - l1_index 2+: both at minimum
    """
    if l1_index == 0:
        return {"temperature": 0.3}
    elif l1_index == 1:
        return {"top_p": 0.5}
    else:
        return {"temperature": 0.3, "top_p": 0.5}


__all__ = ["decide_repair"]
