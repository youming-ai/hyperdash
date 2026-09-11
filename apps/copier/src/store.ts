/**
 * Postgres persistence for the copier.
 *
 * Two directions matter:
 *  - Reads: which strategies are active, who they copy, and what those leads
 *    currently hold. `trader_positions` is populated by the ingest plane.
 *  - Writes: `copy_orders` and `copy_positions`, which had **no writer at all**
 *    in the Workers plane — every performance column the UI reads stayed at its
 *    default because of it.
 *
 * Approval bookkeeping lives in `agent_wallets.metadata` rather than new
 * columns, so this ships without a migration.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './db';
import { schema } from './db';
import { log } from './log';
import type { SourcePosition } from './sizing';
import type { LoadedStrategy, StrategyRisk, TradingAccount } from './types';

export interface AgentWalletRecord {
  id: string;
  userId: string;
  address: string;
  status: string;
  encryptedPrivateKey: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Every active strategy grouped by the account that would execute it.
 *
 * Reconciling per strategy is wrong when one account carries several of them:
 * each would measure the *account's* positions against its own targets and undo
 * the others. Grouping here is what lets the engine net their targets and act
 * once per account.
 *
 * Strategies with no agent wallet, or whose wallet has no usable master
 * address, are skipped with a warning rather than dropped silently — they cannot
 * be traded, and saying so is better than a strategy that quietly never runs.
 */
export async function loadTradingAccounts(db: Db): Promise<TradingAccount[]> {
  const rows = await db
    .select({
      strategyId: schema.copyStrategies.id,
      userId: schema.copyStrategies.userId,
      name: schema.copyStrategies.name,
      mode: schema.copyStrategies.mode,
      status: schema.copyStrategies.status,
      agentWalletId: schema.copyStrategies.agentWalletId,
      maxPositionUsd: schema.copyStrategies.maxPositionUsd,
      maxLeverage: schema.copyStrategies.maxLeverage,
      slippageBps: schema.copyStrategies.slippageBps,
      minOrderUsd: schema.copyStrategies.minOrderUsd,
      followNewEntriesOnly: schema.copyStrategies.followNewEntriesOnly,
      traderId: schema.copyAllocations.traderId,
      weight: schema.copyAllocations.weight,
      traderAddress: schema.traderStats.address,
      leadEquityUsd: schema.traderStats.equityUsd,
      walletAddress: schema.agentWallets.address,
      walletStatus: schema.agentWallets.status,
      masterAddress: schema.users.walletAddress,
    })
    .from(schema.copyStrategies)
    .innerJoin(
      schema.copyAllocations,
      eq(schema.copyAllocations.strategyId, schema.copyStrategies.id),
    )
    .innerJoin(schema.traderStats, eq(schema.traderStats.traderId, schema.copyAllocations.traderId))
    .innerJoin(schema.users, eq(schema.users.id, schema.copyStrategies.userId))
    .leftJoin(schema.agentWallets, eq(schema.agentWallets.id, schema.copyStrategies.agentWalletId))
    .where(eq(schema.copyStrategies.status, 'active'));

  const strategiesById = new Map<string, LoadedStrategy>();
  const strategiesByAccount = new Map<string, TradingAccount>();
  const skipped = new Set<string>();

  for (const row of rows) {
    const hasAddress =
      typeof row.masterAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(row.masterAddress);
    if (!row.agentWalletId || !row.walletAddress || !hasAddress) {
      if (!skipped.has(row.strategyId)) {
        skipped.add(row.strategyId);
        log.warn('strategy skipped: no tradable account', {
          strategyId: row.strategyId,
          name: row.name,
          reason: !row.agentWalletId
            ? 'no agent wallet authorized'
            : !row.walletAddress
              ? 'agent wallet missing'
              : 'master address is not a wallet address',
        });
      }
      continue;
    }

    const masterAddress = row.masterAddress as `0x${string}`;

    let strategy = strategiesById.get(row.strategyId);
    if (!strategy) {
      const risk: StrategyRisk = {
        maxPositionUsd: Number(row.maxPositionUsd ?? 0) || 1_000,
        maxLeverage: Number(row.maxLeverage ?? 0) || 3,
        slippageBps: Number(row.slippageBps ?? 0) || 10,
        minOrderUsd: Number(row.minOrderUsd ?? 0) || 10,
        followNewEntriesOnly: row.followNewEntriesOnly ?? true,
      };

      strategy = {
        id: row.strategyId,
        userId: row.userId,
        name: row.name,
        mode: row.mode === 'single_trader' ? 'single_trader' : 'portfolio',
        status: 'active',
        agentWalletId: row.agentWalletId,
        risk,
        allocations: [],
      };
      strategiesById.set(row.strategyId, strategy);
    }

    strategy.allocations.push({
      traderId: row.traderId,
      traderAddress: row.traderAddress,
      weight: Number(row.weight),
      leadEquityUsd: Number(row.leadEquityUsd ?? 0),
    });

    let account = strategiesByAccount.get(row.agentWalletId);
    if (!account) {
      account = {
        agentWalletId: row.agentWalletId,
        agentAddress: row.walletAddress as `0x${string}`,
        masterAddress,
        userId: row.userId,
        strategies: [],
      };
      strategiesByAccount.set(row.agentWalletId, account);
    }
    if (!account.strategies.some((s) => s.id === row.strategyId)) {
      account.strategies.push(strategy);
    }
  }

  return [...strategiesByAccount.values()];
}

