/**
 * ChunkStore implementation backed by FastAPI REST API.
 */

import type {
  Chunk,
  ChunkId,
  EditBatch,
  EpisodeId,
  Take,
  TakeId,
} from "../../types";
import type { ChunkStore } from "../../ports/store";
import { apiGet, apiPost } from "./http-client";
import type { RawEpisodeDetail } from "./mappers";
import { mapChunk } from "./mappers";

export class ApiChunkStore implements ChunkStore {
  async get(epId: EpisodeId, cid: ChunkId): Promise<Chunk | null> {
    // No dedicated chunk endpoint — fetch episode detail and filter
    try {
      const raw = await apiGet<RawEpisodeDetail>(
        `/episodes/${encodeURIComponent(epId)}`,
      );
      const rawChunk = raw.chunks.find((c) => c.id === cid);
      return rawChunk ? mapChunk(rawChunk) : null;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status: number }).status === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  async applyEdits(epId: EpisodeId, edits: EditBatch): Promise<void> {
    // Backend has per-chunk edit endpoint; call sequentially
    const entries = Object.entries(edits);
    for (const [cid, edit] of entries) {
      const body: Record<string, unknown> = {};
      if (edit.textNormalized !== undefined) {
        body.text_normalized = edit.textNormalized;
      }
      if (edit.subtitleText !== undefined) {
        body.subtitle_text = edit.subtitleText;
      }
      await apiPost(
        `/episodes/${encodeURIComponent(epId)}/chunks/${encodeURIComponent(cid)}/edit`,
        body,
      );
    }
  }

  async appendTake(
    _epId: EpisodeId,
    _cid: ChunkId,
    _take: Take,
  ): Promise<void> {
    throw new Error("not implemented: appendTake — use pipeline runner retry");
  }

  async selectTake(
    _epId: EpisodeId,
    _cid: ChunkId,
    _takeId: TakeId,
  ): Promise<void> {
    throw new Error(
      "not implemented: selectTake — use pipeline runner finalizeTake",
    );
  }

  async removeTake(
    _epId: EpisodeId,
    _cid: ChunkId,
    _takeId: TakeId,
  ): Promise<void> {
    throw new Error("not implemented: removeTake — no backend route yet");
  }
}
