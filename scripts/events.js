/**
 * Event emitter for per-chunk pipeline state.
 *
 * Single source of truth for chunk stage state is the trace.jsonl event stream.
 * Scripts emit stage.start / stage.end events; the web adapter derives state.
 *
 * Also provides per-chunk log file management:
 *   .work/<ep>/logs/<cid>/<stage>.log
 *
 * Usage:
 *   const { emitStageStart, emitStageEnd, openStageLog } = require("./events");
 *
 *   const logFile = openStageLog(workDir, chunkId, "p2");      // truncates + returns abs path
 *   emitStageStart(tracePath, chunkId, "p2", 1);
 *   try {
 *     // ... do work, append to logFile as you go ...
 *     emitStageEnd(tracePath, chunkId, "p2", "ok", { durationMs });
 *   } catch (e) {
 *     emitStageEnd(tracePath, chunkId, "p2", "fail", { error: e.message });
 *   }
 */

const fs = require("fs");
const path = require("path");

const VALID_STAGES = ["p2", "check2", "p3", "check3", "p5"];

function _appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + "\n");
}

function emitStageStart(tracePath, chunkId, stage, attempt = 1) {
  if (!VALID_STAGES.includes(stage)) throw new Error(`invalid stage: ${stage}`);
  _appendJsonl(tracePath, {
    ts: new Date().toISOString(),
    type: "stage.start",
    chunkId,
    stage,
    attempt,
  });
}

/**
 * @param {string} status "ok" | "fail"
 * @param {object} opts { durationMs?, error? }
 */
function emitStageEnd(tracePath, chunkId, stage, status, opts = {}) {
  if (!VALID_STAGES.includes(stage)) throw new Error(`invalid stage: ${stage}`);
  if (status !== "ok" && status !== "fail") throw new Error(`invalid status: ${status}`);
  const entry = {
    ts: new Date().toISOString(),
    type: "stage.end",
    chunkId,
    stage,
    status,
  };
  if (opts.durationMs != null) entry.durationMs = opts.durationMs;
  if (opts.error) entry.error = String(opts.error).slice(0, 500);
  _appendJsonl(tracePath, entry);
}

/**
 * Return absolute path to the per-chunk stage log file. Truncates (clears) it
 * on first open, so retries overwrite old logs.
 *
 * @param {string} workDir  .work/<ep>
 * @param {string} chunkId
 * @param {string} stage
 */
function openStageLog(workDir, chunkId, stage) {
  if (!VALID_STAGES.includes(stage)) throw new Error(`invalid stage: ${stage}`);
  const logDir = path.join(workDir, "logs", chunkId);
  fs.mkdirSync(logDir, { recursive: true });
  const p = path.join(logDir, `${stage}.log`);
  // truncate
  fs.writeFileSync(p, "");
  return p;
}

/** Append a line to a per-chunk stage log (no newline added if text ends with \n). */
function appendStageLog(logFile, text) {
  if (!logFile) return;
  const s = text.endsWith("\n") ? text : text + "\n";
  fs.appendFileSync(logFile, s);
}

// ============================================================
// Trace compaction
// ============================================================
//
// trace.jsonl is append-only, so retries accumulate old stage.start/.end
// pairs. The web UI derives "latest attempt wins" from all events, so old
// pairs are harmless but eventually balloon the file.
//
// compactTrace() rewrites the file keeping only:
//   - The latest (highest attempt, newest ts on ties) stage.start/.end pair
//     per (chunkId, stage).
//   - The latest pipeline.cost event per stage.
//   - Any other non-stage, non-cost event (future-proofing).
//
// Written atomically via tmp-file + rename, safe against concurrent readers.

/**
 * Parse a single trace.jsonl line into an object, or null on malformed line.
 */
