"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * 小问号图标 + hover 气泡。用 CSS group 实现,不需要 JS state。
 * 气泡内容作为 children 传入,支持富文本。
 *
 * `placement`:
 *   - "right" (默认): 气泡出现在图标右侧
 *   - "left":  气泡出现在图标左侧（用于右栏字段,避免溢出对话框）
 */
function HelpIcon({
  children,
  placement = "right",
}: {
  children: ReactNode;
  placement?: "left" | "right";
}) {
  const tipPos =
    placement === "right" ? "left-5 top-0" : "right-5 top-0";
  return (
    <span className="relative inline-flex group cursor-help">
      <span
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-neutral-300 text-neutral-400 text-[9px] font-bold leading-none hover:border-neutral-600 hover:text-neutral-600"
        aria-label="说明"
      >
        ?
      </span>
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${tipPos} z-50 w-64 opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 bg-neutral-900 text-white text-[11px] leading-relaxed rounded-md shadow-lg px-3 py-2`}
      >
        {children}
      </span>
    </span>
  );
}

interface EffectiveConfig {
  model: string;
  normalize: boolean;
  temperature: number | null;
  top_p: number | null;
  reference_id: string;
  speed: number;
  concurrency: number;
  max_retries: number;
}

type SourceMap = Record<string, "default" | "harness" | "override" | "env">;

interface ApiResponse {
  override: Record<string, unknown> | null;
  effective: EffectiveConfig;
  sources: SourceMap;
}

interface Props {
  episodeId: string;
  /** bumped by parent to force refetch (e.g. after run) */
  refreshKey?: number;
}

const SOURCE_LABEL: Record<SourceMap[string], string> = {
  default: "代码默认",
  harness: ".harness",
  override: "episode",
  env: "env var",
};

const SOURCE_COLOR: Record<SourceMap[string], string> = {
  default: "text-neutral-400",
  harness: "text-neutral-500",
  override: "text-blue-600 font-semibold",
  env: "text-purple-600 font-semibold",
};

export function TtsConfigBar({ episodeId, refreshKey = 0 }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savedHint, setSavedHint] = useState(false);

  const refetch = async () => {
    try {
      const r = await fetch(
        `/api/episodes/${encodeURIComponent(episodeId)}/config`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as ApiResponse;
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId, refreshKey]);

  if (error) {
    return (
      <div className="px-6 py-1.5 border-b border-neutral-200 bg-neutral-50 text-xs text-red-500">
        TTS config 加载失败: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="px-6 py-1.5 border-b border-neutral-200 bg-neutral-50 text-xs text-neutral-400">
        加载 TTS config…
      </div>
    );
  }

  const { effective, sources, override } = data;
  const hasOverride = override && Object.keys(override).length > 0;

  const field = (key: keyof EffectiveConfig, formatted: string) => (
    <span
      className="inline-flex items-center gap-1"
      title={`来源: ${SOURCE_LABEL[sources[key] ?? "default"]}`}
    >
      <span className="text-neutral-400">{key}=</span>
      <span className={`font-mono ${SOURCE_COLOR[sources[key] ?? "default"]}`}>
        {formatted}
      </span>
    </span>
  );

  return (
    <>
      <div className="px-6 py-1.5 border-b border-neutral-200 bg-neutral-50 text-[11px] flex items-center gap-4 flex-wrap">
        <span className="text-neutral-500 font-semibold shrink-0">
          TTS Config:
        </span>
        {field("model", effective.model)}
        {field("normalize", String(effective.normalize))}
        {field(
          "temperature",
          effective.temperature == null ? "null" : String(effective.temperature),
        )}
        {field(
          "top_p",
          effective.top_p == null ? "null" : String(effective.top_p),
        )}
        {field("speed", `${effective.speed}x`)}
        {field("reference_id", effective.reference_id || "(none)")}
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="ml-auto px-2 py-0.5 text-[11px] rounded border border-neutral-300 text-neutral-600 hover:bg-white hover:border-neutral-400"
          title="编辑 episode 级 TTS 覆盖"
        >
          ✎ 编辑
        </button>
        {hasOverride ? (
          <span className="text-[10px] text-blue-600 font-mono" title="此 episode 有自定义覆盖">
            ● override
          </span>
        ) : null}
      </div>
      {savedHint ? (
        <div className="px-6 py-1 border-b border-emerald-200 bg-emerald-50 text-[11px] text-emerald-800 flex items-center gap-2">
          <span>✓ 已保存</span>
          <span className="text-emerald-700">
            ·  点任意 chunk 的 <span className="font-mono bg-emerald-100 px-1 rounded">P2</span> pill → <span className="font-mono bg-emerald-100 px-1 rounded">仅重跑 P2</span> 用新配置验证
          </span>
          <span className="ml-auto text-emerald-600">
            Run All 只处理 pending chunks,不会重跑已完成的
          </span>
        </div>
      ) : null}

      <TtsConfigDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        episodeId={episodeId}
        current={data}
        onSaved={(fresh) => {
          setData(fresh);
          setDialogOpen(false);
          setSavedHint(true);
          window.setTimeout(() => setSavedHint(false), 6000);
        }}
      />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Dialog
// ───────────────────────────────────────────────────────────────────────────

interface DialogProps {
  open: boolean;
  onClose: () => void;
  episodeId: string;
  current: ApiResponse;
  onSaved: (fresh: ApiResponse) => void;
}

type FormState = {
  model: string;
  normalize: boolean;
  temperature: string; // string for input control
  top_p: string;
  speed: string;
  reference_id: string;
};

function formFromOverride(
  override: Record<string, unknown> | null,
  effective: EffectiveConfig,
): FormState {
  // Pre-populate with current effective values so user sees what's active.
  return {
    model: (override?.model as string) ?? effective.model,
    normalize:
      typeof override?.normalize === "boolean"
        ? (override.normalize as boolean)
        : effective.normalize,
    temperature:
      override?.temperature != null
        ? String(override.temperature)
        : effective.temperature != null
          ? String(effective.temperature)
          : "",
    top_p:
      override?.top_p != null
        ? String(override.top_p)
        : effective.top_p != null
          ? String(effective.top_p)
          : "",
    speed:
      override?.speed != null
        ? String(override.speed)
        : String(effective.speed),
    reference_id:
      (override?.reference_id as string) ?? effective.reference_id ?? "",
  };
}

function TtsConfigDialog({
  open,
  onClose,
  episodeId,
  current,
  onSaved,
}: DialogProps) {
  const [form, setForm] = useState<FormState>(() =>
    formFromOverride(current.override, current.effective),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(formFromOverride(current.override, current.effective));
      setErr(null);
    }
  }, [open, current]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const override: Record<string, unknown> = {};
      if (form.model.trim()) override.model = form.model.trim();
      override.normalize = form.normalize;
      if (form.temperature !== "") {
        const n = parseFloat(form.temperature);
        if (!Number.isFinite(n)) throw new Error("temperature 必须是数字");
        override.temperature = n;
      }
      if (form.top_p !== "") {
        const n = parseFloat(form.top_p);
        if (!Number.isFinite(n)) throw new Error("top_p 必须是数字");
        override.top_p = n;
      }
      if (form.speed !== "") {
        const n = parseFloat(form.speed);
        if (!Number.isFinite(n)) throw new Error("speed 必须是数字");
        override.speed = n;
      }
      if (form.reference_id.trim()) {
        override.reference_id = form.reference_id.trim();
      }
      const r = await fetch(
        `/api/episodes/${encodeURIComponent(episodeId)}/config`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ override }),
        },
      );
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text || `HTTP ${r.status}`);
      }
      const fresh = (await r.json()) as ApiResponse;
      onSaved(fresh);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const clearOverride = async () => {
    if (!confirm("清除 episode 级覆盖,恢复为 .harness 默认?")) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/episodes/${encodeURIComponent(episodeId)}/config`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ override: null }),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const fresh = (await r.json()) as ApiResponse;
      onSaved(fresh);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-neutral-200">
          <h2 className="font-semibold text-sm">编辑 Episode TTS 配置</h2>
          <p className="text-[11px] text-neutral-500 mt-0.5 leading-relaxed">
            调试工作流: <strong className="text-neutral-700">改配置 → 单 chunk retry 试听 → 满意后再编辑 chunk 触发批量</strong>。
            Run All 只跑 pending chunks,<span className="text-amber-600">不会因为改配置自动重合成</span>。
          </p>
        </div>

        <div className="px-5 py-4 space-y-3 text-sm">
          <div>
            <label className="block text-xs text-neutral-500 mb-1">model</label>
            <input
              type="text"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="s2-pro"
              className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-neutral-900"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="normalize"
              type="checkbox"
              checked={form.normalize}
              onChange={(e) =>
                setForm({ ...form, normalize: e.target.checked })
              }
            />
            <label
              htmlFor="normalize"
              className="flex items-center gap-1 text-xs text-neutral-700"
            >
              normalize
              <span className="text-neutral-400">(让 Fish 引擎做文本归一化)</span>
              <HelpIcon>
                <div className="font-semibold mb-1">normalize · 文本归一化</div>
                <p className="mb-1.5">
                  控制 Fish TTS 引擎是否在合成前对文本做自动规整
                  （数字 / 日期 / 符号 → 口语表达）。
                </p>
                <ul className="space-y-0.5 list-disc list-inside">
                  <li>
                    <span className="font-mono">true</span>:{" "}
                    <span>Fish 自己处理</span>
                    <span className="text-neutral-400">
                      ,如 "2025" → "二零二五"、"3.5" → "三点五"、"68%" → "百分之六十八"
                    </span>
                  </li>
                  <li>
                    <span className="font-mono">false</span>:{" "}
                    <span>原样送入模型</span>
                    <span className="text-neutral-400">
                      ,不做替换。适合手工已经写好朗读形式的稿子
                    </span>
                  </li>
                </ul>
                <p className="mt-1.5 text-neutral-400">
                  默认 false。S2-Pro 的默认归一化经常破坏英文缩写 /
                  专名 / 控制标记,建议关掉后在稿子里手工处理。
                </p>
              </HelpIcon>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="flex items-center gap-1 text-xs text-neutral-500 mb-1">
                temperature
                <HelpIcon>
                  <div className="font-semibold mb-1">temperature · 采样温度</div>
                  <p className="mb-1.5">
                    控制 TTS 输出的随机性。范围 0–2,默认 0.3。
                  </p>
                  <ul className="space-y-0.5 list-disc list-inside">
                    <li>
                      <span className="font-mono">低 (0–0.3)</span>：稳定、可复现,
                      同一段文本每次发音相似,但可能单调
                    </li>
                    <li>
                      <span className="font-mono">中 (0.4–0.7)</span>：自然的韵律变化,
                      推荐范围
                    </li>
                    <li>
                      <span className="font-mono">高 (0.8+)</span>：富有表现力但
                      发音可能漂移/出错
                    </li>
                  </ul>
                  <p className="mt-1.5 text-neutral-400">
                    字符比校验失败多的话 → 调低
                  </p>
                </HelpIcon>
              </label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={form.temperature}
                onChange={(e) =>
                  setForm({ ...form, temperature: e.target.value })
                }
                placeholder="0.3"
                className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-neutral-900"
              />
            </div>
            <div>
              <label className="flex items-center gap-1 text-xs text-neutral-500 mb-1">
                top_p
                <HelpIcon placement="left">
                  <div className="font-semibold mb-1">top_p · nucleus sampling</div>
                  <p className="mb-1.5">
                    从概率最高的候选里只保留累积概率前 P 的那部分。
                    范围 0–1,默认 0.5。
                  </p>
                  <ul className="space-y-0.5 list-disc list-inside">
                    <li>
                      <span className="font-mono">低 (0.3–0.5)</span>：收敛到高频
                      读音,英文专名/缩写更可能读对
                    </li>
                    <li>
                      <span className="font-mono">高 (0.8–1.0)</span>：允许低频候选,
                      多样性高但英文常"瞎读"
                    </li>
                  </ul>
                  <p className="mt-1.5 text-neutral-400">
                    和 temperature 正交,通常两者一起调低可以压住发音不稳定
                  </p>
                </HelpIcon>
              </label>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={form.top_p}
                onChange={(e) => setForm({ ...form, top_p: e.target.value })}
                placeholder="0.5"
                className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-neutral-900"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-neutral-500 mb-1">
              speed (atempo 后处理)
            </label>
            <input
              type="number"
              step="0.05"
              min="0.5"
              max="2"
              value={form.speed}
              onChange={(e) => setForm({ ...form, speed: e.target.value })}
              placeholder="1.15"
              className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-neutral-900"
            />
          </div>

          <div>
            <label className="block text-xs text-neutral-500 mb-1">
              reference_id
              <span className="ml-2 text-neutral-400 font-normal">
                (声音克隆 ID)
              </span>
            </label>
            <input
              type="text"
              value={form.reference_id}
              onChange={(e) =>
                setForm({ ...form, reference_id: e.target.value })
              }
              placeholder="7f3a2b..."
              className="w-full border border-neutral-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-neutral-900"
            />
          </div>

          {err ? (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              {err}
            </div>
          ) : null}
        </div>

        <div className="px-5 py-3 border-t border-neutral-200 flex items-center gap-2">
          <button
            type="button"
            onClick={clearOverride}
            disabled={saving}
            className="text-xs text-neutral-500 hover:text-red-600 underline-offset-2 hover:underline"
          >
            清除覆盖
          </button>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-sm rounded hover:bg-neutral-100"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-neutral-900 text-white rounded hover:bg-neutral-800 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
