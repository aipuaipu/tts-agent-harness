# A2 Domain — Worklog

**Agent**: A2
**Wave**: W2
**Branch**: worktree-agent-ad00da0b (worktree: `.claude/worktrees/agent-ad00da0b`)
**Status**: completed

## 产物

- `server/pyproject.toml` — Python 3.11+ 项目元数据，锁定 sqlalchemy[asyncio]≥2、pydantic≥2、minio、pytest-asyncio、testcontainers[postgres,minio]
- `server/core/models.py` — SQLAlchemy 2.x Mapped/mapped_column ORM，对应 ADR-001 §5.1 的全部 5 张表；JSONB 在 SQLite 下降级为 JSON，BigInteger 主键在 SQLite 下降级为 Integer 保证 autoincrement 工作
- `server/core/domain.py` — Pydantic v2 schemas；包含写侧 (EpisodeCreate / ChunkInput / ChunkEdit / TakeAppend)、读侧 (EpisodeView / ChunkView / TakeView / StageRunView / EpisodeSummary)、pipeline 结果 (P1Result / P2Result / P3Result / P5Result / P6Result)、StageEvent；读侧全部 `ConfigDict(from_attributes=True)`
- `server/core/repositories.py` — 5 个 async Repo：EpisodeRepo / ChunkRepo / TakeRepo / StageRunRepo / EventRepo；每个构造器接收 `AsyncSession`；`ChunkRepo.apply_edits` 用 SAVEPOINT 保证批量原子性
- `server/core/storage.py` — `MinIOStorage` async facade（同步 minio 客户端 + `asyncio.to_thread`）；按 ADR-002 §3.3 实现 7 个路径常量函数：`episode_script_key` / `chunk_take_key` / `chunk_transcript_key` / `chunk_subtitle_key` / `final_wav_key` / `final_srt_key` / `chunk_log_key`
- `server/core/events.py` — `write_event()`：同一事务内 INSERT events 行 + Postgres `pg_notify('episode_events', json)`；SQLite 下 NOTIFY 静默 no-op
- `server/tests/conftest.py` — pytest fixtures：`session` (SQLite in-memory，始终可用)、`pg_session` (testcontainers Postgres)、`minio_client` (testcontainers MinIO)，docker 不可用时自动跳过 docker-gated 测试
- `server/tests/test_repositories.py` — 20 个 case，覆盖 5 个 repo 所有公开方法（happy / boundary / error）
- `server/tests/test_storage.py` — 6 个 case：upload_bytes / upload_file / exists / presigned_url / delete / path 常量比对 ADR
- `server/tests/test_events.py` — 3 个 case：SQLite 下 insert + 单调 id + Postgres 真实 LISTEN/NOTIFY 端到端（asyncpg listener + 独立连接，断言 500ms 内收到通知）

## 关键决策

1. **JSONB with_variant fallback**。业务 schema 用 `JSONB`（Postgres），但 A2 必须在 A1 完成前能用 SQLite in-memory 起步。我用 `JSONB().with_variant(JSON(), "sqlite")` 让同一份 ORM 两边跑。A1 的真实 migration 仍然用 JSONB。
2. **BigInteger 主键在 SQLite 降级 Integer**。SQLite `autoincrement` 只对 `INTEGER PRIMARY KEY` 生效，`BIGINT` 会退化成 `NOT NULL`；最初一版是纯 `BigInteger` 跑 SQLite 挂了 — 改成 `BigInteger().with_variant(Integer(), "sqlite")` 一次搞定。Postgres 下仍是 bigserial。
3. **`apply_edits` 用 nested savepoint**。任务要求"单事务内原子提交"；用 `session.begin_nested()` 让 repo 不拥有 outer transaction，同时失败能局部回滚不污染 caller 的 UoW。
4. **MinIO 同步客户端 + `asyncio.to_thread`**。官方 `minio` 包没有原生 asyncio 支持；引入 `aioboto3` 会把依赖链拉到 boto3 / botocore（~50MB），远不如 `to_thread` 简单。所有公开方法都是 `async def` — 上层无感知。
5. **NOTIFY 走 `text("SELECT pg_notify(...)")`**。严格禁止裸 SQL，但 LISTEN/NOTIFY 没有 ORM 对应物；在注释里标明这是**唯一一处**允许的 `text()` 调用，防止后人放水。
6. **channel name 与 payload 固定**。频道 `episode_events`、payload `{"ep": <id>, "id": <row_id>}` — A9 (FastAPI SSE) 直接按此解析，无需协商。
7. **docker gating**。`test_storage.py` / `test_events.py::test_notify_*` 用 `@requires_docker`，`conftest.py` 自动探测 docker socket / `SKIP_DOCKER_TESTS=1` env；开发者没 docker 仍能跑 19 个 SQLite 测试。
8. **`ChunkView.extra_metadata` 命名**。Python 里 `metadata` 是 SQLAlchemy `DeclarativeBase` 保留字，所以 ORM 列名为 `metadata`、Python 属性为 `extra_metadata`。Pydantic 读侧用 `Field(alias="extra_metadata")` + `populate_by_name=True`，对上层暴露的名字仍是 `extra_metadata`（不与 Python `BaseModel.metadata` 冲突）。

## 放弃的方案

