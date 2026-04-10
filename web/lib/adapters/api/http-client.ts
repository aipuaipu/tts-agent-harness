/**
 * Fetch wrapper for FastAPI backend.
 *
 * - Base URL from NEXT_PUBLIC_API_URL (default http://localhost:8000)
 * - Optional Bearer token from NEXT_PUBLIC_API_TOKEN
 * - Unified error handling: 4xx/5xx -> throw with error body
 * - JSON and multipart content types
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, "") ||
  "http://localhost:8000";

const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN || "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    const msg =
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as Record<string, unknown>).detail)
        : `HTTP ${status}`;
    super(msg);
    this.name = "ApiError";
  }
}

async function handleResponse(res: Response): Promise<unknown> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    throw new ApiError(res.status, body);
  }
  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (API_TOKEN) {
    h["Authorization"] = `Bearer ${API_TOKEN}`;
  }
  return h;
}

/** GET JSON */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "GET",
    headers: headers(),
  });
  return handleResponse(res) as Promise<T>;
}

/** POST JSON */
export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse(res) as Promise<T>;
}

/** POST multipart/form-data */
export async function apiPostForm<T = unknown>(
  path: string,
  formData: FormData,
): Promise<T> {
  // Don't set Content-Type — browser sets boundary automatically
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: formData,
  });
  return handleResponse(res) as Promise<T>;
}

/** DELETE */
export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "DELETE",
    headers: headers(),
  });
  return handleResponse(res) as Promise<T>;
}

/** Get the base API URL (for SSE EventSource etc.) */
export function getApiUrl(): string {
  return API_URL;
}

/** Get the auth token (for SSE if needed) */
export function getApiToken(): string {
  return API_TOKEN;
}
