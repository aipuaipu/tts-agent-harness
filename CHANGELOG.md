# Changelog

All notable changes to this project will be documented in this file.

## [2026-04-29]

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
