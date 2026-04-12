# TTS Agent Harness — 用户故事 & 功能点 & 链路审计

> 审计日期: 2026-04-10
> 更新日期: 2026-04-10 (产品决策补充)
> 审计范围: 前端 page.tsx → hooks → api-client → FastAPI routes → Prefect flows → DB/MinIO 全链路

---

## 产品设计决策（2026-04-10 讨论确认）

### D-01: TTS Config 管理

- **层级**: Episode 级（不下放到 chunk）
- **工作流**: 探针校准 → 锁定 → 批量合成 → 后续只微调文本
- **理由**: config 调整是一次性的前置校准，不是贯穿全程的操作

### D-02: Run 按钮职责

- Run = "选定范围内的 chunk，跑完整 pipeline"
- Run **不管** "从哪个 stage 开始" — 那是 chunk 级 StageLogDrawer 的职责
- P1 切分与 Run 分离 — P1 是独立操作，Run 的前提是 chunks 已存在

### D-03: 按钮状态设计

| Episode Status | 按钮 | 行为 |
|---|---|---|
| `empty` | 切分 | 只跑 P1 |
| `ready` | 合成全部 / 合成选中(N) | 全部或勾选的 chunk 跑 P2→P3→P5→P6 |
| `running` | 运行中... | 禁用 |
| `failed` | 重试失败(N) | 只跑 status=failed 的 chunk |
| `done` | 完成 ✓ | 菜单里"重新生成"（需确认，清空重来） |

### D-04: 两层重试分离

| 层 | UI 位置 | 粒度 |
|---|---|---|
| Episode 级 | Header 按钮 | 批量 chunk × 完整 pipeline |
| Stage 级 | Episode stage 进度条（新） | 批量重跑某 stage 的失败 chunk |
| Chunk 级 | StageLogDrawer retry 按钮 | 单 chunk × 指定 stage |

### D-05: 跳过已确认 chunk

- **规则**: 有 `selectedTakeId` 的 chunk → Run 时跳过 P2，直接跑 P3→P5
- **不加新字段**: "有满意的 take" 本身就是"已确认"的信号
- **全部重做**: "重新生成" = 清空 takes → 回 pending → 全量跑

### D-06: Episode 级 Stage 进度条（新 UI 概念）

```
P1 [✓ 20/20] ─── P2 [17/20 ⚠3] ─── P3 [17/17] ─── P5 [17/17] ─── P6 [pending]
                    └── 点击 → "重跑 3 个失败的 P2"
```

数据来源: 从所有 chunks 的 stageRuns 聚合。

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
| F-03-2 Episode 级 stage 进度条 | 新 UI（D-06），从 chunks.stageRuns 聚合 | ❌ **未实现** |
| F-03-3 SSE 推送更新 | `pg_notify → sse.py → EventSource → mutate()` | ✅ |
| F-03-4 running 轮询 | SWR `refreshInterval: 2000` when `status === "running"` | ✅ |

### US-04: 切分脚本 (P1)

上传 script 后，切分成 chunks 供预览。P1 与 Run 分离（D-02）。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-04-1 切分按钮 | EpisodeHeader (status=empty 时显示) | ❌ **未实现**（当前 Run 包含 P1） |
| F-04-2 P1 执行 | `POST /episodes/{id}/run` → `p1_chunk()` | ✅ 后端有 |
| F-04-3 chunks 预览 | ChunksTable 显示切分结果 | ✅ |

### US-05: 探针校准 TTS Config

用 chunk #1 当探针，调 TTS 参数（temperature/top_p/speed），试听后锁定 config。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-05-1 TtsConfigBar 显示 config | 读 `episode.config` | ❌ **组件未接入 page.tsx** |
| F-05-2 修改 config | `PUT /episodes/{id}/config` | ❌ **API 不存在** |
| F-05-3 单 chunk P2 探针 | 选 chunk #1 → retry P2 | ✅ chunk 级 retry 已有 |
| F-05-4 P2 读 episode.config | `p2_synth` 读 `episode.config` 构造 FishTTSParams | ❌ **P2 从 env var 读** |
| F-05-5 听 → 不满意 → 再调 → 重跑 | 循环 F-05-2 → F-05-3 | ❌ 依赖 F-05-2/F-05-4 |
| F-05-6 锁定后批量合成 | 用确认的 config 跑全部 chunk 的 P2 | ❌ 依赖 Run 按钮重设计 |

### US-06: 批量合成 (Run)

