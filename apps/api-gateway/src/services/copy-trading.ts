/**
 * Copy Trading Service
 *
 * Handles copy trading strategy management, allocation, and execution.
 */

import type {
  CopyAllocation,
  CopyOrder,
  CopyPosition,
  CopyStrategy,
  NewCopyAllocation,
  NewCopyOrder,
  NewCopyPosition,
  NewCopyStrategy,
} from '@hyperdash/database';
import {
  agentWallets,
  copyAllocations,
  copyOrders,
  copyPositions,
  copyStrategies,
  traderStats,
} from '@hyperdash/database';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDatabaseConnection } from './connection';

export type StrategyStatus = 'paused' | 'active' | 'error' | 'terminated';
export type StrategyMode = 'portfolio' | 'single_trader';
export type AllocationStatus = 'active' | 'paused';
export type OrderStatus = 'pending' | 'submitted' | 'filled' | 'partial' | 'cancelled' | 'failed';

export interface CreateStrategyInput {
  userId: string;
  name: string;
  description?: string;
  mode: StrategyMode;
  maxLeverage?: number;
  maxPositionUsd?: number;
  slippageBps?: number;
  minOrderUsd?: number;
  followNewEntriesOnly?: boolean;
  autoRebalance?: boolean;
  rebalanceThresholdBps?: number;
  agentWalletId?: string;
}

export interface UpdateStrategyInput {
  name?: string;
  description?: string;
  status?: StrategyStatus;
  maxLeverage?: number;
  maxPositionUsd?: number;
  slippageBps?: number;
  minOrderUsd?: number;
  followNewEntriesOnly?: boolean;
  autoRebalance?: boolean;
  rebalanceThresholdBps?: number;
  agentWalletId?: string;
}

export interface CreateAllocationInput {
  strategyId: string;
  userId: string; // owning user, enforced at the DB layer
  traderId: string;
  weight: number; // 0-1
}

export interface StrategyWithAllocations extends CopyStrategy {
  allocations: Array<{
    id: string;
    traderId: string;
    weight: number;
    status: AllocationStatus;
    allocatedPnl: number;
    allocatedFees: number;
    trader: {
      traderId: string;
      address: string;
      pnl7d: number;
      pnl30d: number;
      winrate: number;
      totalTrades: number;
    } | null;
  }>;
  agentWallet: {
    id: string;
    exchange: string;
    address: string;
    status: string;
  } | null;
}

export interface StrategyPerformance {
  strategyId: string;
  totalPnl: number;
  totalFees: number;
  netPnl: number;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  alignmentRate: number;
  currentPositions: number;
  activeAllocations: number;
}

/**
 * Batch-hydrate a list of {@link CopyStrategy} rows with their allocations
 * (each with its trader stats) and agent wallets.
 *
 * Three round-trips total regardless of how many strategies or allocations
 * are in play — previously this path was 1 + N + M*N queries where N =
 * strategies and M = allocations per strategy, which produced 60+ queries
 * for a user with 10 strategies × 5 allocations.
 */
