# TTS Rules

发音规则备忘。当前 P1 不做内容修改，P4 生产中跳过，这些规则作为人工编辑 text 时的参考。

## S2-Pro 控制标记

脚本 `text` 字段中可内嵌以下控制标记，P2 直接传 TTS 引擎，P5 生成字幕时自动 strip：

- `[break]` — 短停顿
- `[breath]` — 气口
- `[long break]` — 长停顿
- `<|phoneme_start|>...<|phoneme_end|>` — 强制发音

## 英文处理

- 英文品牌名/缩写保持原样，不转中文，不音译
- S2-Pro 中文模型能读大部分英文品牌名，发音不稳定时用 phoneme 标注或人工调整
- 英文连字符改空格（`yoyo-evolve` → `yoyo evolve`）

## 数字处理

- 数字保持原样，交 TTS 引擎处理
- 如果 TTS 读法不理想，人工在 text 中改为中文写法（如 `2024年` → `二零二四年`）

## TTS 参数

- 模型：S2-Pro（config.json p2.model）
- 语速：1.15x（config.json p2.default_speed）
- 采样：temperature=0.3, top_p=0.5（config.json p2.temperature/top_p）
- normalize: false（P2 代码硬编码，让 S2-Pro 原样处理）

## 人工修复流程

遇到发音问题时：
1. 修改 chunks.json 中目标 chunk 的 `text_normalized`
2. 重跑 P2 合成该 chunk
3. 人工听音频验证
4. 满意后从 P3 续跑完成字幕和拼接
