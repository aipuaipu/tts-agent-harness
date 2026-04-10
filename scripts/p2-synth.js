#!/usr/bin/env node
/**
 * P2 — 并行 TTS 合成
 *
 * 读取 chunks.json，对每个 pending chunk 调用 Fish TTS，输出独立 WAV。
 * 支持指定单个 chunk 重做（--chunk <id>）。
 *
 * Usage:
 *   node scripts/p2-synth.js --chunks <chunks.json> --outdir <dir>
 *   node scripts/p2-synth.js --chunks <chunks.json> --outdir <dir> --chunk shot02_chunk01
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { emitStageStart, emitStageEnd, openStageLog, appendStageLog, maybeCompactTrace } = require("./events");

// Fish S2-Pro pricing — ~$15 per million characters. Tweak as needed.
const FISH_PER_MILLION_USD = 15;

// 国内 DNS 会污染 fish.audio,Fish API 必须走代理。
// Node 24+ 原生 fetch 在 NODE_USE_ENV_PROXY=1 时自动读 HTTPS_PROXY/NO_PROXY。
// 这里只确保该 flag 被设置,真正的代理 URL 来自 .env / 环境变量。
if ((process.env.HTTPS_PROXY || process.env.HTTP_PROXY) && !process.env.NODE_USE_ENV_PROXY) {
  process.env.NODE_USE_ENV_PROXY = "1";
}

// --- 配置 ---
//
// 优先级：env var > script.tts_config > .harness/config.json > 代码默认值
//
// 支持的字段（script.tts_config 全部支持，env 仅部分覆盖）：
//   model           string   Fish TTS 模型 (s1, s2-pro …)
//   normalize       boolean  是否让 Fish 做文本归一化
//   temperature     number   采样温度
//   top_p           number   nucleus sampling
//   speed           number   atempo 后处理速度（env: TTS_SPEED）
//   reference_id    string   声音克隆 ID (env: FISH_TTS_REFERENCE_ID)
//   concurrency     number   并行度（仅 harness config 有意义）
//   max_retries     number   单 chunk 重试次数
const DEFAULT_CONFIG = {
  concurrency: 3,
  max_retries: 3,
  speed: 1.0,
  model: "s1",
  normalize: false,
  temperature: null,
  top_p: null,
  reference_id: "",
};

function loadMergedConfig(workDir) {
  const cfg = { ...DEFAULT_CONFIG };

  // Layer 1: .harness/config.json (global defaults)
  try {
    const _cfg = JSON.parse(
      require("fs").readFileSync(
        require("path").join(__dirname, "..", ".harness", "config.json"),
        "utf-8",
      ),
    );
    if (_cfg.p2) {
      // Legacy: harness config uses `default_speed`, map to `speed`
      if (_cfg.p2.default_speed != null && _cfg.p2.speed == null) {
        _cfg.p2.speed = _cfg.p2.default_speed;
      }
      for (const [k, v] of Object.entries(_cfg.p2)) {
        if (v != null && k in cfg) cfg[k] = v;
      }
    }
  } catch {}

  // Layer 2: <workDir>/tts_config.json (script-level override)
  if (workDir) {
    try {
      const scriptCfg = JSON.parse(
        require("fs").readFileSync(
          require("path").join(workDir, "tts_config.json"),
          "utf-8",
        ),
      );
      for (const [k, v] of Object.entries(scriptCfg)) {
        if (v != null && k in cfg) cfg[k] = v;
      }
    } catch {}
  }

  // Layer 3: env vars (highest priority)
  if (process.env.FISH_TTS_MODEL) cfg.model = process.env.FISH_TTS_MODEL;
  if (process.env.FISH_TTS_REFERENCE_ID) cfg.reference_id = process.env.FISH_TTS_REFERENCE_ID;
  if (process.env.TTS_SPEED) cfg.speed = parseFloat(process.env.TTS_SPEED);

  return cfg;
}

const TTS_API_URL = "https://api.fish.audio/v1/tts";
const TTS_API_KEY = process.env.FISH_TTS_KEY;
if (!TTS_API_KEY) {
  console.error("ERROR: FISH_TTS_KEY environment variable is required");
  process.exit(1);
}

// Config 在 main() 里根据 workDir 加载
let TTS_CONFIG = { ...DEFAULT_CONFIG };

// --- 参数解析 ---
const args = process.argv.slice(2);
let chunksPath = "";
let outdir = "";
let targetChunk = "";
let speed = null; // 加载 config 后再赋值
let tracePath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--chunks" && args[i + 1]) chunksPath = args[++i];
  else if (args[i] === "--outdir" && args[i + 1]) outdir = args[++i];
  else if (args[i] === "--chunk" && args[i + 1]) targetChunk = args[++i];
  else if (args[i] === "--speed" && args[i + 1]) speed = parseFloat(args[++i]);
  else if (args[i] === "--trace" && args[i + 1]) tracePath = args[++i];
}

if (!chunksPath || !outdir) {
  console.error(
    "Usage: node p2-synth.js --chunks <chunks.json> --outdir <dir> [--chunk <id>] [--speed 1.15]"
  );
  process.exit(1);
}

/**
 * Call Fish TTS API and return audio buffer + detailed timing info for logging.
 * `onDetail` is an optional callback(line) that receives structured progress
 * lines for the per-chunk log (not printed to console).
 */
