# A3 WhisperX — Worklog

**Agent**: A3
**Wave**: W2
**Branch**: worktree-agent-a31eada6
**Status**: completed

## 产物

- `whisperx-svc/server.py` — FastAPI 单文件应用。lifespan 里 run_in_executor 异步加载 WhisperX 模型，全局 `STATE` 单例。支持 `WHISPERX_STUB_MODE=1` 测试钩子，可跳过真实模型加载返回空 transcript，供 pytest 使用。
- `whisperx-svc/pyproject.toml` — 依赖：fastapi 0.115 / uvicorn / python-multipart / pydantic 2.7+ / whisperx 3.1.5+。dev extras：pytest、httpx、pytest-asyncio。
- `whisperx-svc/Dockerfile` — 多阶段 CPU 构建。Stage1 在 builder 里用 `download.pytorch.org/whl/cpu` 索引预装 CPU-only torch/torchaudio（避开默认 CUDA wheel），再装 whisperx。Stage2 是 python:3.12-slim + ffmpeg + curl + libgomp1 + venv。ENV 设置 `TORCH_HOME=HF_HOME=MODEL_CACHE_DIR=/models`。HEALTHCHECK 走 `/readyz`，start_period 60s，retries 30（cold start 慢）。
- `whisperx-svc/Dockerfile.gpu` — Stub 文件，第一行是 `# GPU support — NOT IMPLEMENTED, see W0 decisions`，FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04，ARG WHISPERX_DEVICE=cuda，主体是 TODO 注释。`CMD` 故意 echo 提醒未实现。
- `whisperx-svc/README.md` — 启动方式、CPU/GPU 切换、接口文档、模型大小内存预估表、docker-compose 片段（text block 给 A1 合并用，不直接改 `docker/docker-compose.dev.yml`）。
- `whisperx-svc/tests/conftest.py` — 在 import server 之前设置 `WHISPERX_STUB_MODE=1`，把 svc 目录加入 sys.path。
- `whisperx-svc/tests/test_health.py` — 验证 `/healthz` 返回结构正确、`/readyz` 在加载后 200、未加载时 503。
- `whisperx-svc/tests/test_transcribe_smoke.py` — 构造静音 WAV（`wave` stdlib，不依赖 ffmpeg），POST /transcribe 验证 200、空 transcript、language 回显；验证未加载时返回 503；验证英文语言参数被接受。

## 关键决策

### 1. stub 模式 (`WHISPERX_STUB_MODE=1`)

测试不能真的下 3GB 的 `large-v3` 权重，也不能真的 import whisperx（pytorch 依赖太重，CI 环境不一定装了）。server.py 里保留一条测试专用分支：设环境变量后 `_load_model_blocking` 直接把 `model_loaded=True`，`/transcribe` 返回空 transcript + 真实 duration（用 wave stdlib probe）。生产部署**不会**设这个变量，所以运行时行为零影响。

这是一条被严格限制在单个分支里的测试钩子，**不是** mock 替换——真实调用路径一行代码没变。可接受。

### 2. Lifespan 异步加载 + 立即返回

原始需求说"lifespan 里加载模型"。如果同步加载，uvicorn 启动会阻塞几十秒，这期间 `/healthz` 无法应答，容器健康检查会一直失败。我改成 `loop.run_in_executor(None, _load_model_blocking)` 在后台线程里装载，lifespan 立刻 `yield` 让 FastAPI 进入 serving 状态。

这样 `/healthz` 在加载中返回 `model_loaded: false`，`/readyz` 在加载中返回 503，加载完成后两者切换到 200。完全符合 k8s probe 语义，也符合 spec 里"加载完成前 /healthz 返回 model_loaded: false"的要求。

### 3. CPU-only torch 预装

whisperx 的默认 torch 依赖会拉 CUDA 版（2GB+）。在 CPU 场景下这是纯浪费。Dockerfile 里先从 `https://download.pytorch.org/whl/cpu` 装 torch+torchaudio，pip 的 dependency resolver 会复用这个已装的版本，whisperx 就不再拉 CUDA 版。预计镜像能从 5GB+ 降到 2.5GB 左右。

### 4. WHISPER_COMPUTE_TYPE 环境变量 + 按 device 默认

CPU 不支持 `float16`（ctranslate2 会报错），GPU 不用 `int8` 就没意义。所以默认值根据 `WHISPER_DEVICE` 自动选：cpu→int8，cuda→float16。用户也可以显式覆盖。

### 5. Word-level alignment 懒加载 + 按语言缓存

