#!/bin/bash
# TTS Agent Harness — Multi-Agent Orchestration
#
# Usage:
#   bash run.sh <script.json> <episode_id> [--from pN] [--output-dir <path>]
#   bash run.sh example/demo-script.json demo
#   bash run.sh script/brief01-script.json brief01 --output-dir /path/to/public/brief01/tts
#
# Resume from a step:
#   bash run.sh <script.json> <episode_id> --from p3

set -euo pipefail

SCRIPT_PATH="${1:?Usage: run.sh <script.json> <episode_id> [--from pN] [--output-dir <path>]}"
EPISODE="${2:?Usage: run.sh <script.json> <episode_id> [--from pN] [--output-dir <path>]}"

FROM_STEP="p1"
EXTERNAL_OUTPUT_DIR=""

# 解析可选参数（位置不固定）
shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM_STEP="${2:?--from requires a step name}"; shift 2 ;;
    --output-dir) EXTERNAL_OUTPUT_DIR="${2:?--output-dir requires a path}"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Paths — all relative to this repo root
HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$HARNESS_DIR/.work/$EPISODE"
AUDIO_DIR="$WORK_DIR/audio"
TRANSCRIPT_DIR="$WORK_DIR/transcripts"
OUTPUT_DIR="$WORK_DIR/output"

CHUNKS="$WORK_DIR/chunks.json"
SUBTITLES="$WORK_DIR/subtitles.json"
PREVIEW="$WORK_DIR/preview.html"
TRACE="$WORK_DIR/trace.jsonl"

VENV="$HARNESS_DIR/.venv/bin/activate"

