"use client";

import { useState } from "react";
import type { Episode, EpisodeStatus } from "@/lib/types";

interface Props {
  episode: Episode;
  running: boolean;
  onRun: (mode: string) => void;
  failedCount?: number;
}

const STATUS_BADGE: Record<
  EpisodeStatus,
  { bg: string; fg: string; br: string; label: string }
> = {
  done: { bg: "bg-emerald-50", fg: "text-emerald-700", br: "border-emerald-200", label: "done" },
  running: { bg: "bg-blue-50", fg: "text-blue-700", br: "border-blue-200", label: "running" },
  ready: { bg: "bg-neutral-50", fg: "text-neutral-600", br: "border-neutral-200", label: "ready" },
  failed: { bg: "bg-red-50", fg: "text-red-700", br: "border-red-200", label: "failed" },
  empty: { bg: "bg-neutral-50", fg: "text-neutral-500", br: "border-neutral-200", label: "empty" },
};

export function EpisodeHeader({ episode, running, onRun, failedCount = 0 }: Props) {
  const badge = STATUS_BADGE[episode.status] ?? STATUS_BADGE.ready;
  const [menuOpen, setMenuOpen] = useState(false);

  const totalDurationS = episode.chunks.reduce((sum, c) => {
    const selectedTake = c.takes.find((t) => t.id === c.selectedTakeId);
    return sum + (selectedTake?.durationS ?? 0);
  }, 0);

  // D-03: Button config per status
  const primaryButton = (() => {
    if (running) return { label: "运行中...", disabled: true, mode: "" };
    switch (episode.status) {
      case "empty":
        return { label: "切分", disabled: false, mode: "chunk_only" };
      case "ready":
        return { label: "合成全部", disabled: false, mode: "synthesize" };
      case "failed":
        return { label: `重试失败 (${failedCount})`, disabled: failedCount === 0, mode: "retry_failed" };
      case "done":
        return { label: "完成 ✓", disabled: true, mode: "" };
      default:
        return { label: "Run", disabled: true, mode: "" };
    }
  })();

  return (
    <div className="px-6 py-3 border-b border-neutral-200 bg-white shrink-0">
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-lg font-semibold">{episode.title}</h2>
        <span className="text-xs text-neutral-400 font-mono">{episode.id}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${badge.bg} ${badge.fg} ${badge.br}`}>
          {badge.label}
        </span>
        <span className="ml-auto text-[11px] text-neutral-400 font-mono">
          {episode.chunks.length} chunks · {totalDurationS.toFixed(1)}s
        </span>
      </div>
      <div className="flex gap-2 items-center">
        {/* Primary action button */}
        <button
          type="button"
          onClick={() => onRun(primaryButton.mode)}
          disabled={primaryButton.disabled}
          className={`px-3 py-1.5 text-sm rounded ${
            primaryButton.disabled
              ? "bg-neutral-200 text-neutral-400 cursor-not-allowed"
              : "bg-neutral-900 text-white hover:bg-neutral-800"
          }`}
        >
          {primaryButton.label}
        </button>

        {/* Menu for secondary actions (done state: regenerate) */}
        {episode.status === "done" && !running && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              className="px-2 py-1.5 text-sm rounded border border-neutral-300 text-neutral-600 hover:bg-neutral-100"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute left-0 top-full mt-1 w-44 bg-white border border-neutral-200 rounded-md shadow-lg z-30">
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("确认重新生成？\n会清空所有已有产物重新开始。")) {
                      setMenuOpen(false);
                      onRun("regenerate");
                    }
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 rounded-md"
                >
                  重新生成（清空重来）
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