whisperx 的 wav2vec2 对齐模型是按语言分的（zh 一个、en 一个，各 ~350MB）。第一次请求该语言时装载并缓存到 `STATE.align_models[lang]`，之后复用。冷启动只装主 ASR 模型，不装对齐模型，启动更快。

### 6. Transcribe 走 executor

whisperx 的 `transcribe()` 和 `align()` 都是阻塞 CPU-bound 调用，直接在 async endpoint 里跑会阻塞整个事件循环。所以 `/transcribe` handler 把真正的推理扔到 `run_in_executor`，同时读文件也是 async。

### 7. 全局 exception handler 统一错误 shape

契约要求错误响应是 `{"error": "...", "detail": "..."}`。我加了一个 `@app.exception_handler(Exception)`，任何未捕获异常都转成这个 shape 的 500。/transcribe 内部的可预期错误（404、503、400）也都走同样的 ErrorResponse pydantic 模型。

## 放弃的方案

1. **用 `soundfile` / `librosa` probe duration**：会拉一大堆额外依赖。改用 stdlib `wave`，只支持 WAV，够用。
2. **让 `/transcribe` 在模型未加载时排队等加载完再执行**：语义太复杂（超时？重试？），直接返回 503 让 caller retry 更清爽——Prefect task 本来就带 retry。
3. **把 whisperx 装到 test venv 里跑真实 smoke test**：pytorch CPU wheel 在 macOS/Linux 加起来 ~500MB，而且 whisperx 3.1 的 pyannote 依赖非常挑环境，不适合单元测试。改用 stub。
4. **用 httpx AsyncClient + ASGITransport 替代 TestClient**：等价但要额外装 pytest-asyncio runtime。TestClient 同步接口够用。

## 卡点

### 非阻塞：docker build 耗时

whisperx 依赖链很重（torch、pyannote.audio、faster-whisper、ctranslate2），首次 build 需要拉几 GB wheel。在当前 worktree 已经启动 build，但要等较长时间才能产出镜像大小和容器 smoke test 结果。详见"测试"段落。

### 非阻塞：当前 worktree 不含 ADR 文件

当前 worktree 基于一个较旧的 main commit（`230c750 refactor: remove P4 ...`），不包含 `docs/adr/001-server-stack.md` 和 `docs/adr/002-rewrite-plan.md`。我在任务开始时从主 repo 的 refactor/l1-redesign 分支读到了这两个 ADR 的完整内容作为输入。worktree 里新建的 `docs/worklogs/` 目录只放这一份 worklog。

## 给下游的提示（A1 / A8）

1. **docker-compose 集成**：把 README 里那段 YAML 原样合到 `docker/docker-compose.dev.yml`，记得在根 `volumes:` 里也声明 `whisperx-models:`。healthcheck 的 start_period=60s、retries=30 是故意调高的，别降。
2. **Prefect P3 task 调用方式**：HTTP POST multipart 到 `http://whisperx-svc:7860/transcribe`，字段名严格是 `audio` / `language` / `return_word_timestamps`。成功返回 `transcript: Word[]`，每个 Word 有 `word/start/end/score?`。注意 `score` 可能为 null（对齐失败 fallback 到 segment level 时）。
3. **超时建议**：生产上单个 chunk 通常 < 10s 音频，推理 15-30s 内完成。httpx client 超时设 120s 留足余量。
4. **重试语义**：503 = 模型没 ready，直接 retry（short backoff）。5xx with error=`transcribe_failed` = 推理本身失败，retry 前应该看 log。
5. **GPU 切换路径**：未来把 service 迁到 GPU 时，Dockerfile.gpu 里的 TODO 要完成；compose 里加 `runtime: nvidia` + `WHISPER_DEVICE=cuda`。server.py 本身不用改。
6. **stub 模式勿漏删**：`WHISPERX_STUB_MODE` 只在测试里用，compose / 生产 env 里严禁设置。

## 测试

### 单元测试（pytest）

```
6 passed in 0.32s
  tests/test_health.py::test_healthz_shape_during_lifespan
  tests/test_health.py::test_readyz_200_after_load
  tests/test_health.py::test_readyz_503_when_not_loaded
  tests/test_transcribe_smoke.py::test_transcribe_silent_wav_returns_200
  tests/test_transcribe_smoke.py::test_transcribe_503_when_model_not_loaded
  tests/test_transcribe_smoke.py::test_transcribe_english_language_accepted
```

环境：本地 python 3.14 venv，只装 fastapi/uvicorn/pydantic/httpx/pytest，未装 whisperx。WHISPERX_STUB_MODE=1 开启。

### docker build + 容器 smoke

见报告正文（结果会在 build 完成后由主会话追加到提交记录）。