async function hydrateStrategies(strategies: CopyStrategy[]): Promise<StrategyWithAllocations[]> {
  if (strategies.length === 0) return [];

  const db = getDatabaseConnection().getDatabase();
  const strategyIds = strategies.map((s) => s.id);
  const agentWalletIds = strategies.map((s) => s.agentWalletId).filter((id): id is string => !!id);

  // 1) Every allocation for every input strategy.
  const allocationRows = await db
    .select({
      id: copyAllocations.id,
      strategyId: copyAllocations.strategyId,
      traderId: copyAllocations.traderId,
      weight: copyAllocations.weight,
      status: copyAllocations.status,
      allocatedPnl: copyAllocations.allocatedPnl,
      allocatedFees: copyAllocations.allocatedFees,
    })
    .from(copyAllocations)
    .where(inArray(copyAllocations.strategyId, strategyIds));

  // 2) Every distinct trader referenced by those allocations.
  const traderIds = Array.from(new Set(allocationRows.map((a) => a.traderId)));
  const traderRows =
    traderIds.length > 0
      ? await db
          .select({
            traderId: traderStats.traderId,
            address: traderStats.address,
            pnl7d: traderStats.pnl7d,
            pnl30d: traderStats.pnl30d,
            winrate: traderStats.winrate,
            totalTrades: traderStats.totalTrades,
          })
          .from(traderStats)
          .where(inArray(traderStats.traderId, traderIds))
      : [];

  // 3) Every agent wallet referenced by any strategy.
  const walletRows =
    agentWalletIds.length > 0
      ? await db
          .select({
            id: agentWallets.id,
            exchange: agentWallets.exchange,
            address: agentWallets.address,
            status: agentWallets.status,
          })
          .from(agentWallets)
          .where(inArray(agentWallets.id, agentWalletIds))
      : [];

  const tradersById = new Map(traderRows.map((t) => [t.traderId, t]));
  const walletsById = new Map(walletRows.map((w) => [w.id, w]));
  const allocationsByStrategyId = new Map<string, typeof allocationRows>();
  for (const a of allocationRows) {
    const list = allocationsByStrategyId.get(a.strategyId) ?? [];
    list.push(a);
    allocationsByStrategyId.set(a.strategyId, list);
  }

  return strategies.map((strategy) => {
    const rows = allocationsByStrategyId.get(strategy.id) ?? [];
    return {
      ...strategy,
      allocations: rows.map((allocation) => {
        const trader = tradersById.get(allocation.traderId);
        return {
          id: allocation.id,
          traderId: allocation.traderId,
          weight: Number(allocation.weight),
          status: allocation.status as AllocationStatus,
          allocatedPnl: Number(allocation.allocatedPnl || 0),
          allocatedFees: Number(allocation.allocatedFees || 0),
          trader: trader
            ? {
                traderId: trader.traderId,
                address: trader.address,
                pnl7d: Number(trader.pnl7d || 0),
                pnl30d: Number(trader.pnl30d || 0),
                winrate: Number(trader.winrate || 0),
                totalTrades: trader.totalTrades || 0,
              }
            : null,
        };
      }),
      agentWallet: strategy.agentWalletId
        ? (walletsById.get(strategy.agentWalletId) ?? null)
        : null,
    };
  });
}

/**
 * Get all strategies owned by `userId`, hydrated with allocations and wallet.
 */
export async function getStrategiesByUser(userId: string): Promise<StrategyWithAllocations[]> {
  const db = getDatabaseConnection().getDatabase();

  const strategies = await db
    .select()
    .from(copyStrategies)
    .where(eq(copyStrategies.userId, userId))
    .orderBy(desc(copyStrategies.createdAt));

  return hydrateStrategies(strategies);
}

/**
 * Get a single strategy by ID, hydrated. Returns null if the strategy does
 * not exist or does not belong to `userId`.
 */
export async function getStrategyById(
  strategyId: string,
  userId: string,
): Promise<StrategyWithAllocations | null> {
  const db = getDatabaseConnection().getDatabase();

  const strategies = await db
    .select()
    .from(copyStrategies)
    .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId)))
    .limit(1);

  if (!strategies[0]) return null;

  const [hydrated] = await hydrateStrategies(strategies);
  return hydrated ?? null;
}

/**
 * Create a new copy strategy
 */
export async function createStrategy(input: CreateStrategyInput): Promise<CopyStrategy> {
  const db = getDatabaseConnection().getDatabase();

  const [strategy] = await db
    .insert(copyStrategies)
    .values({
      userId: input.userId,
      name: input.name,
      description: input.description,
      mode: input.mode,
      maxLeverage: input.maxLeverage?.toString(),
      maxPositionUsd: input.maxPositionUsd?.toString(),
      slippageBps: input.slippageBps,
      minOrderUsd: input.minOrderUsd?.toString(),
      followNewEntriesOnly: input.followNewEntriesOnly,
      autoRebalance: input.autoRebalance,
      rebalanceThresholdBps: input.rebalanceThresholdBps,
      agentWalletId: input.agentWalletId,
      status: 'paused', // Start paused
    } as NewCopyStrategy)
    .returning();

  return strategy;
}

