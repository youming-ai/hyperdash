import { zValidator } from '@hono/zod-validator';
import type {
  CopyAllocation,
  CopyStrategy,
  NewCopyAllocation,
  NewCopyStrategy,
} from '@hyperdash/database/schema';
import {
  agentWallets,
  copyAllocations,
  copyStrategies,
  traderStats,
} from '@hyperdash/database/schema';
import { toNumber, validateAllocationWeights } from '@hyperdash/shared-types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '~/db';
import { requireSession } from '~/server/middleware/auth';
import type { AppEnv } from '~/server/types';
import { resolveBusinessUserId } from '~/server/user';

type StrategyStatus = 'paused' | 'active' | 'error' | 'terminated';
type StrategyMode = 'portfolio' | 'single_trader';
type AllocationStatus = 'active' | 'paused';

interface StrategyAllocation {
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
}

type StrategyWithAllocations = CopyStrategy & {
  allocations: StrategyAllocation[];
  agentWallet: {
    id: string;
    exchange: string;
    address: string;
    status: string;
  } | null;
};

interface CreateStrategyBody {
  name: string;
  description?: string;
  mode: StrategyMode;
  riskParams: {
    maxLeverage: number;
    maxPositionUsd?: number;
    slippageBps: number;
    minOrderUsd: number;
  };
  settings: {
    followNewEntriesOnly: boolean;
    autoRebalance: boolean;
    rebalanceThresholdBps: number;
  };
  allocations: Array<{ traderId: string; weight: number }>;
}

interface UpdateStrategyBody {
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
}

const listQuery = z.object({
  status: z.enum(['active', 'paused', 'error', 'terminated', 'all']).default('all'),
  limit: z.coerce.number().min(1).max(50).default(20),
  offset: z.coerce.number().min(0).default(0),
});

const idParam = z.object({ id: z.string() });

const createBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  mode: z.enum(['portfolio', 'single_trader']).default('portfolio'),
  riskParams: z.object({
    maxLeverage: z.number().min(1).max(10).default(3.0),
    maxPositionUsd: z.number().positive().optional(),
    slippageBps: z.number().min(0).max(100).default(10),
    minOrderUsd: z.number().positive().default(100),
  }),
  settings: z.object({
    followNewEntriesOnly: z.boolean().default(true),
    autoRebalance: z.boolean().default(true),
    rebalanceThresholdBps: z.number().min(0).max(500).default(50),
  }),
  allocations: z
    .array(
      z.object({
        traderId: z.string(),
        weight: z.number().min(0).max(1),
      }),
    )
    .min(1),
});

const updateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  status: z.enum(['active', 'paused', 'terminated']).optional(),
  riskParams: z
    .object({
      maxLeverage: z.number().min(1).max(10),
      maxPositionUsd: z.number().positive().optional(),
      slippageBps: z.number().min(0).max(100),
      minOrderUsd: z.number().positive(),
    })
    .optional(),
  settings: z
    .object({
      followNewEntriesOnly: z.boolean(),
      autoRebalance: z.boolean(),
      rebalanceThresholdBps: z.number().min(0).max(500),
    })
    .optional(),
});

// validateAllocationWeights imported from @hyperdash/shared-types (single source)

async function hydrateStrategies(
  db: Db,
  strategies: CopyStrategy[],
): Promise<StrategyWithAllocations[]> {
  if (strategies.length === 0) return [];

  const strategyIds = strategies.map((s) => s.id);
  const agentWalletIds = strategies.map((s) => s.agentWalletId).filter((id): id is string => !!id);

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
          weight: toNumber(allocation.weight),
          status: allocation.status as AllocationStatus,
          allocatedPnl: toNumber(allocation.allocatedPnl),
          allocatedFees: toNumber(allocation.allocatedFees),
          trader: trader
            ? {
                traderId: trader.traderId,
                address: trader.address,
                pnl7d: toNumber(trader.pnl7d),
                pnl30d: toNumber(trader.pnl30d),
                winrate: toNumber(trader.winrate),
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

async function getStrategiesByUser(db: Db, userId: string): Promise<StrategyWithAllocations[]> {
  const strategies = await db
    .select()
    .from(copyStrategies)
    .where(eq(copyStrategies.userId, userId))
    .orderBy(desc(copyStrategies.createdAt));

  return hydrateStrategies(db, strategies);
}

async function getStrategyById(
  db: Db,
  strategyId: string,
  userId: string,
): Promise<StrategyWithAllocations | null> {
  const strategies = await db
    .select()
    .from(copyStrategies)
    .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId)))
    .limit(1);

  if (!strategies[0]) return null;

  const [hydrated] = await hydrateStrategies(db, strategies);
  return hydrated ?? null;
}

