# TTS Agent Harness — 用户故事 & 功能点 & 链路审计

> 审计日期: 2026-04-10
> 审计范围: 前端 page.tsx → hooks → api-client → FastAPI routes → Prefect flows → DB/MinIO 全链路

---

## Part 1: 用户故事清单

### US-01: 创建新 Episode

用户上传 script.json，指定 episode ID，创建新 episode。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-01-1 打开新建对话框 | page.tsx → NewEpisodeDialog | ✅ 纯前端 |
| F-01-2 输入 ID + 选择文件 | NewEpisodeDialog 本地 state | ✅ 纯前端 |
| F-01-3 提交创建 | hooks.ts `createEpisode()` → `POST /episodes` multipart → `EpisodeRepo.create()` + `storage.upload_bytes()` | ✅ |
| F-01-4 列表更新 | `mutateList()` → SWR refetch `GET /episodes` | ✅ |

### US-02: 选择 Episode 加载详情

用户从 sidebar 点击 episode，加载 chunks + takes + stage_runs。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-02-1 点击 sidebar | EpisodeSidebar → `setSelectedId()` | ✅ 纯前端 |
| F-02-2 加载详情 | `useEpisode(id)` → `GET /episodes/{id}` → 嵌套 chunks/takes/stage_runs | ✅ |
| F-02-3 连接 SSE | `connectSSE(id)` → EventSource `/episodes/{id}/stream` | ✅ |

### US-03: 查看状态和进度

运行中实时看到 episode 状态变化 + 当前 stage。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-03-1 状态 badge | EpisodeHeader STATUS_BADGE 映射 | ✅ 纯前端 |
| F-03-2 进度条 | StageProgress 组件 | ✅ 纯前端 |
| F-03-3 SSE 推送更新 | `pg_notify → sse.py → EventSource → mutate()` | ✅ |
| F-03-4 running 轮询 | SWR `refreshInterval: 2000` when `status === "running"` | ✅ |

### US-04: 运行 Episode (全 pipeline)

点击 Generate 触发 P1 → P2 → P3 → P5 → P6。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-04-1 确认对话框 | EpisodeHeader popover | ✅ 纯前端 |
| F-04-2 触发 run | `runEpisode()` → `POST /episodes/{id}/run` → Prefect `create_flow_run_from_deployment` | ✅ |
| F-04-3 P1 切分 | `p1_chunk()` → read script → chunk → DB INSERT | ✅ |
| F-04-4 P2 合成 (并行) | `p2_synth.map()` → Fish API → WAV → MinIO | ✅ |
| F-04-5 P3 转写 (并行) | `p3_transcribe.map()` → WhisperX HTTP → transcript JSON | ✅ |
| F-04-6 P5 字幕 (并行) | `p5_subtitles.map()` → SRT → MinIO | ✅ |
| F-04-7 P6 拼接 | `p6_concat()` → ffmpeg → final WAV/SRT → MinIO | ✅ |
| F-04-8 状态推进 | empty → ready → running → done | ✅ |

### US-05: 编辑 Chunk TTS 源文本

编辑 `textNormalized`，保存后重新合成 (P2 → P3 → P5)。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-05-1 打开编辑 | ChunksTable `onEdit()` → ChunkEditor | ✅ 纯前端 |
| F-05-2 Stage 草稿 | `handleStage()` → `edits` state | ✅ 纯前端 |
| F-05-3 Apply All | `applyEdits()` → per-chunk `POST .../edit` + `POST .../retry?from_stage=p2&cascade=true` | ✅ |
| F-05-4 P2→P3→P5 级联 | `retry_chunk_stage_flow` → `CHUNK_STAGES[p2:]` | ✅ |

### US-06: 编辑 Chunk 字幕文本

编辑 `subtitleText`，只重生字幕 (P5)。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-06-1 编辑字幕 | ChunkEditor subtitleText field | ✅ 纯前端 |
| F-06-2 Retry P5 | `from_stage="p5"` → `retry_chunk_stage_flow` → 只跑 P5 | ✅ |

### US-07: 播放 Chunk 音频

点击 Play 播放该 chunk 的合成音频。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-07-1 Play 按钮 | ChunkRow toggle `playingChunkId` | ✅ 纯前端 |
| F-07-2 获取 URL | `getAudioUrl(audioUri)` → `/audio/{audioUri}` | ✅ URL 生成正确 |
| F-07-3 下载音频 | `GET /audio/{audioUri}` → MinIO download | ❌ **路由未实现** |
| F-07-4 播放控制 | HTMLAudioElement play/pause | ✅ 纯前端 |

### US-08: 选择 Take

多次合成的 chunk 有多个 take，用户选择其中一个作为最终版。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-08-1 显示 takes 列表 | TakeSelector (takes.length > 1 时显示) | ✅ 纯前端 |
| F-08-2 Finalize take | `finalizeTake()` → `POST .../finalize-take?take_id=...` → Prefect flow → P3→P5 | ✅ |

### US-09: 查看 Stage 执行日志

