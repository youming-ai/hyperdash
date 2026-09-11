import { users } from '@hyperdash/database/schema';
import { eq } from 'drizzle-orm';
import type { Db } from '~/db';

/**
 * Resolve the business `users.id` (uuid) for a wallet address, creating the row
 * on first use. Better Auth owns the auth `user` table (text id, keyed by
 * wallet); business tables (`copy_strategies.user_id`, ...) reference this uuid.
 * This bridge maps between them.
 */
export async function resolveBusinessUserId(db: Db, walletAddress: string): Promise<string> {
  const wallet = walletAddress.toLowerCase();

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.walletAddress, wallet))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const [created] = await db
    .insert(users)
    .values({ walletAddress: wallet })
    .onConflictDoNothing()
    .returning({ id: users.id });

  if (created) return created.id;

  // Lost an insert race; re-read.
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.walletAddress, wallet))
    .limit(1);
  return row.id;
}