- **SQLModel**：最初考虑用 SQLModel 同时当 ORM 和 schema。放弃原因：SQLModel 2025 年仍是 Pydantic 1 / 2 兼容层，跟 Pydantic v2 high-end 特性（`ConfigDict` / discriminators）有若干边角坑；一个文件承担两个角色也违反"domain.py 只负责数据形状"的任务约束。
- **aioboto3**：见决策 4。
- **asyncpg 直连做 LISTEN 写端**：理论上更轻，但和 SQLAlchemy session 跨库共存会让 A9 的 repo composition 变复杂；留着一个 AsyncSession 写事件 + 一个独立 asyncpg 连接纯听，是最简洁的分工。
- **Alembic init in A2**：A1 的领域，明确不做。ORM `Base.metadata.create_all` 只在测试里用。

## 卡点（已自解决）

- **SQLite `BIGINT` 主键插入失败 NOT NULL**。首次 pytest 跑 5 个 events 相关用例挂，原因见决策 2。用 `with_variant(Integer, "sqlite")` 解决。
- **docker-py 报 `docker-credential-desktop not installed`**。在本机有 Docker Desktop 但 `/Applications/Docker.app/Contents/Resources/bin` 不在 PATH。跑测试前 `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` 即可。写进 worklog 以免 A11/A12 踩同坑。
- **Python 3.14 部分 wheel 缺失**。首次在系统 python 3.14 上 `pip install asyncpg` 抓源码编译超时。改成 `python@3.11` venv 直接用 wheel，30 秒装完。建议 A1 dev image 也钉 3.11 / 3.12。

## 与 A1 的边界（依赖断点）

A1 的 `server/core/db.py` 尚未存在。本 PR 里**没有** `db.py`。切换点：
1. `tests/conftest.py` 里手搓 `create_async_engine("sqlite+aiosqlite:///:memory:")`。A1 完成后，`session` fixture 应改为 `from server.core.db import session_factory`，in-memory 只保留给极少数纯 ORM 单测。
2. 所有 repo 的 caller（将来 A9 的 FastAPI routes）必须从 `server.core.db.get_session()` 取 session；A2 不规定 factory 形状——只要求它 yield `AsyncSession`。
3. `DATABASE_URL` env 变量是**唯一**切换轴。A1 需要在 `db.py` 里读这个变量。A2 的测试不依赖 env，所以 A1 并行开发不会撞车。
4. A1 的 alembic V001 migration 必须与 `models.py` 的字段逐列对齐。我已按 ADR-001 §5.1 的 DDL 逐字段实现，A1 参照同一份 DDL 即可保持一致。**不要**从 `models.py` 反向 autogenerate migration — 反向生成会丢掉 `events_episode_idx` 和 `uq_chunks_shot_idx` 的命名约束对齐。

## 测试

### 运行方式

```bash
# SQLite only (no docker)
SKIP_DOCKER_TESTS=1 ./server/.venv/bin/python -m pytest server/tests/ -v
# → 19 passed, 7 skipped

# Full suite (docker + testcontainers)
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
./server/.venv/bin/python -m pytest server/tests/ -v
# → 26 passed
```

### 覆盖的 Repo 方法清单

| Repo | 方法 | Case 数 |
|---|---|---|
| EpisodeRepo | create / get / list / delete / archive / set_status | 4 test methods / 9 assertions |
| ChunkRepo | get / list_by_episode / bulk_insert / apply_edits / set_status / set_selected_take | 4 test methods / 12 assertions |
| TakeRepo | append / select / list_by_chunk / remove | 3 test methods / 7 assertions |
| StageRunRepo | get / list_by_chunk / upsert (create + update paths) | 3 test methods / 8 assertions |
| EventRepo | write / list_since / count / NOTIFY no-op on SQLite | 3 test methods / 8 assertions |

### Storage 覆盖

upload_bytes / upload_file / download_bytes / exists / get_presigned_url / delete — 6 个真实 testcontainer MinIO case + 1 个纯函数路径常量断言。

### Events 覆盖

- SQLite: insert row 生效 / id 单调
- Postgres: `write_event` + `COMMIT` → 独立 asyncpg LISTEN 连接在 2s 内收到 `{"ep": ..., "id": ...}`

## 给下游的提示

- **A9 (FastAPI)**：SSE endpoint 用 `asyncpg.connect(DATABASE_URL).add_listener('episode_events', ...)`。收到通知后 payload 是 JSON 字符串 `{"ep", "id"}`，用 `EventRepo.list_since(ep, after_id=id-1)` 拉具体 payload。不要试图把完整 payload 塞进 NOTIFY（Postgres 8KB 限制）。
- **A4-A7 (tasks)**：import 路径就是 `from server.core.repositories import XxxRepo` / `from server.core.storage import MinIOStorage, chunk_take_key`。你们拿到的应该是 `AsyncSession` 实例，不要自己 `create_async_engine`。
- **所有下游**：Pydantic 读模型字段叫 `extra_metadata` 不是 `metadata`（Python 保留字冲突解法，见决策 8）。JSON 序列化后字段名仍是 `extra_metadata`。如果前端要的是 `metadata`，由 A9 在 OpenAPI schema 层做 alias。
- **CI 建议**：CI 跑 `SKIP_DOCKER_TESTS=1 pytest` 作为快速门，然后单独一个 job 起 docker runner 跑全量 26 个 case。