/**
 * Per-allocation weight range ((0, 1]). Applied by both the aggregate
 * `validateAllocationWeights` (for new strategies) and the single-allocation
 * mutation paths (`addAllocation` / `updateAllocation`), so a caller can't
 * slip an invalid weight in by updating one row at a time.
 */
function validateWeightRange(weight: number): void {
  if (!(weight > 0 && weight <= 1)) {
    throw new Error(`Allocation weight must be in (0, 1]; got ${weight}`);
  }
}

/**
 * Enforce the weight invariants for the full allocation set of a strategy.
 *
 * Portfolio mode: weights must sum to 1 (within 0.0001 tolerance for float
 * round-off). Single-trader mode: exactly one allocation with weight=1.
 *
 * Callers that mutate one allocation at a time (addAllocation / updateAllocation)
 * can only enforce the per-weight range via {@link validateWeightRange}; the
 * sum invariant is a batch-level contract so it lives with
 * `createStrategyWithAllocations` / a future `replaceAllocations`.
 */
export function validateAllocationWeights(
  mode: StrategyMode,
  allocations: Array<{ weight: number }>,
): void {
  if (allocations.length === 0) {
    throw new Error('Strategy must have at least one allocation');
  }
  for (const a of allocations) validateWeightRange(a.weight);

  if (mode === 'single_trader') {
    if (allocations.length !== 1) {
      throw new Error(
        `single_trader strategies must have exactly one allocation; got ${allocations.length}`,
      );
    }
    if (Math.abs(allocations[0].weight - 1) > 0.0001) {
      throw new Error(`single_trader allocation weight must be 1; got ${allocations[0].weight}`);
    }
    return;
  }

  // portfolio mode
  const sum = allocations.reduce((acc, a) => acc + a.weight, 0);
  if (Math.abs(sum - 1) > 0.0001) {
    throw new Error(`Portfolio allocation weights must sum to 1; got ${sum.toFixed(4)}`);
  }
}

/**
 * Create a strategy together with its initial allocations, atomically.
 *
 * Either every row lands or none do; partial state (strategy without
 * allocations, or half-inserted allocations) is no longer possible. Weight
 * invariants are checked up front via {@link validateAllocationWeights}.
 */
export async function createStrategyWithAllocations(
  input: CreateStrategyInput,
  allocations: Array<{ traderId: string; weight: number }>,
): Promise<{ strategy: CopyStrategy; allocations: CopyAllocation[] }> {
  validateAllocationWeights(input.mode, allocations);

  const db = getDatabaseConnection().getDatabase();

  return db.transaction(async (tx) => {
    const [strategy] = await tx
      .insert(copyStrategies)
      .values({
        userId: input.userId,
        name: input.name,
        description: input.description,
        mode: input.mode,
        maxLeverage: input.maxLeverage?.toString(),
        maxPositionUsd: input.maxPositionUsd?.toString(),
        slippageBps: input.slippageBps,
        minOrderUsd: input.minOrderUsd?.toString(),
        followNewEntriesOnly: input.followNewEntriesOnly,
        autoRebalance: input.autoRebalance,
        rebalanceThresholdBps: input.rebalanceThresholdBps,
        agentWalletId: input.agentWalletId,
        status: 'paused',
      } as NewCopyStrategy)
      .returning();

    // Insert all allocations in one round-trip. Drizzle returns them in the
    // same order they were given, so the output matches the input zipping.
    const allocationRows = await tx
      .insert(copyAllocations)
      .values(
        allocations.map(
          (a) =>
            ({
              strategyId: strategy.id,
              traderId: a.traderId,
              weight: a.weight.toString(),
              status: 'active',
            }) as NewCopyAllocation,
        ),
      )
      .returning();

    return { strategy, allocations: allocationRows };
  });
}

