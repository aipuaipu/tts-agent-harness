"use client";

import { useCallback, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props {
  episodeId: string;
  config: Record<string, unknown>;
  onConfigSaved?: () => void;
  onUpdateConfig: (epId: string, config: Record<string, unknown>) => Promise<void>;
}

type Provider = "fish" | "xiaomi_mimo";

interface FormState {
  provider: Provider;
  model: string;
  temperature: string;
  top_p: string;
  reference_id: string;
  mimoModel: string;
  mimoVoice: string;
  mimoVoiceDataUri: string;
  stylePrompt: string;
}

const DEFAULTS: FormState = {
  provider: "xiaomi_mimo",
  model: "s2-pro",
  temperature: "0.7",
  top_p: "0.7",
  reference_id: "",
  mimoModel: "mimo-v2.5-tts",
  mimoVoice: "mimo_default",
  mimoVoiceDataUri: "",
  stylePrompt: "",
};

function configToForm(config: Record<string, unknown>): FormState {
  const provider = String(config.provider ?? DEFAULTS.provider).replace("xiaomi_bridge", "xiaomi_mimo");
  return {
    provider: provider === "xiaomi_mimo" ? "xiaomi_mimo" : "fish",
    model: String(config.model ?? DEFAULTS.model),
    temperature: String(config.temperature ?? DEFAULTS.temperature),
    top_p: String(config.top_p ?? DEFAULTS.top_p),
    reference_id: String(config.reference_id ?? DEFAULTS.reference_id),
    mimoModel: String(config.model ?? DEFAULTS.mimoModel),
    mimoVoice: String((typeof config.voice === "string" && !String(config.voice).startsWith("data:")) ? config.voice : DEFAULTS.mimoVoice),
    mimoVoiceDataUri: String(config.voice_data_uri ?? (typeof config.voice === "string" && String(config.voice).startsWith("data:") ? config.voice : DEFAULTS.mimoVoiceDataUri)),
    stylePrompt: String(config.style_prompt ?? DEFAULTS.stylePrompt),
  };
}

function formToConfig(form: FormState): Record<string, unknown> {
  if (form.provider === "xiaomi_mimo") {
    const isVoiceClone = form.mimoModel === "mimo-v2.5-tts-voiceclone";
    return {
      provider: "xiaomi_mimo",
      model: form.mimoModel,
      voice: isVoiceClone ? undefined : form.mimoVoice,
      voice_data_uri: isVoiceClone ? (form.mimoVoiceDataUri || undefined) : undefined,
      style_prompt: form.stylePrompt || undefined,
    };
  }

  return {
    provider: "fish",
    model: form.model,
    temperature: parseFloat(form.temperature) || 0.7,
    top_p: parseFloat(form.top_p) || 0.7,
    reference_id: form.reference_id || undefined,
  };
}

function HelpTip({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-neutral-300 text-[9px] font-bold text-neutral-400 hover:border-neutral-600 hover:text-neutral-600">
            ?
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function providerLabel(provider: Provider): string {
  return provider === "xiaomi_mimo" ? "xiaomi_mimo" : "fish";
}

export function TtsConfigBar({ episodeId, config, onConfigSaved, onUpdateConfig }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savedHint, setSavedHint] = useState(false);

  const hasOverride = Object.keys(config).length > 0;
  const provider = (String(config.provider ?? DEFAULTS.provider).replace("xiaomi_bridge", "xiaomi_mimo") === "xiaomi_mimo"
    ? "xiaomi_mimo"
    : "fish") as Provider;
  const mimoModel = String(config.model ?? DEFAULTS.mimoModel);
  const mimoVoiceDataUri = String(config.voice_data_uri ?? (typeof config.voice === "string" && String(config.voice).startsWith("data:") ? config.voice : ""));

  const field = (key: string, value: string) => (
    <span className="inline-flex items-center gap-1">
      <span className="text-neutral-400 dark:text-neutral-500">{key}=</span>
      <span className={`font-mono ${hasOverride ? "text-blue-600 dark:text-blue-400" : "text-neutral-600 dark:text-neutral-400"}`}>{value}</span>
    </span>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-4 border-b border-neutral-200 bg-neutral-50 px-6 py-1.5 text-[11px] dark:border-neutral-700 dark:bg-neutral-800">
        <span className="shrink-0 font-semibold text-neutral-500 dark:text-neutral-400">TTS Config:</span>
        {field("provider", providerLabel(provider))}
        {provider === "fish" ? (
          <>
            {field("model", String(config.model ?? DEFAULTS.model))}
            {field("temperature", String(config.temperature ?? DEFAULTS.temperature))}
            {field("top_p", String(config.top_p ?? DEFAULTS.top_p))}
            {field("reference_id", String(config.reference_id || "(none)"))}
          </>
        ) : (
          <>
            {field("model", mimoModel)}
            {field("voice", mimoModel === "mimo-v2.5-tts-voiceclone" ? (mimoVoiceDataUri ? "data-uri" : "(missing)") : String(config.voice ?? DEFAULTS.mimoVoice))}
            {field("style", String(config.style_prompt ?? "(none)"))}
          </>
        )}
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="ml-auto rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:border-neutral-400 hover:bg-white dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:bg-neutral-700"
          title="编辑 TTS 配置"
        >
          ✎ 编辑
        </button>
        {hasOverride && <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400">● override</span>}
      </div>

      {savedHint && (
        <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-6 py-1 text-[11px] text-emerald-800">
          <span>✓ 已保存</span>
          <span className="text-emerald-700">· 点 chunk 的 P2 pill → 仅重跑 P2 验证新配置</span>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <ConfigForm
            episodeId={episodeId}
            config={config}
            onClose={() => setDialogOpen(false)}
            onSaved={() => {
              setDialogOpen(false);
              setSavedHint(true);
              onConfigSaved?.();
              setTimeout(() => setSavedHint(false), 6000);
            }}
            onUpdateConfig={onUpdateConfig}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConfigForm({
  episodeId,
  config,
  onClose,
  onSaved,
  onUpdateConfig,
}: {
  episodeId: string;
  config: Record<string, unknown>;
  onClose: () => void;
  onSaved: () => void;
  onUpdateConfig: (epId: string, config: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(configToForm(config));
  const [saving, setSaving] = useState(false);
  const [voiceFileName, setVoiceFileName] = useState<string>("");
  const set = (key: keyof FormState, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const isVoiceClone = form.provider === "xiaomi_mimo" && form.mimoModel === "mimo-v2.5-tts-voiceclone";

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onUpdateConfig(episodeId, formToConfig(form));
      onSaved();
    } catch (error) {
      toast.error("保存失败", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }, [episodeId, form, onSaved, onUpdateConfig]);

  const inputClass = "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100";

  const handleVoiceFile = useCallback(async (file: File | null) => {
    if (!file) return;
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
      reader.readAsDataURL(file);
    });
    set("mimoVoiceDataUri", dataUri);
    setVoiceFileName(file.name);
  }, []);

  return (
    <>
      <DialogHeader>
        <DialogTitle>编辑 TTS 配置</DialogTitle>
        <DialogDescription>
          先选择 provider，再调整对应参数。`xiaomi_mimo` 直连官方 `chat/completions` TTS 接口，需要服务端配置 `XIAOMI_MIMO_API_KEY`。
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 px-5 py-4 text-sm">
        <div>
          <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
            Provider
            <HelpTip>当前支持 `fish` 与 `xiaomi_mimo`。后者直连官方 Xiaomi MiMo 服务端 HTTP API。</HelpTip>
          </label>
          <select value={form.provider} onChange={(event) => set("provider", event.target.value as Provider)} className={inputClass}>
            <option value="fish">fish</option>
            <option value="xiaomi_mimo">xiaomi_mimo</option>
          </select>
        </div>

        {form.provider === "fish" ? (
          <>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                Model
                <HelpTip>Fish Audio 模型。现有后端保持兼容，默认 `s2-pro`。</HelpTip>
              </label>
              <select value={form.model} onChange={(event) => set("model", event.target.value)} className={inputClass}>
                <option value="s2-pro">s2-pro</option>
                <option value="s2">s2</option>
              </select>
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                Temperature
                <HelpTip>Fish 采样温度。低值更稳定，高值更多样。</HelpTip>
              </label>
              <input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={(event) => set("temperature", event.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                Top P
                <HelpTip>Fish nucleus sampling 截断。</HelpTip>
              </label>
              <input type="number" step="0.1" min="0" max="1" value={form.top_p} onChange={(event) => set("top_p", event.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                Reference ID
                <HelpTip>Fish 声音模型 ID。留空使用默认声音。</HelpTip>
              </label>
              <input type="text" value={form.reference_id} onChange={(event) => set("reference_id", event.target.value)} className={inputClass} placeholder="留空使用默认声音" />
            </div>
          </>
        ) : (
          <>
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              `xiaomi_mimo` 直连官方 `https://api.xiaomimimo.com/v1/chat/completions`。目标朗读文本会放在 `assistant` 消息中，`style_prompt` 会放在可选的 `user` 消息中。
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                MiMo Model
                <HelpTip>官方文档列出的 TTS 模型，如 `mimo-v2.5-tts`。</HelpTip>
              </label>
              <select value={form.mimoModel} onChange={(event) => set("mimoModel", event.target.value)} className={inputClass}>
                <option value="mimo-v2.5-tts">mimo-v2.5-tts</option>
                <option value="mimo-v2.5-tts-voiceclone">mimo-v2.5-tts-voiceclone</option>
                <option value="mimo-v2.5-tts-voicedesign">mimo-v2.5-tts-voicedesign</option>
              </select>
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                Voice
                <HelpTip>内置音色 ID，从下拉列表选择。voiceclone 模型改用下面的 data URI 输入。</HelpTip>
              </label>
              <select value={form.mimoVoice} onChange={(event) => set("mimoVoice", event.target.value)} className={inputClass} disabled={isVoiceClone}>
                <option value="mimo_default">mimo_default (默认)</option>
                <option value="冰糖">冰糖</option>
                <option value="茉莉">茉莉</option>
                <option value="苏打">苏打</option>
                <option value="白桦">白桦</option>
                <option value="Mia">Mia</option>
                <option value="Chloe">Chloe</option>
                <option value="Milo">Milo</option>
                <option value="Dean">Dean</option>
              </select>
            </div>
            {isVoiceClone && (
              <>
                <div>
                  <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                    Voice Clone Audio File
                    <HelpTip>选择参考音频后，前端会自动转成官方要求的 `data:{mime};base64,...` 并写入配置。</HelpTip>
                  </label>
                  <input
                    type="file"
                    accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg"
                    onChange={(event) => { void handleVoiceFile(event.target.files?.[0] ?? null); }}
                    className={`${inputClass} font-sans`}
                  />
                  {voiceFileName && (
                    <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                      已载入: {voiceFileName}
                    </div>
                  )}
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                    Voice Data URI
                    <HelpTip>也可以直接粘贴官方 voiceclone 需要的 data URI。</HelpTip>
                  </label>
                  <textarea
                    value={form.mimoVoiceDataUri}
                    onChange={(event) => set("mimoVoiceDataUri", event.target.value)}
                    className={`${inputClass} min-h-[120px] break-all`}
                    placeholder="data:audio/mpeg;base64,..."
                  />
                </div>
              </>
            )}
            <div>
              <label className="mb-1 flex items-center gap-1 text-xs text-neutral-600">
                Style Prompt
                <HelpTip>官方 docs 里的可选 `user` 消息，用于控制语气和风格；实际朗读文本仍来自 `assistant` 消息。</HelpTip>
              </label>
              <textarea value={form.stylePrompt} onChange={(event) => set("stylePrompt", event.target.value)} className={`${inputClass} min-h-[96px] font-sans`} />
            </div>
          </>
        )}
      </div>

      <DialogFooter>
        <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={`ml-auto rounded px-4 py-1.5 text-xs ${saving ? "bg-neutral-200 text-neutral-400 dark:bg-neutral-700" : "bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"}`}
        >
          {saving ? "保存中..." : "保存配置"}
        </button>
      </DialogFooter>
    </>
  );
}
