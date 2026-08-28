import { zValidator } from '@hono/zod-validator';
import { traderPositions, traderStats, traderTrades } from '@hyperdash/database/schema';
import { and, asc, count, desc, eq, gte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '~/server/types';

const timeframes = ['7d', '30d', '90d', 'all'] as const;
const sortableColumns = ['pnl', 'winrate', 'trades', 'sharpe', 'equity'] as const;

const listQuery = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  sortBy: z.enum(sortableColumns).default('pnl'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  timeframe: z.enum(timeframes).default('7d'),
  minPnl: z.coerce.number().optional(),
  minWinrate: z.coerce.number().optional(),
  minTrades: z.coerce.number().int().optional(),
  isActive: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const addressParam = z.object({ address: z.string().length(42) });
const tradesQuery = z.object({ limit: z.coerce.number().min(1).max(100).default(10) });

export const tradersRouter = new Hono<AppEnv>()
  .get('/', zValidator('query', listQuery), async (c) => {
    const { limit, offset, sortBy, sortOrder, timeframe, minPnl, minWinrate, minTrades, isActive } =
      c.req.valid('query');
    const db = c.get('db');

    const normalizedTimeframe = timeframe === '90d' ? '30d' : timeframe;
    const pnlColumn =
      normalizedTimeframe === '7d'
        ? traderStats.pnl7d
        : normalizedTimeframe === '30d'
          ? traderStats.pnl30d
          : traderStats.pnlAll;

    const sortColumn = {
      pnl: pnlColumn,
      winrate: traderStats.winrate,
      trades: traderStats.totalTrades,
      equity: traderStats.equityUsd,
      sharpe: traderStats.sharpeRatio,
    }[sortBy];

    const orderFn = sortOrder === 'desc' ? desc : asc;

    const conditions = [];
    if (minPnl !== undefined) conditions.push(gte(pnlColumn, minPnl.toString()));
    if (minWinrate !== undefined) conditions.push(gte(traderStats.winrate, minWinrate.toString()));
    if (minTrades !== undefined) conditions.push(gte(traderStats.totalTrades, minTrades));
    if (isActive) conditions.push(sql`${traderStats.lastTradeAt} > NOW() - INTERVAL '7 days'`);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(traderStats)
      .where(whereClause)
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);

    const traders = rows.map((t, i) => ({ ...t, rank: offset + i + 1 }));
    return c.json({ traders });
  })
  .get('/:address', zValidator('param', addressParam), async (c) => {
    const { address } = c.req.valid('param');
    const db = c.get('db');
    const rows = await db
      .select()
      .from(traderStats)
      .where(eq(traderStats.address, address))
      .limit(1);
    if (!rows[0]) return c.json({ error: 'trader not found' }, 404);
    return c.json({ trader: rows[0] });
  })
  .get('/:address/positions', zValidator('param', addressParam), async (c) => {
    const { address } = c.req.valid('param');
    const db = c.get('db');
    const positions = await db
      .select()
      .from(traderPositions)
      .where(eq(traderPositions.traderAddress, address))
      .orderBy(desc(traderPositions.positionValueUsd));
    return c.json({ positions });
  })
  .get(
    '/:address/trades',
    zValidator('param', addressParam),
    zValidator('query', tradesQuery),
    async (c) => {
      const { address } = c.req.valid('param');
      const { limit } = c.req.valid('query');
      const db = c.get('db');

      const whereClause = and(
        eq(traderTrades.traderAddress, address),
        sql`${traderTrades.closedAt} IS NOT NULL`,
      );

      const trades = await db
        .select()
        .from(traderTrades)
        .where(whereClause)
        .orderBy(desc(traderTrades.openedAt))
        .limit(limit);

      const [{ value: total }] = await db
        .select({ value: count() })
        .from(traderTrades)
        .where(whereClause);

      return c.json({ trades, total: Number(total) });
    },
  );