/** Active strategies with their allocations and lead equity resolved. */

export async function loadActiveStrategies(db: Db): Promise<LoadedStrategy[]> {
  const rows = await db
    .select({
      strategyId: schema.copyStrategies.id,
      userId: schema.copyStrategies.userId,
      name: schema.copyStrategies.name,
      mode: schema.copyStrategies.mode,
      status: schema.copyStrategies.status,
      agentWalletId: schema.copyStrategies.agentWalletId,
      maxPositionUsd: schema.copyStrategies.maxPositionUsd,
      maxLeverage: schema.copyStrategies.maxLeverage,
      slippageBps: schema.copyStrategies.slippageBps,
      minOrderUsd: schema.copyStrategies.minOrderUsd,
      followNewEntriesOnly: schema.copyStrategies.followNewEntriesOnly,
      traderId: schema.copyAllocations.traderId,
      weight: schema.copyAllocations.weight,
      traderAddress: schema.traderStats.address,
      leadEquityUsd: schema.traderStats.equityUsd,
    })
    .from(schema.copyStrategies)
    .innerJoin(
      schema.copyAllocations,
      eq(schema.copyAllocations.strategyId, schema.copyStrategies.id),
    )
    .innerJoin(schema.traderStats, eq(schema.traderStats.traderId, schema.copyAllocations.traderId))
    .where(eq(schema.copyStrategies.status, 'active'));

  const byId = new Map<string, LoadedStrategy>();

  for (const row of rows) {
    let strategy = byId.get(row.strategyId);

    if (!strategy) {
      const risk: StrategyRisk = {
        maxPositionUsd: Number(row.maxPositionUsd ?? 0) || 1_000,
        maxLeverage: Number(row.maxLeverage ?? 0) || 3,
        slippageBps: Number(row.slippageBps ?? 0) || 10,
        minOrderUsd: Number(row.minOrderUsd ?? 0) || 10,
        followNewEntriesOnly: row.followNewEntriesOnly ?? true,
      };

      strategy = {
        id: row.strategyId,
        userId: row.userId,
        name: row.name,
        mode: row.mode === 'single_trader' ? 'single_trader' : 'portfolio',
        status: 'active',
        agentWalletId: row.agentWalletId,
        risk,
        allocations: [],
      };
      byId.set(row.strategyId, strategy);
    }

    strategy.allocations.push({
      traderId: row.traderId,
      traderAddress: row.traderAddress,
      weight: Number(row.weight),
      leadEquityUsd: Number(row.leadEquityUsd ?? 0),
    });
  }

  return [...byId.values()];
}

/** Current positions held by the leads a set of strategies copies. */
export async function loadSourcePositions(db: Db, traderIds: string[]): Promise<SourcePosition[]> {
  if (traderIds.length === 0) return [];

  const rows = await db
    .select({
      traderId: schema.traderPositions.traderId,
      symbol: schema.traderPositions.symbol,
      side: schema.traderPositions.side,
      quantity: schema.traderPositions.quantity,
      markPrice: schema.traderPositions.markPrice,
      positionValueUsd: schema.traderPositions.positionValueUsd,
    })
    .from(schema.traderPositions)
    .where(inArray(schema.traderPositions.traderId, traderIds));

  return rows.map((r) => ({
    traderId: r.traderId,
    symbol: r.symbol,
    side: r.side,
    quantity: Number(r.quantity),
    markPrice: Number(r.markPrice),
    positionValueUsd: Number(r.positionValueUsd),
  }));
}

/** Resolve the follower's Hyperliquid master account for a business user. */
export async function loadMasterAddress(db: Db, userId: string): Promise<`0x${string}` | null> {
  const rows = await db
    .select({ walletAddress: schema.users.walletAddress })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  const address = rows[0]?.walletAddress;
  return address && /^0x[0-9a-fA-F]{40}$/.test(address) ? (address as `0x${string}`) : null;
}

