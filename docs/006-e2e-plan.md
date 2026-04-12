# 全流程 E2E 测试计划 (v2)

## 目标

用 Playwright 从浏览器出发，走通完整用户流程。全部真实服务，不 mock。

## 测试架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Playwright (headless Chromium)                                  │
│                                                                  │
│  e2e/full-pipeline.spec.ts                                      │
│    test 1: 创建 episode                                         │
│    test 2: P1 切分                                              │
│    test 3: TTS config                                           │
│    test 4: 合成全部 (P2→P3→P5→P6)                               │
│    test 5: 播放音频                                              │
│    test 6: 查看 stage 日志                                       │
│    test 7: 编辑 + 重试                                           │
│    test 8: 删除                                                  │
│                                                                  │
│  产出: video/ + trace/ + screenshots/ + server-logs/ + report    │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP (localhost:3010)
                       ▼
┌──────────────────────────────────┐
│  Next.js :3010                   │
│  (纯 UI，openapi-fetch client)   │
└──────────────────────┬───────────┘
                       │ HTTP + SSE (localhost:8100)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  FastAPI :8100  (dev mode, in-process flow execution)         │
│                                                               │
│  /episodes          CRUD                                      │
│  /episodes/{id}/run P1 / P2→P3→P5→P6 (async background)     │
│  /episodes/{id}/stream  SSE real-time events                 │
│  /audio/{key}       WAV streaming from MinIO                  │
└───┬──────────┬──────────┬──────────┬─────────────────────────┘
    │          │          │          │
    │ SQL      │ S3       │ HTTP     │ HTTPS (via proxy)
    ▼          ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────────┐
│Postgres│ │ MinIO  │ │whisperx- │ │ Fish Audio   │
│ :55432 │ │ :59000 │ │svc :7860 │ │ API (外网)    │
│        │ │        │ │ (Docker) │ │              │
│episodes│ │WAV/SRT │ │WhisperX  │ │ TTS 合成     │
│chunks  │ │transcript│ large-v3 │ │ S2-Pro       │
│takes   │ │logs    │ │          │ │              │
│stage_  │ │        │ │ CPU/GPU  │ │ via ClashX   │
│ runs   │ │        │ │          │ │ SOCKS5 proxy │
│events  │ │        │ │          │ │              │
└────────┘ └────────┘ └──────────┘ └──────────────┘
  Docker     Docker     Docker        外部服务
  compose    compose    手动 run
```

### 数据流（一次完整 E2E）

```
Playwright 点击 "合成全部"
  → Next.js fetch POST /episodes/{id}/run {mode: "synthesize"}
    → FastAPI 启动 background task
      → P2: 逐 chunk 调 Fish API (HTTPS, via proxy)
        ← WAV bytes → 上传 MinIO → 写 takes 表 → 写 stage_runs (p2: ok)
      → P3: 逐 chunk 从 MinIO 下载 WAV → POST whisperx-svc:7860/transcribe
        ← transcript JSON → 上传 MinIO → 写 stage_runs (p3: ok)
      → P5: 读 transcript + take.duration → 生成 SRT → 上传 MinIO
      → P6: 从 MinIO 下载全部 WAV → ffmpeg concat → 上传 final WAV/SRT
      → episode status → done
    ← SSE event push (stage_started / stage_finished)
  → Next.js SSE → SWR mutate → UI 刷新
