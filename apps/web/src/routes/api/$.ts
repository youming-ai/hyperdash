import { env } from 'cloudflare:workers';
import { createFileRoute } from '@tanstack/react-router';
import type { WorkerEnv } from '~/server/env';
import { app } from '~/server/hono';

// FE/BE split: when BE_URL is set, FE Worker proxies /api to the standalone
// BE Worker (high-performance separation). Otherwise handles locally (co-located).
const handler = async ({ request }: { request: Request }) => {
  const beUrl = (env as unknown as WorkerEnv).BE_URL?.replace(/\/$/, '');
  if (beUrl) {
    const url = new URL(request.url);
    const target = `${beUrl}${url.pathname}${url.search}`;
    const proxied = new Request(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // @ts-expect-error — duplex required for streaming bodies on Workers
      duplex: 'half',
    });
    return fetch(proxied);
  }
  return app.fetch(request, env as unknown as WorkerEnv);
};
export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
      PUT: handler,
      DELETE: handler,
      PATCH: handler,
    },
  },
});
