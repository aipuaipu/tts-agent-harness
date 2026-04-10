#!/usr/bin/env node
/**
 * Deterministic pre-checks between pipeline stages.
 * Run cheap validation before expensive AI calls.
 *
 * Usage:
 *   node scripts/precheck.js --stage p2 --chunks <chunks.json> --audiodir <dir> [--trace <path>]
 *   node scripts/precheck.js --stage p3 --chunks <chunks.json> --transcripts <dir> [--trace <path>]
 *
 * Per-chunk pipeline events:
 *   stage "p2"      → event stage "check2"
 *   stage "post-p2" → event stage "check2"
 *   stage "p3"      → event stage "check3"
 *   stage "post-p3" → event stage "check3"
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { emitStageStart, emitStageEnd, openStageLog, appendStageLog, maybeCompactTrace } = require("./events");

const args = process.argv.slice(2);
let stage = "";
let chunksPath = "";
let audiodir = "";
let transcriptsDir = "";
let tracePath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--stage" && args[i + 1]) stage = args[++i];
  else if (args[i] === "--chunks" && args[i + 1]) chunksPath = args[++i];
  else if (args[i] === "--audiodir" && args[i + 1]) audiodir = args[++i];
  else if (args[i] === "--transcripts" && args[i + 1]) transcriptsDir = args[++i];
  else if (args[i] === "--trace" && args[i + 1]) tracePath = args[++i];
}

if (!stage || !chunksPath) {
  console.error("Usage: node precheck.js --stage <p2|p3> --chunks <chunks.json> [--audiodir <dir>] [--transcripts <dir>] [--trace <path>]");
  process.exit(1);
}

// Map --stage to event stage name (check2 | check3)
let eventStage = "";
if (stage === "p2" || stage === "post-p2") eventStage = "check2";
else if (stage === "p3" || stage === "post-p3") eventStage = "check3";
else {
  console.error(`Invalid --stage: ${stage} (expected p2|p3|post-p2|post-p3)`);
  process.exit(1);
}

const workDir = path.dirname(path.resolve(chunksPath));
if (!tracePath) tracePath = path.join(workDir, "trace.jsonl");

// Startup: opportunistic trace compaction
try { maybeCompactTrace(tracePath); } catch {}

const chunks = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
let errors = 0;      // 硬错误（文件缺失、JSON 坏、ffprobe 崩）→ 阻塞下游
let softErrors = 0;  // 软错误（字符比、语速异常）→ 记录但继续，让下游只处理通过的 chunk

function getAudioDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { encoding: "utf-8" }
    );
    return parseFloat(out.trim());
  } catch {
    return -1;
  }
}

// Per-chunk logging helpers: mirror console.* to stage log file.
function mkLogger(logFile) {
  return {
    log(msg) {
      console.log(msg);
      appendStageLog(logFile, String(msg));
    },
    warn(msg) {
      console.warn(msg);
      appendStageLog(logFile, String(msg));
    },
    error(msg) {
      console.error(msg);
      appendStageLog(logFile, String(msg));
    },
  };
}

// ========== Post-P2 checks ==========
if (stage === "p2" || stage === "post-p2") {
  console.log("=== Pre-check: Post-P2 (TTS output validation) ===\n");

  const synthDone = chunks.filter(c => c.status === "synth_done");
  for (const chunk of synthDone) {
    const logFile = openStageLog(workDir, chunk.id, eventStage);
    const L = mkLogger(logFile);
    const t0 = Date.now();
    emitStageStart(tracePath, chunk.id, eventStage, 1);

    let chunkErrors = 0;
    let lastError = "";

    const wavPath = path.join(audiodir, `${chunk.id}.wav`);

    // Check 1: file exists
    if (!fs.existsSync(wavPath)) {
      lastError = `WAV file missing at ${wavPath}`;
      L.error(`  ✗ ${chunk.id}: ${lastError}`);
      chunkErrors++;
      errors++;
      emitStageEnd(tracePath, chunk.id, eventStage, "fail", {
        durationMs: Date.now() - t0,
        error: lastError,
      });
      continue;
    }

    // Check 2: duration > 0 and < 60s
    const dur = getAudioDuration(wavPath);
    if (dur <= 0) {
      lastError = `WAV duration is ${dur}s (invalid)`;
      L.error(`  ✗ ${chunk.id}: ${lastError}`);
      chunkErrors++;
      errors++;
    } else if (dur > 60) {
      lastError = `WAV duration ${dur.toFixed(1)}s exceeds 60s limit`;
      L.error(`  ✗ ${chunk.id}: ${lastError}`);
      chunkErrors++;
      errors++;
    } else {
      // Check 3: duration is reasonable for text length (rough: 3-8 chars/sec for Chinese)
      const charsPerSec = chunk.char_count / dur;
      if (charsPerSec < 2 || charsPerSec > 12) {
        L.warn(`  ⚠ ${chunk.id}: ${chunk.char_count} chars in ${dur.toFixed(1)}s = ${charsPerSec.toFixed(1)} chars/s (unusual)`);
      } else {
        L.log(`  ✓ ${chunk.id}: ${dur.toFixed(1)}s, ${charsPerSec.toFixed(1)} chars/s`);
      }

      // Check: sample rate and channels
      try {
        const formatInfo = execSync(
          `ffprobe -v quiet -show_entries stream=sample_rate,channels -of csv=p=0 "${wavPath}"`,
          { encoding: "utf-8" }
        ).trim();
        const [sampleRate, channels] = formatInfo.split(",").map(Number);
        if (sampleRate !== 44100) {
          lastError = `sample rate ${sampleRate} != 44100`;
          L.error(`  ✗ ${chunk.id}: ${lastError}`);
          chunkErrors++;
          errors++;
        } else if (channels !== 1) {
          lastError = `channels ${channels} != 1 (mono)`;
          L.error(`  ✗ ${chunk.id}: ${lastError}`);
          chunkErrors++;
          errors++;
        }
      } catch (e) {
        lastError = `ffprobe failed: ${e.message}`;
        L.error(`  ✗ ${chunk.id}: ${lastError}`);
        chunkErrors++;
        errors++;
      }
    }

    emitStageEnd(tracePath, chunk.id, eventStage, chunkErrors > 0 ? "fail" : "ok", {
      durationMs: Date.now() - t0,
      error: chunkErrors > 0 ? lastError : undefined,
    });
  }
}

// ========== Post-P3 checks ==========
if (stage === "p3" || stage === "post-p3") {
  console.log("=== Pre-check: Post-P3 (Transcription validation) ===\n");

  const transcribed = chunks.filter(c => c.status === "transcribed");
  for (const chunk of transcribed) {
    const logFile = openStageLog(workDir, chunk.id, eventStage);
    const L = mkLogger(logFile);
    const t0 = Date.now();
    emitStageStart(tracePath, chunk.id, eventStage, 1);

    let chunkErrors = 0;
    let lastError = "";

    const jsonPath = path.join(transcriptsDir, `${chunk.id}.json`);

    // Check 1: file exists
    if (!fs.existsSync(jsonPath)) {
      lastError = `transcript JSON missing`;
      L.error(`  ✗ ${chunk.id}: ${lastError}`);
      errors++;
      emitStageEnd(tracePath, chunk.id, eventStage, "fail", {
        durationMs: Date.now() - t0,
        error: lastError,
      });
      continue;
    }

    let transcript;
    try {
      transcript = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    } catch (e) {
      lastError = `invalid JSON — ${e.message}`;
      L.error(`  ✗ ${chunk.id}: ${lastError}`);
      errors++;
      emitStageEnd(tracePath, chunk.id, eventStage, "fail", {
        durationMs: Date.now() - t0,
        error: lastError,
      });
      continue;
    }

    // Check 2: has segments
    if (!transcript.segments || transcript.segments.length === 0) {
      lastError = `no segments in transcript`;
      L.error(`  ✗ ${chunk.id}: ${lastError}`);
      errors++;
      emitStageEnd(tracePath, chunk.id, eventStage, "fail", {
        durationMs: Date.now() - t0,
        error: lastError,
      });
      continue;
    }

    // Check 3: timestamps are monotonically increasing
    let lastEnd = -1;
    let monotonic = true;
    for (const seg of transcript.segments) {
      if (seg.start < lastEnd - 0.01) { // 10ms tolerance
        monotonic = false;
        break;
      }
      if (seg.end < seg.start) {
        monotonic = false;
        break;
      }
      lastEnd = seg.end;
    }
    if (!monotonic) {
      lastError = `timestamps not monotonically increasing`;
      L.error(`  ✗ ${chunk.id}: ${lastError}`);
      errors++;
      emitStageEnd(tracePath, chunk.id, eventStage, "fail", {
        durationMs: Date.now() - t0,
        error: lastError,
      });
      continue;
    }

    // Check 4: transcribed text length vs original (within 30% tolerance)
    const transcribedText = transcript.full_transcribed_text || "";
    // Strip S2-Pro 控制标记：[break]/[breath]/[long break]/[pause]/[long pause]/[inhale] 等
    // 统一规则：任何 [ascii letters/space/-] bracket tag 都视为控制标记
    const strippedText = chunk.text
      .replace(/\[[a-z][a-z\s-]{0,30}\]/gi, "")
      .replace(/<\|phoneme_start\|>.*?<\|phoneme_end\|>/g, "");
    const originalLen = strippedText.replace(/[^\u4e00-\u9fff\w]/g, "").length;
    const transcribedLen = transcribedText.replace(/[^\u4e00-\u9fff\w]/g, "").length;
    const ratio = originalLen > 0 ? transcribedLen / originalLen : 0;
    const THRESHOLD_LOW = 0.7;
    const THRESHOLD_HIGH = 1.3;

    // Detailed diff log (per-chunk only)
    L.log(``);
    L.log(`════════════════════════════════════════════`);
    L.log(`[CHECK3] ${chunk.id}`);
    L.log(`════════════════════════════════════════════`);
    L.log(`  transcript: ${jsonPath}`);
    L.log(`  segments: ${transcript.segments.length}`);
    L.log(``);
    L.log(`  原文 (raw, ${chunk.text.length} chars):`);
    L.log(`    ${chunk.text}`);
    L.log(`  原文 (stripped control tags, ${strippedText.length} chars):`);
    L.log(`    ${strippedText.trim()}`);
    L.log(`  转写文本 (${transcribedText.length} chars):`);
    L.log(`    ${transcribedText}`);
    L.log(``);
    L.log(`  char count (中文+英数字):`);
    L.log(`    original     = ${originalLen}`);
    L.log(`    transcribed  = ${transcribedLen}`);
    L.log(`    diff         = ${transcribedLen - originalLen} (${((transcribedLen - originalLen) / Math.max(1, originalLen) * 100).toFixed(0)}%)`);
    L.log(`    ratio        = ${ratio.toFixed(3)}`);
    L.log(`    threshold    = [${THRESHOLD_LOW}, ${THRESHOLD_HIGH}]`);
    L.log(``);

    // char count mismatch 是 SOFT 失败：下游 stage（P5）仍会处理其他 chunk
    if (ratio < THRESHOLD_LOW || ratio > THRESHOLD_HIGH) {
      lastError = `char count mismatch — original ${originalLen}, transcribed ${transcribedLen} (ratio ${ratio.toFixed(2)})`;
      L.error(`  ✗ ${chunk.id}: ${lastError}`);
      softErrors++;
      L.error(`    可能原因:`);
      if (ratio < THRESHOLD_LOW) {
        L.error(`      - TTS 漏读/吞字（ratio 偏低）`);
        L.error(`      - 原文含大量 TTS 忽略的标点/emoji`);
        L.error(`      - 文本含控制标记但本脚本正则未覆盖`);
      } else {
        L.error(`      - WhisperX 重复识别（ratio 偏高）`);
        L.error(`      - 音频有回声/串声`);
      }
      L.error(`    修复:`);
      L.error(`      1. 听一下 .work/<ep>/audio/${chunk.id}.wav 判断是 TTS 还是转写问题`);
      L.error(`      2. 如是 TTS 漏读: 修改 text_normalized 后重跑 P2`);
      L.error(`      3. 如是误报(字符确实对得上): 调整 precheck.js 的 THRESHOLD_LOW/HIGH`);
      chunkErrors++;
      // 不计入 hard errors — 下游可以继续处理其他 chunk
    } else {
      L.log(`  ✓ char ratio ${ratio.toFixed(2)} within threshold`);
    }

    emitStageEnd(tracePath, chunk.id, eventStage, chunkErrors > 0 ? "fail" : "ok", {
      durationMs: Date.now() - t0,
      error: chunkErrors > 0 ? lastError : undefined,
    });
  }
}

if (errors > 0) {
  console.error(`\n✗ ${errors} hard error(s) found. Fix before proceeding.`);
  process.exit(1);
} else if (softErrors > 0) {
  console.error(
    `\n⚠ ${softErrors} chunk(s) have soft issues (see per-chunk logs). ` +
      `Pipeline continues; failed chunks will be marked in UI.`,
  );
  process.exit(0);
} else {
  console.log(`\n✓ All checks passed.`);
}
