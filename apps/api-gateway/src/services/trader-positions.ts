import type * as schema from '@hyperdash/database';
import { traderPositions } from '@hyperdash/database';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TraderPositionRow } from './hyperliquid';

export async function replaceTraderPositions(
  db: PostgresJsDatabase<typeof schema>,
  traderId: string,
  rows: TraderPositionRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const existingPositions = await tx
      .select({
        id: traderPositions.id,
        symbol: traderPositions.symbol,
        side: traderPositions.side,
      })
      .from(traderPositions)
      .where(eq(traderPositions.traderId, traderId));

    const existingByKey = new Map(existingPositions.map((p) => [`${p.symbol}:${p.side}`, p.id]));
    const newKeys = new Set(rows.map((row) => `${row.symbol}:${row.side}`));

    for (const row of rows) {
      const key = `${row.symbol}:${row.side}`;
      const existingId = existingByKey.get(key);
      if (existingId) {
        await tx
          .update(traderPositions)
          .set(row as any)
          .where(eq(traderPositions.id, existingId));
      } else {
        await tx.insert(traderPositions).values(row as any);
      }
    }

    const staleIds = Array.from(existingByKey.entries())
      .filter(([key]) => !newKeys.has(key))
      .map(([, id]) => id);

    if (staleIds.length > 0) {
      await tx.delete(traderPositions).where(sql`${traderPositions.id} = ANY(${staleIds})`);
    }
  });
}
