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
  "http://localhost:8000";

const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN || "";

export const api = createClient<paths>({
  baseUrl: API_URL,
  headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {},
});

/** Base URL for non-openapi-fetch uses (SSE EventSource, audio URLs). */
export function getApiUrl(): string {
  return API_URL;
}