点击 chunk 的某个 stage，查看执行日志。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-09-1 点击 stage pill | StagePipeline `onStageClick()` → `setDrawerOpen({cid, stage})` | ✅ 纯前端 |
| F-09-2 打开 StageLogDrawer | drawer 渲染 | ✅ 纯前端 |
| F-09-3 获取日志 | StageLogDrawer fetch → `GET .../chunks/{cid}/log?stage=xxx` | ✅ |
| F-09-4 显示日志 | pre 标签渲染 log text | ✅ |
| F-09-5 Retry 按钮 | StageLogDrawer → `POST .../retry` | ✅ |

### US-10: 查看 Episode 事件日志

查看 episode 的事件时间线。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-10-1 LogViewer 显示 | `<LogViewer log={[]} />` | ❌ **传空数组，未加载** |
| F-10-2 后端日志格式化 | `GET /episodes/{id}/logs?tail=100` → `EventRepo.list_recent()` | ✅ 后端有 |

### US-11: 删除 Episode

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-11-1 删除按钮 | EpisodeSidebar 右键菜单 | ⚠ 需验证 UI 存在 |
| F-11-2 确认对话框 | window.confirm | ⚠ 需验证 |
| F-11-3 调用删除 | `deleteEpisode()` → `DELETE /episodes/{id}` → cascade delete | ✅ |

### US-12: 复制 Episode

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-12-1 Duplicate 按钮 | EpisodeSidebar 右键菜单 | ⚠ 需验证 UI 存在 |
| F-12-2 输入新 ID | window.prompt | ⚠ 需验证 |
| F-12-3 调用复制 | `duplicateEpisode()` → `POST .../duplicate` → read script → create new | ✅ |

### US-13: 归档 Episode

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-13-1 Archive 按钮 | EpisodeSidebar 右键菜单 | ⚠ 需验证 UI 存在 |
| F-13-2 调用归档 | `archiveEpisode()` → `POST .../archive` → set archived_at | ✅ |
| F-13-3 列表隐藏 | `GET /episodes` 默认排除 archived | ⚠ API 未传 include_archived 参数 |

### US-14: 实时事件推送 (SSE)

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-14-1 连接 | EventSource → `GET /episodes/{id}/stream` | ✅ |
| F-14-2 监听事件 | `stage_event` → onEvent → mutate() | ✅ |
| F-14-3 自动重连 | EventSource 原生支持 | ✅ |
| F-14-4 keepalive | 30s comment 保活 | ✅ |

### US-15: API Token 认证

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-15-1 Token 验证 | `auth.py verify_token()` → check `HARNESS_API_TOKEN` env | ✅ |
| F-15-2 Dev mode | 未设 token → 允许所有 | ✅ |
| F-15-3 前端注入 | `api-client.ts` 读 `NEXT_PUBLIC_API_TOKEN` → Authorization header | ✅ |

---

## Part 2: Break Point 清单（按严重度排序）

| # | 功能 | 断点 | 严重度 | 修复方案 |
|---|---|---|---|---|
| **BP-01** | 播放音频 | `GET /audio/{audioUri}` 路由未实现，前端会 404 | **高** | 新增 `routes/audio.py`：从 MinIO 下载 WAV → StreamingResponse |
| **BP-02** | 事件日志 | LogViewer 传 `log={[]}`，未调用后端 | **中** | 实现 `useEpisodeLogs(id)` hook，调用 `GET /episodes/{id}/logs` |
| **BP-03** | 归档列表过滤 | `GET /episodes` 未传 `include_archived` 参数 | **低** | episodes.py list_episodes 加 query param |
| **BP-04** | 删除/复制/归档 UI | 前端重构后这些菜单可能丢了 | **低** | 验证 EpisodeSidebar 是否保留了右键菜单 |

---

## Part 3: 测试覆盖度

### 已有测试覆盖的功能

| US | 单元测试 | 集成测试 | e2e 测试 |
|---|---|---|---|
| US-01 创建 | — | test_routes::test_create_episode | test_episode_crud::test_create |
| US-02 加载详情 | — | test_routes::test_get_episode | test_episode_crud::test_get |
| US-04 运行 pipeline | test_run_episode (mock) | test_routes::test_trigger_run | test_full_pipeline::happy_path |
| US-05 编辑文本 | — | test_routes::test_edit_chunk | test_chunk_operations::test_edit |
| US-05 重试 P2 | test_retry_chunk (mock) | test_routes::test_retry_chunk | test_chunk_operations::test_retry |
| US-08 Finalize take | — | test_routes::test_finalize_take | — |
| US-09 查看日志 | — | test_routes::test_get_chunk_log | — |
| US-11 删除 | — | test_routes::test_delete_episode | test_episode_crud::test_delete |
| US-12 复制 | — | test_routes::test_duplicate | — |
| US-13 归档 | — | test_routes::test_archive | — |
| US-14 SSE | test_sse (api) | — | test_sse (e2e) |
| US-15 认证 | — | test_routes::test_auth_* | — |

### 未覆盖的功能

| US | 缺失维度 | 原因 |
|---|---|---|
| US-07 播放音频 | 全部 | 后端路由不存在 |
| US-10 事件日志 | 前端集成 | 前端未调用后端 |
| 前端 component 测试 | 全部 | vitest 配置了但零测试文件 |
| 真实 HTTP 服务器测试 | 全部 | 所有后端测试用 ASGI transport，不起 uvicorn |
| 前后端联调 | 全部 | 从未在浏览器里跑过 |
