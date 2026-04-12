# 配置管理设计方案

## 现状问题

配置散落在 5 个地方，切换环境需要改代码：

```
.env                    ← Fish TTS key、proxy（部分服务读）
docker/.env             ← Docker compose 端口（只 compose 读）
Makefile                ← 端口硬编码、proxy 清除逻辑
server/core/db.py       ← DATABASE_URL 默认值硬编码
server/flows/tasks/p3_transcribe.py  ← WHISPERX_URL 默认值硬编码
web/lib/api-client.ts   ← API_URL 默认值硬编码
```

结果：每次切环境要改多个文件，容易漏。

## 设计原则

1. **单一配置源**：所有配置从根目录 `.env` 文件读，不散落
2. **不改代码切环境**：`.env.dev` / `.env.prod` / `.env.test` 切文件，不改代码
3. **有默认值**：不配 `.env` 也能跑（用 dev 默认值），降低上手门槛
4. **三层读取**：`.env` 文件 → 环境变量 → 代码默认值（优先级从高到低）

## 配置变量全表

### 基础设施

| 变量 | dev 默认值 | prod 示例 | 消费者 |
|---|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://harness:harness@localhost:55432/harness` | `postgresql+asyncpg://user:pass@db:5432/harness` | FastAPI, alembic |
| `MINIO_ENDPOINT` | `localhost:59000` | `minio:9000` | FastAPI |
| `MINIO_ACCESS_KEY` | `minioadmin` | `prod-key` | FastAPI |
| `MINIO_SECRET_KEY` | `minioadmin` | `prod-secret` | FastAPI |
| `MINIO_BUCKET` | `tts-harness` | `tts-harness` | FastAPI |
| `MINIO_SECURE` | `false` | `true` | FastAPI |
| `PREFECT_API_URL` | `http://localhost:54200/api` | `http://prefect:4200/api` | FastAPI (prefect mode) |

### 应用服务

| 变量 | dev 默认值 | prod 示例 | 消费者 |
|---|---|---|---|
| `API_PORT` | `8100` | `8000` | Makefile, Dockerfile |
| `WEB_PORT` | `3010` | `3010` | Makefile, Dockerfile |
| `WHISPERX_URL` | `http://localhost:7860` | `http://whisperx-svc:7860` | P3 task |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8100` | `http://api:8000` | Next.js (编译时) |

### 外部服务

| 变量 | dev 默认值 | prod 示例 | 消费者 |
|---|---|---|---|
| `FISH_TTS_KEY` | (无默认) | `your-key` | P2 task |
| `FISH_TTS_REFERENCE_ID` | (无默认) | `voice-id` | P2 task |
| `FISH_TTS_MODEL` | `s2-pro` | `s2-pro` | P2 task |

### 运行模式

| 变量 | dev 默认值 | prod 示例 | 消费者 |
|---|---|---|---|
| `TTS_USE_PREFECT` | (空 = dev mode) | `1` | FastAPI run/retry/finalize |
| `HARNESS_API_TOKEN` | (空 = 无鉴权) | `secret-token` | FastAPI auth |
| `LOG_LEVEL` | `info` | `warning` | uvicorn |

### 网络/代理

| 变量 | dev 默认值 | prod 示例 | 消费者 |
|---|---|---|---|
| `HTTPS_PROXY` | (从系统继承) | (无) | httpx (Fish API) |
| `NO_PROXY` | `localhost,127.0.0.1` | (无) | 防止 localhost 连接走代理 |

### Docker compose 端口映射

| 变量 | dev 默认值 | prod 示例 | 消费者 |
|---|---|---|---|
| `POSTGRES_PORT` | `55432` | `5432` | docker-compose |
| `MINIO_API_PORT` | `59000` | `9000` | docker-compose |
| `MINIO_CONSOLE_PORT` | `59001` | `9001` | docker-compose |
| `PREFECT_PORT` | `54200` | `4200` | docker-compose |

## 文件结构

```
tts-agent-harness/
├── .env                  ← 当前激活的配置（.gitignore，不进 git）
├── .env.dev              ← dev 环境模板（进 git）
├── .env.prod             ← prod 环境模板（进 git，不含真实 secret）
├── .env.test             ← test 环境模板（进 git）
├── docker/.env           ← 删除，统一到根 .env
```

## 各消费者如何读取

### Makefile

```makefile
# 加载 .env（如果存在）
-include .env
export

# 端口从 .env 读，有默认值
API_PORT   ?= 8100
WEB_PORT   ?= 3010
```

不再 hardcode 端口和 proxy 处理。

### Docker compose

```yaml
# docker-compose.dev.yml
services:
  postgres:
    ports:
      - "${POSTGRES_PORT:-55432}:5432"
```

compose 的 `--env-file` 指向根 `.env`：
```makefile
COMPOSE := docker compose --env-file .env -f docker/docker-compose.dev.yml
```

删除 `docker/.env`，统一用根目录 `.env`。

### FastAPI (server/core/db.py)

```python
import os

DATABASE_URL = os.environ.get("DATABASE_URL",
    "postgresql+asyncpg://harness:harness@localhost:55432/harness")
```

