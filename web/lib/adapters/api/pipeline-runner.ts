/**
 * PipelineRunner implementation backed by FastAPI REST API.
 */

import type {
  ChunkId,
  EditBatch,
  EpisodeId,
  JobId,
  JobStatus,
  OperationResult,
} from "../../types";
import type { PipelineRunner } from "../../ports/runner";
import { apiPost } from "./http-client";
import { ApiChunkStore } from "./chunk-store";

interface RunResponse {
  flow_run_id: string;
}

interface RetryResponse {
  flow_run_id: string;
}

interface FinalizeResponse {
  flow_run_id: string;
}

function toOperationResult(flowRunId: string): OperationResult {
  return {
    jobId: flowRunId,
    startedAt: new Date().toISOString(),
  };
}

export class ApiPipelineRunner implements PipelineRunner {
  async runFull(
    epId: EpisodeId,
    _options?: { mode?: "fresh" | "text-only"; force?: boolean },
  ): Promise<OperationResult> {
    const res = await apiPost<RunResponse>(
      `/episodes/${encodeURIComponent(epId)}/run`,
    );
    return toOperationResult(res.flow_run_id);
  }

  async applyEdits(
    epId: EpisodeId,
    edits: EditBatch,
  ): Promise<OperationResult> {
    // 1. Apply the text edits via chunk store
    const chunkStore = new ApiChunkStore();
    await chunkStore.applyEdits(epId, edits);

    // 2. Retry from p2 for each edited chunk that has textNormalized changes
    const entries = Object.entries(edits);
    let lastResult: OperationResult | null = null;
    for (const [cid, edit] of entries) {
      const fromStage = edit.textNormalized !== undefined ? "p2" : "p5";
      const res = await apiPost<RetryResponse>(
        `/episodes/${encodeURIComponent(epId)}/chunks/${encodeURIComponent(cid)}/retry`,
        { from_stage: fromStage, cascade: true },
      );
      lastResult = toOperationResult(res.flow_run_id);
    }

    return lastResult ?? { jobId: "noop", startedAt: new Date().toISOString() };
  }

  async retryChunk(
    epId: EpisodeId,
    cid: ChunkId,
    _options: { count: number; params?: Record<string, unknown> },
  ): Promise<OperationResult> {
    const res = await apiPost<RetryResponse>(
      `/episodes/${encodeURIComponent(epId)}/chunks/${encodeURIComponent(cid)}/retry`,
      { from_stage: "p2", cascade: true },
    );
    return toOperationResult(res.flow_run_id);
  }

  async finalizeTake(
    epId: EpisodeId,
    cid: ChunkId,
  ): Promise<OperationResult> {
    const res = await apiPost<FinalizeResponse>(
      `/episodes/${encodeURIComponent(epId)}/chunks/${encodeURIComponent(cid)}/finalize-take`,
    );
    return toOperationResult(res.flow_run_id);
  }

  async cancel(_jobId: JobId): Promise<void> {
    throw new Error("not implemented: cancel — no backend route yet");
  }

  async getJobStatus(_jobId: JobId): Promise<JobStatus> {
    throw new Error("not implemented: getJobStatus — no backend route yet");
  }
}
