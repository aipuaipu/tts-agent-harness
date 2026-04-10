/**
 * Observability adapters backed by FastAPI REST API.
 *
 * Implements ProgressSource and LogTailer ports.
 */

import type { EpisodeId } from "../../types";
import type { LogTailer, ProgressSource } from "../../ports/observability";
import { apiGet } from "./http-client";
import type { RawEpisodeDetail } from "./mappers";

export class ApiProgressSource implements ProgressSource {
  async getCurrentStage(epId: EpisodeId): Promise<string | null> {
    try {
      const raw = await apiGet<RawEpisodeDetail>(
        `/episodes/${encodeURIComponent(epId)}`,
      );
      // Find any running stage across chunks
      for (const c of raw.chunks) {
        for (const sr of c.stage_runs) {
          if (sr.status === "running") {
            return sr.stage.toUpperCase();
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async isRunning(epId: EpisodeId): Promise<boolean> {
    try {
      const raw = await apiGet<RawEpisodeDetail>(
        `/episodes/${encodeURIComponent(epId)}`,
      );
      return raw.status === "running";
    } catch {
      return false;
    }
  }
}

export class ApiLogTailer implements LogTailer {
  async tail(_epId: EpisodeId, _lines: number): Promise<string[]> {
    // No backend route for log tailing yet — return empty
    return [];
  }

  async clear(_epId: EpisodeId): Promise<void> {
    // No backend route yet
  }
}
