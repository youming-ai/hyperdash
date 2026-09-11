import { t } from '@hyperdash/contracts';
import { z } from 'zod';
import { analyticsRouter } from './analytics';
import { copyRouter } from './copy';
import { copyControlRouter } from './copy-control';
import { marketRouter } from './market';
import { systemRouter } from './system';
import { tradersRouter } from './traders';
import { userRouter } from './user';

/**
 * Main tRPC Router for HyperDash Platform
 *
 * This router combines all feature-specific routers:
 * - market: Market data, OHLCV, heatmaps, and real-time prices
 * - traders: Trader profiles, rankings, and performance analytics
 * - copy: Copy trading operations and strategy management
 * - user: User management, authentication, and preferences
 * - analytics: Platform analytics and metrics
 * - system: System health, monitoring, and administrative functions
 */
export const appRouter = t.router({
  // Market Data Endpoints
  market: marketRouter,

  // Trader Analytics Endpoints
  traders: tradersRouter,

  // Copy Trading Endpoints
  copy: copyRouter,

  // Copy Trading Control (Admin)
  copyControl: copyControlRouter,

  // User Management Endpoints
  user: userRouter,

  // Analytics Endpoints
  analytics: analyticsRouter,

  // System & Admin Endpoints
  system: systemRouter,

  // Root health check
  health: t.procedure.query(
    // biome-ignore lint/correctness/noUnusedFunctionParameters: tRPC signature
    async ({ ctx }: { ctx: any }) => {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      };
    },
  ),

  // API Version and Capabilities
  info: t.procedure.query(
    // biome-ignore lint/correctness/noUnusedFunctionParameters: tRPC signature
    async ({ ctx }: { ctx: any }) => {
      return {
        name: 'HyperDash API',
        version: '1.0.0',
        description: 'Trading intelligence and copy trading platform',
        endpoints: {
          market: ['overview', 'ohlcv', 'heatmap', 'ticker', 'prices'],
          traders: ['profiles', 'rankings', 'performance', 'positions'],
          copy: ['strategies', 'allocations', 'performance', 'execution'],
          user: ['profile', 'wallets', 'preferences', 'alerts'],
          analytics: ['platform', 'market', 'traders', 'copy'],
          system: ['health', 'metrics', 'status'],
        },
        rateLimits: {
          default: '100 requests/minute',
          authenticated: '1000 requests/minute',
          premium: '5000 requests/minute',
        },
        supportedChains: ['ethereum'],
        supportedExchanges: ['hyperliquid'],
      };
    },
  ),

  // WebSocket authentication endpoint
  wsAuth: t.procedure.input(z.object({ token: z.string() })).mutation(
    // biome-ignore lint/correctness/noUnusedFunctionParameters: tRPC signature
    async ({ input, ctx }: { input: { token: string }; ctx: any }) => {
      // Implementation will validate JWT token and issue WebSocket auth token
      return {
        wsToken: 'ws_token_placeholder',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        permissions: ['market_data', 'trader_updates', 'copy_signals'],
      };
    },
  ),

  // Market data subscription validation
  validateSubscription: t.procedure
    .input(
      z.object({
        type: z.enum(['market', 'traders', 'copy']),
        symbols: z.array(z.string()).optional(),
        filters: z.record(z.string(), z.any()).optional(),
      }),
    )
    .mutation(
      async ({
        input,
        ctx,
      }: {
        input: { type: string; symbols?: string[]; filters?: Record<string, any> };
        ctx: any;
      }) => {
        // Implementation will validate if user can subscribe to requested data
        if (!ctx.user) {
          return { valid: false, reason: 'Authentication required' };
        }

        // Check user subscription level
        const maxSymbols = ctx.user.kycLevel >= 2 ? 100 : 10;
        if (input.symbols && input.symbols.length > maxSymbols) {
          return {
            valid: false,
            reason: `Maximum ${maxSymbols} symbols allowed for your subscription level`,
          };
        }

        return {
          valid: true,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        };
      },
    ),
});

export type AppRouter = typeof appRouter;