async function callTTS(text, onDetail) {
  const payload = {
    text,
    model: TTS_CONFIG.model,
    normalize: TTS_CONFIG.normalize,
  };
  if (TTS_CONFIG.reference_id) payload.reference_id = TTS_CONFIG.reference_id;
  if (TTS_CONFIG.temperature != null) payload.temperature = TTS_CONFIG.temperature;
  if (TTS_CONFIG.top_p != null) payload.top_p = TTS_CONFIG.top_p;

  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf-8");

  if (onDetail) {
    // Redact auth for log safety; show everything else
    const logPayload = { ...payload };
    // truncate very long text in the log preview (but still show full length)
    if (logPayload.text && logPayload.text.length > 300) {
      logPayload.text = logPayload.text.slice(0, 300) + `…<+${logPayload.text.length - 300} chars>`;
    }
    onDetail(`    → POST ${TTS_API_URL}`);
    onDetail(`      payload (${payloadBytes}B): ${JSON.stringify(logPayload)}`);
    if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
      onDetail(`      proxy: ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY}`);
    }
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 120000);
  const reqStart = Date.now();
  try {
    const res = await fetch(TTS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TTS_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errBody = await res.text();
      if (onDetail) {
        const reqMs = Date.now() - reqStart;
        onDetail(`    ← HTTP ${res.status} in ${reqMs}ms`);
        onDetail(`      body: ${errBody.slice(0, 200)}`);
      }
      throw new Error(`TTS API ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const reqMs = Date.now() - reqStart;
    if (onDetail) {
      const ct = res.headers.get("content-type") || "?";
      onDetail(`    ← HTTP ${res.status} in ${reqMs}ms`);
      onDetail(`      content-type: ${ct}, ${buf.length} bytes`);
    }
    return { buf, reqMs };
  } finally {
    clearTimeout(timeout);
  }
}

function applySpeed(inputPath, outputPath, tempo) {
  execSync(
    `ffmpeg -y -i "${inputPath}" -filter:a "atempo=${tempo}" -ar 44100 "${outputPath}" 2>/dev/null`
  );
}

function getAudioDuration(filePath) {
  const out = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
    { encoding: "utf-8" }
  );
  return parseFloat(out.trim());
}

// =============================================================
// 并行控制
// =============================================================

async function processChunk(chunk) {
  const mp3Path = path.join(outdir, `${chunk.id}.mp3`);
  const wavPath = path.join(outdir, `${chunk.id}.wav`);

  // Per-chunk log file (sibling to chunks.json → workDir)
  const workDir = path.dirname(chunksPath);
  let logFile = null;
  try {
    logFile = openStageLog(workDir, chunk.id, "p2");
  } catch (e) {
    console.error(`    [WARN] openStageLog failed for ${chunk.id}: ${e.message}`);
  }

  const logLine = (line) => {
    if (logFile) appendStageLog(logFile, line);
  };
  const logAndOut = (line) => {
    console.log(line);
    logLine(line);
  };
  const logAndErr = (line) => {
    console.error(line);
    logLine(line);
  };
  // Writes to per-chunk log ONLY (not console / run.log)
  const logDetail = (line) => {
    if (logFile) appendStageLog(logFile, line);
  };

  // Console sees compact line
  logAndOut(`  [TTS] ${chunk.id}: "${chunk.text_normalized.slice(0, 40)}..."`);

  // Per-chunk log gets a full detail header
  const ts = new Date().toISOString();
  logDetail("");
  logDetail(`════════════════════════════════════════════`);
  logDetail(`[P2] ${chunk.id} @ ${ts}`);
  logDetail(`════════════════════════════════════════════`);
  logDetail(`  shot: ${chunk.shot_id}  sentence_count: ${chunk.sentence_count ?? "?"}  char_count: ${chunk.char_count}`);
  logDetail(`  text (${chunk.text_normalized.length} chars):`);
  logDetail(`    ${chunk.text_normalized}`);
  if (chunk.subtitle_text && chunk.subtitle_text !== chunk.text_normalized) {
    logDetail(`  subtitle_text (${chunk.subtitle_text.length} chars):`);
    logDetail(`    ${chunk.subtitle_text}`);
  }
  logDetail(`  config:`);
  logDetail(`    model=${TTS_CONFIG.model}  normalize=${TTS_CONFIG.normalize}`);
  logDetail(`    temperature=${TTS_CONFIG.temperature}  top_p=${TTS_CONFIG.top_p}`);
  logDetail(`    reference_id=${TTS_CONFIG.reference_id || "(none)"}`);
  logDetail(`    speed=${speed}x (post-process atempo)`);

  const t0 = Date.now();

  // Per-chunk pipeline event (attempt always 1 — retry semantics are internal here)
  const pipelineAttempt = 1;
  try {
    emitStageStart(tracePath, chunk.id, "p2", pipelineAttempt);
  } catch (e) {
    console.error(`    [WARN] emitStageStart failed for ${chunk.id}: ${e.message}`);
  }

  // 重试 3 次
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const attemptStart = Date.now();
    logDetail("");
    logDetail(`  [attempt ${attempt}/3]`);
    try {
      const { buf: audioBuffer, reqMs } = await callTTS(chunk.text_normalized, logDetail);

      const mp3Start = Date.now();
      fs.writeFileSync(mp3Path, audioBuffer);
      const mp3WriteMs = Date.now() - mp3Start;
      logDetail(`    ✓ mp3 written: ${audioBuffer.length} bytes in ${mp3WriteMs}ms`);

      const ffStart = Date.now();
      applySpeed(mp3Path, wavPath, speed);
      const ffMs = Date.now() - ffStart;
      logDetail(`    ✓ ffmpeg atempo=${speed} in ${ffMs}ms → ${path.basename(wavPath)}`);
      fs.unlinkSync(mp3Path);

      const duration = getAudioDuration(wavPath);
      const wavStat = fs.statSync(wavPath);
      logAndOut(`    → ${chunk.id}.wav (${duration.toFixed(2)}s)`);
      logDetail(`    ✓ final WAV: ${wavStat.size} bytes, ${duration.toFixed(3)}s audio`);
      logDetail(`    speech rate: ${(chunk.char_count / duration).toFixed(2)} chars/s`);

      const durationMs = Date.now() - t0;
      const attemptMs = Date.now() - attemptStart;
      logDetail("");
      logDetail(`  [summary]`);
      logDetail(`    api: ${reqMs}ms  ffmpeg: ${ffMs}ms  attempt: ${attemptMs}ms  total: ${durationMs}ms`);
      logDetail(`    status: ok`);

      try {
        emitStageEnd(tracePath, chunk.id, "p2", "ok", { durationMs });
      } catch (e) {
        console.error(`    [WARN] emitStageEnd failed for ${chunk.id}: ${e.message}`);
      }
      return { id: chunk.id, duration_s: Math.round(duration * 1000) / 1000, file: `${chunk.id}.wav`, status: "synth_done", chars: chunk.text_normalized.length };
    } catch (e) {
      lastErr = e;
      const attemptMs = Date.now() - attemptStart;
      logAndErr(`    [RETRY ${attempt}/3] ${chunk.id}: ${e.message}`);
      logDetail(`    ✗ attempt ${attempt} failed in ${attemptMs}ms: ${e.message}`);
      if (e.stack) logDetail(`    stack: ${e.stack.split("\n").slice(0, 3).join(" | ")}`);
      if (attempt < 3) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        logDetail(`    sleeping ${backoffMs}ms before retry...`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  const durationMs = Date.now() - t0;
  logAndErr(`    [FAIL] ${chunk.id}: ${lastErr.message}`);
  logDetail("");
  logDetail(`  [summary]`);
  logDetail(`    total: ${durationMs}ms`);
  logDetail(`    status: fail — ${lastErr.message}`);
  try {
    emitStageEnd(tracePath, chunk.id, "p2", "fail", { error: lastErr.message, durationMs });
  } catch (e) {
    console.error(`    [WARN] emitStageEnd failed for ${chunk.id}: ${e.message}`);
  }
  return { id: chunk.id, duration_s: 0, file: null, status: "synth_failed", error: lastErr.message };
}

async function runWithConcurrency(items, fn, limit) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// =============================================================
// Main
// =============================================================

async function main() {
  const chunks = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
  fs.mkdirSync(outdir, { recursive: true });

  // Default tracePath to <workDir>/trace.jsonl if not supplied
  const workDir = path.dirname(chunksPath);
  if (!tracePath) {
    tracePath = path.join(workDir, "trace.jsonl");
  }

  // Startup: opportunistic trace compaction (cheap when file is small)
  try {
    maybeCompactTrace(tracePath);
  } catch {}

  // Load merged config (env > tts_config.json > .harness/config.json > defaults)
  TTS_CONFIG = loadMergedConfig(workDir);
  // CLI --speed overrides everything (explicit user intent)
  if (speed == null) speed = TTS_CONFIG.speed;
  // Log the effective config so it's visible in run.log
  console.log(
    `  Effective TTS config: model=${TTS_CONFIG.model} normalize=${TTS_CONFIG.normalize} ` +
      `temp=${TTS_CONFIG.temperature} top_p=${TTS_CONFIG.top_p} ` +
      `ref_id=${TTS_CONFIG.reference_id || "(none)"} speed=${speed}x ` +
      `concurrency=${TTS_CONFIG.concurrency}`,
  );

  // 过滤要处理的 chunks
  let toProcess;
  if (targetChunk) {
    toProcess = chunks.filter((c) => c.id === targetChunk);
    if (toProcess.length === 0) {
      console.error(`Chunk "${targetChunk}" not found`);
      process.exit(1);
    }
  } else {
    toProcess = chunks.filter((c) => c.status === "pending" || c.status === "synth_failed");
  }

  console.log(`=== P2: Synthesizing ${toProcess.length} chunk(s), concurrency=${TTS_CONFIG.concurrency}, speed=${speed}x ===\n`);

  const results = await runWithConcurrency(toProcess, processChunk, TTS_CONFIG.concurrency);

  // 更新 chunks.json 的 status
  for (const r of results) {
    const chunk = chunks.find((c) => c.id === r.id);
    if (chunk) {
      chunk.status = r.status;
      chunk.duration_s = r.duration_s;
      chunk.file = r.file;
      if (r.error) chunk.error = r.error;
    }
  }

  fs.writeFileSync(chunksPath, JSON.stringify(chunks, null, 2));

  // 摘要
  const ok = results.filter((r) => r.status === "synth_done").length;
  const fail = results.filter((r) => r.status === "synth_failed").length;
  const totalDur = results.reduce((s, r) => s + r.duration_s, 0);

  console.log(`\n=== Done: ${ok} ok, ${fail} failed, total ${totalDur.toFixed(1)}s ===`);

  // Emit pipeline.cost trace event (P2 Fish API usage)
  try {
    const totalChars = results
      .filter((r) => r.status === "synth_done")
      .reduce((s, r) => s + (r.chars || 0), 0);
    const chunkCount = results.filter((r) => r.status === "synth_done").length;
    const estimatedUsdCents = Math.round(
      (totalChars * FISH_PER_MILLION_USD) / 10000,
    ); // $15/M chars → 1500 cents/M → chars*1500/1e6 = chars*0.0015
    const costEvent = {
      ts: new Date().toISOString(),
      type: "pipeline.cost",
      stage: "p2",
      chars: totalChars,
      chunks: chunkCount,
      estimatedUsdCents,
    };
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, JSON.stringify(costEvent) + "\n");
    console.log(
      `  [cost] p2: ${totalChars} chars across ${chunkCount} chunks ≈ ${(estimatedUsdCents / 100).toFixed(2)} USD`,
    );
  } catch (e) {
    console.error(`  [WARN] pipeline.cost emit failed: ${e.message}`);
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