export async function loadAgentWallet(
  db: Db,
  agentWalletId: string,
): Promise<AgentWalletRecord | null> {
  const rows = await db
    .select()
    .from(schema.agentWallets)
    .where(eq(schema.agentWallets.id, agentWalletId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    userId: row.userId,
    address: row.address,
    status: row.status,
    encryptedPrivateKey: row.encryptedPrivateKey ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

export interface OrderRecord {
  userId: string;
  strategyId: string | null;
  agentWalletId: string | null;
  symbol: string;
  /** 'buy' | 'sell' */
  side: string;
  quantity: number;
  price: number;
  status: 'submitted' | 'filled' | 'failed';
  exchangeOrderId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Persist one execution attempt — successes and failures alike.
 *
 * `copy_orders` has no dedicated paper/live column, so paper fills are tagged
 * through `errorCode` ("paper"). That keeps rows distinguishable without a
 * migration while preserving the same shape the UI already reads.
 */
export async function recordOrder(
  db: Db,
  order: OrderRecord,
  mode: 'paper' | 'live',
): Promise<void> {
  const isFilled = order.status === 'filled';
  const errorCode =
    order.errorCode ?? (mode === 'paper' && order.status !== 'failed' ? 'paper' : null);

  await db.insert(schema.copyOrders).values({
    userId: order.userId,
    strategyId: order.strategyId,
    agentWalletId: order.agentWalletId,
    symbol: order.symbol,
    side: order.side,
    orderType: 'limit',
    quantity: order.quantity.toFixed(8),
    price: order.price.toFixed(8),
    status: order.status,
    filledQuantity: isFilled ? order.quantity.toFixed(8) : '0',
    averagePrice: isFilled ? order.price.toFixed(8) : null,
    exchangeOrderId: order.exchangeOrderId ?? null,
    errorCode,
    errorMessage: order.errorMessage ?? null,
    submittedAt: new Date(),
    filledAt: isFilled ? new Date() : null,
  });
}

/**
 * Mirror the follower's real position set into `copy_positions`.
 *
 * Upsert-by-(user, agent, symbol) then close anything the exchange no longer
 * reports, so the table tracks the chain rather than accumulating stale rows.
 */
export async function syncCopyPositions(
  db: Db,
  userId: string,
  agentWalletId: string | null,
  positions: Array<{
    symbol: string;
    side: string;
    quantity: number;
    entryPrice: number;
    markPrice: number;
    leverage: number;
    unrealizedPnl: number;
  }>,
): Promise<void> {
  const now = new Date();

  for (const position of positions) {
    await db
      .insert(schema.copyPositions)
      .values({
        userId,
        agentWalletId,
        symbol: position.symbol,
        side: position.side,
        quantity: position.quantity.toFixed(8),
        entryPrice: position.entryPrice.toFixed(8),
        markPrice: position.markPrice.toFixed(8),
        leverage: position.leverage.toFixed(2),
        unrealizedPnl: position.unrealizedPnl.toFixed(2),
        lastUpdatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.copyPositions.userId,
          schema.copyPositions.agentWalletId,
          schema.copyPositions.symbol,
        ],
        set: {
          side: position.side,
          quantity: position.quantity.toFixed(8),
          entryPrice: position.entryPrice.toFixed(8),
          markPrice: position.markPrice.toFixed(8),
          leverage: position.leverage.toFixed(2),
          unrealizedPnl: position.unrealizedPnl.toFixed(2),
          lastUpdatedAt: now,
          closedAt: null,
        },
      });
  }

  const liveSymbols = positions.map((p) => p.symbol);

  // Close rows the exchange no longer reports for this strategy's account.
  const closeCondition =
    liveSymbols.length > 0
      ? and(
          eq(schema.copyPositions.userId, userId),
          agentWalletId
            ? eq(schema.copyPositions.agentWalletId, agentWalletId)
            : sql`${schema.copyPositions.agentWalletId} IS NULL`,
          sql`${schema.copyPositions.closedAt} IS NULL`,
          sql`${schema.copyPositions.symbol} NOT IN ${liveSymbols}`,
        )
      : and(
          eq(schema.copyPositions.userId, userId),
          agentWalletId
            ? eq(schema.copyPositions.agentWalletId, agentWalletId)
            : sql`${schema.copyPositions.agentWalletId} IS NULL`,
          sql`${schema.copyPositions.closedAt} IS NULL`,
        );

  await db
    .update(schema.copyPositions)
    .set({ closedAt: now, quantity: '0', lastUpdatedAt: now })
    .where(closeCondition);
}

/** Record approval bookkeeping on the agent wallet (metadata, no migration). */
export async function markAgentApproved(
  db: Db,
  agentWalletId: string,
  info: { agentName: string; validUntil: number | null },
): Promise<void> {
  const existing = await loadAgentWallet(db, agentWalletId);
  const metadata = {
    ...(existing?.metadata ?? {}),
    agentName: info.agentName,
    approvedAt: new Date().toISOString(),
    validUntil: info.validUntil,
  };

  await db
    .update(schema.agentWallets)
    .set({ status: 'active', metadata, updatedAt: new Date() })
    .where(eq(schema.agentWallets.id, agentWalletId));
}
