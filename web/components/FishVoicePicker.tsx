"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import useSWRInfinite from "swr/infinite";
import { getApiUrl } from "@/lib/api-client";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

interface FishVoice {
  id: string;
  title: string;
  description?: string;
  languages?: string[];
  tags?: string[];
  gender?: string | null;
  age?: string | null;
  preview_url?: string | null;
}

interface Props {
  value: string; // current reference_id
  onChange: (referenceId: string) => void;
}

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

/** Fixed language chips — always visible regardless of loaded data. */
const LANGUAGE_OPTIONS = [
  { value: null, label: "全部" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "de", label: "Deutsch" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "ar", label: "العربية" },
] as const;

const GENDER_OPTIONS = [
  { value: null, label: "全部" },
  { value: "male", label: "男声" },
  { value: "female", label: "女声" },
] as const;

const AGE_OPTIONS = [
  { value: null, label: "全部" },
  { value: "young", label: "年轻" },
  { value: "middle-aged", label: "中年" },
  { value: "old", label: "年长" },
] as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const LANG_LABELS: Record<string, string> = {
  zh: "中文", en: "English", ja: "日本語", ko: "한국어",
  de: "Deutsch", fr: "Français", es: "Español", ar: "العربية",
};

function langLabel(code: string): string {
  return LANG_LABELS[code] ?? code;
}

function genderIcon(gender: string | null | undefined): string {
  if (gender === "male") return "♂";
  if (gender === "female") return "♀";
  return "";
}

function genderColor(gender: string | null | undefined): string {
  if (gender === "male") return "text-sky-500";
  if (gender === "female") return "text-pink-400";
  return "text-neutral-400";
}

