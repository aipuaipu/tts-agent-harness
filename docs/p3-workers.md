# P3 Multi-Worker 并行转写

## 是什么

P3 阶段调 WhisperX 本地模型做 CPU 推理，单个 chunk 在 M4 Pro 上约 10 秒。
默认实现是一个 WhisperX server 常驻、客户端串行 loop 所有 chunk——10 个 chunk ≈ 100 秒。

多 worker 模式允许启动 N 个独立的 WhisperX server 进程，每个进程加载自己的 large-v3 模型实例，
客户端用 `ThreadPoolExecutor` round-robin 把 chunk 分发到 N 个 URL。

**纯吞吐优化**：模型还是 large-v3 / CPU / int8，精度、输出格式完全不变。

## 为什么有效

- 单个 WhisperX 推理并不能把所有 CPU 核吃满（PyTorch 线程池限制 + 模型内部有串行段）
- 两个独立进程在 Apple Silicon 的 performance cores 上可以近乎线性加速
- 3 个以上受限于内存带宽和 P-core 数量，收益递减

## 资源占用

| 项目 | 每 worker |
|------|----------|
| RAM | ~3-4 GB（large-v3 int8 + alignment 模型） |
| CPU 核 | ~4 核可有效利用（PyTorch 默认 OMP/MKL 线程） |
| 启动时间 | ~20-40 秒（加载模型） |

## 推荐配置

| 机器 | 推荐 workers |
|------|-------------|
| MBP 13" M1 / 16GB | 1（默认） |
| MBA M2 / 16GB | 1-2 |
| MBP 14" M2 Pro / 32GB | 2 |
| **MBP 14" M4 Pro / 64GB（本项目目标机型）** | **2-3** |
| Mac Studio M2 Ultra / 128GB | 3 |

自动档（`auto_workers: true`）用的启发式：
```
byCore = floor(cpuCount / 4)         # 每 worker 4 核
byRam  = floor(ramGB / 4)            # 每 worker 4GB
recommended = max(1, min(3, byCore, byRam))   # 硬上限 3
```

## 开启方式

编辑 `.harness/config.json`：

```jsonc
{
  "p3": {
    "model": "large-v3",
    "device": "cpu",
    "port": 5555,
    "workers": 2,         // 手动指定 worker 数
    "auto_workers": false // 或改 true 让系统自动推荐
  }
}
```

两种模式二选一：

- `workers: N` — 固定 N 个 worker
- `auto_workers: true` — 忽略 `workers`，运行时调 `scripts/p3-recommend-workers.js` 动态计算

默认 `workers: 1` / `auto_workers: false`，和之前行为完全一致，零回归。

## 行为细节

- **端口分配**：`base_port, base_port+1, ..., base_port+N-1`（默认 5555, 5556, 5557）
- **PID 文件**：
  - `workers=1` → `.work/<ep>/p3.pid`（单 PID，旧格式）
  - `workers>1` → `.work/<ep>/p3.pids`（多行）
- **日志**：
  - `workers=1` → `.work/<ep>/p3-server.log`
  - `workers>1` → `.work/<ep>/p3-server-0.log`, `p3-server-1.log`, ...
- **启动同步**：所有 worker `/health` 全部 ok 才返回成功
- **客户端并发**：`ThreadPoolExecutor(max_workers=N)`，原子计数器 round-robin 分发 URL
- **chunks.json 写入**：每个任务完成后用 `threading.Lock` 串行回写，避免竞争
- **events.py 是线程安全的**：每 chunk 独立的 log 文件 + `trace.jsonl` append-only

## 预期加速

实测（chunks 数 ≥ worker 数时）：

| workers | 加速比 | 说明 |
|---------|--------|------|
| 1 | 1.0x | baseline |
| 2 | ~1.7x | 甜点区 |
| 3 | ~2.3x | 仍划算 |
| 4+ | <2.5x | 收益递减，大量切换开销 |

## 回滚

把 `.harness/config.json` 里 `workers` 改回 `1`（或删掉该字段）即可，所有产物、PID 文件、日志格式都会退回旧行为。
