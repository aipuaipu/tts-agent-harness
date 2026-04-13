/**
 * Fixture trace.jsonl samples for developing the per-chunk pipeline widget
 * without running real scripts. These match the event schema in
 * scripts/events.js exactly.
 *
 * Three scenarios:
 *   - ALL_OK:       every chunk passes every stage
 *   - PARTIAL_FAIL: some chunks fail at p2v (char ratio mismatch)
 *   - WITH_RETRY:   one chunk failed p2 once then succeeded on attempt 2
 */

export interface TraceEvent {
  ts: string;
  type: "stage.start" | "stage.end";
  chunkId: string;
  stage: "p2" | "p2c" | "p2v" | "p5";
  attempt?: number;
  status?: "ok" | "fail";
  durationMs?: number;
  error?: string;
}

const T0 = new Date("2026-04-09T10:00:00.000Z").getTime();
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function stage(
  chunkId: string,
  stage: TraceEvent["stage"],
  startMs: number,
  durationMs: number,
  status: "ok" | "fail" = "ok",
  error?: string,
  attempt = 1,
): TraceEvent[] {
  const start: TraceEvent = {
    ts: iso(startMs),
    type: "stage.start",
    chunkId,
    stage,
    attempt,
  };
  const end: TraceEvent = {
    ts: iso(startMs + durationMs),
    type: "stage.end",
    chunkId,
    stage,
    status,
    durationMs,
  };
  if (error) end.error = error;
  return [start, end];
}

// ────────────────────────────────────────────────────────────
// Scenario 1: all chunks pass every stage
// ────────────────────────────────────────────────────────────
export const TRACE_ALL_OK: TraceEvent[] = [
  ...stage("shot01_chunk01", "p2", 0, 4200),
  ...stage("shot01_chunk02", "p2", 100, 5000),
  ...stage("shot01_chunk01", "p2c", 4300, 50),
  ...stage("shot01_chunk02", "p2c", 5200, 50),
  ...stage("shot01_chunk01", "p2v", 6000, 2500),
  ...stage("shot01_chunk02", "p2v", 8600, 2300),
  ...stage("shot01_chunk01", "p5", 11500, 200),
  ...stage("shot01_chunk02", "p5", 11800, 200),
];

// ────────────────────────────────────────────────────────────
// Scenario 2: chunk02 fails p2v (char ratio 0.54)
// ────────────────────────────────────────────────────────────
export const TRACE_PARTIAL_FAIL: TraceEvent[] = [
  ...stage("shot01_chunk01", "p2", 0, 4200),
  ...stage("shot01_chunk02", "p2", 100, 5000),
  ...stage("shot01_chunk01", "p2c", 4300, 50),
  ...stage("shot01_chunk02", "p2c", 5200, 50),
  ...stage("shot01_chunk01", "p2v", 6000, 2500),
  ...stage(
    "shot01_chunk02",
    "p2v",
    11000,
    10,
    "fail",
    "char count mismatch — original 166, transcribed 90 (ratio 0.54)",
  ),
  // chunk02 downstream stages never ran
  ...stage("shot01_chunk01", "p5", 11500, 200),
];

// ────────────────────────────────────────────────────────────
// Scenario 3: chunk01 p2 failed on attempt 1, succeeded on attempt 2
// ────────────────────────────────────────────────────────────
export const TRACE_WITH_RETRY: TraceEvent[] = [
  ...stage("shot01_chunk01", "p2", 0, 3000, "fail", "HTTP 500 from Fish API", 1),
  ...stage("shot01_chunk01", "p2", 3500, 4200, "ok", undefined, 2),
  ...stage("shot01_chunk01", "p2c", 7800, 50),
  ...stage("shot01_chunk01", "p2v", 8000, 2500),
  ...stage("shot01_chunk01", "p5", 10800, 200),
];

/** Serialize an array of events to JSONL text (for writing a trace file). */
export function toJsonl(events: TraceEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
