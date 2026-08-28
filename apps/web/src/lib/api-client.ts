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
export const beBaseUrl = beUrl;