/**
 * Update a strategy. Scoped to the owning user to prevent IDOR.
 * Throws if the strategy does not exist or does not belong to `userId`.
 */
export async function updateStrategy(
  strategyId: string,
  userId: string,
  input: UpdateStrategyInput,
): Promise<CopyStrategy> {
  const db = getDatabaseConnection().getDatabase();

  const [strategy] = await db
    .update(copyStrategies)
    .set({
      ...input,
      maxLeverage: input.maxLeverage?.toString(),
      maxPositionUsd: input.maxPositionUsd?.toString(),
      minOrderUsd: input.minOrderUsd?.toString(),
      updatedAt: new Date(),
    } as NewCopyStrategy)
    .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId)))
    .returning();

  if (!strategy) {
    throw new Error('Strategy not found or access denied');
  }

  return strategy;
}

/**
 * Delete a strategy. Scoped to the owning user to prevent IDOR.
 * Throws if the strategy does not exist or does not belong to `userId`.
 */
export async function deleteStrategy(strategyId: string, userId: string): Promise<void> {
  const db = getDatabaseConnection().getDatabase();

  const deleted = await db
    .delete(copyStrategies)
    .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId)))
    .returning({ id: copyStrategies.id });

  if (deleted.length === 0) {
    throw new Error('Strategy not found or access denied');
  }
}

/**
 * Verify that a strategy belongs to `userId`. Throws otherwise.
 * Use before allocation mutations so the user can't touch someone else's strategy.
 */
async function assertStrategyOwned(strategyId: string, userId: string): Promise<void> {
  const db = getDatabaseConnection().getDatabase();
  const rows = await db
    .select({ id: copyStrategies.id })
    .from(copyStrategies)
    .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    throw new Error('Strategy not found or access denied');
  }
}

/**
 * Resolve the strategyId for an allocation and assert it is owned by `userId`.
 * Returns the strategyId so callers can scope follow-up queries.
 */
