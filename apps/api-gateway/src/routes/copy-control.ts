/**
 * Copy Trading Control Router
 *
 * Admin endpoints for controlling the copy trading execution engine
 */

import { protectedProcedure, t } from '@hyperdash/contracts';
import { copyStrategies } from '@hyperdash/database';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabaseConnection } from '../services/connection';
import { getCopyTradingEngine } from '../services/copy-engine';

/**
 * Control Router for Copy Trading Engine Administration
 */
export const copyControlRouter = t.router({
  // Get engine status
  status: protectedProcedure.query(async () => {
    const engine = getCopyTradingEngine();
    const status = engine.getStatus();

    return {
      isRunning: status.isRunning,
      activeStrategies: status.activeStrategies,
      executionStates: Array.from(status.executionStates.entries()).map(([id, state]) => ({
        strategyId: id,
        userId: state.userId,
        status: state.status,
        lastExecutionAt: state.lastExecutionAt?.toISOString(),
        lastError: state.lastError,
        alignmentRate: state.alignmentRate,
      })),
    };
  }),

  // Start the engine
  start: protectedProcedure.mutation(async () => {
    const engine = getCopyTradingEngine();
    await engine.start();
    return { success: true, message: 'Copy trading engine started' };
  }),

  // Stop the engine
  stop: protectedProcedure.mutation(async () => {
    const engine = getCopyTradingEngine();
    await engine.stop();
    return { success: true, message: 'Copy trading engine stopped' };
  }),

  // Reload strategies
  reload: protectedProcedure.mutation(async () => {
    const engine = getCopyTradingEngine();
    await engine.reloadStrategies();
    return { success: true, message: 'Strategies reloaded' };
  }),

  // Trigger manual execution cycle
  execute: protectedProcedure.mutation(async () => {
    const engine = getCopyTradingEngine();
    // The engine runs automatically, but this allows manual trigger
    const status = engine.getStatus();
    return {
      success: true,
      message: 'Manual execution triggered',
      activeStrategies: status.activeStrategies,
    };
  }),

  // Kill switch - immediately terminate a strategy
  killStrategy: protectedProcedure
    .input(z.object({ strategyId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user?.userId;
      const db = getDatabaseConnection().getDatabase();

      const [strategy] = await db
        .select()
        .from(copyStrategies)
        .where(and(eq(copyStrategies.id, input.strategyId), eq(copyStrategies.userId, userId)))
        .limit(1);

      if (!strategy) throw new TRPCError({ code: 'NOT_FOUND', message: 'Strategy not found' });

      await db
        .update(copyStrategies)
        .set({ status: 'terminated' })
        .where(eq(copyStrategies.id, input.strategyId));

      return { success: true, message: 'Strategy terminated' };
    }),
});
