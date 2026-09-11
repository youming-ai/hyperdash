/// <reference types="@cloudflare/workers-types" />

/**
 * Worker bindings + secrets, available only at request time via `c.env`.
 *
 * - Bindings (`HYPERDRIVE`, `KV`) come from `wrangler.toml`.
 * - Secrets are set with `wrangler secret put NAME` (never committed).
 * - `process.env` is empty on Workers; always read config from here.
 */
export interface WorkerEnv {
  HYPERDRIVE: Hyperdrive;
  KV: KVNamespace;
  BETTER_AUTH_SECRET: string;
  PUBLIC_ORIGIN: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  SENTRY_DSN?: string;
  HYPERLIQUID_API_URL: string;
  OPENAI_API_KEY?: string;
  LOG_LEVEL?: string;
}
