# TODO

已知待办事项。按优先级排序。

---

## P0 · 架构债

### Batch retry (重新设计)

**背景**：之前的批量选中 → Retry P2 功能有致命架构问题，已删除。

**失败原因**（写出来防止下次重犯同样错误）：

1. 前端 `batchRetryChunks` 用 `Promise.allSettled` 并发 N 次 HTTP 调用 `/chunks/:cid/stages/:stage/retry`
2. 每次 HTTP 打到 `runner.retryChunkFromStage`，后者是 **fire-and-forget**：写 job 到 map、acquire chunk-level lock、立即 return jobId、pipeline 在 async IIFE 里后台跑
3. 结果：N 个 job 并行后台执行，spawn N 个独立 `p2-synth.js` 进程
4. 每个 p2-synth 内部 `concurrency=6` → 实际 60 个 concurrent Fish API calls → **429 rate limit**
5. 同时 N 个进程并发 read-modify-write `chunks.json` → **race condition**（后写者覆盖前写者的 status 更新）
6. `InMemoryLockManager` 是 **fail-fast**（throw on contention），不是 queue，所以客户端串行化 HTTP 也不管用（HTTP 返回 ≠ pipeline 完成）

**正确架构**：

新增 `POST /api/episodes/:id/batch-retry` 端点：

```ts
// runner.ts
async batchRetry(epId, cids: ChunkId[], fromStage: StageName, opts) {
  const handle = await this.locks.acquire({ type: "global" }, ...);
  const { logFile, runningFile, lastExit } = this.prepareWork(epId, "batch-retry");

  // fire-and-forget background loop
  (async () => {
    try {
      // 启动 P3 server 一次(全部 cids 共享)
      await ensureP3Server(workDir(epId), logFile, this.spawnAndWait.bind(this));

      for (const cid of cids) {
        const steps = this.stageScripts(epId, cid, fromStage, opts);
        for (const step of steps) {
          const code = await this.spawnAndWait(step.cmd, step.args, logFile);
          if (code !== 0) {
            // 记录失败但继续下一个 chunk(不要整批 abort)
            break;
          }
        }
      }
      this.finalize(job, runningFile, lastExit, 0, handle);
    } catch (e) {
      this.finalize(job, runningFile, lastExit, -1, handle, (e as Error).message);
    }
  })();

  return { jobId, startedAt };
}
```

关键点：
- **Global lock 一次持有**，整批结束才释放。客户端只 fire 1 次 HTTP。
- **内部串行** for loop，每次只有一个 p2-synth 进程在跑 → Fish API 节奏由 p2-synth 内部的 concurrency=6 保证（单进程内 6 并发是 Fish 可承受的）
- **chunks.json 串行写**，无 race
- **P3 server 启动一次**，不是每 chunk 启动一次
- **逐 chunk 错误隔离**：单 chunk 失败不阻塞其他 chunks

客户端改动：
- 恢复 `ChunksTable` 的 checkbox 列 + floating action bar
- `batchRetryChunks(epId, cids, stage)` 改成一次 POST 到新端点
- `ChunkRow` 恢复 `selected` / `onToggleSelected` / `selectionActive` props

预计工作量：**~1 小时**。

---

## P1 · 前端打磨

（暂无，上次 Stream C 的 memo / keyboard shortcuts / last_edited_at 已落地）

---

## P2 · 生产质量

### TTS config 变更后重合成的工作流
当前：改 tts_config → 单 chunk retry 试听 → 编辑文本才能触发 apply 重合成全部。
想改进：加"批量重合成"入口（见上面的 batch retry）。

### trace.jsonl 无限增长
已有 `maybeCompactTrace(threshold=5000)`，开机触发一次。但如果 threshold 一直不到，trace 还是缓慢增长。
考虑：加个定时清理（比如每次 applyEdits 后检查）或手动"清理 trace"按钮。

### 所有 stage 都走 venv python
P3 现在走 `resolvePython()` 了。其他 stage 是 Node.js 不受影响。

---

## P3 · Tech debt

- `HelpDialog.tsx` 里的 stage 说明还是硬编码 JSX（没用 `web/lib/stage-info.ts`）
- `webDetail.ts` 等 adapter 文件没有 TS 单元测试（只有 `observability.test.ts`）
- `ch04.ts` fixture 在 fixture mode 下缺少 `cost` 字段

---

## P4 · UI 想法（等未来有心情）

- Dark mode toggle（LogViewer 已经 dark，其他 light，不统一）
- Keyboard shortcut 助记卡（右下角 `⌨ Shortcuts` 已实现）
- Sidebar 按状态分组（Running / Ready / Done / Failed）
- Chunks 区大列表性能（100+ chunks 的 virtual list）
- 架构大改：紧凑模式（见之前的 UI 方案 A）
