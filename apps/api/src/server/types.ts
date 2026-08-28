import type { Db } from '~/db';
import type { WorkerEnv } from '~/server/env';

export interface SessionContext {
  /** Lower-cased wallet address from the SIWE session. */
  walletAddress: string;
  /** Better Auth user id (text). Business rows key off the uuid in `users`. */
  authUserId: string;
}

/** Shared Hono generics for every router: request-scoped bindings + variables. */
export interface AppEnv {
  Bindings: WorkerEnv;
  Variables: {
    db: Db;
    session: SessionContext | null;
  };
}