async function createStrategyWithAllocations(
  db: Db,
  input: CreateStrategyBody,
  userId: string,
): Promise<{ strategy: CopyStrategy; allocations: CopyAllocation[] }> {
  validateAllocationWeights(input.mode, input.allocations);

  return db.transaction(async (tx) => {
    const [strategy] = await tx
      .insert(copyStrategies)
      .values({
        userId,
        name: input.name,
        description: input.description,
        mode: input.mode,
        maxLeverage: input.riskParams.maxLeverage.toString(),
        maxPositionUsd: input.riskParams.maxPositionUsd?.toString(),
        slippageBps: input.riskParams.slippageBps,
        minOrderUsd: input.riskParams.minOrderUsd.toString(),
        followNewEntriesOnly: input.settings.followNewEntriesOnly,
        autoRebalance: input.settings.autoRebalance,
        rebalanceThresholdBps: input.settings.rebalanceThresholdBps,
        status: 'paused',
      } as NewCopyStrategy)
      .returning();

    const allocationRows = await tx
      .insert(copyAllocations)
      .values(
        input.allocations.map(
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

async function updateStrategyRow(
  db: Db,
  strategyId: string,
  userId: string,
  input: UpdateStrategyBody,
): Promise<CopyStrategy> {
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

async function deleteStrategyRow(db: Db, strategyId: string, userId: string): Promise<void> {
  const deleted = await db
    .delete(copyStrategies)
    .where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.userId, userId)))
    .returning({ id: copyStrategies.id });

  if (deleted.length === 0) {
    throw new Error('Strategy not found or access denied');
  }
}

function formatStrategy(strategy: StrategyWithAllocations) {
  return {
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
    status: strategy.status,
    mode: strategy.mode,
    riskParams: {
      maxLeverage: toNumber(strategy.maxLeverage) || 5,
      maxPositionUsd: strategy.maxPositionUsd ? toNumber(strategy.maxPositionUsd) : undefined,
      slippageBps: strategy.slippageBps || 10,
      minOrderUsd: toNumber(strategy.minOrderUsd) || 100,
    },
    settings: {
      followNewEntriesOnly: strategy.followNewEntriesOnly || false,
      autoRebalance: strategy.autoRebalance || false,
      rebalanceThresholdBps: strategy.rebalanceThresholdBps || 50,
    },
    performance: {
      totalPnl: toNumber(strategy.totalPnl),
      totalFees: toNumber(strategy.totalFees),
      alignmentRate: toNumber(strategy.alignmentRate) || 100,
      totalTrades: 0,
    },
    allocations: strategy.allocations.map((alloc) => ({
      traderId: alloc.traderId,
      weight: alloc.weight,
      performance: {
        allocatedPnl: alloc.allocatedPnl,
        allocatedFees: alloc.allocatedFees,
      },
    })),
    createdAt: strategy.createdAt?.toISOString() || new Date().toISOString(),
    updatedAt: strategy.updatedAt?.toISOString() || new Date().toISOString(),
  };
}

export const strategiesRouter = new Hono<AppEnv>()
  .use(requireSession)
  .get('/', zValidator('query', listQuery), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { status, limit, offset } = c.req.valid('query');

    const strategies = await getStrategiesByUser(db, userId);
    const filtered = status === 'all' ? strategies : strategies.filter((s) => s.status === status);
    const paginated = filtered.slice(offset, offset + limit);

    return c.json({ strategies: paginated.map(formatStrategy) });
  })
  .post('/', zValidator('json', createBody), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { name, description, mode, riskParams, settings, allocations } = c.req.valid('json');

    try {
      const { strategy } = await createStrategyWithAllocations(
        db,
        {
          name,
          description,
          mode,
          riskParams,
          settings,
          allocations,
        },
        userId,
      );

      const strategyWithAllocations = await getStrategyById(db, strategy.id, userId);
      if (!strategyWithAllocations) {
        return c.json({ error: 'strategy not found after creation' }, 500);
      }

      return c.json(
        {
          id: strategyWithAllocations.id,
          name: strategyWithAllocations.name,
          description: strategyWithAllocations.description,
          status: strategyWithAllocations.status,
          mode: strategyWithAllocations.mode,
          riskParams,
          settings,
          performance: {
            totalPnl: toNumber(strategyWithAllocations.totalPnl),
            totalFees: toNumber(strategyWithAllocations.totalFees),
            alignmentRate: toNumber(strategyWithAllocations.alignmentRate) || 100,
            totalTrades: 0,
          },
          allocations: allocations.map((alloc) => ({
            ...alloc,
            performance: { allocatedPnl: 0, allocatedFees: 0 },
          })),
          createdAt: strategyWithAllocations.createdAt?.toISOString() || new Date().toISOString(),
          updatedAt: strategyWithAllocations.updatedAt?.toISOString() || new Date().toISOString(),
        },
        201,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid strategy';
      return c.json({ error: message }, 400);
    }
  })
  .get('/:id', zValidator('param', idParam), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { id } = c.req.valid('param');

    const strategy = await getStrategyById(db, id, userId);
    if (!strategy) return c.json({ error: 'strategy not found' }, 404);

    return c.json(formatStrategy(strategy));
  })
  .patch('/:id', zValidator('param', idParam), zValidator('json', updateBody), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const updates: UpdateStrategyBody = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.status !== undefined) updates.status = body.status;
    if (body.riskParams !== undefined) {
      updates.maxLeverage = body.riskParams.maxLeverage;
      updates.maxPositionUsd = body.riskParams.maxPositionUsd;
      updates.slippageBps = body.riskParams.slippageBps;
      updates.minOrderUsd = body.riskParams.minOrderUsd;
    }
    if (body.settings !== undefined) {
      updates.followNewEntriesOnly = body.settings.followNewEntriesOnly;
      updates.autoRebalance = body.settings.autoRebalance;
      updates.rebalanceThresholdBps = body.settings.rebalanceThresholdBps;
    }

    try {
      const strategy = await updateStrategyRow(db, id, userId, updates);

      return c.json({
        success: true,
        strategyId: id,
        updates,
        updatedAt: strategy.updatedAt?.toISOString() || new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'strategy not found';
      return c.json({ error: message }, message.includes('not found') ? 404 : 400);
    }
  })
  .delete('/:id', zValidator('param', idParam), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { id } = c.req.valid('param');

    try {
      await deleteStrategyRow(db, id, userId);
      return c.json({ success: true, strategyId: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'strategy not found';
      return c.json({ error: message }, message.includes('not found') ? 404 : 400);
    }
  });
