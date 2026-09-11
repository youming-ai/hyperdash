import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { siwe } from 'better-auth/plugins';

/**
 * Static Better Auth config used ONLY by `better-auth generate` to emit the
 * Drizzle schema (`bun run auth:generate`). Mirrors the runtime plugins in
 * `src/lib/auth.ts` so the generated tables (incl. SIWE `walletAddress`) match.
 */
export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: 'pg' }),
  plugins: [
    siwe({
      domain: 'localhost',
      getNonce: async () => '',
      verifyMessage: async () => true,
    }),
  ],
});
