import type { TraderStats, TraderTrades } from '@hyperdash/database';
import { traderPositions, traderStats, traderTrades } from '@hyperdash/database';
import { and, asc, count, desc, eq, gte, sql } from 'drizzle-orm';
import { getDatabaseConnection } from './connection';

export type Timeframe = '7d' | '30d' | '90d' | 'all';
export type SortBy = 'pnl' | 'winrate' | 'winRate' | 'trades' | 'sharpe' | 'equity';
export type SortOrder = 'asc' | 'desc';

export interface GetTradersOptions {
  limit?: number;
  offset?: number;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
  timeframe?: Timeframe;
  minPnl?: number;
  minWinrate?: number;
  minTrades?: number;
  isActive?: boolean;
}

export interface TraderWithRank extends TraderStats {
  rank: number;
}

/**
 * Get traders list with filtering and sorting
 */
export async function getTraders(options: GetTradersOptions = {}): Promise<TraderWithRank[]> {
  const {
    limit = 20,
    offset = 0,
    sortBy = 'pnl',
    sortOrder = 'desc',
    timeframe = '7d',
    minPnl,
    minWinrate,
    minTrades,
    isActive = true,
  } = options;

  const db = getDatabaseConnection().getDatabase();

  const normalizedSortBy =
    sortBy === 'winRate' ? 'winrate' : sortBy === 'equity' ? 'trades' : sortBy;
  const normalizedTimeframe = timeframe === '90d' ? '30d' : timeframe;

  // Map sortBy to column
  const sortColumnMap: Record<SortBy, any> = {
    pnl:
      normalizedTimeframe === '7d'
        ? traderStats.pnl7d
        : normalizedTimeframe === '30d'
          ? traderStats.pnl30d
          : traderStats.pnlAll,
    winrate: traderStats.winrate,
    winRate: traderStats.winrate,
    trades: traderStats.totalTrades,
    equity: traderStats.totalTrades,
    sharpe: traderStats.sharpeRatio,
  };

  const sortColumn = sortColumnMap[normalizedSortBy];
  const orderFn = sortOrder === 'desc' ? desc : asc;

  // Build where conditions
  const conditions = [];

  if (minPnl !== undefined) {
    const column =
      normalizedTimeframe === '7d'
        ? traderStats.pnl7d
        : normalizedTimeframe === '30d'
          ? traderStats.pnl30d
          : traderStats.pnlAll;
    conditions.push(gte(column, minPnl.toString()));
  }

  if (minWinrate !== undefined) {
    conditions.push(gte(traderStats.winrate, minWinrate.toString()));
  }

  if (minTrades !== undefined) {
    conditions.push(gte(traderStats.totalTrades, minTrades));
  }

  if (isActive) {
    conditions.push(sql`${traderStats.lastTradeAt} > NOW() - INTERVAL '7 days'`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get traders
  const traders = await db
    .select({
      id: traderStats.id,
      traderId: traderStats.traderId,
      address: traderStats.address,
      equityUsd: traderStats.equityUsd,
      pnl7d: traderStats.pnl7d,
      pnl30d: traderStats.pnl30d,
      pnlAll: traderStats.pnlAll,
      winrate: traderStats.winrate,
      totalTrades: traderStats.totalTrades,
      winningTrades: traderStats.winningTrades,
      losingTrades: traderStats.losingTrades,
      maxDrawdown: traderStats.maxDrawdown,
      sharpeRatio: traderStats.sharpeRatio,
      avgHoldTimeSeconds: traderStats.avgHoldTimeSeconds,
      lastTradeAt: traderStats.lastTradeAt,
      firstTradeAt: traderStats.firstTradeAt,
      longTrades: traderStats.longTrades,
      shortTrades: traderStats.shortTrades,
      avgPositionSizeUsd: traderStats.avgPositionSizeUsd,
    })
    .from(traderStats)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset);

  // Add rank
  return traders.map((t, i) => ({
    ...t,
    rank: offset + i + 1,
  })) as TraderWithRank[];
}

/**
 * Get trader by address
 */
export async function getTraderByAddress(address: string): Promise<TraderStats | null> {
  const db = getDatabaseConnection().getDatabase();

  const traders = await db
    .select()
    .from(traderStats)
    .where(eq(traderStats.address, address))
    .limit(1);

  return traders[0] || null;
}

/**
 * Get trader by ID
 */
export async function getTraderById(traderId: string): Promise<TraderStats | null> {
  const db = getDatabaseConnection().getDatabase();

  const traders = await db
    .select()
    .from(traderStats)
    .where(eq(traderStats.traderId, traderId))
    .limit(1);

  return traders[0] || null;
}

/**
 * Get trader trades
 */
export interface GetTraderTradesOptions {
  traderAddress: string;
  limit?: number;
  offset?: number;
  symbol?: string;
  side?: 'long' | 'short';
  closedOnly?: boolean;
}

export async function getTraderTrades(
  options: GetTraderTradesOptions,
): Promise<{ trades: TraderTrades[]; total: number }> {
  const { traderAddress, limit = 50, offset = 0, symbol, side, closedOnly = true } = options;

  const db = getDatabaseConnection().getDatabase();

  // Build conditions
  const conditions = [eq(traderTrades.traderAddress, traderAddress)];

  if (symbol) {
    conditions.push(eq(traderTrades.symbol, symbol));
  }

  if (side) {
    conditions.push(eq(traderTrades.side, side));
  }

  if (closedOnly) {
    conditions.push(sql`${traderTrades.closedAt} IS NOT NULL`);
  }

  const whereClause = and(...conditions);

  // Get trades with count
  const trades = await db
    .select()
    .from(traderTrades)
    .where(whereClause)
    .orderBy(desc(traderTrades.openedAt))
    .limit(limit)
    .offset(offset);

  // Get total count
  const [{ value: total }] = await db
    .select({ value: count() })
    .from(traderTrades)
    .where(whereClause);

  return {
    trades,
    total: Number(total),
  };
}

/**
 * Get trader performance summary
 */
export interface TraderPerformance {
  traderId: string;
  address: string;
  timeframe: Timeframe;
  periodStart: Date;
  periodEnd: Date;
  summary: {
    totalReturn: number;
    totalPnl: number;
    totalVolume: number;
    winRate: number;
    sharpeRatio: number | null;
    maxDrawdown: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
  };
  dailyStats?: Array<{
    date: string;
    pnl: number;
    volume: number;
    trades: number;
    winRate: number;
  }>;
}

export async function getTraderPerformance(
  address: string,
  timeframe: Timeframe = '30d',
): Promise<TraderPerformance | null> {
  const trader = await getTraderByAddress(address);
  if (!trader) return null;

  const db = getDatabaseConnection().getDatabase();

  // Calculate period start based on timeframe
  const periodEnd = new Date();
  const periodStart = new Date();

  if (timeframe === '7d') {
    periodStart.setDate(periodStart.getDate() - 7);
  } else if (timeframe === '30d') {
    periodStart.setDate(periodStart.getDate() - 30);
  } else {
    // All time - use first trade date
    if (trader.firstTradeAt) {
      periodStart.setTime(trader.firstTradeAt.getTime());
    }
  }

  // Get trades in period
  const trades = await db
    .select()
    .from(traderTrades)
    .where(
      and(eq(traderTrades.traderAddress, address), sql`${traderTrades.openedAt} >= ${periodStart}`),
    )
    .orderBy(desc(traderTrades.openedAt));

  // Calculate summary
  const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const winningTrades = trades.filter((t) => Number(t.pnl || 0) > 0).length;
  const losingTrades = trades.filter((t) => Number(t.pnl || 0) < 0).length;
  const winRate = trades.length > 0 ? (winningTrades / trades.length) * 100 : 0;
  const totalTrades = trades.length;

  // Get equity at start and end (simplified - using total PnL as proxy)
  const startEquity = Number(trader.equityUsd || 0) - totalPnl;
  const totalReturn = startEquity > 0 ? (totalPnl / startEquity) * 100 : 0;

  return {
    traderId: trader.traderId,
    address: trader.address,
    timeframe,
    periodStart,
    periodEnd,
    summary: {
      totalReturn,
      totalPnl,
      totalVolume: trades.reduce(
        (sum, t) => sum + Number(t.size || 0) * Number(t.entryPrice || 0),
        0,
      ),
      winRate,
      sharpeRatio: trader.sharpeRatio ? Number(trader.sharpeRatio) : null,
      maxDrawdown: Number(trader.maxDrawdown || 0),
      totalTrades,
      winningTrades,
      losingTrades,
    },
  };
}

/**
 * Search traders by query
 */
export interface SearchTradersOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

export async function searchTraders(options: SearchTradersOptions = {}): Promise<TraderStats[]> {
  const { query, limit = 20, offset = 0 } = options;

  const db = getDatabaseConnection().getDatabase();

  if (!query) {
    return db
      .select()
      .from(traderStats)
      .orderBy(desc(traderStats.pnl7d))
      .limit(limit)
      .offset(offset);
  }

  // Search by address or nickname (in metadata)
  const traders = await db
    .select()
    .from(traderStats)
    .where(
      sql`${traderStats.address} ILIKE ${`%${query}%`} OR ${traderStats.metadata}->>'nickname' ILIKE ${`%${query}%`}`,
    )
    .orderBy(desc(traderStats.pnl7d))
    .limit(limit)
    .offset(offset);

  return traders;
}

/**
 * Create or update trader stats
 */
export async function upsertTraderStats(
  address: string,
  data: Partial<Omit<TraderStats, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<TraderStats> {
  const db = getDatabaseConnection().getDatabase();

  // Check if trader exists
  const existing = await getTraderByAddress(address);

  if (existing) {
    // Update
    const [updated] = await db
      .update(traderStats)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(traderStats.address, address))
      .returning();

    return updated;
  } else {
    // Insert
    const [inserted] = await db
      .insert(traderStats)
      .values({
        traderId: crypto.randomUUID(),
        address,
        ...data,
      } as any)
      .returning();

    return inserted;
  }
}

/**
 * Add a trade for a trader
 */
export async function addTraderTrade(
  trade: Omit<TraderTrades, 'id' | 'createdAt'>,
): Promise<TraderTrades> {
  const db = getDatabaseConnection().getDatabase();

  const [inserted] = await db
    .insert(traderTrades)
    .values({
      ...trade,
      id: crypto.randomUUID(),
    } as any)
    .returning();

  return inserted;
}

export async function getTraderPositions(address: string) {
  const db = getDatabaseConnection().getDatabase();

  return db
    .select()
    .from(traderPositions)
    .where(eq(traderPositions.traderAddress, address))
    .orderBy(desc(traderPositions.positionValueUsd));
}