Playwright 看到 stage pills 变绿 → 截图 → PASS
```

### 测试层次

```
┌─────────────────────────────────────────────┐
│ Layer 4: Playwright 浏览器 E2E              │  ← 本计划新增
│   真浏览器 × 真全部服务 × 真外部 API         │
│   验证: 用户看到的就是对的                    │
├─────────────────────────────────────────────┤
│ Layer 3: pytest e2e (test_live_http.py)     │  ← 已有
│   真 uvicorn × 真 DB/MinIO × mock Prefect   │
│   验证: HTTP 层行为正确                      │
├─────────────────────────────────────────────┤
│ Layer 2: pytest API (test_routes.py)        │  ← 已有
│   ASGI transport × 真 DB × mock Prefect     │
│   验证: route handler 逻辑正确              │
├─────────────────────────────────────────────┤
│ Layer 1: pytest unit (test_*_logic.py)      │  ← 已有
│   纯函数 × 无 IO × 无外部依赖               │
│   验证: 算法正确                             │
└─────────────────────────────────────────────┘
```

## 技术选型

| 维度 | 工具 | 理由 |
|---|---|---|
| 浏览器 E2E | **Playwright** (`@playwright/test`) | 行业标准，headless Chrome，等待/截图/trace |
| 后端 API 测试 | pytest + httpx | 已有，保留 |
| 前端组件测试 | vitest + testing-library | 已配置，后续补 |
| ~~Smoke test~~ | ~~bash + curl~~ | 删除，Playwright 替代 |

## 服务依赖

| 服务 | 端口 | 镜像/启动方式 | 状态 |
|---|---|---|---|
| Postgres | 55432 | docker-compose | ✅ |
| MinIO | 59000 | docker-compose | ✅ |
| Prefect Server | 54200 | docker-compose | ✅（dev mode 不依赖） |
| **whisperx-svc** | 7860 | **Docker 容器** | ❌ 镜像未 build 完 |
| FastAPI | 8100 | `make serve-api` | ✅ |
| Next.js | 3010 | `make serve-web` | ✅ |
| Fish TTS API | 外网 | .env FISH_TTS_KEY | ✅ |

## 执行顺序

### Phase 0: 基础设施

#### 0.1 Build whisperx-svc Docker 镜像
```bash
cd whisperx-svc && docker build -t whisperx-svc:dev .
```
验收：`docker images | grep whisperx-svc:dev`

#### 0.2 启动全部服务
```bash
make dev                    # postgres + minio + prefect
docker run -d --name whisperx-svc -p 7860:7860 \
  -v whisperx-models:/models whisperx-svc:dev
make serve                  # fastapi + next.js
```
验收：6 个端口全通

#### 0.3 安装 Playwright
```bash
cd web
pnpm add -D @playwright/test
npx playwright install chromium
```

### Phase 1: Playwright E2E 测试

文件：`web/e2e/full-pipeline.spec.ts`

一个 test = 一条完整用户旅程 = 一个录屏文件。中间失败则录屏停在失败步骤，修 bug 后整条重跑。

```typescript
test('完整用户旅程: 创建 → 切分 → 配置 → 合成 → 播放 → 日志 → 编辑 → 删除', async ({ page }) => {

  // ── Step 1: 创建 Episode ──
  await page.goto('/');
  await page.click('text=+ New');
  await page.fill('input[placeholder*="ID"]', 'e2e-test');
  await page.setInputFiles('input[type="file"]', 'e2e/fixtures/test-script.json');
  await page.click('text=Create');
  await expect(page.locator('text=e2e-test')).toBeVisible();

  // ── Step 2: P1 切分 ──
  await page.click('text=e2e-test');
  await page.click('text=切分');
  await expect(page.locator('table tbody tr')).toHaveCount({ min: 1 }, { timeout: 15000 });

  // ── Step 3: TTS Config ──
  await page.click('text=TTS Config');
  await page.fill('input[type="number"] >> nth=0', '0.5');  // temperature
  await page.click('text=Save Config');

  // ── Step 4: 合成全部 (P2→P3→P5→P6) ──
  await page.click('text=合成全部');
  // 等 episode 完成（Fish API + WhisperX，最长 2 分钟）
  await expect(page.locator('text=完成')).toBeVisible({ timeout: 180000 });
  // 验证 stage pills 绿色
  await expect(page.locator('.bg-emerald-500')).toHaveCount({ min: 1 });

  // ── Step 5: 播放音频 ──
  await page.click('button:has-text("▶") >> nth=0');
  const audio = page.locator('audio');
  await expect(audio).toHaveAttribute('src', /\/audio\//);

  // ── Step 6: 查看 Stage 日志 ──
  await page.click('.rounded-full:has-text("P2") >> nth=0');
  await expect(page.locator('text=P2').first()).toBeVisible();
  await page.click('button:has-text("✕")');

  // ── Step 7: 编辑 + 重试 ──
  await page.click('button:has-text("✎") >> nth=0');
  const editor = page.locator('textarea');
  await editor.fill('修改后的测试文本。');
  await page.click('text=Apply');
  // 等重新合成完成
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 120000 });

  // ── Step 8: 删除 Episode ──
  page.on('dialog', dialog => dialog.accept());
  await page.click('button:has-text("⋯") >> nth=0');
  await page.click('text=Delete');
  await expect(page.locator('text=e2e-test')).not.toBeVisible({ timeout: 5000 });
});
```

### Phase 2: Playwright 配置

`web/playwright.config.ts`:
```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 180000,       // 3 min per test (Fish API + WhisperX 慢)
  retries: 0,            // 不重试，失败就是失败
  use: {
    baseURL: 'http://localhost:3010',
    screenshot: 'on',
    video: 'on',             // 每个 test 录屏 → webm
    trace: 'on',             // 含 DOM 快照 + 网络请求 + 操作时间线
  },
  webServer: undefined,  // 服务手动起（make serve）
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
```

### 服务端日志收集

Playwright 的 `globalSetup` / `globalTeardown` 负责：

1. **测试开始前**：清空日志文件，记录起始时间戳
2. **测试结束后**：把各服务日志收集到 `test-results/server-logs/`

```typescript
// e2e/global-setup.ts
import { execSync } from 'child_process';