async function assertAllocationOwned(allocationId: string, userId: string): Promise<string> {
  const db = getDatabaseConnection().getDatabase();
  const rows = await db
    .select({ strategyId: copyAllocations.strategyId })
    .from(copyAllocations)
    .innerJoin(copyStrategies, eq(copyAllocations.strategyId, copyStrategies.id))
    .where(and(eq(copyAllocations.id, allocationId), eq(copyStrategies.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    throw new Error('Allocation not found or access denied');
  }
  return rows[0].strategyId;
}

/**
 * Add a trader allocation to a strategy. Ownership of the strategy is enforced.
 * Weight must be in (0, 1]; callers that change a whole strategy's allocation
 * set should use {@link createStrategyWithAllocations} to also check the
 * sum-to-1 invariant.
 */
export async function addAllocation(input: CreateAllocationInput): Promise<CopyAllocation> {
  validateWeightRange(input.weight);
  await assertStrategyOwned(input.strategyId, input.userId);

  const db = getDatabaseConnection().getDatabase();
  const [allocation] = await db
    .insert(copyAllocations)
    .values({
      strategyId: input.strategyId,
      traderId: input.traderId,
      weight: input.weight.toString(),
      status: 'active',
    } as NewCopyAllocation)
    .returning();

  return allocation;
}

/**
 * Update an allocation. Ownership of the parent strategy is enforced.
 * If weight is being updated, the per-weight range is enforced; the sum-to-1
 * invariant across a strategy is the caller's responsibility.
 */
export async function updateAllocation(
  allocationId: string,
  userId: string,
  updates: { weight?: number; status?: AllocationStatus },
): Promise<CopyAllocation> {
  if (updates.weight !== undefined) validateWeightRange(updates.weight);
  await assertAllocationOwned(allocationId, userId);

  const db = getDatabaseConnection().getDatabase();
  const [allocation] = await db
    .update(copyAllocations)
    .set({
      ...updates,
      weight: updates.weight?.toString(),
      updatedAt: new Date(),
    } as NewCopyAllocation)
    .where(eq(copyAllocations.id, allocationId))
    .returning();

  return allocation;
}

/**
 * Remove an allocation. Ownership of the parent strategy is enforced.
 */
export async function removeAllocation(allocationId: string, userId: string): Promise<void> {
  await assertAllocationOwned(allocationId, userId);

  const db = getDatabaseConnection().getDatabase();
  await db.delete(copyAllocations).where(eq(copyAllocations.id, allocationId));
}

/**
 * Start a strategy (set status to active). Ownership enforced via updateStrategy.
 */
export async function startStrategy(strategyId: string, userId: string): Promise<CopyStrategy> {
  return updateStrategy(strategyId, userId, { status: 'active' });
}

/**
 * Pause a strategy (set status to paused). Ownership enforced via updateStrategy.
 */
export async function pauseStrategy(strategyId: string, userId: string): Promise<CopyStrategy> {
  return updateStrategy(strategyId, userId, { status: 'paused' });
}

/**
 * Stop a strategy (set status to terminated). Ownership enforced via updateStrategy.
 */
export async function stopStrategy(strategyId: string, userId: string): Promise<CopyStrategy> {
  return updateStrategy(strategyId, userId, { status: 'terminated' });
}

/**
 * Get strategy performance. Returns null if the strategy is not owned by `userId`.
 */
export async function getStrategyPerformance(
  strategyId: string,
  userId: string,
): Promise<StrategyPerformance | null> {
  const db = getDatabaseConnection().getDatabase();

  const strategy = await db
    .select()
    .from(copyStrategies)
    .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId)))
    .limit(1);

  if (!strategy[0]) return null;

  // Get total orders
  const orderStats = await db
    .select({
      total: sql<number>`count(*)`,
      totalPnl: sql<number>`coalesce(sum(${copyOrders.pnl}), 0)`,
      totalFees: sql<number>`coalesce(sum(${copyOrders.feeUsd}), 0)`,
      winningTrades: sql<number>`count(*) filter (where ${copyOrders.pnl} > 0)`,
    })
    .from(copyOrders)
    .where(eq(copyOrders.strategyId, strategyId));

  const stats = orderStats[0];

  // Get current positions
  const positions = await db
    .select()
    .from(copyPositions)
    .where(and(eq(copyPositions.strategyId, strategyId), sql`${copyPositions.closedAt} IS NULL`));

  // Get active allocations
  const activeAllocations = await db
    .select()
    .from(copyAllocations)
    .where(and(eq(copyAllocations.strategyId, strategyId), eq(copyAllocations.status, 'active')));

  return {
    strategyId,
    totalPnl: Number(strategy[0].totalPnl || 0),
    totalFees: Number(strategy[0].totalFees || 0),
    netPnl: Number(strategy[0].totalPnl || 0) - Number(strategy[0].totalFees || 0),
    totalTrades: stats?.total || 0,
    winningTrades: stats?.winningTrades || 0,
    winRate: stats?.total ? (stats.winningTrades / stats.total) * 100 : 0,
    alignmentRate: Number(strategy[0].alignmentRate || 0),
    currentPositions: positions.length,
    activeAllocations: activeAllocations.length,
  };
}

/**
 * Get orders for a strategy. Scoped by `userId` so a user can only see their own orders.
 */
export interface GetStrategyOrdersOptions {
  strategyId: string;
  userId: string;
  limit?: number;
  offset?: number;
  status?: OrderStatus;
}

