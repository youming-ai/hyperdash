import { env } from 'cloudflare:workers';
import { createFileRoute } from '@tanstack/react-router';
import type { WorkerEnv } from '~/server/env';
import { app } from '~/server/hono';

// Pass the Workers env as the second arg so Hono handlers get `c.env`.
const handler = ({ request }: { request: Request }) =>
  app.fetch(request, env as unknown as WorkerEnv);

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
