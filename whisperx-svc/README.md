# whisperx-svc

P3 转写阶段的独立 HTTP 服务。把 WhisperX 模型常驻在单个 Python 进程里，
worker task 通过 HTTP multipart 上传音频拿回带 word-level timestamp 的 transcript。

对应决策：ADR-001 §4.8（WhisperX 不进 Prefect task）、ADR-002 §4.3（A3 任务）。

## 接口

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/transcribe` | 上传音频，返回 transcript JSON |
| `GET` | `/healthz` | 返回 `{model_loaded, device, model}` |
| `GET` | `/readyz` | k8s 风格：未加载返回 503，已加载返回 200 |

### POST /transcribe

```
multipart/form-data:
  audio: <file>            # 必填，WAV/MP3
  language: "zh" | "en"    # 默认 "zh"
  return_word_timestamps: bool  # 默认 true
```

成功 200：

```json
{
  "transcript": [
    { "word": "你好", "start": 0.12, "end": 0.45, "score": 0.98 }
  ],
  "language": "zh",
  "duration_s": 12.34,
  "model": "large-v3"
}
```

错误：

```json
{ "error": "model_not_loaded", "detail": "..." }
```

模型加载完成前调用 `/transcribe` 会返回 503。

## 启动方式

### 本地（不跑 Docker）

```bash
cd whisperx-svc
pip install -e .[dev]
uvicorn server:app --host 0.0.0.0 --port 7860
```

首次启动会下载 `large-v3` 模型到 `$MODEL_CACHE_DIR`（默认 `/models`，本地可覆盖为 `./.cache`）。

### Docker（CPU，推荐）

```bash
cd whisperx-svc
docker build -t whisperx-svc:dev .
docker run -d --name whisperx \
    -p 7860:7860 \
    -v whisperx-models:/models \
    -e WHISPER_MODEL=large-v3 \
    -e WHISPER_DEVICE=cpu \
    whisperx-svc:dev

# 等几十秒模型下载 + 加载
curl http://localhost:7860/healthz
curl http://localhost:7860/readyz
```

### Docker（GPU，未实现）

`Dockerfile.gpu` 当前是 stub。等 W0 GPU 决策落地后再填内容，参考文件内 TODO。

切换方式（未来）：把下面 compose 片段的 `dockerfile: Dockerfile` 改成 `Dockerfile.gpu`，
加 `runtime: nvidia` 并把 `WHISPER_DEVICE=cuda`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WHISPER_MODEL` | `large-v3` | WhisperX 模型名 |
| `WHISPER_DEVICE` | `cpu` | `cpu` 或 `cuda` |
| `WHISPER_COMPUTE_TYPE` | `int8` (cpu) / `float16` (cuda) | ctranslate2 compute type |
| `MODEL_CACHE_DIR` | `/models` | 模型缓存目录（对应 named volume） |
| `TORCH_HOME` / `HF_HOME` | `/models` | 在 Dockerfile 里同步指向 `/models` |
| `WHISPERX_STUB_MODE` | `0` | 测试钩子：设 `1` 时跳过真实推理，返回空 transcript |

## docker-compose 片段（A1 集成时合并到 `docker/docker-compose.dev.yml`）

```yaml
services:
  whisperx-svc:
    build:
      context: ../whisperx-svc
      dockerfile: Dockerfile
    ports:
      - "7860:7860"
    volumes:
      - whisperx-models:/models
    environment:
      - WHISPER_MODEL=large-v3
      - WHISPER_DEVICE=cpu
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7860/readyz"]
      interval: 10s
      timeout: 5s
      retries: 30        # cold start 慢
      start_period: 60s

volumes:
  whisperx-models:
```

> **不要**由 A3 直接改 `docker/docker-compose.dev.yml`。A1 会把这个片段合进去。

## 模型大小与内存占用（参考）

| Model | 磁盘 | CPU 内存峰值 | CPU 实时因子 | 备注 |
|---|---|---|---|---|
| `tiny` | ~75 MB | ~500 MB | 0.1x | 开发自测够用 |
| `base` | ~150 MB | ~700 MB | 0.2x | — |
| `small` | ~500 MB | ~1.5 GB | 0.4x | — |
| `medium` | ~1.5 GB | ~3 GB | 1x | — |
| **`large-v3`** | **~3 GB** | **4-6 GB** | **1.5-2x** (int8) | **默认，生产用** |

加上对齐模型（wav2vec2，按语言懒加载，每个 ~350 MB）和 torch/ctranslate2 基础开销，
整个容器 RSS 在 `large-v3 + int8` 下稳定在 ~5 GB 左右。请给容器预留 **至少 6 GB** 内存。

## 测试

```bash
# 纯单元测试（不需要模型权重，用 WHISPERX_STUB_MODE=1）
cd whisperx-svc
WHISPERX_STUB_MODE=1 pytest tests/ -v
```

冷启动 + 真实推理的集成验证：先 `docker build` 再 `docker run`，
`curl` `/readyz` 等绿，然后 POST 一段静音 WAV：

```bash
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 3 -ar 16000 silent.wav
curl -F "audio=@silent.wav" -F "language=zh" http://localhost:7860/transcribe
```

返回 `transcript: []` 是预期的（静音没内容）。

## 严格边界（ADR-002 §4.3）

- 不引入数据库
- 不引入对象存储 — 音频走 multipart，返回 JSON
- 不写业务逻辑（不懂 episode/chunk/take 概念）
- 模型权重走 named volume，不打进镜像