export async function getStrategyOrders(options: GetStrategyOrdersOptions) {
  const { strategyId, userId, limit = 50, offset = 0, status } = options;
  const db = getDatabaseConnection().getDatabase();

  const baseFilters = [eq(copyOrders.strategyId, strategyId), eq(copyOrders.userId, userId)];
  const whereClause = status
    ? and(...baseFilters, eq(copyOrders.status, status))
    : and(...baseFilters);

  const orders = await db
    .select()
    .from(copyOrders)
    .where(whereClause)
    .orderBy(desc(copyOrders.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ value: total }] = await db
    .select({ value: sql<number>`count(*)` })
    .from(copyOrders)
    .where(whereClause);

  return {
    orders,
    total: Number(total || 0),
  };
}

/**
 * Get positions for a strategy. Scoped by `userId`.
 */
export async function getStrategyPositions(strategyId: string, userId: string) {
  const db = getDatabaseConnection().getDatabase();

  const positions = await db
    .select()
    .from(copyPositions)
    .where(and(eq(copyPositions.strategyId, strategyId), eq(copyPositions.userId, userId)))
    .orderBy(desc(copyPositions.openedAt));

  return positions;
}

/**
 * Create a copy order when a source trader makes a trade
 */
export async function createCopyOrder(input: {
  userId: string;
  strategyId: string;
  agentWalletId: string;
  sourceTraderId: string;
  sourceTradeId: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: number;
  price?: number;
}): Promise<CopyOrder> {
  const db = getDatabaseConnection().getDatabase();

  const [order] = await db
    .insert(copyOrders)
    .values({
      userId: input.userId,
      strategyId: input.strategyId,
      agentWalletId: input.agentWalletId,
      sourceTraderId: input.sourceTraderId,
      sourceTradeId: input.sourceTradeId,
      exchange: 'hyperliquid',
      symbol: input.symbol,
      side: input.side,
      orderType: input.orderType,
      quantity: input.quantity.toString(),
      price: input.price?.toString(),
      status: 'pending',
    } as NewCopyOrder)
    .returning();

  return order;
}

/**
 * Update order status
 */
