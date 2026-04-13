"use client";

import { useEffect, useState } from "react";
import { getApiUrl } from "@/lib/api-client";

interface Props {
  episodeId: string;
  open: boolean;
  onClose: () => void;
}

type ViewMode = "cards" | "json";

export function ScriptPreviewDialog({ episodeId, open, onClose }: Props) {
  const [raw, setRaw] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("json");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch(`${getApiUrl()}/episodes/${episodeId}/script`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(setRaw)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open, episodeId]);

  if (!open) return null;

  const script = raw as { title?: string; description?: string; segments?: { id: number | string; type?: string; text: string }[] } | null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white dark:bg-neutral-900 rounded-lg shadow-xl dark:shadow-neutral-900 w-[700px] max-h-[80vh] flex flex-col">
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold">脚本预览</h3>
          <div className="flex items-center gap-2">
            <div className="flex rounded border border-neutral-200 dark:border-neutral-700 text-[11px]">
              <button
                type="button"
                onClick={() => setView("cards")}
                className={`px-2 py-1 ${view === "cards" ? "bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200" : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"}`}
              >
                卡片
              </button>
              <button
                type="button"
                onClick={() => setView("json")}
                className={`px-2 py-1 ${view === "json" ? "bg-neutral-100 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200" : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"}`}
              >
                JSON
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-neutral-400 hover:text-neutral-600 text-lg leading-none ml-2"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && <p className="text-sm text-neutral-400">加载中...</p>}
          {error && <p className="text-sm text-red-500">加载失败: {error}</p>}

          {raw && view === "json" && (
            <pre className="text-xs font-mono bg-neutral-950 text-neutral-200 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed">
              {JSON.stringify(raw, null, 2)}
            </pre>
          )}

          {script && view === "cards" && (
            <div className="space-y-3">
              {script.title && (
                <div className="text-sm font-medium text-neutral-800">{script.title}</div>
              )}
              {script.description && (
                <div className="text-xs text-neutral-500">{script.description}</div>
              )}
              <div className="space-y-2 mt-3">
                {script.segments?.map((seg) => (
                  <div key={seg.id} className="border border-neutral-100 dark:border-neutral-700 rounded p-3">
                    <div className="flex gap-2 mb-1">
                      <span className="text-[10px] font-mono bg-neutral-100 text-neutral-500 px-1.5 py-0.5 rounded">
                        #{seg.id}
                      </span>
                      {seg.type && (
                        <span className="text-[10px] font-mono bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                          {seg.type}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap">{seg.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-700 flex justify-end gap-2 shrink-0">
          <a
            href={`${getApiUrl()}/episodes/${episodeId}/script`}
            download={`${episodeId}-script.json`}
            className="px-3 py-1.5 text-xs rounded border border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            下载 JSON
          </a>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
