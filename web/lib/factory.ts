/**
 * Service factory — sole place adapters are wired.
 *
 * Now uses API adapters that call FastAPI (:8000) directly.
 * Legacy adapters are preserved in adapters/legacy/ but not imported.
 *
 * Route Handlers still call getServices(); the API adapter implementations
 * will forward to FastAPI, making the Route Handlers thin proxies.
 */

import type {
  AudioService,
  ChunkStore,
  EpisodeStore,
  ExportResult,
  ExportService,
  LockManager,
  LogTailer,
  PipelineRunner,
  PreviewService,
  ProgressSource,
} from "./ports";

import {
  ApiChunkStore,
  ApiEpisodeStore,
  ApiLogTailer,
  ApiPipelineRunner,
  ApiProgressSource,
} from "./adapters/api";

// ---------------------------------------------------------------------------
// Stub implementations for ports with no backend API yet
// ---------------------------------------------------------------------------

class StubLockManager implements LockManager {
  async acquire() {
    return { release: async () => {} };
  }
  async isBusy() {
    return false;
  }
  async list() {
    return [];
  }
}

class StubAudioService implements AudioService {
  async getTakeFile(): Promise<string> {
    throw new Error("not implemented: audio files are served from MinIO");
  }
  async getShotFile(): Promise<string> {
    throw new Error("not implemented: audio files are served from MinIO");
  }
}

class StubPreviewService implements PreviewService {
  async getPreviewFile(): Promise<string> {
    throw new Error("not implemented: preview served from FastAPI");
  }
}

class StubExportService implements ExportService {
  async exportTo(): Promise<ExportResult> {
    throw new Error("not implemented: export via FastAPI");
  }
}

// ---------------------------------------------------------------------------
// Services interface & factory
// ---------------------------------------------------------------------------

export interface Services {
  episodes: EpisodeStore;
  chunks: ChunkStore;
  runner: PipelineRunner;
  locks: LockManager;
  progress: ProgressSource;
  logs: LogTailer;
  audio: AudioService;
  preview: PreviewService;
  export: ExportService;
}

let _services: Services | null = null;

/** Singleton accessor — all Route Handlers use this. */
export function getServices(): Services {
  if (_services) return _services;

  const episodes = new ApiEpisodeStore();
  const chunks = new ApiChunkStore();
  const runner = new ApiPipelineRunner();
  const locks = new StubLockManager();
  const progress = new ApiProgressSource();
  const logs = new ApiLogTailer();
  const audio = new StubAudioService();
  const preview = new StubPreviewService();
  const exportSvc = new StubExportService();

  const services: Services = {
    episodes,
    chunks,
    runner,
    locks,
    progress,
    logs,
    audio,
    preview,
    export: exportSvc,
  };

  _services = services;
  return services;
}

/** Test helper — replace or reset the singleton. */
export function _resetServices(services?: Services): void {
  _services = services ?? null;
}
