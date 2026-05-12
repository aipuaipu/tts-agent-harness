# TTS Agent Harness

当前版本：**[2026.05.12]** (详细更新日志见 [CHANGELOG.md](CHANGELOG.md))

确定性视频脚本转语音加字幕生产工具。导入脚本 JSON/TXT/MD 文档或者直接在 Web UI 中粘贴剪贴板文案，系统会自动智能分段，输出分段 WAV + 时间对齐字幕，最后拼接为完整的音频和字幕产物。

**原始项目在线 Demo**: https://hiveden-tts.fly.dev
**新项目在线 Demo**: 待部署

## 最新特性 (Recent Updates)

- **极致流畅的多维音色筛选**：新增了针对 Fish Audio 音色的语言、性别、年龄等多维度过滤系统，引入 SWR 进行数据缓存，实现即时、高性能的音色探索。
- **TTS 连字符发音彻底修复**：增加正则替换预处理逻辑，完美解决英文复合词间的连字符被语音引擎错误播报的问题。
- **全量汉化与通俗化重构**：彻底告别生硬的技术缩写（如 P1/P2/Episode），全界面采用最直白的中文操作动词（如切分、预检、合成、项目等），大幅降低非技术人员的使用心智成本。
- **多端接口接入与安全提升**：支持直连 Xiaomi MiMo 官方 TTS 服务端 API；前端 API Key 升级为加密 HttpOnly Cookie 存储极大提升安全性；音频支持带倍速的连续播放。

## 架构

```
浏览器 → Next.js (3010) → FastAPI (8100) → Prefect Tasks
                                              ↓
                                     PostgreSQL + MinIO
```

流水线流程：**切分 → 预检 → 合成 → 初筛 → 校验 → 字幕 → 拼接 → 验收**

## 前置依赖

- Docker（PostgreSQL + MinIO + Prefect）
- Node.js 18+
- Python 3.11 + venv
- ffmpeg + ffprobe

## 快速开始

```bash
# 0. 一键启动（推荐）
make start        # dev + wait + migrate + serve

# 1. 启动基础设施
make dev          # PostgreSQL + MinIO + Prefect (Docker)

# 2. 配置
cp .env.dev .env  # 编辑 FISH_TTS_KEY

# 3. 数据库迁移
make migrate

# 4. 启动服务
make serve        # API :8100 + Web :3010

# 5. 打开浏览器
make open         # → http://localhost:3010
```

Windows / PowerShell 直接用：

```powershell
.\start.ps1
# 或
start.cmd
```

## 使用流程

1. 导入脚本文件或直接粘贴文案以创建**项目**
2. 点击**合成全部**执行全量流水线
3. 逐句试听音频，不满意可直接编辑文本后单句重跑（重试）
4. 全部满意后导出（按镜头切分的 WAV + 字幕 zip 包）

### API Key 配置

本地开发：在 `.env` 中配置 `FISH_TTS_KEY` 和 `WHISPERX_URL`。

线上部署：用户在 Web UI 右上角钥匙图标填入自己的 API Key（Fish Audio + Groq）。
系统会在保存前自动连接相关端点验证 Key 的有效性，验证通过后采用 `COOKIE_SECRET` 进行加密，并存储在浏览器的 HttpOnly Cookie 中，避免 Key 暴露在 localStorage 或被第三方拓展截取，极大提升了安全性。前端输入框也禁用了浏览器自动填充行为。

优先级：Cookie 携带的加密 Key > 环境变量 > 401 拒绝。

### ASR 后端

| 方式 | 配置 | 适用场景 |
|------|------|---------|
| 本地 WhisperX | `WHISPERX_URL=http://localhost:7860` | 开发环境，有 GPU |
| Groq Whisper API | `GROQ_API_KEY=gsk_xxx` 或前端填入 | 线上部署，无 GPU |

优先级：前端传入加密 Cookie 中的 Groq Key > 环境变量 GROQ_API_KEY > WHISPERX_URL > 401

## 脚本格式

系统虽然支持多种导入格式，但在后台都会转换为标准的 `script.json`：

```json
{
  "title": "项目标题",
  "segments": [
    { "id": 1, "type": "hook", "text": "要朗读的文本，可含 [break] 控制标记。" },
    { "id": 2, "type": "content", "text": "正文内容。" }
  ]
}
```

`text` 同时用于 TTS 输入和字幕来源。S2-Pro 控制标记（`[break]`/`[breath]`/phoneme）在字幕环节会自动剥离。

## 导出格式（Remotion 消费）

