# TODO

已知待办事项。按优先级排序。更新日期: 2026-04-13。

**一期目标：确定性的视频脚本转语音加字幕生产工具。**

---

## 已完成 ✓

- Pipeline 全链路：P1 → P1c → P2 → P2c → P2v → P5 → P6 → P6v
- Web UI：Episode 管理、Chunk pipeline 可视化、音频播放、字幕预览
- 单 chunk 编辑/重试、Take 管理
- 导出功能（Remotion 格式：per-shot WAV + subtitles.json + durations.json）
- 错误处理、开发模式容错
- Dark mode + 主题切换（自定义 ThemeProvider，兼容 Next.js 16）
- 虚拟滚动（@tanstack/react-virtual）
- ChunkRow Zustand 直连 + React.memo
- 侧边栏可折叠 + 状态缩略图 + 基础响应式
- HelpDialog / stage-info 动态渲染，与代码逻辑同步
- Stage 名称统一（check2/check3 → p2c/p2v，domain.py 移除 p3）
- P2v 2 维评估（duration + silence）+ 前端展示
- P5 word-level 时间戳对齐 + 智能分行（从原版 JS 移植）
- repair 循环简化（删 L0/L1，单次 P2→P2c→P2v，失败直接 needs_review）
- 用户自带 API Key（Fish + Groq，localStorage + header 透传）
- Groq Whisper ASR 接入（云端替代本地 WhisperX）
- ChunkEditor 原型图风格重写（inline edit + review banner）
- 菜单 Radix DropdownMenu 统一 + 汉化
- TTS 参数描述对齐 Fish Audio 官方文档
- 旧版 CLI 脚本归档（`_archive/`）
- 过时文档归档 + README 重写
- 死代码清理（repair.py、RepairConfig、RepairAction）
- 存储过期清理（按容量 + episode locked 保护）
- 脚本预览（JSON 视图 + 下载）
- 接入 Xiaomi MIMO TTS (直连官方服务端 API)
- 拓展 JSON 外的 MD、TXT、文本复制等前端材料输入方式

---

## P0 · 部署上线

### 部署容器化

docker-compose 加 API server + Web，一键 `docker compose up` 全套启动。

---

## P1 · 功能补全

### 多选 chunk 合成

后端已有：`run_episode_flow(mode="synthesize", chunk_ids=[...])`。
前端：ChunksTable checkbox + floating action bar。

---

## P2 · 质量与打磨（低优先级）

- `next-themes` 从 package.json 移除（已替换为自定义实现）
- adapter TS 单元测试

---

## 二期方向（不在一期范围）

- LLM Agent 叠加：发音修改建议、风险判断、自然语言解释
- 架构设计见 `docs/017-llm-agent-design.md`
