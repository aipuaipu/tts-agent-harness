# 自动修复测试设计

## 核心问题

TTS 和 ASR 都是非确定性的，无法用真实 API 稳定复现"合成失败 → 诊断 → 修复 → 通过"的流程。
需要用 mock 来确定性地模拟每一步的输入输出。

## 测试架构

```
MockTtsProvider          MockWhisperX
  ↓ 返回预设 WAV            ↓ 返回预设 transcript
  P2 ──→ P2c ──→ P2v ──→ Repair ──→ P2（下一轮）
```

两个 mock 的行为由 **fixture 剧本** 驱动——预先定义"第 N 次调用返回什么结果"，让整个修复循环变成确定性的回放。

## 真实失败案例（来自 brief02 + ab-param-test）

| 原文 | 转写结果 | 失败类型 |
|------|---------|----------|
| `Mac 跑本地模型` | `卖个跑本地模型` | 英文品牌名 → 中文谐音 |
| `装了 Ollama` | `装了欧罗麦` | 英文品牌名 → 错误谐音 |
| `一个 RAG 项目` | `一个 IG 项目` | 英文缩写 → 完全错读 |
| `不是进程挂` | `不是进城挂` | 中文同音字替换 |
| `GitHub 上有` | `DTHUB 上有` | 品牌名严重变形 |
| `用 API 跑` | `用跑` | 关键词完全缺失 |
| `三十五 B 参数` | `三十五比参数` | 单位符号错读 |

## 测试用例

### TC-01: Level 0 通过 — 原样重试成功

模拟 TTS 随机性：第一次读错，第二次碰巧读对。

```
Fixture 剧本:
  attempt 1: TTS → bad.wav,  ASR → "一个IG项目" (ratio=0.65) → FAIL
  attempt 2: TTS → good.wav, ASR → "一个RAG项目" (ratio=0.95) → PASS

输入文本: "最近我在做一个 RAG 项目，需要大量跑测试"

预期:
  - P2v attempt 1: verdict=fail, level=0
  - Repair 决策: L0 原样重试
  - P2v attempt 2: verdict=pass
  - 最终状态: verified
  - verify/ 下有 2 个 attempt 文件
```

### TC-02: Level 1 通过 — 调参修复

Level 0 两次都失败，Level 1 降 temperature 后成功。

```
Fixture 剧本:
  attempt 1: TTS(temp=0.7) → bad.wav,  ASR → "卖个跑本地模型" → FAIL
  attempt 2: TTS(temp=0.7) → bad.wav,  ASR → "马克跑本地模型" → FAIL  (L0 耗尽)
  attempt 3: TTS(temp=0.3) → good.wav, ASR → "Mac跑本地模型"  → PASS

输入文本: "Mac 跑本地模型，之前一直很尴尬"

预期:
  - attempt 1-2: level=0, verdict=fail
  - Repair 决策: 升级到 L1, 策略=lower_temperature
  - attempt 3: level=1, params.temperature=0.3, verdict=pass
  - 最终状态: verified
```

### TC-03: Level 2 通过 — 文本改写修复

英文缩写+数字场景，调参也解决不了，需要改写 text_normalized。

```
Fixture 剧本:
  attempt 1: TTS(temp=0.7, text="GPT-4o 的表现") → ASR → "GPT佛哦的表现" → FAIL
  attempt 2: TTS(temp=0.7, text="GPT-4o 的表现") → ASR → "GPT佛哦的表现" → FAIL
  attempt 3: TTS(temp=0.3, text="GPT-4o 的表现") → ASR → "GPT佛哦的表现" → FAIL
  attempt 4: TTS(temp=0.3, text="GPT-4o 的表现") → ASR → "GPT思偶的表现" → FAIL
  attempt 5: TTS(temp=0.7, text="GPT four o 的表现") → ASR → "GPT four o的表现" → PASS

输入文本: "GPT-4o 的表现令人惊艳"

预期:
  - attempt 1-2: level=0, verdict=fail
  - attempt 3-4: level=1, verdict=fail
  - Repair 决策: 升级到 L2, 策略=rewrite_text
  - diagnosis.missing=["4o"], repair_action.suggested_text 含 "four o"
  - attempt 5: level=2, text_normalized 被改写, verdict=pass
  - normalized_history 新增一条 source="repair-l2" 的记录
```

### TC-04: Level 3 — 所有自动修复失败，进入 needs_review

```
Fixture 剧本:
  attempt 1-5: 全部 FAIL（模拟无论怎么改都读不对的极端情况）

输入文本: "WWDC25 发布了 visionOS 3.0"

预期:
  - 5 次 attempt 全部 verdict=fail
  - 最终状态: needs_review
  - verify/ 下有 5 个 attempt 文件，包含完整诊断链
  - pipeline 不阻塞其他 chunk
```

### TC-05: P2c 拦截 — 格式错误不进 ASR

```
Fixture 剧本:
  attempt 1: TTS → corrupt.wav (采样率 22050Hz)
  P2c 检测到采样率不对 → 直接 retry P2，不调 WhisperX
  attempt 2: TTS → good.wav (44100Hz mono)
  P2v → ASR → PASS

预期:
  - attempt 1: P2c fail, 不触发 P2v
  - attempt 2: P2c pass → P2v pass
  - WhisperX 只被调用 1 次（不是 2 次）
```

