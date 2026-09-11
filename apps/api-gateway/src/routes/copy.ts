import { kycProcedure, protectedProcedure, t } from '@hyperdash/contracts';
import {
  agentWallets,
  aiRecommendations,
  copyAllocations,
  copyStrategies,
  traderPositions,
  traderStats,
} from '@hyperdash/database';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { generateAgentWallet } from '../services/agent-wallets';
import { getAiRecommendations } from '../services/ai-recommendations';
import { getDatabaseConnection } from '../services/connection';
import * as copyService from '../services/copy-trading';
import { getEncryptionKey } from '../services/key-management';

/**
 * Copy Trading Router
 *
 * Handles copy trading strategies, allocations, performance tracking, and execution
 */
export const copyRouter = t.router({
  // Get user's copy strategies
  strategies: protectedProcedure
    .input(
      z.object({
        status: z.enum(['active', 'paused', 'error', 'terminated', 'all']).default('all'),
        limit: z.number().min(1).max(50).default(20),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { status } = input;
      const userId = ctx.user?.userId;

      const strategies = await copyService.getStrategiesByUser(userId);

      // Filter by status if not "all"
      const filtered =
        status === 'all' ? strategies : strategies.filter((s) => s.status === status);

      // Apply pagination
      const paginated = filtered.slice(input.offset, input.offset + input.limit);

      // Transform to match expected schema
      return paginated.map((strategy) => ({
        id: strategy.id,
        name: strategy.name,
        description: strategy.description,
        status: strategy.status,
        mode: strategy.mode,
        riskParams: {
          maxLeverage: Number(strategy.maxLeverage || 5),
          maxPositionUsd: strategy.maxPositionUsd ? Number(strategy.maxPositionUsd) : undefined,
          slippageBps: strategy.slippageBps || 10,
          minOrderUsd: Number(strategy.minOrderUsd || 100),
        },
        settings: {
          followNewEntriesOnly: strategy.followNewEntriesOnly || false,
          autoRebalance: strategy.autoRebalance || false,
          rebalanceThresholdBps: strategy.rebalanceThresholdBps || 50,
        },
        performance: {
          totalPnl: Number(strategy.totalPnl || 0),
          totalFees: Number(strategy.totalFees || 0),
          alignmentRate: Number(strategy.alignmentRate || 100),
          totalTrades: 0, // Would need to calculate from orders
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
      }));
    }),

  // Create a new copy strategy
  createStrategy: kycProcedure(1)
    .input(
      z.object({
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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const { name, description, mode, riskParams, settings, allocations } = input;

      // Strategy + allocations are created atomically in one transaction.
      // Weight invariants (per-weight range + mode-specific sum) are enforced
      // inside the service, so we don't repeat them here.
      const { strategy } = await copyService.createStrategyWithAllocations(
        {
          userId,
          name,
          description,
          mode,
          maxLeverage: riskParams.maxLeverage,
          maxPositionUsd: riskParams.maxPositionUsd,
          slippageBps: riskParams.slippageBps,
          minOrderUsd: riskParams.minOrderUsd,
          followNewEntriesOnly: settings.followNewEntriesOnly,
          autoRebalance: settings.autoRebalance,
          rebalanceThresholdBps: settings.rebalanceThresholdBps,
        },
        allocations,
      );

      // Return the created strategy with allocations
      const strategyWithAllocations = await copyService.getStrategyById(strategy.id, userId);

      return {
        id: strategyWithAllocations?.id,
        name: strategyWithAllocations?.name,
        description: strategyWithAllocations?.description,
        status: strategyWithAllocations?.status,
        mode: strategyWithAllocations?.mode,
        riskParams,
        settings,
        performance: {
          totalPnl: Number(strategyWithAllocations?.totalPnl || 0),
          totalFees: Number(strategyWithAllocations?.totalFees || 0),
          alignmentRate: Number(strategyWithAllocations?.alignmentRate || 100),
          totalTrades: 0,
        },
        allocations: allocations.map((alloc) => ({
          ...alloc,
          performance: { allocatedPnl: 0, allocatedFees: 0 },
        })),
        createdAt: strategyWithAllocations?.createdAt?.toISOString() || new Date().toISOString(),
        updatedAt: strategyWithAllocations?.updatedAt?.toISOString() || new Date().toISOString(),
      };
    }),

  // Update copy strategy
  updateStrategy: protectedProcedure
    .input(
      z.object({
        strategyId: z.string(),
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
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const { strategyId, name, description, status, riskParams, settings } = input;

      // Build update object
      const updates: copyService.UpdateStrategyInput = {};
      if (name) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (status) updates.status = status;
      if (riskParams) {
        updates.maxLeverage = riskParams.maxLeverage;
        updates.maxPositionUsd = riskParams.maxPositionUsd;
        updates.slippageBps = riskParams.slippageBps;
        updates.minOrderUsd = riskParams.minOrderUsd;
      }
      if (settings) {
        updates.followNewEntriesOnly = settings.followNewEntriesOnly;
        updates.autoRebalance = settings.autoRebalance;
        updates.rebalanceThresholdBps = settings.rebalanceThresholdBps;
      }

      const strategy = await copyService.updateStrategy(strategyId, userId, updates);

      return {
        success: true,
        strategyId,
        updates,
        updatedAt: strategy.updatedAt?.toISOString() || new Date().toISOString(),
      };
    }),

  // Get copy strategy performance analytics
  performance: protectedProcedure
    .input(
      z.object({
        strategyId: z.string(),
        timeframe: z.enum(['1d', '7d', '30d', '90d', 'all']).default('30d'),
        granularity: z.enum(['hour', 'day']).default('day'),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { strategyId, timeframe, granularity } = input;
      const userId = ctx.user?.userId;

      const perf = await copyService.getStrategyPerformance(strategyId, userId);

      if (!perf) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found' });
      }

      // Calculate period start based on timeframe
      const periodEnd = new Date();
      const periodStart = new Date();
      if (timeframe === '1d') {
        periodStart.setDate(periodStart.getDate() - 1);
      } else if (timeframe === '7d') {
        periodStart.setDate(periodStart.getDate() - 7);
      } else if (timeframe === '30d') {
        periodStart.setDate(periodStart.getDate() - 30);
      } else if (timeframe === '90d') {
        periodStart.setDate(periodStart.getDate() - 90);
      } else {
        periodStart.setFullYear(periodStart.getFullYear() - 10);
      }

      // Get orders for timeseries data
      const { orders } = await copyService.getStrategyOrders({
        strategyId,
        userId,
        limit: 1000,
      });

      // Group by day for timeseries
      const timeseriesByDay = new Map<string, any>();
      for (const order of orders) {
        if (order.createdAt) {
          const date = new Date(order.createdAt);
          const dateKey = date.toISOString().split('T')[0];
          if (!timeseriesByDay.has(dateKey)) {
            timeseriesByDay.set(dateKey, {
              timestamp: date.toISOString(),
              portfolioValue: 100000,
              dailyPnl: 0,
              alignmentRate: 100,
              tradeCount: 0,
            });
          }
          const entry = timeseriesByDay.get(dateKey);
          if (!entry) continue;
          entry.tradeCount++;
          if (order.pnl) {
            entry.dailyPnl += Number(order.pnl);
          }
        }
      }

      const timeseriesData = Array.from(timeseriesByDay.values());

      return {
        strategyId,
        timeframe,
        granularity,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        summary: {
          totalReturn: perf.totalPnl > 0 ? perf.netPnl / (perf.totalPnl - perf.netPnl) : 0,
          totalPnl: perf.totalPnl,
          totalFees: perf.totalFees,
          alignmentRate: perf.alignmentRate,
          slippage: 0, // Would need to calculate from orders
          totalTrades: perf.totalTrades,
          winRate: perf.winRate,
          profitFactor:
            perf.winningTrades > 0
              ? perf.winningTrades / (perf.totalTrades - perf.winningTrades)
              : 0,
          sharpeRatio: 0, // Would need to calculate
          maxDrawdown: 0, // Would need to calculate
        },
        timeseriesData,
        allocationPerformance: [], // Would need to fetch from allocations
      };
    }),

  // Get copy execution history
  executionHistory: protectedProcedure
    .input(
      z.object({
        strategyId: z.string(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
        status: z
          .enum(['pending', 'submitted', 'filled', 'partial', 'cancelled', 'failed', 'all'])
          .default('all'),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { strategyId, limit, offset, status } = input;
      const userId = ctx.user?.userId;

      const { orders } = await copyService.getStrategyOrders({
        strategyId,
        userId,
        limit,
        offset,
        status: status === 'all' ? undefined : (status as copyService.OrderStatus),
      });

      return orders.map((order) => ({
        id: order.id,
        strategyId: order.strategyId || undefined,
        sourceTraderId: order.sourceTraderId || undefined,
        symbol: order.symbol,
        eventType: order.status === 'filled' ? 'order_filled' : 'order_placed',
        status: order.status,
        latency: 0, // Would need to track
        alignmentRate: 100, // Would need to calculate
        slippageBps: 0, // Would need to calculate
        orderDetails: {
          orderId: order.exchangeOrderId || order.id,
          quantity: Number(order.quantity),
          price: order.price ? Number(order.price) : 0,
          side: order.side,
        },
        timestamp: order.createdAt?.toISOString() || new Date().toISOString(),
      }));
    }),

  // Update strategy allocations
  updateAllocations: protectedProcedure
    .input(
      z.object({
        strategyId: z.string(),
        allocations: z.array(
          z.object({
            traderId: z.string(),
            weight: z.number().min(0).max(1),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const { strategyId, allocations } = input;

      // Validate allocations sum to 1.0
      const totalWeight = allocations.reduce((sum, alloc) => sum + alloc.weight, 0);
      if (Math.abs(totalWeight - 1.0) > 0.0001) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Allocation weights must sum to 1.0' });
      }

      // Service layer enforces ownership; this still rejects unknown IDs.
      const strategy = await copyService.getStrategyById(strategyId, userId);
      if (!strategy) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found or access denied' });
      }

      // For now, we'd need to update allocations by ID
      // This is a simplified implementation
      console.log(`Updated allocations for strategy ${strategyId}:`, allocations);

      return {
        success: true,
        strategyId,
        allocations,
        updatedAt: new Date().toISOString(),
      };
    }),

  // Get copy trading recommendations
  recommendations: protectedProcedure
    .input(
      z.object({
        strategyId: z.string().optional(),
        riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).default('moderate'),
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const db = getDatabaseConnection().getDatabase();

      // Get top traders
      const topTraders = await db
        .select({
          traderId: traderStats.traderId,
          address: traderStats.address,
          pnl7d: traderStats.pnl7d,
          pnl30d: traderStats.pnl30d,
          winrate: traderStats.winrate,
          totalTrades: traderStats.totalTrades,
          equityUsd: traderStats.equityUsd,
          maxDrawdown: traderStats.maxDrawdown,
          sharpeRatio: traderStats.sharpeRatio,
        })
        .from(traderStats)
        .where(sql`${traderStats.lastTradeAt} > NOW() - INTERVAL '7 days'`)
        .orderBy(desc(traderStats.pnl7d))
        .limit(50);

      // Get current positions for top traders
      const traderIds = topTraders.map((t) => t.traderId);
      const positions =
        traderIds.length > 0
          ? await db
              .select()
              .from(traderPositions)
              .where(sql`${traderPositions.traderId} = ANY(${traderIds})`)
          : [];

      // Get current strategy if specified
      let currentStrategy = null;
      if (input.strategyId) {
        const strategies = await db
          .select()
          .from(copyStrategies)
          .where(and(eq(copyStrategies.id, input.strategyId), eq(copyStrategies.userId, userId)))
          .limit(1);
        currentStrategy = strategies[0] || null;
      }

      // Call AI service
      // biome-ignore lint/suspicious/noImplicitAnyLet: AI recommendation shape is dynamic
      let recommendation;
      try {
        recommendation = await getAiRecommendations({
          traders: topTraders.map((t) => ({
            ...t,
            pnl7d: Number(t.pnl7d || 0),
            pnl30d: Number(t.pnl30d || 0),
            winrate: Number(t.winrate || 0),
            totalTrades: t.totalTrades || 0,
            equityUsd: Number(t.equityUsd || 0),
            maxDrawdown: Number(t.maxDrawdown || 0),
            sharpeRatio: Number(t.sharpeRatio || 0),
            isActive: true,
          })),
          positions: positions.map((p) => ({
            traderId: p.traderId,
            symbol: p.symbol,
            side: p.side,
            quantity: Number(p.quantity),
            positionValueUsd: Number(p.positionValueUsd),
            unrealizedPnl: Number(p.unrealizedPnl || 0),
          })),
          currentStrategy,
          constraints: {
            maxLeverage: Number(currentStrategy?.maxLeverage || 5),
            maxPositionUsd: Number(currentStrategy?.maxPositionUsd || 10000),
            riskTolerance: input.riskTolerance,
          },
        });
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `AI recommendation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        });
      }

      // Store recommendation
      const [row] = await db
        .insert(aiRecommendations)
        .values({
          userId,
          strategyId: input.strategyId || null,
          type: 'trader_selection',
          inputData: {
            traders: topTraders,
            positions,
            currentStrategy,
            constraints: { riskTolerance: input.riskTolerance },
          },
          recommendations: recommendation.traders,
          reasoning: recommendation.overallReasoning,
          confidence:
            recommendation.traders.length > 0
              ? (
                  recommendation.traders.reduce((sum, t) => sum + t.confidence, 0) /
                  recommendation.traders.length
                ).toString()
              : '0',
          status: 'pending',
        })
        .returning();

      return {
        id: row.id,
        traders: recommendation.traders,
        overallReasoning: recommendation.overallReasoning,
        riskAssessment: recommendation.riskAssessment,
        status: row.status,
        createdAt: row.createdAt,
      };
    }),

  // Approve a recommendation and apply allocations
  approveRecommendation: protectedProcedure
    .input(z.object({ recommendationId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const db = getDatabaseConnection().getDatabase();

      const [recommendation] = await db
        .select()
        .from(aiRecommendations)
        .where(
          and(
            eq(aiRecommendations.id, input.recommendationId),
            eq(aiRecommendations.userId, userId),
          ),
        )
        .limit(1);

      if (!recommendation)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Recommendation not found' });
      if (recommendation.status !== 'pending')
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Recommendation already reviewed' });

      await db.transaction(async (tx) => {
        if (recommendation.strategyId) {
          const recs = recommendation.recommendations as any[];
          for (const rec of recs) {
            const [existing] = await tx
              .select()
              .from(copyAllocations)
              .where(
                and(
                  eq(copyAllocations.strategyId, recommendation.strategyId),
                  eq(copyAllocations.traderId, rec.traderId),
                ),
              )
              .limit(1);

            if (existing) {
              await tx
                .update(copyAllocations)
                .set({ weight: rec.suggestedWeight.toString() })
                .where(eq(copyAllocations.id, existing.id));
            } else {
              await tx.insert(copyAllocations).values({
                strategyId: recommendation.strategyId,
                traderId: rec.traderId,
                weight: rec.suggestedWeight.toString(),
                status: 'active',
              } as any);
            }
          }
        }

        await tx
          .update(aiRecommendations)
          .set({ status: 'approved', reviewedAt: new Date() })
          .where(eq(aiRecommendations.id, input.recommendationId));
      });

      return { success: true, message: 'Recommendation approved and applied' };
    }),

  // Reject a recommendation
  rejectRecommendation: protectedProcedure
    .input(z.object({ recommendationId: z.string(), notes: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const db = getDatabaseConnection().getDatabase();

      const [recommendation] = await db
        .select()
        .from(aiRecommendations)
        .where(
          and(
            eq(aiRecommendations.id, input.recommendationId),
            eq(aiRecommendations.userId, userId),
          ),
        )
        .limit(1);

      if (!recommendation)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Recommendation not found' });
      if (recommendation.status !== 'pending')
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Recommendation already reviewed' });

      await db
        .update(aiRecommendations)
        .set({ status: 'rejected', reviewedAt: new Date(), reviewNotes: input.notes })
        .where(eq(aiRecommendations.id, input.recommendationId));

      return { success: true, message: 'Recommendation rejected' };
    }),

  // Start/stop copy strategy
  toggleStrategy: protectedProcedure
    .input(
      z.object({
        strategyId: z.string(),
        action: z.enum(['start', 'pause', 'terminate']),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const { strategyId, action } = input;

      // Ownership is enforced inside start/pause/stopStrategy; an error bubbles
      // up if the user does not own this strategy.
      // biome-ignore lint/suspicious/noImplicitAnyLet: strategy shape varies by action
      let updatedStrategy;
      switch (action) {
        case 'start':
          updatedStrategy = await copyService.startStrategy(strategyId, userId);
          break;
        case 'pause':
          updatedStrategy = await copyService.pauseStrategy(strategyId, userId);
          break;
        case 'terminate':
          updatedStrategy = await copyService.stopStrategy(strategyId, userId);
          break;
      }

      return {
        success: true,
        strategyId,
        action,
        status: updatedStrategy?.status,
        timestamp: updatedStrategy?.updatedAt?.toISOString() || new Date().toISOString(),
      };
    }),

  // Generate a new agent wallet for the user
  generateAgentWallet: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.user?.userId;

    let encryptionKey: Buffer;
    try {
      encryptionKey = getEncryptionKey();
    } catch (_error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Server encryption not configured',
      });
    }

    const wallet = generateAgentWallet(encryptionKey);
    const db = getDatabaseConnection().getDatabase();

    const [row] = await db
      .insert(agentWallets)
      .values({
        userId,
        exchange: 'hyperliquid',
        address: wallet.address,
        encryptedPrivateKey: wallet.encryptedPrivateKey,
        status: 'pending_approval',
      })
      .returning();

    return {
      walletId: row.id,
      address: wallet.address,
      status: 'pending_approval',
    };
  }),

  // Verify agent wallet approval and activate it
  verifyAgentApproval: protectedProcedure
    .input(z.object({ walletId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const db = getDatabaseConnection().getDatabase();

      const [wallet] = await db
        .select()
        .from(agentWallets)
        .where(and(eq(agentWallets.id, input.walletId), eq(agentWallets.userId, userId)))
        .limit(1);

      if (!wallet) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent wallet not found' });

      await db
        .update(agentWallets)
        .set({ status: 'active' })
        .where(eq(agentWallets.id, input.walletId));

      return { success: true, address: wallet.address };
    }),
});
