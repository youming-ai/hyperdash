import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { createDb } from '~/db';
import { createAuth } from '~/lib/auth';
import { withSession } from '~/server/middleware/auth';
import { analyticsRouter } from '~/server/routers/analytics';
import { marketRouter } from '~/server/routers/market';
import { strategiesRouter } from '~/server/routers/strategies';
import { systemRouter } from '~/server/routers/system';
import { tradersRouter } from '~/server/routers/traders';
import { userRouter } from '~/server/routers/user';
import type { AppEnv } from '~/server/types';

// KV-backed fixed-window limiter. Approximate (KV is eventually consistent);
// for hard per-key limits use a Durable Object or the rate-limiting binding.
async function rateLimit(
  kv: KVNamespace,
  keyPrefix: string,
  limit = 20,
  windowSec = 900,
): Promise<boolean> {
  const windowId = Math.floor(Date.now() / 1000 / windowSec);
  const key = `${keyPrefix}:${windowId}`;
  const n = Number((await kv.get(key)) ?? 0) + 1;
  await kv.put(key, String(n), { expirationTtl: windowSec * 2 });
  return n <= limit;
}

export const app = new Hono<AppEnv>()
  .basePath('/api')
  .use('*', secureHeaders())
  .use('*', (c, next) => cors({ origin: c.env.PUBLIC_ORIGIN, credentials: true })(c, next))
  // Request-scoped Drizzle client from the Hyperdrive binding.
  .use('*', async (c, next) => {
    c.set('db', createDb(c.env.HYPERDRIVE.connectionString));
    await next();
  })
  // Rate-limit auth (SIWE nonce/verify) by client IP.
  .use('/auth/*', async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') ?? 'anon';
    if (!(await rateLimit(c.env.KV, `rate-limit:${ip}:${c.req.path}`))) {
      return c.text('Too many requests', 429);
    }
    await next();
  })
  // Better Auth (SIWE) handler.
  .on(['GET', 'POST'], '/auth/*', (c) => createAuth(c.get('db'), c.env).handler(c.req.raw))
  // Populate session for business routers below.
  .use('*', withSession)
  .route('/traders', tradersRouter)
  .route('/strategies', strategiesRouter)
  .route('/market', marketRouter)
  .route('/user', userRouter)
  .route('/analytics', analyticsRouter)
  .route('/system', systemRouter);

export type AppType = typeof app;
