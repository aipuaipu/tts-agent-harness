# TTS Harness — 多 Agent 语音生产系统规范

## 概述

本文档定义了从脚本定稿到字幕输出的完整语音生产 harness，解决以下核心问题：

- 长文本直接进 TTS 导致部分调整需整条重做
- 语音与字幕对齐依赖手工校准
- 英文发音不稳定时需要快速定位和重做单个 chunk

## 架构：两 Agent + 确定性胶水

### 生产流程

```
脚本 (script.json)
  │
  ▼
┌─────────────── Harness (run.sh + chunks.json) ────────────────┐
│                                                                │
│  [P1]  确定性切分 (JS)        ── text → chunks.json           │
│  [P2]  Fish TTS Agent (S2-Pro) ── text → speech (黑盒)        │
│  [✓2]  确定性预检             ── WAV 存在/时长/语速合理       │
│  [P3]  WhisperX Agent         ── speech → text + timestamps   │
│  [P5]  确定性字幕 (JS)        ── timestamps → per-chunk subs  │
│  [P6]  确定性拼接 (JS)        ── concat + offset → final      │
│  [V2]  验收预览               ── HTML 播放+字幕高亮           │
│                                                                │
│  状态: chunks.json status + trace.jsonl                        │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
产物: per-shot WAV + subtitles.json + durations.json + preview.html
```

### 完整流程（含 P4，当前未使用）

```
P1 → P2 → ✓2 → P3 → ✓3 → text-diff → P4(Claude) → P5 → P6 → ✓P6 → V2
                                         │
                                         └→ FAIL → 改 text_normalized → P2 → P3 → P4（最多3轮）
```

P4 Claude 自动校验/修复循环代码保留，但生产中跳过。原因：
- TTS 非确定性导致自动修复效果不稳定
- S2-Pro 引擎质量提升后，多数发音问题可通过控制标记解决
- 人工修改 text_normalized + 重做比 LLM 自动修复更可控

### Harness 四要素映射

| 要素 | 实现 |
|------|------|
| 操作对象 | `text` / `text_normalized` 字段 |
| 评估函数 | 确定性预检（免费）+ 人工听音频 |
| 约束系统 | config.json 参数 + S2-Pro 控制标记 |
| 状态记忆 | `chunks.json` status + `trace.jsonl` |

---

## 数据流与契约

### chunks.json — 状态机

```
pending → synth_done → transcribed → validated → (P5/P6 消费)
            │              │
       synth_failed   transcribe_failed
```

生产流程中 P3 完成（transcribed）后直接进 P5，不经过 P4 校验。

### chunk 数据结构

```json
{
  "id": "shot02_chunk01",
  "shot_id": "shot02",
  "text": "原始文本，可含 [break] 控制标记",
  "text_normalized": "TTS 实际输入（P1 仅 trim，通常 = text）",
  "sentence_count": 3,
  "char_count": 120,
  "status": "pending",
  "duration_s": 0,
  "file": null,
  "validate_round": 0
}
```

### subtitles.json — Remotion 消费格式

```json
{
  "shot01": [
    { "id": "sub_001", "text": "控制标记已 strip 的字幕文本", "start": 0.2, "end": 2.54 },
    { "id": "sub_002", "text": "下一句字幕", "start": 2.54, "end": 4.72 }
  ]
}
```

- `start` / `end`：浮点秒，精确到 3 位小数
- 字幕文本来自 `text`，P5 自动 strip `[break]`/`[breath]`/`[long break]`/phoneme 标记
- 时间戳已包含首部 padding 和 chunk 间 gap 的偏移

---

## P1 — 切分（确定性）

### 输入
`script.json`（按 segment/shot 组织的脚本）

### 切分规则

| 优先级 | 规则 | 说明 |
|--------|------|------|
| 1 | 以 shot 为一级单元 | 每个 shot 的 chunks 独立管理 |
| 2 | shot 内按句号/问号/感叹号/分号切分 | 句子级粒度 |
| 3 | 打包：每 chunk ≤ 5 句且 ≤ 200 字 | 控制 TTS 输入长度 |
| 4 | 最小片段保护：≥ 2 句 | 避免语气孤立 |

### normalize

P1 只做 trim，不修改文本内容。脚本的 `text` 字段直接作为 TTS 输入。

S2-Pro 控制标记（`[break]`/`[breath]`/phoneme）原样保留在 `text` 和 `text_normalized` 中。

---

## P2 — Fish TTS Agent（S2-Pro）

- 模型：S2-Pro，通过 request body 的 `model` 字段指定
- `normalize: false`：让 S2-Pro 原样处理文本，不做引擎侧规范化
- 支持 `temperature` / `top_p` 采样参数（config.json 配置）
- 每个 chunk 独立调用 Fish TTS API（通过 HTTPS_PROXY 环境变量）
- 并行度上限：3
- 使用 `text_normalized` 作为 TTS 输入
- 输出 `<chunk_id>.wav`（44100Hz，经 atempo 加速至 config 中的 speed）
- 重试 3 次，指数退避

### Post-P2 确定性预检
- WAV 文件存在且时长 > 0 且 < 60s
- 语速合理（2-12 chars/sec）

---

## P3 — WhisperX Agent

