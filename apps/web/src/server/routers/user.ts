import { zValidator } from '@hono/zod-validator';
import { users } from '@hyperdash/database/schema';
import {
  AgentWallet,
  Notification,
  PriceAlert,
  UserProfile,
  UserStatistics,
  UserTrade,
} from '@hyperdash/shared-types';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession } from '~/server/middleware/auth';
import type { AppEnv } from '~/server/types';
import { resolveBusinessUserId } from '~/server/user';

const updateProfileBody = z.object({
  email: z.string().email().optional(),
  preferences: z
    .object({
      theme: z.enum(['light', 'dark']).optional(),
      language: z.string().optional(),
      timezone: z.string().optional(),
      notifications: z
        .object({
          email: z.boolean().optional(),
          push: z.boolean().optional(),
          trading: z.boolean().optional(),
          priceAlerts: z.boolean().optional(),
        })
        .optional(),
      privacy: z
        .object({
          showFollowing: z.boolean().optional(),
          showPortfolio: z.boolean().optional(),
          allowAnalytics: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

const addWalletBody = z.object({
  exchange: z.string().default('hyperliquid'),
  address: z.string(),
  minOrderUsd: z.number().positive().default(100),
  maxLeverage: z.number().min(1).max(10).default(5),
  permissions: z.object({
    trade: z.boolean().default(true),
    withdraw: z.boolean().default(false),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const alertsQuery = z.object({
  status: z.enum(['active', 'triggered', 'all']).default('active'),
  limit: z.coerce.number().min(1).max(50).default(20),
});

const createAlertBody = z.object({
  symbol: z.string(),
  type: z.enum(['price_above', 'price_below', 'percent_change']),
  targetPrice: z.number().optional(),
  percentChange: z.number().optional(),
  repeat: z.boolean().default(false),
  expiresAt: z.string().optional(),
});

const deleteAlertBody = z.object({
  alertId: z.string(),
});

const notificationsQuery = z.object({
  type: z.enum(['all', 'trading', 'system', 'price', 'social']).default('all'),
  read: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().min(1).max(50).default(20),
  offset: z.coerce.number().min(0).default(0),
});

const markNotificationsReadBody = z.object({
  notificationIds: z.array(z.string()).optional(),
  markAll: z.boolean().default(false),
});

const tradingHistoryQuery = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  symbol: z.string().optional(),
  strategyId: z.string().optional(),
});

const statisticsQuery = z.object({
  timeframe: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
});

export const userRouter = new Hono<AppEnv>()
  .get('/profile', requireSession, async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);

    const [user] = await db
      .select({
        kycLevel: users.kycLevel,
        status: users.status,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const now = new Date().toISOString();
    const profile = UserProfile.parse({
      userId,
      email: 'user@example.com',
      walletAddr: session.walletAddress,
      kycLevel: user?.kycLevel ?? 0,
      status: user?.status ?? 'active',
      preferences: {
        theme: 'dark',
        language: 'en',
        timezone: 'UTC',
        notifications: {
          email: true,
          push: true,
          trading: true,
          priceAlerts: true,
        },
        privacy: {
          showFollowing: false,
          showPortfolio: false,
          allowAnalytics: true,
        },
      },
      subscription: {
        tier: 'premium',
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        features: ['unlimited_symbols', 'advanced_analytics', 'api_access'],
      },
      stats: {
        totalStrategies: 3,
        activeStrategies: 2,
        totalTradersFollowed: 5,
        totalPnl: 12500,
        totalVolume: 500000,
        joinDate: '2024-01-15T10:30:00Z',
        lastLogin: now,
      },
      createdAt: user?.createdAt?.toISOString() ?? '2024-01-15T10:30:00Z',
      updatedAt: user?.updatedAt?.toISOString() ?? now,
    });

    return c.json(profile);
  })
  .post('/profile', requireSession, zValidator('json', updateProfileBody), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const updates = c.req.valid('json');

    return c.json({
      success: true,
      userId,
      updates,
      updatedAt: new Date().toISOString(),
    });
  })
  .get('/wallets', requireSession, async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);

    const mockWallets = [
      {
        id: 'wallet_1',
        userId,
        exchange: 'hyperliquid',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        status: 'active',
        minOrderUsd: 100,
        maxLeverage: 5,
        permissions: { trade: true, withdraw: false },
        metadata: { name: 'Main Trading Wallet' },
        positions: [
          {
            symbol: 'BTC-PERP',
            side: 'long',
            size: 1.5,
            entryPrice: 42000,
            markPrice: 42500,
            unrealizedPnl: 750,
          },
        ],
        balance: {
          total: 25000,
          available: 15000,
          used: 10000,
        },
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'wallet_2',
        userId,
        exchange: 'hyperliquid',
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
        status: 'inactive',
        minOrderUsd: 50,
        maxLeverage: 3,
        permissions: { trade: true, withdraw: false },
        metadata: { name: 'Testing Wallet' },
        positions: [],
        balance: {
          total: 5000,
          available: 5000,
          used: 0,
        },
        createdAt: '2024-02-01T14:20:00Z',
        updatedAt: '2024-02-15T09:45:00Z',
      },
    ];

    return c.json(mockWallets.map((wallet) => AgentWallet.parse(wallet)));
  })
  .post('/wallets', requireSession, zValidator('json', addWalletBody), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);

    const [user] = await db
      .select({ kycLevel: users.kycLevel })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if ((user?.kycLevel ?? 0) < 1) {
      return c.json({ error: 'KYC level 1 required' }, 403);
    }

    const { exchange, address, minOrderUsd, maxLeverage, permissions, metadata } =
      c.req.valid('json');
    const newWallet = {
      id: `wallet_${Date.now()}`,
      userId,
      exchange,
      address,
      status: 'active',
      minOrderUsd,
      maxLeverage,
      permissions,
      metadata: metadata ?? {},
      positions: [],
      balance: { total: 0, available: 0, used: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return c.json(AgentWallet.parse(newWallet));
  })
  .get('/alerts', requireSession, zValidator('query', alertsQuery), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { status, limit } = c.req.valid('query');

    const mockAlerts = [
      {
        id: 'alert_1',
        userId,
        symbol: 'BTC-PERP',
        type: 'price_above',
        targetPrice: 45000,
        status: 'active',
        createdAt: '2025-01-18T08:30:00Z',
        updatedAt: '2025-01-18T08:30:00Z',
      },
      {
        id: 'alert_2',
        userId,
        symbol: 'ETH-PERP',
        type: 'price_below',
        targetPrice: 2500,
        status: 'triggered',
        triggeredAt: '2025-01-18T14:15:00Z',
        createdAt: '2025-01-17T16:45:00Z',
        updatedAt: '2025-01-18T14:15:00Z',
      },
    ];

    const filtered =
      status === 'all' ? mockAlerts : mockAlerts.filter((alert) => alert.status === status);
    return c.json(filtered.slice(0, limit).map((alert) => PriceAlert.parse(alert)));
  })
  .post('/alerts', requireSession, zValidator('json', createAlertBody), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { symbol, type, targetPrice, percentChange, repeat, expiresAt } = c.req.valid('json');

    const newAlert = {
      id: `alert_${Date.now()}`,
      userId,
      symbol,
      type,
      targetPrice,
      percentChange,
      status: 'active',
      repeat,
      expiresAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return c.json(PriceAlert.parse(newAlert));
  })
  .post('/alerts/delete', requireSession, zValidator('json', deleteAlertBody), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const { alertId } = c.req.valid('json');

    return c.json({
      success: true,
      alertId,
      deletedAt: new Date().toISOString(),
    });
  })
  .get('/notifications', requireSession, zValidator('query', notificationsQuery), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { type, read, limit, offset } = c.req.valid('query');

    const mockNotifications = [
      {
        id: 'notif_1',
        userId,
        type: 'trading',
        title: 'Copy Trade Executed',
        message: 'Successfully copied BTC-PERP trade from WhaleTrader42',
        data: { traderId: 'trader_42', symbol: 'BTC-PERP', size: 1.2 },
        read: false,
        createdAt: '2025-01-18T15:30:00Z',
      },
      {
        id: 'notif_2',
        userId,
        type: 'price',
        title: 'Price Alert Triggered',
        message: 'ETH-PERP has dropped below $2,500',
        data: { symbol: 'ETH-PERP', currentPrice: 2480, targetPrice: 2500 },
        read: true,
        createdAt: '2025-01-18T14:15:00Z',
      },
      {
        id: 'notif_3',
        userId,
        type: 'system',
        title: 'Strategy Performance Update',
        message: 'Your "Conservative Portfolio" strategy is up 2.3% this week',
        data: { strategyId: 'strategy_1', weeklyReturn: 0.023 },
        read: false,
        createdAt: '2025-01-18T12:00:00Z',
      },
    ];

    let filtered = mockNotifications;
    if (type !== 'all') {
      filtered = filtered.filter((notif) => notif.type === type);
    }
    if (read !== undefined) {
      filtered = filtered.filter((notif) => notif.read === read);
    }

    const paginated = filtered.slice(offset, offset + limit);
    return c.json({
      notifications: paginated.map((notif) => Notification.parse(notif)),
      total: filtered.length,
      unread: filtered.filter((notif) => !notif.read).length,
    });
  })
  .post(
    '/notifications/read',
    requireSession,
    zValidator('json', markNotificationsReadBody),
    async (c) => {
      const session = c.get('session');
      if (!session) return c.json({ error: 'unauthorized' }, 401);

      const { notificationIds, markAll } = c.req.valid('json');

      return c.json({
        success: true,
        markedCount: markAll ? -1 : (notificationIds?.length ?? 0),
        timestamp: new Date().toISOString(),
      });
    },
  )
  .get('/trading-history', requireSession, zValidator('query', tradingHistoryQuery), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const db = c.get('db');
    const userId = await resolveBusinessUserId(db, session.walletAddress);
    const { limit, offset, symbol, strategyId } = c.req.valid('query');

    const mockHistory = Array.from({ length: Math.min(20, limit) }, (_, i) => ({
      id: `trade_${offset + i + 1}`,
      userId,
      symbol: symbol ?? ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'][i % 3],
      side: Math.random() > 0.5 ? 'buy' : 'sell',
      size: (Math.random() * 5 + 0.1).toFixed(2),
      price: Math.random() * 50000 + 1000,
      fee: Math.random() * 50,
      realizedPnl: (Math.random() - 0.3) * 2000,
      isCopyTrade: Math.random() > 0.5,
      strategyId: strategyId ?? `strategy_${Math.floor(Math.random() * 3) + 1}`,
      timestamp: new Date(Date.now() - (offset + i) * 3600000).toISOString(),
    }));

    return c.json(mockHistory.map((trade) => UserTrade.parse(trade)));
  })
  .get('/statistics', requireSession, zValidator('query', statisticsQuery), async (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    const { timeframe } = c.req.valid('query');

    const mockStats = {
      timeframe,
      periodStart: new Date(Date.now() - 30 * 86400000).toISOString(),
      periodEnd: new Date().toISOString(),
      overview: {
        totalReturn: 0.125,
        totalPnl: 12500,
        totalVolume: 500000,
        totalFees: 2500,
        netReturn: 10000,
      },
      copyTrading: {
        activeStrategies: 2,
        totalTradersFollowed: 5,
        alignmentRate: 96.5,
        copyVolume: 300000,
        copyPnl: 8000,
      },
      performance: {
        winRate: 0.62,
        profitFactor: 1.8,
        sharpeRatio: 1.45,
        maxDrawdown: 0.08,
        totalTrades: 145,
        winningTrades: 90,
        losingTrades: 55,
      },
      risk: {
        leverageUsage: { avg: 2.8, max: 5.0 },
        positionConcentration: { topSymbol: 'BTC-PERP', concentration: 0.45 },
        varDaily: { confidence95: 2500, confidence99: 3800 },
      },
      engagement: {
        loginDays: 25,
        avgSessionTime: 45,
        alertsCreated: 8,
        notificationsRead: 85,
      },
    };

    return c.json(UserStatistics.parse(mockStats));
  });
