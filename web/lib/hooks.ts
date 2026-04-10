"use client";

import { useEffect } from "react";
import useSWR from "swr";
import type { Episode, EpisodeSummary, ChunkEdit } from "./types";
import {
  fixtureEpisodeSummaries,
  fixtureEpisodes,
  fixtureLogTail,
} from "./__fixtures__/ch04";
import { apiGet, apiPost, apiPostForm, getApiUrl } from "./adapters/api/http-client";
import type { RawEpisodeDetail, RawEpisodeSummary } from "./adapters/api/mappers";
import { mapEpisodeDetail, mapEpisodeSummary } from "./adapters/api/mappers";
import { connectSSE } from "./sse-client";
import type { StageEventData } from "./sse-client";

const USE_FIXTURES = process.env.NEXT_PUBLIC_USE_FIXTURES === "1";

// ---------------------------------------------------------------------------
// SWR fetcher — calls FastAPI directly
// ---------------------------------------------------------------------------

const episodeListFetcher = async (): Promise<EpisodeListResponse> => {
  const raw = await apiGet<RawEpisodeSummary[]>("/episodes");
  return { episodes: raw.map(mapEpisodeSummary) };
};

const episodeDetailFetcher = async (
  id: string,
): Promise<EpisodeDetailResponse> => {
  const raw = await apiGet<RawEpisodeDetail>(
    `/episodes/${encodeURIComponent(id)}`,
  );
  const episode = mapEpisodeDetail(raw);
  return {
    episode,
    logTail: [],
    running: raw.status === "running",
    currentStage: episode.currentStage,
  };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpisodeDetailResponse {
  episode: Episode;
  logTail: string[];
  running: boolean;
  currentStage: string | null;
}

export interface EpisodeListResponse {
  episodes: EpisodeSummary[];
}

interface HookResult<T> {
  data: T | null | undefined;
  error: Error | null;
  isLoading: boolean;
  mutate: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useEpisodes(): HookResult<EpisodeListResponse> {
  const swr = useSWR<EpisodeListResponse>(
    USE_FIXTURES ? null : "api:episodes",
    () => episodeListFetcher(),
  );
  if (USE_FIXTURES) {
    return {
      data: { episodes: fixtureEpisodeSummaries },
      error: null,
      isLoading: false,
      mutate: async () => undefined,
    };
  }
  return {
    data: swr.data,
    error: (swr.error as Error) ?? null,
    isLoading: swr.isLoading,
    mutate: swr.mutate,
  };
}

export function useEpisode(
  id: string | null,
): HookResult<EpisodeDetailResponse> {
  const swr = useSWR<EpisodeDetailResponse>(
    USE_FIXTURES || !id ? null : `api:episode:${id}`,
    () => episodeDetailFetcher(id!),
    {
      refreshInterval: (data) => (data?.running ? 2000 : 0),
    },
  );

  // SSE real-time updates — connect when viewing an episode
  const mutate = swr.mutate;
  useEffect(() => {
    if (USE_FIXTURES || !id) return;

    const conn = connectSSE(
      id,
      (_event: StageEventData) => {
        // On any stage event, re-fetch the episode data to get latest state
        mutate();
      },
      () => {
        // On SSE error, silently ignore — SWR polling is the fallback
      },
    );

    return () => conn.close();
  }, [id, mutate]);

  if (USE_FIXTURES) {
    if (!id) {
      return {
        data: null,
        error: null,
        isLoading: false,
        mutate: async () => undefined,
      };
    }
    const ep = fixtureEpisodes[id];
    if (!ep) {
      return {
        data: null,
        error: new Error("not found"),
        isLoading: false,
        mutate: async () => undefined,
      };
    }
    return {
      data: {
        episode: ep,
        logTail: fixtureLogTail.split("\n"),
        running: false,
        currentStage: null,
      },
      error: null,
      isLoading: false,
      mutate: async () => undefined,
    };
  }
  return {
    data: swr.data,
    error: (swr.error as Error) ?? null,
    isLoading: swr.isLoading,
    mutate: swr.mutate,
  };
}

// ============================================================
// Mutations — call FastAPI directly
// ============================================================

export async function runEpisode(id: string) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, 1500));
    return { jobId: "fake", startedAt: new Date().toISOString() };
  }
  const res = await apiPost<{ flow_run_id: string }>(
    `/episodes/${encodeURIComponent(id)}/run`,
  );
  return { jobId: res.flow_run_id, startedAt: new Date().toISOString() };
}

export async function applyEdits(
  id: string,
  edits: Record<string, ChunkEdit>,
) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, 1500));
    return { jobId: "fake", startedAt: new Date().toISOString() };
  }
  // Apply edits per-chunk then retry
  const entries = Object.entries(edits);
  let lastFlowRunId = "noop";
  for (const [cid, edit] of entries) {
    // 1. Edit the chunk text
    const body: Record<string, unknown> = {};
    if (edit.textNormalized !== undefined) body.text_normalized = edit.textNormalized;
    if (edit.subtitleText !== undefined) body.subtitle_text = edit.subtitleText;
    await apiPost(
      `/episodes/${encodeURIComponent(id)}/chunks/${encodeURIComponent(cid)}/edit`,
      body,
    );

    // 2. Trigger retry from appropriate stage
    const fromStage = edit.textNormalized !== undefined ? "p2" : "p5";
    const res = await apiPost<{ flow_run_id: string }>(
      `/episodes/${encodeURIComponent(id)}/chunks/${encodeURIComponent(cid)}/retry`,
      { from_stage: fromStage, cascade: true },
    );
    lastFlowRunId = res.flow_run_id;
  }
  return { jobId: lastFlowRunId, startedAt: new Date().toISOString() };
}

export async function retryChunk(id: string, cid: string, count: number) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, count * 800));
    return { jobId: "fake", startedAt: new Date().toISOString() };
  }
  const res = await apiPost<{ flow_run_id: string }>(
    `/episodes/${encodeURIComponent(id)}/chunks/${encodeURIComponent(cid)}/retry`,
    { from_stage: "p2", cascade: true },
  );
  return { jobId: res.flow_run_id, startedAt: new Date().toISOString() };
}

export async function exportEpisode(id: string, targetDir: string) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, 500));
    return { filesCopied: 8, totalBytes: 0 };
  }
  // No direct export endpoint on FastAPI yet — throw informative error
  throw new Error("Export not yet available via API backend");
}

export async function createEpisode(id: string, file: File) {
  if (USE_FIXTURES) {
    await new Promise((r) => setTimeout(r, 500));
    return { id, status: "ready" };
  }
  const fd = new FormData();
  fd.append("id", id);
  fd.append("script", file);
  const raw = await apiPostForm<RawEpisodeDetail>("/episodes", fd);
  return { id: raw.id, status: raw.status };
}

// audio URL helper
export function getAudioUrl(
  epId: string,
  cid: string,
  takeId: string,
): string {
  if (USE_FIXTURES) return "";
  // In API mode, audio files are stored in MinIO.
  // The FastAPI backend would serve them or provide presigned URLs.
  // For now, construct a URL that could be proxied.
  return `${getApiUrl()}/episodes/${encodeURIComponent(epId)}/chunks/${encodeURIComponent(cid)}/audio/${encodeURIComponent(takeId)}`;
}
