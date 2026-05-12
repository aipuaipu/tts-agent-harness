# Changelog

All notable changes to this project will be documented in this file.

## [2026.05.12]

### Added
- **Fish Audio 音色多维筛选**: 新增了针对 Fish Audio 音色的语言、性别、年龄等多维度过滤系统，并引入 SWR 进行数据缓存，实现即时、高性能的音色发现与浏览。
- **TTS 连字符发音纠正**: 增加正则预处理逻辑，将英文复合词（如 `Human-in-the-Loop`）间的连字符替换为空格，避免发音引擎将其错读为“减号”或“dash”，并已补充对应的单元测试。

### Changed
- **界面全量汉化与通俗化**: 
  - 将技术流水线的内部节点代号（P1, P1c, P2, P2c, P2v, P5, P6, P6v）全面改写为用户友好的两个字中文动词（切分、预检、合成、初筛、校验、字幕、拼接、验收）。
  - 将核心任务单元“Episode”全量汉化为更符合操作直觉的“项目”。
  - 大幅清理并优化了散落在 UI 各处的生硬技术提示框（Tooltip）和弹窗文案，降低了非技术人员的使用门槛。

## [2026.04.29.15.08]

### Added
- **Xiaomi MIMO TTS Support**: 直连官方服务端 API (`https://api.xiaomimimo.com/v1/chat/completions`)。
- **拓展脚本输入方式**: 除标准 `script.json` 外，现支持上传 `.md`/`.txt` 文档，以及前端直接复制粘贴文本或 Markdown，后台自动进行解析。
- **音频播放**: 支持带倍速控制的连续播放。
- **API Key 安全**: 将 API Key 从 localStorage 迁移到加密的 HttpOnly Cookie 中保存，极大增强安全性。

### Changed
- **Audio Hook**: 重构并提取音频逻辑至 `useAudioPlayer` hook 中。
- **UI/UX 改进**:
  - API Key 输入框：如果已配置则默认折叠，只在展开时显示；统一两个输入框的 placeholder 提示语。
  - 为导出下载操作增加了 loading 状态和错误处理提示。
  - 防止模糊效果（blur）吞掉点击 Stage Change / Cancel 按钮的操作。

### Fixed
- 修复了 Groq 请求受限时的重试机制，并修复导出文件头中 CJK（中日韩）文件名的乱码问题。
- 修复了在导出拼接时需要重新编码 WAV 以解决时长计算 Bug 的问题。
- 修复了禁用 Caddy 缓存以支持 SSE 流的实时推送。

---

> *Note: 之前的更新主要记录在 `TODO.md` 的“已完成”列表中。*
