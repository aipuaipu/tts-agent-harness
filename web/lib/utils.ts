/**
 * Frontend 共享小工具函数。
 * 这里不 import 任何 adapter / server-only 代码。
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind class merge utility (shadcn/ui standard). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Strip S2-Pro 控制标记,供字幕显示用。与 P5 脚本的行为一致。 */
export function stripControlMarkers(text: string | null | undefined): string {
  return String(text ?? "")
    // Strip all [...] control markers (break/breath/pause/phoneme etc.)
    .replace(/\[[^\[\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 得到字幕显示文本:优先 subtitleText,否则 strip 后的 text。 */
export function getDisplaySubtitle(c: {
  text: string;
  subtitleText: string | null;
}): string {
  if (c.subtitleText != null) return stripControlMarkers(c.subtitleText);
  return stripControlMarkers(c.text);
}

export function fmtDuration(s: number): string {
  if (!s || s <= 0) return "—";
  return `${s.toFixed(1)}s`;
}
