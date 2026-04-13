/**
 * Type-safe API client powered by openapi-fetch.
 *
 * All request/response types are auto-generated from the backend's
 * OpenAPI schema (web/lib/gen/openapi.d.ts). Zero hand-written type
 * definitions needed.
 */
import createClient from "openapi-fetch";
import type { paths } from "./gen/openapi";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, "") ||
  "http://localhost:8100";

const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN || "";

/** Read the Fish API key from localStorage (browser only). */
function getFishKeyHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const key = window.localStorage.getItem("fish-api-key");
  return key ? { "X-Fish-Key": key } : {};
}

export const api = createClient<paths>({
  baseUrl: API_URL,
  headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {},
});

// Inject X-Fish-Key and handle auth errors via middleware
api.use({
  async onRequest({ request }) {
    const headers = getFishKeyHeader();
    for (const [k, v] of Object.entries(headers)) {
      request.headers.set(k, v);
    }
    return request;
  },
  async onResponse({ response }) {
    if (response.status === 401) {
      // Dynamically import to avoid circular deps and SSR issues
      const { toast } = await import("sonner");
      toast.error("请先配置 Fish API Key", {
        description: "点击右上角钥匙图标设置 API Key",
      });
    }
    return response;
  },
});

/** Base URL for non-openapi-fetch uses (SSE EventSource, audio URLs). */
export function getApiUrl(): string {
  return API_URL;
}