```
episode.zip/
  shot01.wav, shot02.wav, ...
  subtitles.json   — {shot_id: [{id, text, start, end}]}
  durations.json   — [{id, duration_s, file}]
```

## 环境变量（.env）

| 变量 | 必需 | 说明 |
|------|------|------|
| `FISH_TTS_KEY` | 开发时 | Fish Audio API 密钥（线上由用户前端填入） |
| `FISH_TTS_REFERENCE_ID` | 否 | 声音克隆 ID |
| `TTS_PROVIDER` | 否 | 默认 TTS provider，默认 `fish` |
| `XIAOMI_MIMO_API_KEY` | 否 | Xiaomi MiMo 服务端 API Key（provider=`xiaomi_mimo` 时必需） |
| `XIAOMI_MIMO_TTS_MODEL` | 否 | Xiaomi MiMo 默认 TTS 模型，默认 `mimo-v2.5-tts` |
| `XIAOMI_MIMO_TTS_VOICE` | 否 | Xiaomi MiMo 默认音色，默认 `mimo_default` |
| `WHISPERX_URL` | 开发时 | 本地 WhisperX 地址（默认 localhost:7860） |
| `GROQ_API_KEY` | 否 | Groq Whisper API 密钥（线上由用户前端填入） |
| `DATABASE_URL` | 否 | PostgreSQL（默认 localhost:55432） |
| `MINIO_ENDPOINT` | 否 | MinIO（默认 localhost:59000） |
| `STORAGE_QUOTA_GB` | 否 | 存储上限 GB（默认 5），超限自动清理最旧未锁定的项目 |
| `STORAGE_TARGET_GB` | 否 | 清理目标 GB（默认 4） |
| `COOKIE_SECRET` | 否 | 用于加密 Cookie 中存储的 API Key（生产环境建议配置，否则重启失效） |

## 项目管理

- **锁定/解锁 (Lock/Unlock)**: `POST /episodes/{id}/lock` — 锁定项目防止被意外修改和自动清理
- **自动清理**: 存储超 `STORAGE_QUOTA_GB` 时，按时间顺序删除最旧的未锁定项目

## 技术栈

- **TTS**: Fish Audio + Xiaomi MiMo provider
- **ASR**: Groq Whisper API（线上）/ WhisperX（本地）
- **后端**: FastAPI + Prefect + SQLAlchemy
- **前端**: Next.js 16 + Zustand + Tailwind CSS v4 + Radix UI
- **存储**: PostgreSQL + MinIO
- **音频**: ffmpeg

## 测试

```bash
cd server && python -m pytest tests/ -x   # Python 单元测试
cd web && npx tsc --noEmit                 # TypeScript 类型检查
cd web && npx playwright test              # E2E 测试
```

## 文档

见 [docs/README.md](docs/README.md)

## TTS Providers

目前系统支持多 provider 进行合成：

- `fish`
- `xiaomi_mimo`

其中：

- `fish` 直接调用 Fish Audio HTTP API，需要 Fish API Key
- `xiaomi_mimo` 直连官方 Xiaomi MiMo 服务端 HTTP API：
  - endpoint：`https://api.xiaomimimo.com/v1/chat/completions`
  - header：`api-key: $XIAOMI_MIMO_API_KEY`
  - 非流式返回：`choices[0].message.audio.data`（base64）

典型 `tts_config`：

```json
{
  "provider": "xiaomi_mimo",
  "model": "mimo-v2.5-tts",
  "voice": "mimo_default",
  "style_prompt": "Warm and upbeat."
}
```

voiceclone 典型配置：

```json
{
  "provider": "xiaomi_mimo",
  "model": "mimo-v2.5-tts-voiceclone",
  "voice_data_uri": "data:audio/mpeg;base64,...",
  "style_prompt": "Calm and intimate."
}
```

## Authoring Input / 脚本导入

现在新建项目有三种入口，都会在后台统一转换成 canonical `script.json`：

- 上传 `script.json`（兼容旧流程）
- 上传 `.txt` / `.md` 文档
- 直接在 Web UI 粘贴文案或 Markdown

默认导入规则是确定性的：

- Markdown `# 标题` 或 frontmatter `title:` 会变成项目标题
- 空行分隔的段落会变成不同的镜头 (shot)
- Markdown 列表项也会各自变成一个镜头
- 下游流水线仍然只消费标准 JSON，底层切分逻辑无需变更

对普通用户的建议写法：

```md
# 这一期标题

第一镜头文案。

第二镜头文案。

- 第三镜头也可以写成列表
- 第四镜头
```

## License

MIT