探针确认后，批量跑 P2→P3→P5→P6。已有 take 的 chunk 跳过 P2（D-05）。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-06-1 合成全部按钮 | EpisodeHeader (status=ready) | ⚠ **当前是 Generate，语义需改** |
| F-06-2 跳过有 take 的 chunk | Run flow 检查 `selected_take_id` | ❌ **未实现** |
| F-06-3 P2→P3→P5→P6 | `run_episode_flow` | ✅ 后端有 |
| F-06-4 多选 chunk 合成 | checkbox + "合成选中(N)" | ❌ **未实现** |

### US-07: 编辑 Chunk TTS 源文本

编辑 `textNormalized`，保存后重新合成 (P2 → P3 → P5)。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-07-1 打开编辑 | ChunksTable `onEdit()` → ChunkEditor | ✅ 纯前端 |
| F-07-2 Stage 草稿 | `handleStage()` → `edits` state | ✅ 纯前端 |
| F-07-3 Apply All | `applyEdits()` → per-chunk `POST .../edit` + `POST .../retry?from_stage=p2&cascade=true` | ✅ |
| F-07-4 P2→P3→P5 级联 | `retry_chunk_stage_flow` → `CHUNK_STAGES[p2:]` | ✅ |

### US-08: 编辑 Chunk 字幕文本

编辑 `subtitleText`，只重生字幕 (P5)。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-08-1 编辑字幕 | ChunkEditor subtitleText field | ✅ 纯前端 |
| F-08-2 Retry P5 | `from_stage="p5"` → `retry_chunk_stage_flow` → 只跑 P5 | ✅ |

### US-09: 播放 Chunk 音频

点击 Play 播放该 chunk 的合成音频。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-09-1 Play 按钮 | ChunkRow toggle `playingChunkId` | ✅ 纯前端 |
| F-09-2 获取 URL | `getAudioUrl(audioUri)` → `/audio/{audioUri}` | ✅ URL 生成正确 |
| F-09-3 下载音频 | `GET /audio/{audioUri}` → MinIO download | ❌ **路由未实现** |
| F-09-4 播放控制 | HTMLAudioElement play/pause | ✅ 纯前端 |

### US-10: 选择 Take

多次合成的 chunk 有多个 take，用户选择其中一个作为最终版。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-10-1 显示 takes 列表 | TakeSelector (takes.length > 1 时显示) | ✅ 纯前端 |
| F-10-2 Finalize take | `finalizeTake()` → `POST .../finalize-take?take_id=...` → Prefect flow → P3→P5 | ✅ |

### US-11: 查看 Stage 执行日志

点击 chunk 的某个 stage pill，查看执行日志 + retry。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-11-1 点击 stage pill | StagePipeline `onStageClick()` | ✅ 纯前端 |
| F-11-2 StageLogDrawer 获取日志 | fetch → `GET .../chunks/{cid}/log?stage=xxx` | ✅ |
| F-11-3 显示日志 | pre 标签渲染 | ✅ |
| F-11-4 Retry 单 stage | StageLogDrawer → `POST .../retry?from_stage=xxx` | ✅ |
| F-11-5 Retry + cascade | cascade=true 级联下游 | ✅ |

### US-12: 查看 Episode 事件日志

查看 episode 的事件时间线。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-12-1 LogViewer 显示 | `<LogViewer log={[]} />` | ❌ **传空数组，未加载** |
| F-12-2 后端日志格式化 | `GET /episodes/{id}/logs?tail=100` → `EventRepo.list_recent()` | ✅ 后端有 |

### US-13: 删除 Episode

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-13-1 删除按钮 | EpisodeSidebar 右键菜单 | ⚠ 需验证 UI 存在 |
| F-13-2 确认对话框 | window.confirm | ⚠ 需验证 |
| F-13-3 调用删除 | `deleteEpisode()` → `DELETE /episodes/{id}` → cascade delete | ✅ |

### US-14: 复制 Episode

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-14-1 Duplicate 按钮 | EpisodeSidebar 右键菜单 | ⚠ 需验证 UI 存在 |
| F-14-2 输入新 ID | window.prompt | ⚠ 需验证 |
| F-14-3 调用复制 | `duplicateEpisode()` → `POST .../duplicate` | ✅ |

### US-15: 归档 Episode

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-15-1 Archive 按钮 | EpisodeSidebar 右键菜单 | ⚠ 需验证 UI 存在 |
| F-15-2 调用归档 | `archiveEpisode()` → `POST .../archive` → set archived_at | ✅ |
| F-15-3 列表隐藏 | `GET /episodes` 默认排除 archived | ⚠ API 未传 include_archived 参数 |

### US-16: 重试失败的 Chunks

部分 chunk 失败后，只重跑失败的。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-16-1 "重试失败(N)" 按钮 | EpisodeHeader (status=failed) | ❌ **未实现**（当前 Retry 从头跑 P1-P6） |
| F-16-2 只跑 failed chunks | Run flow 过滤 `chunk.status == "failed"` | ❌ **未实现** |
| F-16-3 从失败的 stage 继续 | 读 stage_runs 找到 failed 的 stage | ❌ **未实现** |

