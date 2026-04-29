import type { StageName } from "./types";

export interface StageInfo {
  title: string;
  description: string;
  inputs: string;
  outputs: string;
  failure: string;
}

export const STAGE_INFO: Record<StageName, StageInfo> = {
  p1: {
    title: "P1 · 脚本切分",
    description: "将 script.json 的 segments 按句切分成 chunks。每个 chunk 是一个独立的合成单元。",
    inputs: "script.json（MinIO）",
    outputs: "chunks 列表（DB）",
    failure: "script.json 格式错误 / MinIO 读取失败",
  },
  p1c: {
    title: "P1c · 输入校验",
    description: "校验 chunks 合法性，在 TTS 调用前拦截可预见的问题",
    inputs: "chunks 列表（DB）",
    outputs: "校验通过 / 错误报告",
    failure: "chunk 文本为空 / 字段缺失 / 格式不合规",
  },
  p2: {
    title: "P2 · TTS 合成",
    description: "调用当前 episode 选择的 TTS provider，将 chunk 的 text_normalized 合成为 WAV 音频。Fish 读取 model / temperature / top_p / reference_id；xiaomi_mimo 直连官方 chat/completions，读取 model / voice / style_prompt。",
    inputs: "chunk.textNormalized + episode.config",
    outputs: "WAV 音频（MinIO）+ take 记录（DB）",
    failure: "Provider 鉴权失败 / 限流 / 超时 / 空响应 / Xiaomi MiMo 返回缺失 audio.data",
  },
  p2c: {
    title: "P2c · 格式校验",
    description: "校验 WAV 文件格式合法性，在 ASR 之前拦截坏文件",
    inputs: "take WAV 音频（MinIO）",
    outputs: "校验通过 / 错误报告",
    failure: "WAV 文件损坏 / 采样率不符 / 空文件",
  },
  p2v: {
    title: "P2v · 内容验证",
    description: "ASR 转写（Groq Whisper 或本地 WhisperX）产出 transcript，同时检查语速和静音异常。",
    inputs: "take WAV 音频 + chunk.textNormalized",
    outputs: "transcript.json（MinIO）+ 质量评分（语速 + 静音 2 维）",
    failure: "ASR 服务不可用 / 语速异常 / 异常长停顿",
  },
  p5: {
    title: "P5 · 字幕生成",
    description: "利用 WhisperX word-level 时间戳精确对齐字幕行，按字符数权重分配 words 给每行。智能分行（逗号/顿号/中英边界断行，≤20字/行）。无 word 数据时 fallback 为字符加权。字幕来源优先用 subtitleText，否则用 text（自动去控制标记）。",
    inputs: "transcript.json（word timestamps）+ chunk.subtitleText / chunk.text",
    outputs: "subtitle.srt（MinIO）",
    failure: "transcript 为空 / chunk 无 selected_take / 源文本全是控制标记",
  },
  p6: {
    title: "P6 · 音频拼接",
    description: "将所有 chunk 的 WAV 按 shot 顺序拼接成一个完整的 episode 音频，同时合并字幕并偏移时间戳。chunk 间插入 200ms 静音，shot 间 500ms。",
    inputs: "所有 chunk 的 take WAV + subtitle SRT",
    outputs: "final/episode.wav + final/episode.srt（MinIO）",
    failure: "某 chunk 无 selected_take / ffmpeg 错误 / MinIO 写入失败",
  },
  p6v: {
    title: "P6v · 端到端验证",
    description: "最终产物完整性校验，检查字幕覆盖率和时间戳",
    inputs: "final/episode.wav + final/episode.srt",
    outputs: "校验通过 / 错误报告",
    failure: "字幕覆盖率不足 / 时间戳 gap/overlap 超阈值",
  },
};
