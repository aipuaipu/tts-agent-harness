# Script TTS Config 使用说明

每个 script.json 可以携带一个 `tts_config` 字段，覆盖全局默认，让不同稿子使用不同 TTS 参数（声音、温度、语速等）而不影响其他 episode。

## 配置优先级

```
env var > script.tts_config > .harness/config.json > 代码默认值
```

- **env var**：最高优先级。临时试验或 CI 里最方便
- **script.tts_config**：稿子级配置，跟随 script.json 进出仓库
- **.harness/config.json**：项目级默认
- **代码默认**：最低优先级，安全兜底

P1 切分时会把 `script.tts_config` 抽取出来写到 `.work/<episode>/tts_config.json`，P2 每次合成前会读取这个文件。

## Script 示例

```json
{
  "title": "拒绝自拟合",
  "description": "Alex 的第 42 期",
  "tts_config": {
    "model": "s2-pro",
    "normalize": false,
    "temperature": 0.3,
    "top_p": 0.5,
    "speed": 1.15,
    "reference_id": "7f3a2b..."
  },
  "segments": [
    { "id": 1, "type": "hook", "text": "..." }
  ]
}
```

## 支持的字段

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `model` | string | `s2-pro` | Fish TTS 模型（`s1` / `s2-pro`）|
| `normalize` | boolean | `false` | 让 Fish 引擎自动做文本归一化。英文混合建议 `false`|
| `temperature` | number | `0.3` | 采样温度。低 = 稳定，高 = 发音多样性强 |
| `top_p` | number | `0.5` | nucleus sampling 截断 |
| `speed` | number | `1.15` | atempo 后处理速度。1.0 = 原速 |
| `reference_id` | string | `""` | 声音克隆 ID（Fish 账号里上传的样本）|
| `concurrency` | number | `6` | 并行 API 调用数（仅 .harness/config.json 有效）|
| `max_retries` | number | `3` | 单 chunk 最多重试次数 |

所有字段都是**可选**的，只写想改的。没写的字段会从下一层配置继承。

## 可覆盖的环境变量

对应关系：

| Env Var | 对应字段 |
|---------|---------|
| `FISH_TTS_MODEL` | `model` |
| `FISH_TTS_REFERENCE_ID` | `reference_id` |
| `TTS_SPEED` | `speed` |

只有这三个能用 env 临时覆盖；其他参数必须改 config 文件。

## 常见用法

**切换声音**：在 script 里设 `"reference_id": "xxx"`，下次跑 pipeline 自动用新声音。

**一次实验**：
```bash
FISH_TTS_MODEL=s2-pro TTS_SPEED=1.2 bash run.sh script.json ep01
```
不污染 config 文件，只影响本次运行。

**字段单测**：改完 script.json 后重跑 `--from p1`（让 p1 重写 tts_config.json）或直接手改 `.work/<ep>/tts_config.json`。

## 生效验证

P2 启动时会打印实际生效的配置，类似：

```
Effective TTS config: model=s2-pro normalize=false temp=0.3 top_p=0.5 ref_id=voice-xyz speed=1.15x concurrency=6
```

如果某个字段不是你想要的，按优先级反查（env → tts_config.json → .harness/config.json）。
