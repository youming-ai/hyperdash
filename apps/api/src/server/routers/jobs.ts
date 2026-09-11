import { zValidator } from '@hono/zod-validator';
import { traderPositions, traderStats, traderTrades } from '@hyperdash/database/schema';
import {
  assetPositionToTraderPositionRow,
  calculateTraderStats,
  fillToTraderTradeRow,
  type HyperliquidAssetPosition,
  type HyperliquidClearinghouseState,
  type HyperliquidFill,
  hyperliquidRequest,
} from '@hyperdash/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '~/db';
import type { AppEnv } from '~/server/types';

const whaleDiscoveryBody = z.object({
  addresses: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .min(1)
    .max(50),
});

async function ingestAddress(
  db: Db,
  address: string,
  apiUrl: string,
  mids: Record<string, string>,
): Promise<boolean> {
  try {
    const [fills, state] = await Promise.all([
      hyperliquidRequest<HyperliquidFill[]>(apiUrl, { type: 'userFills', user: address }).catch(
        () => [] as HyperliquidFill[],
      ),
      hyperliquidRequest<HyperliquidClearinghouseState>(apiUrl, {
        type: 'clearinghouseState',
        user: address,
      }).catch(() => null),
    ]);

    const stats = calculateTraderStats(fills, state, address);
    if (!stats) return false;

    const [existing] = await db
      .select({ id: traderStats.id, traderId: traderStats.traderId })
      .from(traderStats)
      .where(eq(traderStats.address, address))
      .limit(1);

    const traderId = existing?.traderId ?? crypto.randomUUID();

    const statsData = {
      traderId,
      address,
      equityUsd: stats.equity.toString(),
      pnl7d: stats.pnl7d.toFixed(2),
      pnl30d: stats.pnl30d.toFixed(2),
      pnlAll: stats.pnlAllTime.toFixed(2),
      winrate: stats.winRate.toFixed(2),
      totalTrades: stats.totalTrades,
      winningTrades: stats.winningTrades,
      losingTrades: stats.losingTrades,
      lastTradeAt: stats.lastTradeAt ? new Date(stats.lastTradeAt) : null,
      updatedAt: new Date(),
    };

    if (existing) {
      await db.update(traderStats).set(statsData).where(eq(traderStats.address, address));
    } else {
      await db.insert(traderStats).values({
        ...statsData,
        firstTradeAt: stats.lastTradeAt ? new Date(stats.lastTradeAt) : null,
        createdAt: new Date(),
      });
    }

    if (fills.length > 0) {
      for (const fill of fills.slice(0, 50)) {
        const row = fillToTraderTradeRow(fill, traderId, address);
        const [existingTrade] = await db
          .select({ id: traderTrades.id })
          .from(traderTrades)
          .where(
            and(
              eq(traderTrades.traderId, traderId),
              eq(traderTrades.exchangeTradeId, row.exchangeTradeId),
            ),
          )
          .limit(1);

        if (!existingTrade) {
          await db.insert(traderTrades).values(row);
        }
      }
    }

    if (state?.assetPositions) {
      const activePositions = state.assetPositions.filter(
        (p: HyperliquidAssetPosition) => Number(p.position.szi) !== 0,
      );
      const rows = activePositions.map((p: HyperliquidAssetPosition) =>
        assetPositionToTraderPositionRow(
          p,
          traderId,
          address,
          mids[p.position.coin] ?? p.position.entryPx,
        ),
      );

      await db.transaction(async (tx) => {
        const existingPositions = await tx
          .select({
            id: traderPositions.id,
            symbol: traderPositions.symbol,
            side: traderPositions.side,
          })
          .from(traderPositions)
          .where(eq(traderPositions.traderId, traderId));

        const existingByKey = new Map(
          existingPositions.map((p) => [`${p.symbol}:${p.side}`, p.id]),
        );
        const newKeys = new Set(
          rows.map((r: { symbol: string; side: string }) => `${r.symbol}:${r.side}`),
        );

        for (const row of rows) {
          const key = `${row.symbol}:${row.side}`;
          const existingId = existingByKey.get(key);
          if (existingId) {
            await tx.update(traderPositions).set(row).where(eq(traderPositions.id, existingId));
          } else {
            await tx.insert(traderPositions).values(row);
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

    return true;
  } catch (err) {
    console.error(`[jobs] Failed to ingest address ${address}:`, err);
    return false;
  }
}

export const jobsRouter = new Hono<AppEnv>().post(
  '/whale-discovery',
  // Machine-to-machine endpoint (ingest cron -> BE): shared secret, not a session.
  // Disabled (403) until JOBS_SECRET is configured via `wrangler secret put`.
  async (c, next) => {
    const secret = c.env.JOBS_SECRET;
    if (!secret || c.req.header('x-jobs-secret') !== secret) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  },
  zValidator('json', whaleDiscoveryBody),
  async (c) => {
    const { addresses } = c.req.valid('json');
    const db = c.get('db');
    const apiUrl = c.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz/info';

    const mids = await hyperliquidRequest<Record<string, string>>(apiUrl, {
      type: 'allMids',
    }).catch(() => ({}) as Record<string, string>);

    let successful = 0;
    let failed = 0;

    for (const address of addresses) {
      const ok = await ingestAddress(db, address.toLowerCase(), apiUrl, mids);
      if (ok) successful++;
      else failed++;
    }

    return c.json({ successful, failed, total: addresses.length });
  },
);
