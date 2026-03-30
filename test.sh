#!/bin/bash
# TTS Agent Harness — 端到端集成测试
#
# 用中英混合压力测试脚本验证全链路。
# 缓存 P2/P3 产物避免重复调 API。
#
# Usage:
#   bash test.sh --p1-only    # P1 离线测试（秒完，无需 API）
#   bash test.sh --no-p4      # P1→P3→P5→P6→V2（需 FISH_TTS_KEY，跳 Claude）
#   bash test.sh              # 全量含 P4（需 FISH_TTS_KEY + Claude API）
#   bash test.sh --clean      # 清缓存后全量重跑

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$HARNESS_DIR/.work/e2e"
SCRIPT="$HARNESS_DIR/example/demo-script.json"
P3_PORT=5557
P3_PID=""

MODE="${1:-full}"

# --clean 清除缓存
if [[ "$MODE" == "--clean" ]]; then
  rm -rf "$WORK"
  MODE="full"
fi

cleanup() {
  if [[ -n "$P3_PID" ]] && kill -0 "$P3_PID" 2>/dev/null; then
    kill "$P3_PID" 2>/dev/null; wait "$P3_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$WORK/audio" "$WORK/transcripts" "$WORK/validation" "$WORK/output"

# 日志持久化：终端 + 文件
LOG="$WORK/test.log"
exec > >(tee -a "$LOG") 2>&1

echo "=================================================="
echo " E2E Test: $MODE"
echo " Log: $LOG"
echo " Work dir: $WORK"
echo "=================================================="

# ========================================
# P1: 切分（总是跑，秒完）
# ========================================
echo ""
echo "--- P1: Chunking ---"
node "$HARNESS_DIR/scripts/p1-chunk.js" --script "$SCRIPT" --outdir "$WORK"

CHUNK_COUNT=$(node -e "console.log(require('$WORK/chunks.json').length)")
echo "  $CHUNK_COUNT chunks"
if [[ "$CHUNK_COUNT" -ne 4 ]]; then
  echo "FAIL: Expected 4 chunks, got $CHUNK_COUNT"
  exit 1
fi

if [[ "$MODE" == "--p1-only" ]]; then
  echo "  PASS"
  exit 0
fi

# ========================================
# P2: TTS 合成（缓存：跳过已有 WAV 的 chunk）
# ========================================
echo ""
echo "--- P2: TTS Synthesis ---"
if [[ -z "${FISH_TTS_KEY:-}" ]]; then
  echo "SKIP: FISH_TTS_KEY not set. Run: export FISH_TTS_KEY=xxx"
  exit 0
fi

# 检查哪些 chunk 已有音频
NEED_SYNTH=$(node -e "
  const c=require('$WORK/chunks.json');
  const fs=require('fs');
  const need=c.filter(x=>!fs.existsSync('$WORK/audio/'+x.id+'.wav'));
  console.log(need.length);
")

if [[ "$NEED_SYNTH" -gt 0 ]]; then
  echo "  Synthesizing $NEED_SYNTH chunk(s) (cached: $((CHUNK_COUNT - NEED_SYNTH)))..."
  node "$HARNESS_DIR/scripts/p2-synth.js" --chunks "$WORK/chunks.json" --outdir "$WORK/audio"
else
  echo "  All $CHUNK_COUNT chunks cached, skipping TTS"
  # 确保 status 是 synth_done（P1 重跑会重置为 pending）
  node -e "
    const fs=require('fs');
    const c=require('$WORK/chunks.json');
    c.forEach(x=>{if(fs.existsSync('$WORK/audio/'+x.id+'.wav')){x.status='synth_done';x.file=x.id+'.wav'}});
    fs.writeFileSync('$WORK/chunks.json',JSON.stringify(c,null,2));
  "
fi

echo ""
echo "--- Post-P2 Precheck ---"
node "$HARNESS_DIR/scripts/precheck.js" --stage p2 --chunks "$WORK/chunks.json" --audiodir "$WORK/audio" || echo "  [WARN] precheck issues found, continuing..."

# ========================================
# P3: WhisperX 转写（缓存：跳过已有 transcript 的 chunk）
# ========================================
echo ""
echo "--- P3: Transcription ---"

NEED_TRANSCRIBE=$(node -e "
  const c=require('$WORK/chunks.json');
  const fs=require('fs');
  const need=c.filter(x=>x.status==='synth_done'&&!fs.existsSync('$WORK/transcripts/'+x.id+'.json'));
  console.log(need.length);
")

if [[ "$NEED_TRANSCRIBE" -gt 0 ]]; then
  echo "  Transcribing $NEED_TRANSCRIBE chunk(s) (cached: $((CHUNK_COUNT - NEED_TRANSCRIBE)))..."

  # 启动 P3 server
  source "$HARNESS_DIR/scripts/start-p3-server.sh" "$P3_PORT" "$HARNESS_DIR/.venv/bin/activate" "$HARNESS_DIR/scripts/p3-transcribe.py"

  source "$HARNESS_DIR/.venv/bin/activate"
  python "$HARNESS_DIR/scripts/p3-transcribe.py" \
    --chunks "$WORK/chunks.json" --audiodir "$WORK/audio" --outdir "$WORK/transcripts" \
    --server-url "http://127.0.0.1:$P3_PORT"
else
  echo "  All chunks cached, skipping transcription"
  node -e "
    const fs=require('fs');
    const c=require('$WORK/chunks.json');
    c.forEach(x=>{if(fs.existsSync('$WORK/transcripts/'+x.id+'.json'))x.status='transcribed'});
    fs.writeFileSync('$WORK/chunks.json',JSON.stringify(c,null,2));
  "
fi

echo ""
echo "--- Post-P3 Precheck ---"
node "$HARNESS_DIR/scripts/precheck.js" --stage p3 --chunks "$WORK/chunks.json" --transcripts "$WORK/transcripts" || echo "  [WARN] precheck issues found, continuing..."

# ========================================
# P4: Claude 校验（full 模式，单 chunk 测试）
# ========================================
if [[ "$MODE" != "--no-p4" ]]; then
  echo ""
  echo "--- P4: Claude Validation (shot01 only) ---"

  # 确保 P3 server 在跑
  if ! curl -s --noproxy 127.0.0.1 "http://127.0.0.1:$P3_PORT/health" 2>/dev/null | grep -q ok; then
    source "$HARNESS_DIR/scripts/start-p3-server.sh" "$P3_PORT" "$HARNESS_DIR/.venv/bin/activate" "$HARNESS_DIR/scripts/p3-transcribe.py"
  fi

  node "$HARNESS_DIR/scripts/p4-validate.js" \
    --chunks "$WORK/chunks.json" \
    --transcripts "$WORK/transcripts" \
    --audiodir "$WORK/audio" \
    --outdir "$WORK/validation" \
    --p3-server "http://127.0.0.1:$P3_PORT" \
    --chunk shot01_chunk01 || true

  ROUNDS=$(ls "$WORK/validation/" 2>/dev/null | grep shot01 | wc -l | tr -d ' ')
  echo "  shot01: $ROUNDS validation round(s)"

  # P4 校验报告汇总
  echo ""
  echo "--- P4 Validation Report ---"
  for f in "$WORK/validation"/shot*_round*.json; do
    [[ -f "$f" ]] || continue
    node -e "
      const r=require('$f');
      const name=require('path').basename('$f');
      const status=r.passed?'PASS':'FAIL';
      const issues=(r.issues||[]).filter(i=>i.severity==='high');
      console.log('  '+name+': '+status+(issues.length?' ('+issues.length+' high)':''));
      issues.forEach(i=>console.log('    ['+i.type+'] \"'+i.original+'\" → \"'+i.transcribed+'\"'));
      if(r.summary) console.log('    → '+r.summary);
    "
  done
fi

# 关闭 P3 server（容错：kill 或 wait 失败不影响后续步骤）
if [[ -n "${P3_PID:-}" ]]; then
  kill "$P3_PID" 2>/dev/null || true
  wait "$P3_PID" 2>/dev/null || true
  P3_PID=""
  echo "  P3 server stopped"
fi

# ========================================
# P5 + P6 + V2
# ========================================
# 标记所有 transcribed 为 validated（P4 只跑了 shot01）
node -e "
  const fs=require('fs');
  const c=require('$WORK/chunks.json');
  c.forEach(x=>{if(x.status==='transcribed')x.status='validated'});
  fs.writeFileSync('$WORK/chunks.json',JSON.stringify(c,null,2));
"

echo ""
echo "--- P5: Subtitles ---"
node "$HARNESS_DIR/scripts/p5-subtitles.js" \
  --chunks "$WORK/chunks.json" --transcripts "$WORK/transcripts" --outdir "$WORK"

echo ""
echo "--- P6: Concat ---"
node "$HARNESS_DIR/scripts/p6-concat.js" \
  --chunks "$WORK/chunks.json" --audiodir "$WORK/audio" --subtitles "$WORK/subtitles.json" --outdir "$WORK/output"

# 验证 WAV 时长
echo "  Output:"
for f in "$WORK/output"/shot*.wav; do
  DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$f")
  echo "    $(basename $f): ${DUR}s"
done

echo ""
echo "--- V2: Preview ---"
node "$HARNESS_DIR/scripts/v2-preview.js" \
  --audiodir "$WORK/output" --subtitles "$WORK/subtitles.json" --output "$WORK/preview.html"

echo ""
echo "=================================================="
echo " E2E COMPLETE"
echo "=================================================="
echo ""
echo " Artifacts:"
echo "   Log:        $LOG"
echo "   Chunks:     $WORK/chunks.json"
echo "   Audio:      $WORK/audio/"
echo "   Transcripts: $WORK/transcripts/"
echo "   Validation: $WORK/validation/"
echo "   Subtitles:  $WORK/subtitles.json"
echo "   Preview:    $WORK/preview.html"
echo ""
echo " To review:"
echo "   open $WORK/preview.html          # 字幕预览"
echo "   cat $LOG                          # 完整日志"
echo "   cat $WORK/validation/*.json       # P4 校验详情"
open "$WORK/preview.html" 2>/dev/null || true