export async function updateOrderStatus(
  orderId: string,
  status: OrderStatus,
  updates?: {
    filledQuantity?: number;
    averagePrice?: number;
    pnl?: number;
    feeUsd?: number;
    exchangeOrderId?: string;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<CopyOrder> {
  const db = getDatabaseConnection().getDatabase();

  const [order] = await db
    .update(copyOrders)
    .set({
      status,
      filledQuantity: updates?.filledQuantity?.toString(),
      averagePrice: updates?.averagePrice?.toString(),
      pnl: updates?.pnl?.toString(),
      feeUsd: updates?.feeUsd?.toString(),
      exchangeOrderId: updates?.exchangeOrderId,
      errorCode: updates?.errorCode,
      errorMessage: updates?.errorMessage,
      filledAt: status === 'filled' || status === 'partial' ? new Date() : undefined,
      cancelledAt: status === 'cancelled' ? new Date() : undefined,
    } as NewCopyOrder)
    .where(eq(copyOrders.id, orderId))
    .returning();

  return order;
}

/**
 * Input for {@link upsertCopyPosition}. Represents a _snapshot_ of the
 * position's current state (as returned by the exchange's clearinghouse API),
 * not a per-fill delta.
 *
 * The identity tuple `(userId, strategyId, agentWalletId, symbol, side)`
 * locates the open row (with `closedAt IS NULL`); any of those fields changing
 * means a different position and will create a new row instead of mutating the
 * old one. Scale-ins/outs are expressed as new values of `quantity` and
 * `entryPrice` — Hyperliquid (and most exchanges) already maintain a
 * volume-weighted entry for us, so we just pass it through.
 */
export interface UpsertCopyPositionInput {
  userId: string;
  strategyId: string;
  agentWalletId: string;
  /** Persisted on INSERT only; ignored on UPDATE (the source doesn't change). */
  sourceTraderId: string;
  symbol: string;
  side: 'long' | 'short';
  /** Absolute position size after this snapshot. */
  quantity: number;
  /** Volume-weighted entry price from the exchange. */
  entryPrice: number;
  markPrice?: number;
  /**
   * Realized-adjacent unrealized PnL from the exchange. When omitted, we fall
   * back to computing `(mark - entry) * qty * sideSign` using the snapshot's
   * own entryPrice — never the stale DB value.
   */
  unrealizedPnl?: number;
  leverage?: number;
  marginUsed?: number;
}

/**
 * Create-or-update an open copy position from an exchange snapshot.
 *
 * On UPDATE, every state field is refreshed from the snapshot (including
 * `entryPrice`, which changes when the exchange recomputes its weighted
 * average on a scale-in). `sourceTraderId`, `side`, and the identity tuple
 * stay immutable — a side flip or agent/symbol change creates a new row.
 */
export async function upsertCopyPosition(input: UpsertCopyPositionInput): Promise<CopyPosition> {
  const db = getDatabaseConnection().getDatabase();

  // Find the currently-open position matching the full identity tuple. Including
  // strategyId, side and the "not closed" check prevents three bugs:
  //   * historical closed rows being revived for the same (user, wallet, symbol);
  //   * two strategies on the same wallet/symbol colliding onto one row;
  //   * flipping long<->short silently overwriting the opposite-side row.
  const existing = await db
    .select()
    .from(copyPositions)
    .where(
      and(
        eq(copyPositions.userId, input.userId),
        eq(copyPositions.strategyId, input.strategyId),
        eq(copyPositions.agentWalletId, input.agentWalletId),
        eq(copyPositions.symbol, input.symbol),
        eq(copyPositions.side, input.side),
        sql`${copyPositions.closedAt} IS NULL`,
      ),
    )
    .limit(1);

  // Unrealized PnL: prefer the exchange-provided value. Fall back to computing
  // it from *this snapshot's* entry price — never the stale DB value, which is
  // what the prior implementation did (it held the original entry across
  // scale-ins and silently produced wrong PnL after any add-to-position).
  const sideSign = input.side === 'long' ? 1 : -1;
  const unrealizedPnl =
    input.unrealizedPnl !== undefined
      ? input.unrealizedPnl
      : input.markPrice !== undefined
        ? (input.markPrice - input.entryPrice) * input.quantity * sideSign
        : undefined;

  if (existing[0]) {
    const [position] = await db
      .update(copyPositions)
      .set({
        quantity: input.quantity.toString(),
        entryPrice: input.entryPrice.toString(),
        markPrice: input.markPrice?.toString(),
        unrealizedPnl:
          unrealizedPnl !== undefined ? unrealizedPnl.toString() : existing[0].unrealizedPnl,
        leverage: input.leverage?.toString(),
        marginUsed: input.marginUsed?.toString(),
        lastUpdatedAt: new Date(),
      } as NewCopyPosition)
      .where(eq(copyPositions.id, existing[0].id))
      .returning();

    return position;
  }

  const [position] = await db
    .insert(copyPositions)
    .values({
      userId: input.userId,
      strategyId: input.strategyId,
      agentWalletId: input.agentWalletId,
      sourceTraderId: input.sourceTraderId,
      exchange: 'hyperliquid',
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity.toString(),
      entryPrice: input.entryPrice.toString(),
      markPrice: input.markPrice?.toString(),
      unrealizedPnl: unrealizedPnl?.toString(),
      leverage: input.leverage?.toString(),
      marginUsed: input.marginUsed?.toString(),
    } as NewCopyPosition)
    .returning();

  return position;
}

/**
 * Close a copy position
 */
export async function closeCopyPosition(
  positionId: string,
  realizedPnl: number,
): Promise<CopyPosition> {
  const db = getDatabaseConnection().getDatabase();

  const [position] = await db
    .update(copyPositions)
    .set({
      realizedPnl: realizedPnl.toString(),
      closedAt: new Date(),
    } as NewCopyPosition)
    .where(eq(copyPositions.id, positionId))
    .returning();

  return position;
}