已经是这样，不用改。只要 `.env` 正确加载到环境变量。

### P3 task (whisperx URL)

```python
WHISPERX_URL = os.environ.get("WHISPERX_URL", "http://localhost:7860")
```

已改，不用再动。

### Next.js (前端)

```typescript
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100";
```

已经是这样。`make serve-web` 启动时从 `.env` 读 `NEXT_PUBLIC_API_URL`。

### Makefile serve target

```makefile
serve-api:
    # 加载 .env 到进程环境
    set -a && [ -f .env ] && . ./.env; set +a; \
    # 设 NO_PROXY 防止 localhost 走代理（不删 HTTPS_PROXY，Fish API 需要）
    NO_PROXY="localhost,127.0.0.1" \
    uvicorn server.api.main:app --port $${API_PORT:-8100}

serve-whisperx:
    # 根据 .env 决定是 Docker 还是本地 Python
    if [ "$${WHISPERX_MODE}" = "docker" ]; then
        docker run ... whisperx-svc:dev
    else
        .venv/bin/uvicorn whisperx-svc.server:app --port 7860
    fi
```

### WhisperX 环境切换

| 变量 | 值 | 行为 |
|---|---|---|
| `WHISPERX_MODE=local` | 用 `.venv` 本地 Python 跑 | dev 默认（ARM 原生，快） |
| `WHISPERX_MODE=docker` | 用 Docker 容器跑 | prod / CI 用 |
| `WHISPERX_URL` | `http://localhost:7860` | P3 task 连接地址，两种 mode 都一样 |

## 环境模板

### .env.dev

```bash
# === Infrastructure ===
DATABASE_URL=postgresql+asyncpg://harness:harness@localhost:55432/harness
POSTGRES_PORT=55432
MINIO_ENDPOINT=localhost:59000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=tts-harness
MINIO_API_PORT=59000
MINIO_CONSOLE_PORT=59001
PREFECT_API_URL=http://localhost:54200/api
PREFECT_PORT=54200

# === Application ===
API_PORT=8100
WEB_PORT=3010
WHISPERX_URL=http://localhost:7860
WHISPERX_MODE=local
NEXT_PUBLIC_API_URL=http://localhost:8100
LOG_LEVEL=info

# === External services ===
FISH_TTS_KEY=your-key-here
# FISH_TTS_REFERENCE_ID=
# FISH_TTS_MODEL=s2-pro

# === Runtime mode ===
# TTS_USE_PREFECT=     # 空 = dev mode (in-process flow)
# HARNESS_API_TOKEN=   # 空 = 无鉴权

# === Network ===
NO_PROXY=localhost,127.0.0.1
```

### .env.prod

```bash
# === Infrastructure ===
DATABASE_URL=postgresql+asyncpg://harness:${DB_PASSWORD}@postgres:5432/harness
POSTGRES_PORT=5432
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=${MINIO_KEY}
MINIO_SECRET_KEY=${MINIO_SECRET}
MINIO_BUCKET=tts-harness
MINIO_SECURE=true

# === Application ===
API_PORT=8000
WEB_PORT=3010
WHISPERX_URL=http://whisperx-svc:7860
WHISPERX_MODE=docker
NEXT_PUBLIC_API_URL=http://api:8000
LOG_LEVEL=warning

# === External services ===
FISH_TTS_KEY=${FISH_KEY}

# === Runtime mode ===
TTS_USE_PREFECT=1
HARNESS_API_TOKEN=${API_TOKEN}
```

### .env.test

```bash
# 继承 .env.dev 的大部分，覆盖需要的
DATABASE_URL=postgresql+asyncpg://harness:harness@localhost:55432/harness
MINIO_ENDPOINT=localhost:59000
WHISPERX_URL=http://localhost:7860
WHISPERX_MODE=local
API_PORT=8100
NEXT_PUBLIC_API_URL=http://localhost:8100
# FISH_TTS_KEY= 需要设置才能跑真实 P2
```

## 切换环境

```bash
# 开发
cp .env.dev .env

# 生产
cp .env.prod .env
# 编辑 .env 填入真实 secret

# 测试
cp .env.test .env
```

或者 Makefile 提供快捷命令：

```makefile
env-dev:
    cp .env.dev .env && echo "switched to dev"

env-prod:
    cp .env.prod .env && echo "switched to prod — edit .env to fill secrets"

env-test:
    cp .env.test .env && echo "switched to test"
```

## 迁移步骤

1. 创建 `.env.dev` / `.env.prod` / `.env.test` 模板文件
2. 把用户现有的 `.env`（Fish key 等）合并到 `.env.dev`
3. 删除 `docker/.env`，compose 改读根 `.env`
4. Makefile 删除 hardcode 端口，全部从 `.env` 读
5. 代码里的默认值保持（作为 fallback），但与 `.env.dev` 的默认值对齐
6. `make serve` 加 `serve-whisperx`（根据 `WHISPERX_MODE` 决定启动方式）
7. `.gitignore` 加 `.env`（不进 git），`.env.dev` / `.env.prod` 进 git
