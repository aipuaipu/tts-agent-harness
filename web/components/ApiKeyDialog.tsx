"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const STORAGE_KEY = "fish-api-key";

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "*".repeat(key.length);
  return "*".repeat(key.length - 4) + key.slice(-4);
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ApiKeyDialog({ open, onClose }: Props) {
  const [key, setKey] = useState("");
  const [savedMask, setSavedMask] = useState("");
  const [hasSaved, setHasSaved] = useState(false);

  // Load current state when dialog opens
  useEffect(() => {
    if (open) {
      const stored = localStorage.getItem(STORAGE_KEY) || "";
      setSavedMask(maskKey(stored));
      setHasSaved(!!stored);
      setKey("");
    }
  }, [open]);

  const handleSave = () => {
    const trimmed = key.trim();
    if (!trimmed) return;
    localStorage.setItem(STORAGE_KEY, trimmed);
    setSavedMask(maskKey(trimmed));
    setHasSaved(true);
    setKey("");
  };

  const handleClear = () => {
    localStorage.removeItem(STORAGE_KEY);
    setSavedMask("");
    setHasSaved(false);
    setKey("");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Fish Audio API Key</DialogTitle>
          <DialogDescription>
            Key 仅存储在浏览器 localStorage 中，不会发送到后端数据库。
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {/* Current key display */}
          {hasSaved && (
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              当前 Key: <span className="font-mono">{savedMask}</span>
            </div>
          )}

          {/* Input */}
          <div className="space-y-1.5">
            <label
              htmlFor="fish-api-key-input"
              className="text-xs font-medium text-neutral-700 dark:text-neutral-300"
            >
              {hasSaved ? "替换 Key" : "输入 API Key"}
            </label>
            <input
              id="fish-api-key-input"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              className="w-full px-3 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:focus:ring-neutral-500"
              onKeyDown={(e) => {
                if (e.key === "Enter" && key.trim()) handleSave();
              }}
            />
          </div>

          {/* Link */}
          <a
            href="https://fish.audio/zh-CN/go-api/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline inline-block"
          >
            fish.audio 获取 API Key &rarr;
          </a>
        </div>

        <DialogFooter>
          {hasSaved && (
            <button
              type="button"
              onClick={handleClear}
              className="px-3 py-1.5 text-sm rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              清除
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!key.trim()}
            className="px-3 py-1.5 text-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            保存
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