### US-17: 重新生成（全部重做）

换了 config 或整体不满意，清空重来。

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-17-1 "重新生成" 菜单项 | EpisodeHeader 菜单 (status=done) | ❌ **未实现** |
| F-17-2 确认弹窗 | "会丢失所有已有产物" | ❌ **未实现** |
| F-17-3 清空 + 重跑 | DELETE chunks/takes → P1 → P2→P3→P5→P6 | ⚠ 当前 Run 已有此行为 |

### US-18: 实时事件推送 (SSE)

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-18-1 连接 | EventSource → `GET /episodes/{id}/stream` | ✅ |
| F-18-2 监听事件 | `stage_event` → onEvent → mutate() | ✅ |
| F-18-3 自动重连 | EventSource 原生支持 | ✅ |

### US-19: API Token 认证

| 功能点 | 链路 | 状态 |
|---|---|---|
| F-19-1 Token 验证 | `auth.py verify_token()` | ✅ |
| F-19-2 Dev mode | 未设 token → 允许所有 | ✅ |
| F-19-3 前端注入 | `api-client.ts` Authorization header | ✅ |

---

## Part 2: Break Point 清单（按严重度排序）

| # | 功能 | 断点 | 严重度 | 修复方案 |
|---|---|---|---|---|
| **BP-01** | 播放音频 (F-09-3) | `GET /audio/{audioUri}` 路由未实现 | **高** | 新增 audio serving route |
| **BP-02** | 事件日志 (F-12-1) | LogViewer 传 `log={[]}`，未加载 | **中** | 实现 `useEpisodeLogs(id)` hook |
| **BP-03** | TTS config 管理 (US-05) | 整个 US 未实现：无 API、P2 不读 config、前端未接入 | **中** | 需后端 + flow + 前端三层联动 |
| **BP-04** | Run 按钮语义 (D-03) | 当前 Run=从头跑 P1-P6，不区分切分/合成/重试失败 | **中** | 按 D-03 重设计 |
| **BP-05** | 跳过已确认 chunk (D-05) | Run 不检查 selectedTakeId | **中** | run_episode_flow 加条件判断 |
| **BP-06** | 归档列表过滤 (F-15-3) | `GET /episodes` 未传 `include_archived` | **低** | 加 query param |
| **BP-07** | Episode 级 stage 进度条 (D-06) | 新 UI 概念，尚未实现 | **低** | 新 component |

---

## Part 3: 测试覆盖度

### 已有测试覆盖的功能

| US | 单元测试 | 集成测试 | e2e 测试 |
|---|---|---|---|
| US-01 创建 | — | test_routes::test_create_episode | test_episode_crud::test_create |
| US-02 加载详情 | — | test_routes::test_get_episode | test_episode_crud::test_get |
| US-06 Run pipeline | test_run_episode (mock) | test_routes::test_trigger_run | test_full_pipeline::happy_path |
| US-07 编辑文本 | — | test_routes::test_edit_chunk | test_chunk_operations::test_edit |
| US-07 重试 P2 | test_retry_chunk (mock) | test_routes::test_retry_chunk | test_chunk_operations::test_retry |
| US-10 Finalize take | — | test_routes::test_finalize_take | — |
| US-11 查看日志 | — | test_routes::test_get_chunk_log | — |
| US-13 删除 | — | test_routes::test_delete_episode | test_episode_crud::test_delete |
| US-14 复制 | — | test_routes::test_duplicate | — |
| US-15 归档 | — | test_routes::test_archive | — |
| US-18 SSE | test_sse (api) | — | test_sse (e2e) |
| US-19 认证 | — | test_routes::test_auth_* | — |

### 未覆盖的功能

| US | 缺失维度 | 原因 |
|---|---|---|
| US-04 切分 (P1 独立) | 前端入口 | 按钮未按 D-03 重设计 |
| US-05 探针校准 | 全部 | 整个 US 未实现 |
| US-06 跳过已确认 | 全部 | Run flow 未实现跳过逻辑 |
| US-09 播放音频 | 全部 | 后端路由不存在 |
| US-12 事件日志 | 前端集成 | 前端未调用后端 |
| US-16 重试失败 | 全部 | 按钮未按 D-03 重设计 |
| US-17 重新生成 | 全部 | 按钮未按 D-03 重设计 |
| 前端 component 测试 | 全部 | vitest 配置了但零测试文件 |
| 真实 HTTP 服务器测试 | 全部 | 所有后端测试用 ASGI transport |
| 前后端联调 | 全部 | 从未在浏览器里跑过 |
