# TODO

已知待办事项。按优先级排序。更新日期: 2026-05-12。

**一期目标：确定性的视频脚本转语音加字幕生产工具。**

---

## 已完成 ✓

- **Pipeline 全链路**：切分 → 预检 → 合成 → 初筛 → 校验 → 字幕 → 拼接 → 验收
- **Web UI**：项目管理、流水线节点可视化、音频播放、字幕预览
- **镜头管理**：单句试听与合成、Take 版本切换、编辑文案后重跑
- **导出功能**：Remotion 格式（分镜头 WAV + 结构化字幕 + 时长 JSON）
- **UI/UX 优化**：全量汉化与通俗化、Dark mode、虚拟滚动渲染、侧边栏折叠
- **系统集成**：
  - 接入 Fish Audio + Xiaomi MIMO 双 TTS provider
  - 接入 Groq Whisper (云端) + WhisperX (本地) 双 ASR 方案
  - 支持 .md / .txt / 剪贴板粘贴等多种脚本导入方式
- **安全与维护**：
  - API Key 迁移至加密 HttpOnly Cookie
  - 存储空间自动清理逻辑（基于配额与项目锁定保护）
  - 单元测试与 README/TODO 术语对齐重写

---

## P0 · 部署上线

### 部署容器化

完善 `docker-compose.yml`，集成 API server + Web，实现一键 `docker compose up` 启动全套环境。

---

## P1 · 功能补全

### 多选镜头合成

- **后端支持**：已具备按 `chunk_ids` 列表运行指定环节的能力。
- **前端实现**：镜头列表增加 checkbox 多选功能，并配套浮动操作栏（Floating Action Bar），支持批量点击“合成”。

---

## P2 · 质量与打磨（低优先级）

- **代码清理**：从 package.json 彻底移除已废弃的 `next-themes`。
- **自动化测试**：补充 adapter 层的 TypeScript 单元测试。

---

## 二期方向（不在一期范围）

- **LLM Agent 叠加**：智能发音修改建议、敏感内容风险判断、合成失败的自然语言解释。
- **架构设计**：详见 `docs/017-llm-agent-design.md`。
