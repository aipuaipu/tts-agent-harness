# A10 Frontend — Worklog

**Agent**: A10
**Wave**: W5
**Branch**: agent/A10-frontend
**Status**: completed

## 产物

| 文件 | 说明 |
|------|------|
| `web/lib/adapters/api/http-client.ts` | fetch wrapper: base URL / Bearer token / 统一错误处理 / JSON+multipart |
| `web/lib/adapters/api/mappers.ts` | 后端 snake_case Pydantic schema -> 前端 camelCase domain types 映射 |
| `web/lib/adapters/api/episode-store.ts` | EpisodeStore port 实现: list/get/create/delete |
| `web/lib/adapters/api/chunk-store.ts` | ChunkStore port 实现: get/applyEdits + stubs |
| `web/lib/adapters/api/pipeline-runner.ts` | PipelineRunner port 实现: runFull/applyEdits/retryChunk/finalizeTake + stubs |
| `web/lib/adapters/api/observability.ts` | ProgressSource + LogTailer 实现 |
| `web/lib/adapters/api/index.ts` | re-export 全部 adapter |
| `web/lib/sse-client.ts` | EventSource wrapper, 连接 /episodes/{id}/stream |
| `web/lib/factory.ts` | 已切换到 api adapter, legacy 保留但不 import |
| `web/lib/hooks.ts` | SWR hooks 直接调 FastAPI + SSE 实时更新 |

## Port 方法实现状态

### EpisodeStore
- ✅ list() — GET /episodes
- ✅ get(id) — GET /episodes/{id}
- ✅ create(id, scriptJson) — POST /episodes (multipart)
- ✅ delete(id) — DELETE /episodes/{id}

### ChunkStore
- ✅ get(epId, cid) — 从 episode detail filter
- ✅ applyEdits(epId, edits) — POST /episodes/{epId}/chunks/{cid}/edit (逐个)
- ❌ appendTake — throw "not implemented"
- ❌ selectTake — throw "not implemented"
- ❌ removeTake — throw "not implemented"

### PipelineRunner
- ✅ runFull(epId) — POST /episodes/{epId}/run
- ✅ retryChunk(epId, cid) — POST /episodes/{epId}/chunks/{cid}/retry
- ✅ finalizeTake(epId, cid) — POST /episodes/{epId}/chunks/{cid}/finalize-take
- ✅ applyEdits(epId, edits) — 先 edit 再 retry
- ❌ cancel — throw "not implemented"
- ❌ getJobStatus — throw "not implemented"

### Observability
- ✅ getCurrentStage — 从 episode detail stage_runs 推断
- ✅ isRunning — episode.status === "running"
- ✅ tail — 返回空数组 (无后端 route)
- ✅ clear — no-op

## 关键决策

1. **直接调 FastAPI, 不走 Next.js BFF**: hooks.ts 的 SWR fetcher 直接 fetch FastAPI :8000, 而不是走 /api/* Route Handler。Route Handler 保留但通过 factory 也走 API adapter。

2. **SSE 作为增量更新**: useEpisode hook 内部用 connectSSE 订阅 stage_event, 每收到事件就 mutate SWR cache 触发 re-fetch。这比手动 patch state 更简单可靠。

3. **类型映射集中在 mappers.ts**: 所有 snake_case -> camelCase 转换封装在一处, 便于维护。后端 `extra_metadata` -> 前端 `metadata`。

4. **Stub 模式**: AudioService/PreviewService/ExportService/LockManager 无后端 API 对应, 用 stub 实现 throw error。factory 仍然满足 Services 接口。

## 放弃的方案

- **openapi-typescript 自动生成类型**: 后端 OpenAPI spec 还未部署, 手写 Raw* 类型 + mapper 更实际。等后端稳定后可切换。
- **SSE 内联 patch state**: 考虑过在 SSE callback 里直接修改 SWR cache 中的 episode 对象, 但这样要维护复杂的 partial update 逻辑。改用 mutate() re-fetch 整个 episode, 实现简单、数据一致。

## 给下游的提示

- `getAudioUrl` 目前返回的 URL 格式 (`/episodes/{id}/chunks/{cid}/audio/{takeId}`) 在 FastAPI 端还没有对应 route, 需要 A9 agent 补一个音频文件 serving endpoint。
- `exportEpisode` 直接 throw, 因为 FastAPI 没有 export endpoint。
- SSE 不传 auth token — EventSource API 不支持自定义 header。如果启用 token 鉴权, 需要用 query parameter 传 token 或改用 fetch-based SSE。

## 测试

- `npx tsc --noEmit` — 零 error ✅
- `pnpm dev` — 正常启动 ✅
- 未修改 web/components/*.tsx ✅
- 未修改 web/app/page.tsx ✅
- 未修改 web/lib/types.ts ✅
- 未修改 server/ ✅
- legacy adapter 保留, 未删除 ✅
