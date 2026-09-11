import type { z } from 'zod';
import { AgentWallet, Notification, PriceAlert, UserStatistics, UserTrade } from './index';

// Dev fixtures until wallets/alerts/notifications tables ship — delete when DB
// lands. Single source for apps/api + apps/web so the two routers stay in sync.

export function mockWallets(userId: string) {
  return [
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
      balance: { total: 25000, available: 15000, used: 10000 },
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
      balance: { total: 5000, available: 5000, used: 0 },
      createdAt: '2024-02-01T14:20:00Z',
      updatedAt: '2024-02-15T09:45:00Z',
    },
  ];
}

export function mockAlerts(userId: string) {
  return [
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
}

export function mockNotifications(userId: string) {
  return [
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
}

export function mockTradingHistory(
  userId: string,
  opts: { limit: number; offset: number; symbol?: string; strategyId?: string },
) {
  const { limit, offset, symbol, strategyId } = opts;
  return Array.from({ length: Math.min(20, limit) }, (_, i) => ({
    id: `trade_${offset + i + 1}`,
    userId,
    symbol: symbol ?? (['BTC-PERP', 'ETH-PERP', 'SOL-PERP'] as const)[i % 3],
    side: i % 2 === 0 ? 'buy' : 'sell',
    size: ((i * 37) % 50) / 10 + 0.1,
    price: ((i * 7919) % 50000) + 1000,
    fee: ((i * 13) % 50) + 1,
    realizedPnl: ((i * 977) % 4000) - 1200,
    isCopyTrade: i % 2 === 0,
    strategyId: strategyId ?? `strategy_${(i % 3) + 1}`,
    timestamp: new Date(Date.now() - (offset + i) * 3600000).toISOString(),
  }));
}

export function mockStatistics(timeframe: string) {
  return {
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
    engagement: { loginDays: 25, avgSessionTime: 45, alertsCreated: 8, notificationsRead: 85 },
  };
}

/**
 * Fixture types, derived from the schemas rather than from `ReturnType` of the
 * mock factories: the schema is the contract these fixtures must satisfy, so
 * inferring from it keeps the two from drifting. `parseMock*` below enforces
 * that at runtime.
 */
export type MockWallet = z.infer<typeof AgentWallet>;
export type MockAlert = z.infer<typeof PriceAlert>;
export type MockNotification = z.infer<typeof Notification>;
export type MockTrade = z.infer<typeof UserTrade>;
export type MockStatistics = z.infer<typeof UserStatistics>;

type ParsedWallet = MockWallet;
type ParsedAlert = MockAlert;
type ParsedNotification = MockNotification;
type ParsedTrade = MockTrade;
type ParsedStatistics = MockStatistics;

export function parseMockWallets(userId: string): ParsedWallet[] {
  return mockWallets(userId).map((wallet) => AgentWallet.parse(wallet));
}

export function parseMockAlerts(userId: string): ParsedAlert[] {
  return mockAlerts(userId).map((alert) => PriceAlert.parse(alert));
}

export function parseMockNotifications(userId: string): ParsedNotification[] {
  return mockNotifications(userId).map((notif) => Notification.parse(notif));
}

export function parseMockTradingHistory(
  userId: string,
  opts: { limit: number; offset: number; symbol?: string; strategyId?: string },
): ParsedTrade[] {
  return mockTradingHistory(userId, opts).map((trade) => UserTrade.parse(trade));
}

export function parseMockStatistics(timeframe: string): ParsedStatistics {
  return UserStatistics.parse(mockStatistics(timeframe));
}
