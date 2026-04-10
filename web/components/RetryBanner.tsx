"use client";

interface Props {
  runMode: string | null | undefined;
}

/**
 * 紧凑单行 banner,仅在单 chunk retry 运行时显示。
 * 目的是让顶部有可见反馈,但不占用 StageProgress 那个"整条 pipeline"进度条的位置。
 *
 * runMode 格式: "retry-<chunkId>-<stage>"
 * 例如: "retry-shot02_chunk03-p5"
 */
export function RetryBanner({ runMode }: Props) {
  if (!runMode || !runMode.startsWith("retry-")) return null;

  // 去掉 "retry-" 前缀,剩下 "<chunkId>-<stage>"
  const rest = runMode.slice("retry-".length);
  const lastDash = rest.lastIndexOf("-");
  const chunkId = lastDash >= 0 ? rest.slice(0, lastDash) : rest;
  const stage = lastDash >= 0 ? rest.slice(lastDash + 1) : "?";

  const stageLabel =
    {
      p2: "P2 · TTS",
      check2: "CHECK2",
      p3: "P3 · 转写",
      check3: "CHECK3",
      p5: "P5 · 字幕",
    }[stage] ?? stage.toUpperCase();

  return (
    <div className="px-6 py-1.5 border-b border-amber-200 bg-amber-50 flex items-center gap-2 text-xs shrink-0">
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse"
          aria-hidden
        />
        <span className="text-amber-800 font-semibold">↻ Retrying</span>
      </span>
      <span className="font-mono text-amber-900">{chunkId}</span>
      <span className="text-amber-500">·</span>
      <span className="font-mono text-amber-800">{stageLabel}</span>
      <span className="ml-auto text-[10px] text-amber-600 font-mono">
        chunk 级重跑 · 不影响其他 chunk
      </span>
    </div>
  );
}
