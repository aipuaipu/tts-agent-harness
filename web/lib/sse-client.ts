/**
 * SSE client — EventSource wrapper for real-time episode updates.
 *
 * Connects to GET /episodes/{id}/stream on the FastAPI backend.
 * Event type: "stage_event" with JSON data payload.
 * Auto-reconnects via native EventSource behavior.
 */

import { getApiUrl } from "./api-client";

export interface StageEventData {
  id: number;
  episode_id: string;
  chunk_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string | null;
}

export interface SSEConnection {
  close(): void;
}

/**
 * Connect to the SSE stream for an episode.
 *
 * @param epId - Episode ID to subscribe to
 * @param onEvent - Callback for each stage_event
 * @param onError - Optional error callback
 * @returns SSEConnection with a close() method
 */
export function connectSSE(
  epId: string,
  onEvent: (event: StageEventData) => void,
  onError?: (error: Event) => void,
): SSEConnection {
  const url = `${getApiUrl()}/episodes/${encodeURIComponent(epId)}/stream`;
  const source = new EventSource(url);

  source.addEventListener("stage_event", (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as StageEventData;
      onEvent(data);
    } catch {
      // Ignore malformed events
    }
  });

  if (onError) {
    source.onerror = onError;
  }

  return {
    close() {
      source.close();
    },
  };
}
