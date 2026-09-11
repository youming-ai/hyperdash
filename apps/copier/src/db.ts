/**
 * Postgres access for the copier.
 *
 * Unlike the Workers apps this is a long-lived process, so a single pooled
 * client is correct here (no per-request client needed). Reads come from the
 * shared Drizzle schema; writes go to `copy_orders` / `copy_positions`, which
 * the Workers plane previously left with no writer at all.
 */

import * as schema from '@hyperdash/database/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(connectionString: string) {
  const client = postgres(connectionString, { prepare: false, max: 10 });
  const db = drizzle(client, { schema });
  return { db, client };
}

export { schema };