export default function globalSetup() {
  // 标记日志起点
  execSync('echo "=== E2E START $(date) ===" >> /tmp/tts-harness-api.log');
  execSync('echo "=== E2E START $(date) ===" >> /tmp/tts-harness-web.log');
}
```

```typescript
// e2e/global-teardown.ts
import { execSync } from 'child_process';

export default function globalTeardown() {
  const dest = 'test-results/server-logs';
  execSync(`mkdir -p ${dest}`);
  execSync(`cp /tmp/tts-harness-api.log ${dest}/fastapi.log 2>/dev/null || true`);
  execSync(`cp /tmp/tts-harness-web.log ${dest}/nextjs.log 2>/dev/null || true`);
  execSync(`docker logs whisperx-svc > ${dest}/whisperx.log 2>&1 || true`);
}
```

playwright.config.ts 引用：
```typescript
globalSetup: './e2e/global-setup.ts',
globalTeardown: './e2e/global-teardown.ts',
```

产物目录结构：
```
web/test-results/
├── server-logs/
│   ├── fastapi.log         ← uvicorn 完整日志
│   ├── nextjs.log          ← next dev 日志
│   └── whisperx.log        ← docker logs whisperx-svc
├── full-pipeline-创建-episode/
│   ├── video.webm          ← 录屏
│   ├── trace.zip           ← DOM + 网络 + 操作时间线
│   └── test-finished-1.png ← 截图
├── full-pipeline-合成全部/
│   ├── video.webm
│   ├── trace.zip
│   └── ...
└── report/
    └── index.html          ← npx playwright show-report
```

测试失败时，可以同时看：
- **video.webm** — 浏览器发生了什么
- **trace.zip** — 哪个请求失败了、响应是什么
- **fastapi.log** — 后端 traceback
- **whisperx.log** — WhisperX 是不是挂了

运行：
```bash
cd web && npx playwright test
```

### Phase 3: Makefile 集成

```makefile
test-e2e-browser:
	cd web && npx playwright test --reporter=html

test-e2e-full:
	# 确认服务在跑
	@curl -sf http://localhost:8100/healthz > /dev/null || (echo "API not running. Run: make serve" && exit 1)
	@curl -sf http://localhost:3010 > /dev/null || (echo "Web not running. Run: make serve" && exit 1)
	@curl -sf http://localhost:7860/healthz > /dev/null || (echo "WhisperX not running" && exit 1)
	# 跑 Playwright
	cd web && npx playwright test
```

### 测试 fixture

`web/e2e/fixtures/test-script.json`:
```json
{
  "title": "E2E Test Episode",
  "segments": [
    {"id": 1, "type": "hook", "text": "你好世界。"},
    {"id": 2, "type": "content", "text": "这是测试内容。"}
  ]
}
```
2 个 segments → ~2 个 chunks。最小化 Fish API 调用次数。

## 替代方案：删除的内容

| 删除 | 原因 |
|---|---|
| `scripts/smoke-test.sh` | Playwright 替代 |
| pytest e2e 里的 mock Fish/WhisperX | 用真实服务 |
| 手动浏览器测试 | Playwright 自动化 |

## 预估时间

| 步骤 | 时间 |
|---|---|
| Phase 0: Docker build + 起服务 | 15-20 min |
| Phase 1+2: 写 Playwright 测试 | 20-30 min |
| Phase 3: Makefile 集成 | 5 min |
| 跑测试 + 修 bug | 30-60 min |
| **总计** | **1.5-2 小时** |

## 阻塞项

1. **whisperx-svc Docker build** — Phase 0 的前置
2. **Fish TTS key 有效性** — 需要提前验证
3. **P3 dev mode 连接地址** — `run_p3_transcribe` 需要连 `localhost:7860`，确认 env 正确