function _parseLine(line) {
  const s = line.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Compact a trace.jsonl file in place. Atomic write (.tmp + rename).
 *
 * @param {string} tracePathArg
 * @returns {{before: number, after: number}}
 */
function compactTrace(tracePathArg) {
  if (!fs.existsSync(tracePathArg)) return { before: 0, after: 0 };

  const raw = fs.readFileSync(tracePathArg, "utf-8");
  const lines = raw.split("\n");
  const parsed = [];
  let before = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    before++;
    const obj = _parseLine(line);
    if (obj) parsed.push(obj);
    // malformed lines are dropped silently
  }

  // Group stage events by (chunkId, stage). We'll pair each stage.start
  // with the first stage.end at the same attempt that follows it.
  // Key = `${chunkId}::${stage}`
  const stageGroups = new Map();
  // Non-stage events preserved as-is (except pipeline.cost which we dedupe).
  const otherEvents = [];
  // Latest pipeline.cost per stage
  const costByStage = new Map();

  for (let i = 0; i < parsed.length; i++) {
    const ev = parsed[i];
    const t = ev && ev.type;
    if (t === "stage.start" || t === "stage.end") {
      if (typeof ev.chunkId !== "string" || typeof ev.stage !== "string") {
        otherEvents.push(ev);
        continue;
      }
      const key = `${ev.chunkId}::${ev.stage}`;
      let arr = stageGroups.get(key);
      if (!arr) {
        arr = [];
        stageGroups.set(key, arr);
      }
      arr.push(ev);
    } else if (t === "pipeline.cost") {
      const stage = typeof ev.stage === "string" ? ev.stage : "_";
      const prev = costByStage.get(stage);
      if (!prev || String(ev.ts || "") >= String(prev.ts || "")) {
        costByStage.set(stage, ev);
      }
    } else {
      otherEvents.push(ev);
    }
  }

  // For each (chunkId, stage) pick latest attempt pair.
  // Strategy: sort events by ts asc. Scan for highest attempt seen on
  // stage.start. Keep the LAST stage.start with that attempt and the FIRST
  // stage.end after it that matches (any stage.end following; ends usually
  // don't carry attempt, so trust ordering).
  const keptStageEvents = [];
  for (const [, evs] of stageGroups) {
    const sorted = [...evs].sort((a, b) => {
      const ta = String(a.ts || "");
      const tb = String(b.ts || "");
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });

    // Find max attempt among starts
    let maxAttempt = 0;
    for (const ev of sorted) {
      if (ev.type === "stage.start") {
        const a = typeof ev.attempt === "number" ? ev.attempt : 1;
        if (a > maxAttempt) maxAttempt = a;
      }
    }
    if (maxAttempt === 0) {
      // Only ends seen (degenerate) — keep the latest end only
      let lastEnd = null;
      for (const ev of sorted) {
        if (ev.type === "stage.end") lastEnd = ev;
      }
      if (lastEnd) keptStageEvents.push(lastEnd);
      continue;
    }

    // Find last stage.start with maxAttempt
    let lastStartIdx = -1;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const ev = sorted[i];
      if (ev.type === "stage.start") {
        const a = typeof ev.attempt === "number" ? ev.attempt : 1;
        if (a === maxAttempt) {
          lastStartIdx = i;
          break;
        }
      }
    }
    if (lastStartIdx < 0) continue;

    keptStageEvents.push(sorted[lastStartIdx]);
    // First stage.end after it
    for (let i = lastStartIdx + 1; i < sorted.length; i++) {
      if (sorted[i].type === "stage.end") {
        keptStageEvents.push(sorted[i]);
        break;
      }
    }
  }

  // Concatenate everything, sort by ts for stable readable output
  const finalEvents = [
    ...keptStageEvents,
    ...otherEvents,
    ...costByStage.values(),
  ].sort((a, b) => {
    const ta = String(a.ts || "");
    const tb = String(b.ts || "");
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  const out = finalEvents.map((e) => JSON.stringify(e)).join("\n") + (finalEvents.length ? "\n" : "");
  const tmpPath = tracePathArg + ".tmp";
  fs.writeFileSync(tmpPath, out);
  fs.renameSync(tmpPath, tracePathArg);

  return { before, after: finalEvents.length };
}

/**
 * Compact trace.jsonl if its line count is >= threshold. Cheap early-return
 * via file size heuristic (avg event ~150 bytes → threshold*150 bytes).
 *
 * @param {string} tracePathArg
 * @param {number} threshold
 */
function maybeCompactTrace(tracePathArg, threshold = 5000) {
  try {
    if (!fs.existsSync(tracePathArg)) return { before: 0, after: 0, compacted: false };
    const stat = fs.statSync(tracePathArg);
    // Cheap size heuristic: avg event ~150 bytes
    if (stat.size < threshold * 120) {
      return { before: 0, after: 0, compacted: false };
    }
    // Count lines precisely
    const raw = fs.readFileSync(tracePathArg, "utf-8");
    let lineCount = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) lineCount++;
    }
    if (lineCount < threshold) {
      return { before: lineCount, after: lineCount, compacted: false };
    }
    const res = compactTrace(tracePathArg);
    return { ...res, compacted: true };
  } catch (e) {
    // Compaction must never kill the pipeline
    return { before: 0, after: 0, compacted: false, error: e.message };
  }
}

module.exports = {
  VALID_STAGES,
  emitStageStart,
  emitStageEnd,
  openStageLog,
  appendStageLog,
  compactTrace,
  maybeCompactTrace,
};