function ageLabel(age: string | null | undefined): string {
  if (age === "young") return "青";
  if (age === "middle-aged") return "中";
  if (age === "old") return "长";
  return "";
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export function FishVoicePicker({ value, onChange }: Props) {
  /* ---- state ---- */
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [langFilter, setLangFilter] = useState<string | null>(null);
  const [genderFilter, setGenderFilter] = useState<string | null>(null);
  const [ageFilter, setAgeFilter] = useState<string | null>(null);

  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customId, setCustomId] = useState("");

  const listRef = useRef<HTMLDivElement>(null);
  
  /* ---- audio preview ---- */
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const togglePlay = useCallback((e: React.MouseEvent, voiceId: string, url: string | null | undefined) => {
    e.stopPropagation();
    if (!url) return;

    if (playingId === voiceId) {
      // stop playing
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlayingId(null);
    } else {
      // play new
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(url);
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => setPlayingId(null);
      audio.play().catch(() => setPlayingId(null));
      audioRef.current = audio;
      setPlayingId(voiceId);
    }
  }, [playingId]);

  /* ---- debounce search ---- */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /* ---- fetch voices via SWR ---- */
  const getKey = (pageIndex: number, previousPageData: any) => {
    if (previousPageData && !previousPageData.has_more) return null; // reached the end
    
    const params = new URLSearchParams();
    params.set("page_size", "100");
    params.set("page_number", String(pageIndex + 1));
    if (debouncedSearch.trim()) params.set("title", debouncedSearch.trim());
    if (langFilter) params.set("language", langFilter);
    
    return `${getApiUrl()}/tts/fish-voices?${params.toString()}`;
  };

  const fetcher = async (url: string) => {
    const response = await fetch(url, { credentials: "include" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(payload?.detail || `请求失败 (${response.status})`);
    return payload;
  };

  const { data, error, size, setSize, isValidating } = useSWRInfinite(getKey, fetcher, {
    keepPreviousData: true,
    revalidateFirstPage: false,
    revalidateOnFocus: false, // avoid fetching too often when switching windows
  });

  const voices: FishVoice[] = useMemo(() => {
    return data ? data.flatMap((page: any) => page.items ?? []) : [];
  }, [data]);

  const loading = !data && !error && isValidating;
  const loadingMore = isValidating && size > 0 && data && typeof data[size - 1] === "undefined";
  const hasMore = data ? Boolean(data[data.length - 1]?.has_more) : false;

  const handleLoadMore = useCallback(() => {
    void setSize(size + 1);
  }, [size, setSize]);

  /* ---- derived: filtered list (client-side secondary filters) ---- */
  const filteredVoices = useMemo(() => {
    let list = voices;
    // Language double-check (Fish API's language param is mostly reliable
    // but we enforce client-side too for safety)
    if (langFilter) {
      list = list.filter((v) => (v.languages ?? []).includes(langFilter));
    }
    // Gender filter (client-side only)
    if (genderFilter) {
      list = list.filter((v) => v.gender === genderFilter);
    }
    // Age filter (client-side only)
    if (ageFilter) {
      list = list.filter((v) => v.age === ageFilter);
    }
    return list;
  }, [voices, langFilter, genderFilter, ageFilter]);

  /* ---- styles ---- */
  const chipBase =
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all cursor-pointer select-none";
  const chipActive =
    "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300";
  const chipInactive =
    "border-neutral-200 bg-white text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:text-neutral-300";

  return (
    <div className="space-y-2">
      {/* Search */}
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400 text-xs">
          🔍
        </span>
        <input
          type="text"
          placeholder="搜索音色名称..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-neutral-300 bg-white py-1.5 pl-8 pr-3 text-xs placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 text-xs"
          >
            ✕
          </button>
        )}
      </div>

      {/* Filter chips row: language | gender | age */}
      <div className="space-y-1.5">
        {/* Language */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-8 shrink-0">语言</span>
          {LANGUAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value ?? "all"}
              type="button"
              className={`${chipBase} ${langFilter === opt.value ? chipActive : chipInactive}`}
              onClick={() => setLangFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Gender */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-8 shrink-0">性别</span>
          {GENDER_OPTIONS.map((opt) => (
            <button
              key={opt.value ?? "all"}
              type="button"
              className={`${chipBase} ${genderFilter === opt.value ? chipActive : chipInactive}`}
              onClick={() => setGenderFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Age */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500 w-8 shrink-0">年龄</span>
          {AGE_OPTIONS.map((opt) => (
            <button
              key={opt.value ?? "all"}
              type="button"
              className={`${chipBase} ${ageFilter === opt.value ? chipActive : chipInactive}`}
              onClick={() => setAgeFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Voice list */}
      <div
        ref={listRef}
        className="max-h-[240px] overflow-y-auto rounded-md border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800/50"
      >
        {/* Default voice option */}
        <button
          type="button"
          onClick={() => { onChange(""); setShowCustomInput(false); }}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
            value === "" && !showCustomInput
              ? "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300"
              : "text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-700/50"
          }`}
        >
          <span className="text-[10px]">✦</span>
          <span className="font-medium">Fish 默认音色</span>
          <span className="ml-auto text-[10px] text-neutral-400">不使用 Reference ID</span>
        </button>

        <div className="border-t border-neutral-100 dark:border-neutral-700" />

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-8 text-xs text-neutral-400">
            <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-500" />
            正在加载音色列表...
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="px-3 py-4 text-center text-xs text-amber-700 dark:text-amber-400">
            {error?.message || String(error)}
            <button
              type="button"
              onClick={() => void setSize(1)}
              className="ml-2 underline hover:no-underline"
            >
              重试
            </button>
          </div>
        )}

        {/* Voice items */}
        {!loading && !error && filteredVoices.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-neutral-400">
            未找到匹配的音色
          </div>
        )}

        {!loading &&
          filteredVoices.map((voice) => {
            const isSelected = value === voice.id && !showCustomInput;
            const langs = (voice.languages ?? []).map(langLabel).join(", ");
            return (
              <button
                key={voice.id}
                type="button"
                onClick={() => { onChange(voice.id); setShowCustomInput(false); }}
                className={`group flex w-full items-center gap-2 border-t border-neutral-100 px-3 py-2 text-left text-xs transition-colors dark:border-neutral-700/50 ${
                  isSelected
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300"
                    : "text-neutral-700 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-700/50"
                }`}
              >
                {voice.preview_url ? (
                  <button
                    type="button"
                    onClick={(e) => togglePlay(e, voice.id, voice.preview_url)}
                    title="试听音色"
                    className={`shrink-0 rounded p-1 text-[10px] transition-colors hover:bg-black/5 dark:hover:bg-white/10 ${
                      playingId === voice.id ? "text-blue-600 dark:text-blue-400" : "opacity-60"
                    }`}
                  >
                    {playingId === voice.id ? "⏸" : "🔊"}
                  </button>
                ) : (
                  <span className="shrink-0 p-1 text-[10px] opacity-40">🔊</span>
                )}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {voice.title}
                </span>
                {langs && (
                  <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">
                    {langs}
                  </span>
                )}
                {voice.gender && (
                  <span className={`shrink-0 text-[11px] ${genderColor(voice.gender)}`}>
                    {genderIcon(voice.gender)}
                  </span>
                )}
                {voice.age && (
                  <span className="shrink-0 rounded bg-neutral-100 px-1 py-0.5 text-[9px] text-neutral-400 dark:bg-neutral-700">
                    {ageLabel(voice.age)}
                  </span>
                )}
                {isSelected && (
                  <span className="shrink-0 text-[10px] text-blue-500">✓</span>
                )}
              </button>
            );
          })}

        {/* Load more */}
        {!loading && hasMore && (
          <div className="border-t border-neutral-100 dark:border-neutral-700">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="flex w-full items-center justify-center gap-1 py-2.5 text-[11px] text-blue-600 hover:bg-blue-50 disabled:text-neutral-400 dark:text-blue-400 dark:hover:bg-blue-900/10"
            >
              {loadingMore ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-500" />
                  加载中...
                </>
              ) : (
                "加载更多"
              )}
            </button>
          </div>
        )}
      </div>

      {/* Custom Reference ID toggle */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setShowCustomInput(!showCustomInput);
            if (!showCustomInput && value) setCustomId(value);
          }}
          className={`text-[11px] ${
            showCustomInput
              ? "text-blue-600 dark:text-blue-400"
              : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300"
          }`}
        >
          {showCustomInput ? "▾ 收起自定义 ID" : "▸ 使用自定义 Reference ID"}
        </button>
      </div>

      {showCustomInput && (
        <div className="flex gap-2">
          <input
            type="text"
            value={customId}
            onChange={(e) => setCustomId(e.target.value)}
            placeholder="粘贴 Fish reference_id"
            className="flex-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-xs placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
          />
          <button
            type="button"
            onClick={() => { if (customId.trim()) onChange(customId.trim()); }}
            disabled={!customId.trim()}
            className="shrink-0 rounded-md bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500"
          >
            确定
          </button>
        </div>
      )}

      {/* Current selection display */}
      {value && (
        <div className="rounded-md border border-dashed border-blue-200 bg-blue-50/50 px-3 py-1.5 text-[11px] text-blue-700 dark:border-blue-800 dark:bg-blue-900/10 dark:text-blue-400">
          当前音色:{" "}
          <span className="font-mono font-medium">
            {filteredVoices.find((v) => v.id === value)?.title ??
              voices.find((v) => v.id === value)?.title ??
              value}
          </span>
        </div>
      )}
    </div>
  );
}