# 解析 script 路径：绝对路径直接用，相对路径基于 HARNESS_DIR
if [[ "$SCRIPT_PATH" == /* ]]; then
  RESOLVED_SCRIPT="$SCRIPT_PATH"
else
  RESOLVED_SCRIPT="$HARNESS_DIR/$SCRIPT_PATH"
fi

mkdir -p "$WORK_DIR" "$AUDIO_DIR" "$TRANSCRIPT_DIR" "$OUTPUT_DIR"

# Input hash — detect script changes, force P1 re-run
SCRIPT_HASH=$(md5 -q "$RESOLVED_SCRIPT" 2>/dev/null || md5sum "$RESOLVED_SCRIPT" | cut -d' ' -f1)
HASH_FILE="$WORK_DIR/.script_hash"
if [[ -f "$HASH_FILE" ]] && [[ "$(cat "$HASH_FILE")" != "$SCRIPT_HASH" ]]; then
  echo "  Script changed since last run, forcing re-run from P1"
  FROM_STEP="p1"
fi
echo "$SCRIPT_HASH" > "$HASH_FILE"

# trace.jsonl is APPEND-ONLY across runs.
#
# The derivation logic uses "last stage.start event wins", so re-running an
# already-done episode:
#   - Stages that re-execute emit new events that override the old state.
#   - Stages that skip (no matching chunks) leave previous events intact, so
#     their pipeline pills stay green instead of resetting to pending.
#
# Only initialize the file if it doesn't exist yet (first-ever run).
if [[ ! -f "$TRACE" ]]; then
  > "$TRACE"
fi

should_run() {
  local steps=("p1" "p2" "check2" "p3" "check3" "p5" "p6" "checkp6" "v2")
  local found=false
  for s in "${steps[@]}"; do
    [[ "$s" == "$FROM_STEP" ]] && found=true
    [[ "$found" == true && "$s" == "$1" ]] && return 0
  done
  return 1
}

echo "=================================================="
echo " TTS Agent Harness: $EPISODE"
echo " Script: $SCRIPT_PATH"
echo " Working dir: $WORK_DIR"
echo " Trace: $TRACE"
echo "=================================================="

# --- P1: Deterministic chunking ---
if should_run p1; then
  echo ""
  echo "=== P1: Text Chunking ==="
  node "$HARNESS_DIR/scripts/p1-chunk.js" \
    --script "$RESOLVED_SCRIPT" \
    --outdir "$WORK_DIR" \
    --harness-dir "$HARNESS_DIR"
fi

# --- P2: Fish TTS Agent ---
if should_run p2; then
  echo ""
  echo "=== P2: TTS Synthesis (Fish TTS Agent) ==="
  node "$HARNESS_DIR/scripts/p2-synth.js" \
    --chunks "$CHUNKS" \
    --outdir "$AUDIO_DIR" \
    --trace "$TRACE"
fi

# --- Post-P2 deterministic pre-check ---
if should_run check2; then
  echo ""
  node "$HARNESS_DIR/scripts/precheck.js" \
    --stage p2 \
    --chunks "$CHUNKS" \
    --audiodir "$AUDIO_DIR"
fi

# --- P3: WhisperX Agent (start server, batch transcribe) ---
# 读取 .harness/config.json 中的 p3.port / p3.workers / p3.auto_workers
P3_CFG=$(node -e "
  const fs=require('fs');
  const path=require('path');
  const p=path.join('$HARNESS_DIR','.harness','config.json');
  let cfg={};
  try { cfg=JSON.parse(fs.readFileSync(p,'utf-8')).p3||{}; } catch(e){}
  const port = cfg.port || 5555;
  const workers = (cfg.workers && Number.isInteger(cfg.workers) && cfg.workers>=1) ? cfg.workers : 1;
  const auto = !!cfg.auto_workers;
  process.stdout.write(port+' '+workers+' '+(auto?'1':'0'));
" 2>/dev/null || echo "5555 1 0")
P3_PORT=$(echo "$P3_CFG" | awk '{print $1}')
P3_WORKERS=$(echo "$P3_CFG" | awk '{print $2}')
P3_AUTO=$(echo "$P3_CFG" | awk '{print $3}')

if [[ "$P3_AUTO" == "1" ]]; then
  # auto_workers: 让脚本把说明打到 stderr，只捕获 stdout 的整数
  P3_WORKERS=$(node "$HARNESS_DIR/scripts/p3-recommend-workers.js" --verbose)
fi

P3_PID=""

if should_run p3; then
  echo ""
  echo "=== P3: Starting WhisperX Agent Server (base_port=$P3_PORT, workers=$P3_WORKERS) ==="
  source "$HARNESS_DIR/scripts/start-p3-server.sh" "$P3_PORT" "$VENV" "$HARNESS_DIR/scripts/p3-transcribe.py" "$WORK_DIR" "$P3_WORKERS"
fi

# --- P3: Batch transcribe via server ---
if should_run p3; then
  echo ""
  echo "=== P3: Batch Transcription (via HTTP) ==="
  # 构建 P3_URLS（start-p3-server.sh 已 export，但 check3 分支也要用，显式重建以防万一）
  if [[ -z "${P3_URLS:-}" ]]; then
    _urls=""
    for ((i=0; i<P3_WORKERS; i++)); do
      _p=$((P3_PORT + i))
      if [[ -z "$_urls" ]]; then _urls="http://127.0.0.1:$_p"; else _urls="$_urls,http://127.0.0.1:$_p"; fi
    done
    P3_URLS="$_urls"
  fi
  python "$HARNESS_DIR/scripts/p3-transcribe.py" \
    --chunks "$CHUNKS" \
    --audiodir "$AUDIO_DIR" \
    --outdir "$TRANSCRIPT_DIR" \
    --server-urls "$P3_URLS"
fi

# --- Post-P3 deterministic pre-check ---
if should_run check3; then
  echo ""
  node "$HARNESS_DIR/scripts/precheck.js" \
    --stage p3 \
    --chunks "$CHUNKS" \
    --transcripts "$TRANSCRIPT_DIR"
fi

# --- Shutdown P3 server ---
source "$HARNESS_DIR/scripts/stop-p3-server.sh" "$WORK_DIR" "$P3_PORT" "$P3_WORKERS"

# --- P5: Deterministic subtitle generation ---
if should_run p5; then
  echo ""
  echo "=== P5: Subtitle Generation ==="
  node "$HARNESS_DIR/scripts/p5-subtitles.js" \
    --chunks "$CHUNKS" \
    --transcripts "$TRANSCRIPT_DIR" \
    --outdir "$WORK_DIR"
fi

# --- P6: Deterministic audio concat + subtitle offset fix ---
if should_run p6; then
  echo ""
  echo "=== P6: Audio Concatenation ==="
  node "$HARNESS_DIR/scripts/p6-concat.js" \
    --chunks "$CHUNKS" \
    --audiodir "$AUDIO_DIR" \
    --subtitles "$SUBTITLES" \
    --outdir "$OUTPUT_DIR"
fi

# --- Post-P6 end-to-end validation ---
if should_run checkp6; then
  echo ""
  echo "=== Post-P6: End-to-End Validation ==="
  node "$HARNESS_DIR/scripts/postcheck-p6.js" \
    --subtitles "$SUBTITLES" \
    --durations "$OUTPUT_DIR/durations.json"
fi

# --- V2: Review preview ---
if should_run v2; then
  echo ""
  echo "=== V2: Review Preview ==="
  node "$HARNESS_DIR/scripts/v2-preview.js" \
    --audiodir "$OUTPUT_DIR" \
    --subtitles "$SUBTITLES" \
    --output "$PREVIEW"

  echo ""
  echo ">>> V2 Review: preview.html generated <<<"
  echo "    $PREVIEW"
  # 只在交互式终端自动 open；web UI / CI 调用时 stdout 不是 tty，跳过
  if [[ -t 1 ]]; then
    open "$PREVIEW" 2>/dev/null || true
  fi
fi

# --- Copy to external output dir ---
if [[ -n "$EXTERNAL_OUTPUT_DIR" ]]; then
  echo ""
  echo "=== Copying output to $EXTERNAL_OUTPUT_DIR ==="
  mkdir -p "$EXTERNAL_OUTPUT_DIR"
  cp "$OUTPUT_DIR"/*.wav "$EXTERNAL_OUTPUT_DIR/" 2>/dev/null || true
  cp "$OUTPUT_DIR/durations.json" "$EXTERNAL_OUTPUT_DIR/" 2>/dev/null || true
  cp "$SUBTITLES" "$EXTERNAL_OUTPUT_DIR/subtitles.json" 2>/dev/null || true
  echo "  Done: $(ls "$EXTERNAL_OUTPUT_DIR"/*.wav 2>/dev/null | wc -l | tr -d ' ') WAV files + subtitles.json + durations.json"
fi

echo ""
echo "=================================================="
echo " Done!"
echo " Output:"
echo "   Audio:     $OUTPUT_DIR/<shot>.wav"
echo "   Durations: $OUTPUT_DIR/durations.json"
echo "   Subtitles: $SUBTITLES"
echo "   Preview:   $PREVIEW"
echo "   Trace:     $TRACE"
if [[ -n "$EXTERNAL_OUTPUT_DIR" ]]; then
echo "   Copied to: $EXTERNAL_OUTPUT_DIR/"
fi
echo "=================================================="
