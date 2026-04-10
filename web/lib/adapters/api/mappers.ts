/**
 * Type mappers: FastAPI Pydantic schemas -> frontend domain types.
 *
 * Backend responses use snake_case; frontend types use camelCase.
 * This module centralizes all conversion logic.
 */

import type {
  Chunk,
  ChunkStatus,
  Episode,
  EpisodeStatus,
  EpisodeSummary,
  Take,
} from "../../types";

// ---------------------------------------------------------------------------
// Raw backend response shapes (what the API actually returns)
// ---------------------------------------------------------------------------

export interface RawEpisodeSummary {
  id: string;
  title: string;
  status: EpisodeStatus;
  chunk_count: number;
  done_count: number;
  failed_count: number;
  updated_at: string;
}

export interface RawTake {
  id: string;
  chunk_id: string;
  audio_uri: string;
  duration_s: number;
  params: Record<string, unknown>;
  created_at: string;
}

export interface RawStageRun {
  chunk_id: string;
  stage: string;
  status: string;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  log_uri: string | null;
  prefect_task_run_id: string | null;
  stale: boolean;
}

export interface RawChunkDetail {
  id: string;
  episode_id: string;
  shot_id: string;
  idx: number;
  text: string;
  text_normalized: string;
  subtitle_text: string | null;
  status: ChunkStatus;
  selected_take_id: string | null;
  boundary_hash: string | null;
  char_count: number;
  last_edited_at: string | null;
  extra_metadata: Record<string, unknown>;
  takes: RawTake[];
  stage_runs: RawStageRun[];
}

export interface RawEpisodeDetail {
  id: string;
  title: string;
  description: string | null;
  status: EpisodeStatus;
  script_uri: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  extra_metadata: Record<string, unknown>;
  chunks: RawChunkDetail[];
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapTake(raw: RawTake): Take {
  return {
    id: raw.id,
    file: raw.audio_uri,
    durationS: raw.duration_s,
    createdAt: raw.created_at,
    params: raw.params,
  };
}

export function mapChunk(raw: RawChunkDetail): Chunk {
  return {
    id: raw.id,
    shotId: raw.shot_id,
    index: raw.idx,
    text: raw.text,
    textNormalized: raw.text_normalized,
    subtitleText: raw.subtitle_text,
    status: raw.status,
    takes: raw.takes.map(mapTake),
    selectedTakeId: raw.selected_take_id,
    charCount: raw.char_count,
    boundaryHash: raw.boundary_hash ?? undefined,
    metadata: raw.extra_metadata ?? {},
  };
}

/** Infer current stage from stage_runs across all chunks. */
function inferCurrentStage(chunks: RawChunkDetail[]): string | null {
  // Find any currently running stage
  for (const c of chunks) {
    for (const sr of c.stage_runs) {
      if (sr.status === "running") {
        return sr.stage.toUpperCase();
      }
    }
  }
  return null;
}

export function mapEpisodeDetail(raw: RawEpisodeDetail): Episode {
  const chunks = raw.chunks.map(mapChunk);
  const totalDurationS = chunks.reduce((sum, c) => {
    const selectedTake = c.takes.find((t) => t.id === c.selectedTakeId);
    return sum + (selectedTake?.durationS ?? 0);
  }, 0);

  return {
    id: raw.id,
    status: raw.status,
    currentStage: inferCurrentStage(raw.chunks),
    chunks,
    totalDurationS,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    metadata: raw.extra_metadata ?? {},
    scriptTitle: raw.title,
    scriptDescription: raw.description ?? undefined,
  };
}

export function mapEpisodeSummary(raw: RawEpisodeSummary): EpisodeSummary {
  return {
    id: raw.id,
    status: raw.status,
    currentStage: null,
    chunkCount: raw.chunk_count,
    updatedAt: raw.updated_at,
    metadata: {
      title: raw.title,
      doneCount: raw.done_count,
      failedCount: raw.failed_count,
    },
  };
}
