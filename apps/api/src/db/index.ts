import * as schema from '@hyperdash/database/schema';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;

/**
 * Build a Drizzle client from a connection string.
 *
 * On Workers the string comes from `env.HYPERDRIVE.connectionString`; in dev
 * from the Hyperdrive `localConnectionString`. Bindings only exist at request
 * time, so this MUST be called per request — never at module scope.
 */
export function createDb(connectionString: string): Db {
  const client = postgres(connectionString, { prepare: false, max: 5 });
  return drizzle(client, { schema });
}

export { schema };
