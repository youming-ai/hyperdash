import { hc } from 'hono/client';
import type { AppType } from '~/server/hono';

// `import type` keeps the server app (db/auth/postgres) out of the client bundle;
// the AppType shape is erased at build time. `.api` matches the Hono `basePath`,
// so callers use `api.traders.$get(...)` rather than `api.api.traders`.
const baseUrl =
  typeof window !== 'undefined'
    ? window.location.origin
    : (import.meta.env.VITE_PUBLIC_ORIGIN ?? 'http://localhost:5173');

export const api = hc<AppType>(baseUrl).api;
