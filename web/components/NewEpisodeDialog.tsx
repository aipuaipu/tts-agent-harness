"use client";

import { useRef, useState } from "react";
import type { CreateEpisodeInput } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateEpisodeInput) => void | Promise<void>;
}

type InputMode = "file" | "paste";

const SUPPORTED_FILE_RE = /\.(json|txt|md|markdown)$/i;

function isSupportedScriptFile(file: File | null): file is File {
  return !!file && SUPPORTED_FILE_RE.test(file.name);
}

function stripExtension(name: string): string {
  return name.replace(/\.(json|txt|md|markdown)$/i, "");
}

function cleanIdSeed(value: string): string {
  return value
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 48);
}

function inferIdFromFile(file: File | null): string {
  if (!file) return "";
  return cleanIdSeed(stripExtension(file.name));
}

function inferIdFromText(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? cleanIdSeed(firstLine) : "";
}

function fallbackEpisodeId(): string {
  return `episode-${Date.now().toString().slice(-6)}`;
}

export function NewEpisodeDialog({ open, onClose, onCreate }: Props) {
  const [mode, setMode] = useState<InputMode>("file");
  const [id, setId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [scriptText, setScriptText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const inferredId = mode === "file" ? inferIdFromFile(file) : inferIdFromText(scriptText);
  const resolvedId = id.trim() || inferredId || fallbackEpisodeId();
  const canCreate = mode === "file"
    ? Boolean(isSupportedScriptFile(file))
    : Boolean(scriptText.trim());

  const resetForm = () => {
    setMode("file");
    setId("");
    setFile(null);
    setScriptText("");
    setDragging(false);
    setSubmitting(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    try {
      if (mode === "file" && file) {
        await onCreate({ id: resolvedId, file });
      } else if (mode === "paste") {
        await onCreate({ id: resolvedId, scriptText: scriptText.trim() });
      }
      resetForm();
    } finally {
      setSubmitting(false);
    }
  };

  const pickFile = (nextFile: File | null) => {
    if (!isSupportedScriptFile(nextFile)) {
      setFile(null);
      return;
    }
    setMode("file");
    setFile(nextFile);
    if (!id.trim()) {
      const autoId = inferIdFromFile(nextFile);
      if (autoId) setId(autoId);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    pickFile(event.dataTransfer.files?.[0] ?? null);
  };

  const hintText = mode === "file"
    ? "支持 .json / .txt / .md。txt/md 会在后台自动转成 script.json。"
    : "Markdown 标题会变成 title；空行和列表项会变成镜头。";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
      <div className="w-full max-w-2xl rounded-2xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-neutral-950">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">新建 Episode</h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              不再要求先手写 JSON。直接导入脚本文档，或把文案粘贴进来即可。
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            关闭
          </button>
        </div>

        <div className="mb-4 flex gap-2 rounded-xl bg-neutral-100 p-1 dark:bg-neutral-800">
          <button
            type="button"
            onClick={() => setMode("file")}
            className={[
              "flex-1 rounded-lg px-3 py-2 text-sm transition",
              mode === "file"
                ? "bg-white font-medium text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-100"
                : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200",
            ].join(" ")}
          >
            导入文件
          </button>
          <button
            type="button"
            onClick={() => setMode("paste")}
            className={[
              "flex-1 rounded-lg px-3 py-2 text-sm transition",
              mode === "paste"
                ? "bg-white font-medium text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-100"
                : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200",
            ].join(" ")}
          >
            直接粘贴
          </button>
        </div>

        <div className="mb-4 grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Episode ID
            </label>
            <input
              type="text"
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="留空时自动生成"
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:border-neutral-300"
            />
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              {id.trim()
                ? "将使用你输入的 ID。"
                : `未填写时将使用: ${resolvedId}`}
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
            <div className="font-medium text-neutral-900 dark:text-neutral-100">导入规则</div>
            <div className="mt-2 leading-6">
              {hintText}
            </div>
            <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              兼容旧流程：上传 `script.json` 仍然可以直接创建。
            </div>
          </div>
        </div>

        {mode === "file" ? (
          <div
            onDrop={handleDrop}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragging(false);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={[
              "cursor-pointer rounded-2xl border-2 border-dashed px-6 py-10 text-center transition",
              dragging
                ? "border-sky-500 bg-sky-50 dark:bg-sky-950/30"
                : file
                  ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30"
                  : "border-neutral-300 bg-neutral-50 hover:border-neutral-400 dark:border-neutral-600 dark:bg-neutral-800/40 dark:hover:border-neutral-500",
            ].join(" ")}
          >
            {file ? (
              <>
                <div className="text-base font-medium text-emerald-700 dark:text-emerald-300">{file.name}</div>
                <div className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
                <div className="mt-3 text-xs text-neutral-400">点击可重新选择文件</div>
              </>
            ) : (
              <>
                <div className="text-base font-medium text-neutral-700 dark:text-neutral-200">
                  拖拽脚本文件到这里
                </div>
                <div className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                  或点击选择 `.json` / `.txt` / `.md`
                </div>
                <div className="mt-3 text-xs text-neutral-400">
                  建议 txt / md 里用空行分镜头，用 Markdown 标题写标题。
                </div>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.txt,.md,.markdown,text/plain,text/markdown,application/json"
              onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
              className="hidden"
            />
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              文案 / Markdown
            </label>
            <textarea
              value={scriptText}
              onChange={(event) => setScriptText(event.target.value)}
              placeholder={"# 视频标题\n\n第一镜头文案。\n\n第二镜头文案。"}
              className="min-h-[260px] w-full rounded-2xl border border-neutral-300 bg-white px-4 py-3 text-sm leading-6 text-neutral-900 outline-none transition focus:border-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:border-neutral-300"
            />
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            创建后后台会统一存成 canonical `script.json`，后续流水线无需改动。
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg px-4 py-2 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={!canCreate || submitting}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {submitting ? "创建中..." : "创建 Episode"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
