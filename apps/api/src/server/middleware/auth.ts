import { sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createAuth } from '~/lib/auth';
import type { AppEnv } from '~/server/types';

/**
 * Populate `c.var.session` from the Better Auth (SIWE) session cookie.
 *
 * SIWE stores the wallet in a dedicated `wallet_address` table keyed by the
 * auth user id, so the wallet is resolved from the TRUSTED session user id —
 * never from a request-supplied address. Raw SQL is used here to sidestep a
 * duplicated-drizzle-instance type identity clash on the auth-schema tables.
 */
export const withSession = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get('db');
  const auth = createAuth(db, c.env);
  const result = await auth.api.getSession({ headers: c.req.raw.headers });

  if (result?.user) {
    const rows = await db.execute(
      sql`SELECT address FROM wallet_address WHERE user_id = ${result.user.id} ORDER BY is_primary DESC LIMIT 1`,
    );
    const first = rows[0] as { address?: unknown } | undefined;
    const wallet =
      first?.address !== undefined && first.address !== null ? String(first.address) : undefined;
    c.set(
      'session',
      wallet ? { walletAddress: wallet.toLowerCase(), authUserId: result.user.id } : null,
    );
  } else {
    c.set('session', null);
  }

  await next();
});

/**
 * Require an authenticated SIWE session; otherwise respond 401.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('session')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});
