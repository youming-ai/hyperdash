import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { siwe } from 'better-auth/plugins';
import { verifyMessage } from 'viem';
import { generateSiweNonce } from 'viem/siwe';
import type { Db } from '~/db';
import type { WorkerEnv } from '~/server/env';

/**
 * Build a Better Auth instance (Sign-In With Ethereum) from the request-scoped
 * DB + Worker bindings. This app is wallet-identity based, so SIWE is the sole
 * auth method; the wallet address is mirrored into the business `users` table
 * (see `~/server/user`). Bindings only exist at request time, so this is a
 * factory — never a module-level singleton.
 */
export function createAuth(db: Db, env: WorkerEnv) {
  const host = new URL(env.PUBLIC_ORIGIN).host;
  const hostname = new URL(env.PUBLIC_ORIGIN).hostname;
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg' }),
    secondaryStorage: {
      get: (key) => env.KV.get(key),
      set: (key, value, ttl) => env.KV.put(key, value, ttl ? { expirationTtl: ttl } : undefined),
      delete: (key) => env.KV.delete(key),
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.PUBLIC_ORIGIN,
    plugins: [
      siwe({
        domain: host,
        emailDomainName: hostname,
        getNonce: async () => generateSiweNonce(),
        verifyMessage: async ({ message, signature, address }) =>
          verifyMessage({
            address: address as `0x${string}`,
            message,
            signature: signature as `0x${string}`,
          }),
      }),
    ],
  });
}