- WhisperX large-v3，CPU 模式
- `HF_HUB_OFFLINE=1`：使用本地缓存模型，不联网
- 输出 segment-level + word-level 时间戳
- Server 模式常驻，模型加载一次，批量处理所有 chunk
- 失败的 chunk 标记 `transcribe_failed` 并 exit(1)

---

## P4 — Claude Agent（保留，生产中跳过）

通过 Anthropic API 调用 Claude，做转写 vs 原文的语义校验。

### 自动修复循环（最多 3 轮）

```
Round 1: Claude 校验
  ├─ PASS → validated
  ├─ 只有 low severity → 自动放行
  └─ 有 high severity → Claude 生成 text_normalized 修改
      → 自动重跑 P2 → P3 → Round 2 校验
        └─ ... → Round 3 → 仍 FAIL → needs_human
```

> 跨期记忆（normalize-patches / tts-known-issues）的读写已移除。这些机制在 TTS 非确定性场景下不可靠——同一文本下次合成可能读对，之前的补丁反而过度修复。

---

## P5 — 字幕生成（确定性）

- 字幕文本来自 `text` 字段（或 `subtitle_text`）
- 生成前自动 strip 控制标记：
  - `[break]` / `[breath]` / `[long break]`
  - `<|phoneme_start|>...<|phoneme_end|>`
- 按 ≤ 20 字/行分行
- 复用 P3 WhisperX 的 word-level 时间戳做加权分配
- 输出 per-chunk 相对时间戳（从 0 开始），P6 负责全局偏移

---

## P6 — 音频拼接 + 字幕偏移修正（确定性）

### 拼接规则
- 首尾 padding：200ms 静音
- chunk 间：50ms 静音间隔
- 单 chunk shot：padding + audio + padding

### 字幕偏移计算

```
chunk1 offset = PADDING_MS
chunk2 offset = PADDING_MS + chunk1_duration + GAP_MS
chunk3 offset = PADDING_MS + chunk1_duration + GAP_MS + chunk2_duration + GAP_MS
...
```

### 输出
- `<shot>.wav` — per-shot 拼接音频
- `durations.json` — per-shot 时长
- 回写 `subtitles.json`（偏移已修正）

---

## 人工修复流程

当 TTS 发音不准确时（特别是英文品牌名/缩写）：

1. 在 `.work/<episode>/chunks.json` 中找到目标 chunk
2. 修改 `text_normalized`（如加 phoneme 标注、换同义表达）
3. 重跑 P2：`node scripts/p2-synth.js --chunks ... --chunk <id>`
4. 人工听音频，不满意重复 2-3
5. 满意后选版本替换，从 P3 续跑

---

## 可观测性

### trace.jsonl
每个 Agent 阶段写一行结构化 JSONL：

```jsonl
{"ts":"2026-03-30T10:00:01Z","chunk":"shot02_chunk01","phase":"p2","event":"start"}
{"ts":"2026-03-30T10:00:14Z","chunk":"shot02_chunk01","phase":"p2","event":"done","duration_ms":13200}
```

运行结束后自动输出摘要：per-phase 耗时统计。

---

## 人工验收节点

| 节点 | 时机 | 内容 |
|------|------|------|
| V2 | P6 之后 | HTML 预览页，播放音频同时高亮字幕，确认同步 |

---

## 文件结构

```
tts-harness/
├── run.sh                    # Harness 调度
├── spec.md                   # 本文档
├── CLAUDE.md                 # AI 协作指南
├── requirements.txt          # Python 依赖
├── .harness/
│   ├── config.json           # 技术参数
│   └── rules.md              # 发音规则备忘
├── scripts/
│   ├── p1-chunk.js           # 确定性切分（normalize 只 trim）
│   ├── p2-synth.js           # Fish TTS Agent（S2-Pro）
│   ├── p3-transcribe.py      # WhisperX Agent
│   ├── p4-validate.js        # Claude Agent（保留，生产跳过）
│   ├── p5-subtitles.js       # 确定性字幕（strip 控制标记）
│   ├── p6-concat.js          # 确定性拼接
│   ├── text-diff.js          # 确定性文本比对（P4 前置）
│   ├── precheck.js           # 确定性预检（Post-P2/P3）
│   ├── postcheck-p6.js       # 端到端验证
│   ├── trace.js              # JSONL trace 工具
│   └── v2-preview.js         # HTML 验收预览
├── test/
│   ├── run-unit.sh           # 离线单元测试
│   └── ab-param-test/        # AB 参数测试
└── .work/<episode>/          # 中间产物（不进 git）
    ├── chunks.json
    ├── audio/<chunk>.wav
    ├── transcripts/<chunk>.json
    ├── subtitles.json
    ├── trace.jsonl
    └── preview.html
```

---

## 运行方式

```bash
# 完整运行
bash run.sh script/brief01-script.json brief01

# 跳过 P4（生产默认）
bash run.sh script/brief01-script.json brief01 --from p5  # 已有转写时

# 从某步继续
bash run.sh script/brief01-script.json brief01 --from p3

# 重做单个 chunk
node scripts/p2-synth.js --chunks .work/brief01/chunks.json --outdir .work/brief01/audio --chunk shot02_chunk01
```
