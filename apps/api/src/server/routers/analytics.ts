import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '~/server/types';

const overviewQuery = z.object({
  timeframe: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
});

const marketQuery = z.object({
  timeframe: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
});

const tradersQuery = z.object({
  timeframe: z.enum(['7d', '30d', '90d']).default('30d'),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const copyQuery = z.object({
  timeframe: z.enum(['7d', '30d', '90d']).default('30d'),
});

export const analyticsRouter = new Hono<AppEnv>()
  .get('/overview', zValidator('query', overviewQuery), async (c) => {
    const { timeframe } = c.req.valid('query');
    return c.json({
      timeframe,
      totalUsers: 0,
      activeUsers: 0,
      totalStrategies: 0,
      totalVolume: 0,
      totalPnl: 0,
    });
  })
  .get('/market', zValidator('query', marketQuery), async (c) => {
    const { timeframe } = c.req.valid('query');
    return c.json({
      timeframe,
      topSymbols: [],
      volumeByExchange: {},
      priceChanges: {},
    });
  })
  .get('/traders', zValidator('query', tradersQuery), async (c) => {
    const { timeframe, limit } = c.req.valid('query');
    return c.json({
      timeframe,
      limit,
      topPerformers: [],
      worstPerformers: [],
      averageMetrics: {
        pnl: 0,
        winrate: 0,
        sharpe: 0,
      },
    });
  })
  .get('/copy', zValidator('query', copyQuery), async (c) => {
    const { timeframe } = c.req.valid('query');
    return c.json({
      timeframe,
      totalCopiedTrades: 0,
      averageAlignmentRate: 0,
      totalCopyPnl: 0,
    });
  });
