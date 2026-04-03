# CLAUDE.md — TTS Agent Harness

多 Agent TTS 语音生产系统。输入脚本 JSON，输出 per-shot WAV + 时间对齐字幕。

**当前只支持**：Fish Audio TTS（S2-Pro）+ WhisperX（本地）。P4 Claude 校验保留但生产流程中跳过。

## 架构速查

### 生产流程（跳过 P4）

```
P1 切分(JS) → P2 TTS(Fish S2-Pro) → precheck → P3 转写(WhisperX) → P5 字幕(JS) → P6 拼接(ffmpeg) → postcheck → V2 预览
```

### 完整流程（含 P4，当前未使用）

```
P1 → P2 → precheck → P3 → precheck → text-diff → P4 校验(Claude) → P5 → P6 → postcheck → V2
```

| 脚本 | 作用 | 确定性 |
|------|------|--------|
| `p1-chunk.js` | 按句切分，normalize 只做 trim（不修改内容） | 是 |
| `p2-synth.js` | Fish TTS S2-Pro 并行合成，normalize:false，支持 temperature/top_p | 否（API） |
| `p3-transcribe.py` | WhisperX 转写，Server 模式常驻，HF_HUB_OFFLINE=1 | 否（模型） |
| `text-diff.js` | Levenshtein + 同音字，auto-pass < 10% 差异 | 是 |
| `p4-validate.js` | Claude 校验 + 自动修复循环，最多 3 轮（生产中跳过） | 否（LLM） |
| `p5-subtitles.js` | 加权分配 word 时间戳到字幕行，自动 strip 控制标记 | 是 |
| `p6-concat.js` | ffmpeg 拼接 + padding/gap + 字幕偏移 | 是 |
| `postcheck-p6.js` | 端到端验证：覆盖率/gap/overlap | 是 |
| `precheck.js` | Post-P2（WAV 格式）/ Post-P3（transcript 质量） | 是 |
| `v2-preview.js` | HTML 字幕预览页 | 是 |

## 状态机

```
pending → synth_done → transcribed → validated → (P5/P6 消费)
```

生产流程中 P3 完成后直接进 P5，不经过 text-diff 和 P4。

## .harness/ 配置

```
.harness/
├── config.json    ← 技术参数（P1/P2/P3/P5/P6 读取）
└── rules.md       ← 发音规则备忘（人工参考，当前无代码读取）
```

> normalize-patches.json 和 tts-known-issues.json 的读写已移除。P4 跨期记忆机制已废弃。

## 运行方式

```bash
# 完整运行（含 P4）
bash run.sh <script.json> <episode_id>

# 生产运行（跳过 P4）— 从 P3 直接到 P5
bash run.sh <script.json> <episode_id> --from p5  # 已有音频和转写时

# 断点续跑
bash run.sh <script.json> <episode_id> --from p3

# 产物复制到目标项目
bash run.sh <script.json> <episode_id> --output-dir /path/to/public/tts
```

### 单 chunk 重做（人工修复流程）

1. 编辑 `.work/<episode>/chunks.json` 中目标 chunk 的 `text_normalized`
2. 重跑 P2：`node scripts/p2-synth.js --chunks ... --outdir ... --chunk <chunk_id>`
3. 人工听音频，不满意则重复 1-2
4. 满意后从 P3 续跑：`bash run.sh ... --from p3`

## 环境变量（.env，不进 git）

| 变量 | 必需 | 说明 |
|------|------|------|
| `FISH_TTS_KEY` | 是 | Fish TTS API 密钥 |
| `FISH_TTS_REFERENCE_ID` | 否 | 声音克隆 ID（不设则用默认声音） |
| `FISH_TTS_MODEL` | 否 | 覆盖 config.json 的 p2.model（默认 s2-pro） |
| `TTS_SPEED` | 否 | 覆盖 config.json 的 p2.default_speed（默认 1.15） |
| `CLAUDE_API_URL` | 否 | 覆盖 config.json 的 p4.proxy_url（P4 跳过时不需要） |
| `CLAUDE_MODEL` | 否 | 覆盖 config.json 的 p4.model（P4 跳过时不需要） |

所有参数优先级：环境变量 > `.harness/config.json` > 代码默认值。

使用时 `source .env && bash run.sh ...`。模板见 `example/.env.example`。

## 测试

```bash
bash test/run-unit.sh    # 离线单元测试，~2 秒
bash test.sh --p1-only   # P1 切分测试，无需 API
bash test.sh --no-p4     # P1→P6 跳 Claude，需 FISH_TTS_KEY
bash test.sh             # 全量含 P4
```

### AB 参数测试

`test/ab-param-test/` — 测试 Fish TTS temperature/top_p 参数对英文关键词发音的影响。详见其 README。

## 开发约定

- 改任何脚本 → 跑 `bash test/run-unit.sh` 验证
- chunks.json 中 `text` 同时用于 TTS 输入和字幕来源
- P1 的 `text_normalized` = trim(text)，不做内容修改
- P5 自动 strip `[break]`/`[breath]`/`[long break]`/phoneme 控制标记后再生成字幕
- P2 发送 `normalize: false`，让 S2-Pro 引擎原样处理文本

## 脚本格式

```json
{
  "title": "Episode Title",
  "segments": [
    { "id": 1, "type": "hook", "text": "要朗读的文本，可含 [break] 控制标记。" },
    { "id": 2, "type": "content", "text": "正文内容。" }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 数字或字符串。数字会被转为 `shot01`、`shot02`... |
| `type` | 否 | `hook`/`content`/`cta` 等，不影响处理逻辑 |
| `text` | 是 | TTS 输入 + 字幕来源。可含 S2-Pro 控制标记（`[break]`/`[breath]`/phoneme），P5 自动 strip |

## 已知限制

- Fish TTS（S2-Pro）对英文缩写/品牌名的发音不稳定，同一文本多次合成可能读法不同
- temperature/top_p 参数对发音稳定性的影响尚在测试中（见 `test/ab-param-test/`）
- P4 自动修复能力有限且当前生产流程已跳过，遇到发音问题靠人工修改 text_normalized 重做