### TC-06: 多维评估 — 音素距离区分真错 vs ASR 误识别

```
Fixture 剧本:
  attempt 1: TTS 发音正确, ASR → "装了欧拉玛" (中文谐音)

  多维评估:
    时长/字数比:    0.95 ✓ (正常语速)
    静音检测:      1.00 ✓ (无异常静音)
    音素距离:      0.88 ✓ ("ou la ma" vs "ou la ma" — 拼音完全匹配)
    字符比:        0.72 ✗ (中文 vs 英文，字符数差异大)
    ASR 置信度:    0.45   (中等)
    综合加权分:    0.83 → PASS

输入文本: "装了 Ollama，跑个小模型还行"

预期:
  - 虽然 char_ratio 偏低，但音素距离表明发音正确
  - verdict=pass，不触发不必要的 retry
  - 避免了假阳性
```

### TC-07: 关键词缺失 — 整词吞掉

```
Fixture 剧本:
  attempt 1: TTS → ASR → "用跑，烧钱" (API 被完全吞掉)

  多维评估:
    时长/字数比:    0.55 ✗ (5字文本只有1秒，正常应2秒+)
    静音检测:      0.40 ✗ (中间有 0.8s 异常静音)
    音素距离:      0.30 ✗ ("yong pao" vs "yong API pao" — 缺失严重)
    字符比:        0.60 ✗
    ASR 置信度:    0.92   (ASR 很确定就是没读)
    综合加权分:    0.45 → FAIL

预期:
  - 确定性信号（时长+静音）已经足够判定失败
  - diagnosis.type = "word_missing", diagnosis.missing = ["API"]
  - 高置信度 + 确定性信号双重确认 → 高可信度的真阳性
```

## Mock 实现

### MockTtsProvider

```typescript
interface MockTtsProvider {
  name: "mock";

  // fixture 驱动：按 (chunk_id, attempt) 返回预设 WAV
  fixtures: Record<string, Buffer[]>;  // chunk_id → [attempt1.wav, attempt2.wav, ...]

  synthesize(text: string, params: TtsParams): Promise<Buffer> {
    return this.fixtures[chunkId][attemptIndex];
  }
}
```

WAV fixture 来源：
- **silence.wav**: ffmpeg 生成的静音（模拟吞字）
- **short.wav**: 0.3s 极短音频（模拟截断）
- **good.wav**: 正常时长的 440Hz 正弦波（格式正确的占位）
- **corrupt.wav**: 22050Hz 采样率（模拟格式错误）

不需要真实语音内容——P2c 只检查格式，P2v 的 ASR 结果由 MockWhisperX 返回。

### MockWhisperX

```typescript
interface MockWhisperX {
  // fixture 驱动：按 (chunk_id, attempt) 返回预设 transcript
  fixtures: Record<string, TranscriptFixture[]>;

  transcribe(audioPath: string): TranscriptResult {
    return this.fixtures[chunkId][attemptIndex];
  }
}
```

Transcript fixture 示例：

```json
{
  "full_transcribed_text": "一个IG项目",
  "segments": [{
    "text": "一个IG项目",
    "start": 0.0,
    "end": 3.2,
    "words": [
      {"word": "一个", "start": 0.0, "end": 0.8, "score": 0.95},
      {"word": "IG",   "start": 0.8, "end": 1.5, "score": 0.31},
      {"word": "项目", "start": 1.5, "end": 3.2, "score": 0.97}
    ]
  }]
}
```

关键：`score` 字段用于测试多维评估中 ASR 置信度的权重。

### Fixture 文件组织

```
test/fixtures/repair/
├── tc-01-level0-pass/
│   ├── scenario.json        ← 剧本：输入文本、repair 配置、预期结果
│   ├── tts/
│   │   ├── attempt_1.wav    ← mock TTS 第 1 次返回
│   │   └── attempt_2.wav
│   └── asr/
│       ├── attempt_1.json   ← mock ASR 第 1 次返回的 transcript
│       └── attempt_2.json
├── tc-02-level1-pass/
│   ├── scenario.json
│   ├── tts/
│   └── asr/
├── ...
```

`scenario.json` 格式：

```json
{
  "description": "Level 0 通过 — RAG 第一次错读为 IG，重试后正确",
  "chunk": {
    "id": "test_chunk_01",
    "text": "最近我在做一个 RAG 项目，需要大量跑测试",
    "text_normalized": "最近我在做一个 RAG 项目，需要大量跑测试"
  },
  "repair_config": {
    "max_attempts_per_level": [2, 2, 1],
    "max_total_attempts": 5
  },
  "expected": {
    "total_attempts": 2,
    "final_verdict": "pass",
    "final_status": "verified",
    "max_level_reached": 0,
    "asr_call_count": 2,
    "history": [
      {"attempt": 1, "level": 0, "verdict": "fail"},
      {"attempt": 2, "level": 0, "verdict": "pass"}
    ]
  }
}
```

## 测试运行方式

```bash
# 离线运行，不需要 Fish API 和 WhisperX
node test/repair/run-repair-tests.js
```

测试框架读取每个 `tc-*/scenario.json`，注入 mock provider，驱动 Repair 循环，断言最终状态和 attempt 历史与 `expected` 匹配。

全量离线，秒级完成。
