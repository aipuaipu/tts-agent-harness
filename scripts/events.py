"""
Python mirror of scripts/events.js — per-chunk pipeline events + stage logs.

Keep the contract identical to events.js:
- trace.jsonl is append-only
- event types: stage.start / stage.end
- valid stages: p2 | p2c | p2v | p5
- per-chunk log path: .work/<ep>/logs/<cid>/<stage>.log

Usage:
    from events import emit_stage_start, emit_stage_end, open_stage_log

    log_file = open_stage_log(work_dir, chunk_id, "p3")
    emit_stage_start(trace_path, chunk_id, "p3", attempt=1)
    try:
        # ... work ...
        emit_stage_end(trace_path, chunk_id, "p3", "ok", duration_ms=1234)
    except Exception as e:
        emit_stage_end(trace_path, chunk_id, "p3", "fail", error=str(e))
"""

import json
import os
from datetime import datetime, timezone

VALID_STAGES = ("p2", "p2c", "p3", "p2v", "p5")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def _append_jsonl(path: str, obj: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def emit_stage_start(trace_path: str, chunk_id: str, stage: str, attempt: int = 1) -> None:
    if stage not in VALID_STAGES:
        raise ValueError(f"invalid stage: {stage}")
    _append_jsonl(
        trace_path,
        {
            "ts": _now_iso(),
            "type": "stage.start",
            "chunkId": chunk_id,
            "stage": stage,
            "attempt": attempt,
        },
    )


def emit_stage_end(
    trace_path: str,
    chunk_id: str,
    stage: str,
    status: str,
    duration_ms: int | None = None,
    error: str | None = None,
) -> None:
    if stage not in VALID_STAGES:
        raise ValueError(f"invalid stage: {stage}")
    if status not in ("ok", "fail"):
        raise ValueError(f"invalid status: {status}")
    entry: dict = {
        "ts": _now_iso(),
        "type": "stage.end",
        "chunkId": chunk_id,
        "stage": stage,
        "status": status,
    }
    if duration_ms is not None:
        entry["durationMs"] = int(duration_ms)
    if error:
        entry["error"] = str(error)[:500]
    _append_jsonl(trace_path, entry)


def open_stage_log(work_dir: str, chunk_id: str, stage: str) -> str:
    """Return absolute path to logs/<cid>/<stage>.log, truncating it."""
    if stage not in VALID_STAGES:
        raise ValueError(f"invalid stage: {stage}")
    log_dir = os.path.join(work_dir, "logs", chunk_id)
    os.makedirs(log_dir, exist_ok=True)
    p = os.path.join(log_dir, f"{stage}.log")
    open(p, "w").close()  # truncate
    return p


def append_stage_log(log_file: str, text: str) -> None:
    if not log_file:
        return
    if not text.endswith("\n"):
        text += "\n"
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(text)


# ============================================================
# Trace compaction (mirror of events.js compactTrace/maybeCompactTrace)
# ============================================================


def compact_trace(trace_path: str) -> dict:
    """Compact trace.jsonl in place, keeping only latest (chunk, stage) pair
    per group plus latest pipeline.cost per stage plus any other events.

    Atomic write via .tmp + rename.
    Returns {"before": int, "after": int}.
    """
    if not os.path.exists(trace_path):
        return {"before": 0, "after": 0}

    with open(trace_path, "r", encoding="utf-8") as f:
        raw = f.read()

    parsed = []
    before = 0
    for line in raw.split("\n"):
        if not line.strip():
            continue
        before += 1
        try:
            parsed.append(json.loads(line))
        except Exception:
            # drop malformed
            pass

    stage_groups: dict[str, list] = {}
    other_events: list = []
    cost_by_stage: dict[str, dict] = {}

    for ev in parsed:
        t = ev.get("type") if isinstance(ev, dict) else None
        if t in ("stage.start", "stage.end"):
            cid = ev.get("chunkId")
            stg = ev.get("stage")
            if not isinstance(cid, str) or not isinstance(stg, str):
                other_events.append(ev)
                continue
            key = f"{cid}::{stg}"
            stage_groups.setdefault(key, []).append(ev)
        elif t == "pipeline.cost":
            stg = ev.get("stage") if isinstance(ev.get("stage"), str) else "_"
            prev = cost_by_stage.get(stg)
            if prev is None or str(ev.get("ts") or "") >= str(prev.get("ts") or ""):
                cost_by_stage[stg] = ev
        else:
            other_events.append(ev)

    kept_stage_events = []
    for _, evs in stage_groups.items():
        sorted_evs = sorted(evs, key=lambda e: str(e.get("ts") or ""))
        max_attempt = 0
        for ev in sorted_evs:
            if ev.get("type") == "stage.start":
                a = ev.get("attempt", 1)
                if isinstance(a, (int, float)) and a > max_attempt:
                    max_attempt = int(a)

        if max_attempt == 0:
            last_end = None
            for ev in sorted_evs:
                if ev.get("type") == "stage.end":
                    last_end = ev
            if last_end is not None:
                kept_stage_events.append(last_end)
            continue

        last_start_idx = -1
        for i in range(len(sorted_evs) - 1, -1, -1):
            ev = sorted_evs[i]
            if ev.get("type") == "stage.start":
                a = ev.get("attempt", 1)
                if isinstance(a, (int, float)) and int(a) == max_attempt:
                    last_start_idx = i
                    break
        if last_start_idx < 0:
            continue

        kept_stage_events.append(sorted_evs[last_start_idx])
        for i in range(last_start_idx + 1, len(sorted_evs)):
            if sorted_evs[i].get("type") == "stage.end":
                kept_stage_events.append(sorted_evs[i])
                break

    final_events = kept_stage_events + other_events + list(cost_by_stage.values())
    final_events.sort(key=lambda e: str(e.get("ts") or "") if isinstance(e, dict) else "")

    out_lines = [json.dumps(e, ensure_ascii=False) for e in final_events]
    body = ("\n".join(out_lines) + "\n") if out_lines else ""

    tmp_path = trace_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(body)
    os.replace(tmp_path, trace_path)

    return {"before": before, "after": len(final_events)}


def maybe_compact_trace(trace_path: str, threshold: int = 5000) -> dict:
    """Compact trace.jsonl if line count >= threshold. Cheap early-return via
    file-size heuristic. Safe to call frequently."""
    try:
        if not os.path.exists(trace_path):
            return {"before": 0, "after": 0, "compacted": False}
        size = os.path.getsize(trace_path)
        if size < threshold * 120:
            return {"before": 0, "after": 0, "compacted": False}
        with open(trace_path, "r", encoding="utf-8") as f:
            raw = f.read()
        line_count = sum(1 for line in raw.split("\n") if line.strip())
        if line_count < threshold:
            return {"before": line_count, "after": line_count, "compacted": False}
        res = compact_trace(trace_path)
        res["compacted"] = True
        return res
    except Exception as e:
        return {"before": 0, "after": 0, "compacted": False, "error": str(e)}
