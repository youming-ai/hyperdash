import { hc } from 'hono/client';
import type { AppType } from '~/server/hono';

// FE/BE split: when VITE_BE_URL (public) or BE_URL (server) is set, FE
// calls the standalone BE Worker directly. Otherwise falls back to same-origin
// `/api` (FE+BE co-located, local dev). `import type` keeps server AppType out
// of the client bundle — shape is erased at build time.
const beUrl =
  (typeof window !== 'undefined'
    ? import.meta.env.VITE_BE_URL
    : (import.meta.env.VITE_BE_URL ?? '')
  )?.replace(/\/$/, '') ?? '';

const baseUrl =
  beUrl ||
  (typeof window !== 'undefined'
    ? window.location.origin
    : (import.meta.env.VITE_PUBLIC_ORIGIN ?? 'http://localhost:5173'));

export const api = hc<AppType>(baseUrl).api;

/** Base origin of the API (BE Worker when split, otherwise same-origin). */
export const apiBaseUrl = baseUrl;
export const beBaseUrl = beUrl;

/** A failed API call. Carries the status so callers can branch on 401/404. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * The minimal response surface `readJson` needs.
 *
 * Deliberately narrower than `Response`: Hono's typed client returns a
 * `ClientResponse` union whose error branch lacks the `webSocket`/`cf`/
 * `textStream` members that the Workers type definitions add to `Response`,
 * so accepting a full `Response` rejects every Hono call site.
 */
export type JsonResponse = Pick<Response, 'ok' | 'status' | 'text' | 'json'>;

/**
 * Read a JSON body, throwing on a non-2xx response.
 *
 * Every query must go through this: resolving a failure into an empty payload
 * makes `isError` unreachable, so an outage renders as a legitimate empty
 * state — the most misleading bug class in a trading UI.
 */
export async function readJson<T>(res: JsonResponse, label: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* body already consumed or unreadable — the status is enough */
    }
    throw new ApiError(
      `${label} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}
