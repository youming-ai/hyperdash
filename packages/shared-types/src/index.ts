import { z } from 'zod';

// Market Data Schemas
export const MarketOverviewSchema = z.object({
  symbol: z.string(),
  exchange: z.string(),
  timestamp: z.string(),
  price: z.number(),
  markPrice: z.number(),
  indexPrice: z.number(),
  fundingRate: z.number(),
  nextFundingTime: z.string(),
  openInterest: z.number(),
  volume24h: z.number(),
  longShortRatio: z.number(),
  volatility24h: z.number(),
});

export const OHLCVSchema = z.object({
  timestamp: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  tradeCount: z.number().optional(),
});

export const HeatmapBinSchema = z.object({
  priceBinCenter: z.number(),
  priceBinWidth: z.number(),
  liquidationVolume: z.number(),
  liquidationCount: z.number(),
  liquidationNotional: z.number(),
  confidenceScore: z.number(),
});

// Trader Schemas
export const TraderSchema = z.object({
  id: z.string(),
  alias: z.string(),
  publicScore: z.number(),
  tags: z.array(z.string()),
  performance: z.object({
    pnl: z.number(),
    returnPct: z.number(),
    sharpeRatio: z.number(),
    maxDrawdown: z.number(),
    winRate: z.number(),
    avgHoldTimeHours: z.number(),
  }),
  tradingActivity: z.object({
    tradeCount: z.number(),
    volume: z.number(),
    turnover: z.number(),
    avgTradeSize: z.number(),
  }),
  riskMetrics: z.object({
    avgLeverage: z.number(),
    maxLeverage: z.number(),
    var95: z.number(),
  }),
  symbolPreferences: z.array(
    z.object({
      symbol: z.string(),
      volumePct: z.number(),
      pnl: z.number(),
    }),
  ),
});

// Copy Trading Schemas
export const CopyStrategySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['paused', 'active', 'error', 'terminated']),
  mode: z.enum(['portfolio', 'single_trader']),
  maxLeverage: z.number(),
  slippageBps: z.number(),
  minOrderUsd: z.number(),
  followNewEntriesOnly: z.boolean(),
  totalPnl: z.number(),
  totalFees: z.number(),
  alignmentRate: z.number(),
});

// Strategy allocation — single source for web + api-gateway validation
// ponytail: keep validation here so weights sum to 1 in one place, upgrade to per-strategy caps if needed
export const AllocationSchema = z.object({
  traderId: z.string().min(1),
  weight: z.number().min(0).max(1),
});
export type Allocation = z.infer<typeof AllocationSchema>;

export function validateAllocationWeights(
  mode: 'portfolio' | 'single_trader',
  allocations: Array<{ weight: number }>,
): void {
  if (allocations.length === 0) throw new Error('Strategy must have at least one allocation');
  for (const a of allocations) {
    if (!(a.weight > 0 && a.weight <= 1))
      throw new Error(`Allocation weight must be in (0, 1]; got ${a.weight}`);
  }
  if (mode === 'single_trader') {
    if (allocations.length !== 1)
      throw new Error(`single_trader requires exactly one allocation; got ${allocations.length}`);
    if (Math.abs(allocations[0].weight - 1) > 0.0001)
      throw new Error(`single_trader weight must be 1; got ${allocations[0].weight}`);
    return;
  }
  const sum = allocations.reduce((acc, a) => acc + a.weight, 0);
  if (Math.abs(sum - 1) > 0.0001)
    throw new Error(`Portfolio weights must sum to 1; got ${sum.toFixed(4)}`);
}

/** Coerce DB numeric (string | number | null) to number, single source for pnl/equity parsing. */
export function toNumber(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Export types
export type MarketOverview = z.infer<typeof MarketOverviewSchema>;
export type OHLCV = z.infer<typeof OHLCVSchema>;
export type HeatmapBin = z.infer<typeof HeatmapBinSchema>;
export type Trader = z.infer<typeof TraderSchema>;
export type CopyStrategy = z.infer<typeof CopyStrategySchema>;

// Additional schemas used by API routes
export const SystemHealth = z.object({
  overall: z.string(),
  timestamp: z.string(),
  version: z.string(),
  uptime: z.number(),
  components: z.record(z.string(), z.any()),
  metrics: z.record(z.string(), z.any()),
});

export const SystemMetrics = z.object({
  timeframe: z.string(),
  granularity: z.string(),
  generatedAt: z.string(),
  system: z.record(z.string(), z.any()),
  application: z.record(z.string(), z.any()),
});

export const SystemStatus = z.object({
  timestamp: z.string(),
  services: z.record(z.string(), z.any()),
  alerts: z.array(z.any()),
  recentEvents: z.array(z.any()),
});

export const UserProfile = z.object({
  userId: z.string(),
  email: z.string().optional(),
  walletAddr: z.string().optional(),
  kycLevel: z.number().optional(),
  status: z.string().optional(),
  preferences: z.record(z.string(), z.any()).optional(),
  subscription: z.record(z.string(), z.any()).optional(),
  stats: z.record(z.string(), z.any()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const AgentWallet = z.object({
  id: z.string(),
  userId: z.string().optional(),
  exchange: z.string().optional(),
  address: z.string().optional(),
  status: z.string().optional(),
  minOrderUsd: z.number().optional(),
  maxLeverage: z.number().optional(),
  permissions: z.record(z.string(), z.any()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  positions: z.array(z.any()).optional(),
  balance: z.record(z.string(), z.any()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const PriceAlert = z.object({
  id: z.string(),
  userId: z.string().optional(),
  symbol: z.string().optional(),
  type: z.string().optional(),
  targetPrice: z.number().optional(),
  percentChange: z.number().optional(),
  status: z.string().optional(),
  repeat: z.boolean().optional(),
  expiresAt: z.string().optional(),
  triggeredAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const Notification = z.object({
  id: z.string(),
  userId: z.string().optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
  data: z.record(z.string(), z.any()).optional(),
  read: z.boolean().optional(),
  createdAt: z.string().optional(),
});

export const UserTrade = z.object({
  id: z.string(),
  userId: z.string().optional(),
  symbol: z.string().optional(),
  side: z.string().optional(),
  size: z.union([z.string(), z.number()]).optional(),
  price: z.number().optional(),
  fee: z.number().optional(),
  realizedPnl: z.number().optional(),
  isCopyTrade: z.boolean().optional(),
  strategyId: z.string().optional(),
  timestamp: z.string().optional(),
});

export const UserStatistics = z.object({
  timeframe: z.string().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  overview: z.record(z.string(), z.any()).optional(),
  copyTrading: z.record(z.string(), z.any()).optional(),
  performance: z.record(z.string(), z.any()).optional(),
  risk: z.record(z.string(), z.any()).optional(),
  engagement: z.record(z.string(), z.any()).optional(),
});

export type { AgentApprovalState, ExtraAgent } from './agent-approval';
// Exchange-side verification, shared by the BE router and the executor.
export { checkAgentApproval, fetchExtraAgents, submitSignedAction } from './agent-approval';
// AES-256-GCM key handling that runs on both Workers and Bun.
export {
  decryptAgentKey,
  encryptAgentKey,
  generateEncryptionKeyHex,
  parseEncryptionKey,
} from './agent-key';
export type {
  AgentApprovalConfirm,
  AgentApprovalIntent,
  AgentApprovalStatus,
  AgentSignature,
  ApproveAgentInput,
  ApproveAgentTypedData,
  HyperliquidNetwork,
} from './agent-wallet';
// Agent-wallet approval contract, shared by the BE router and the web hook so
// the signed message and the submitted action cannot drift apart.
export {
  AGENT_EXPIRY_WARNING_MS,
  AgentApprovalConfirmSchema,
  AgentApprovalIntentSchema,
  AgentApprovalStatusSchema,
  AgentSignatureSchema,
  ApproveAgentTypes,
  agentNameBase,
  buildAgentName,
  buildApproveAgentAction,
  buildApproveAgentTypedData,
  DEFAULT_AGENT_VALIDITY_MS,
  HYPERLIQUID_CHAIN_ID,
  HYPERLIQUID_EXCHANGE_URL,
  HYPERLIQUID_INFO_URL,
  HYPERLIQUID_MAINNET_URL,
  HYPERLIQUID_SIGNATURE_CHAIN_ID,
  HYPERLIQUID_TESTNET_URL,
  hyperliquidApiUrl,
  hyperliquidExchangeUrl,
  hyperliquidInfoUrl,
  isApprovalExpiring,
  MAX_AGENT_NAME_LENGTH,
  networkOf,
  parseAgentValidity,
  ZERO_ADDRESS,
} from './agent-wallet';
// Schemas namespace for convenient access
export {
  default as feed,
  FeedBook,
  FeedCandle,
  FeedCtx,
  FeedLevel,
  FeedState,
  FeedTrade,
  FundingPoint,
  OiPoint,
  PricePoint,
  StressPoint,
  VolumePoint,
  WhaleFlowPoint,
} from './feed';
export type { HyperliquidAssetCtx, HyperliquidMeta } from './hyperliquid';
export {
  HyperliquidApiError,
  HyperliquidAssetCtxSchema,
  HyperliquidMetaSchema,
  hyperliquidRequest,
  resolveInfoUrl,
} from './hyperliquid';
export type {
  MockAlert,
  MockNotification,
  MockStatistics,
  MockTrade,
  MockWallet,
} from './user-fixtures';
export {
  mockAlerts,
  mockNotifications,
  mockStatistics,
  mockTradingHistory,
  mockWallets,
  parseMockAlerts,
  parseMockNotifications,
  parseMockStatistics,
  parseMockTradingHistory,
  parseMockWallets,
} from './user-fixtures';
export type { TradeSource, WhaleEntry } from './whale-discovery';
export { MIN_SAMPLE_MS, WhaleDiscovery } from './whale-discovery';

import {
  FeedBookSchema,
  FeedCandleSchema,
  FeedCtxSchema,
  FeedLevelSchema,
  FeedStateSchema,
  FeedTradeSchema,
  FundingPointSchema,
  OiPointSchema,
  PricePointSchema,
  StressPointSchema,
  VolumePointSchema,
  WhaleFlowPointSchema,
} from './feed';

export const schemas = {
  SystemHealth,
  SystemMetrics,
  SystemStatus,
  UserProfile,
  AgentWallet,
  PriceAlert,
  Notification,
  UserTrade,
  UserStatistics,
  MarketOverview: MarketOverviewSchema,
  OHLCV: OHLCVSchema,
  HeatmapBin: HeatmapBinSchema,
  Trader: TraderSchema,
  CopyStrategy: CopyStrategySchema,
  FeedLevel: FeedLevelSchema,
  FeedBook: FeedBookSchema,
  FeedTrade: FeedTradeSchema,
  FeedCandle: FeedCandleSchema,
  FeedCtx: FeedCtxSchema,
  FeedState: FeedStateSchema,
  FundingPoint: FundingPointSchema,
  PricePoint: PricePointSchema,
  OiPoint: OiPointSchema,
  VolumePoint: VolumePointSchema,
  StressPoint: StressPointSchema,
  WhaleFlowPoint: WhaleFlowPointSchema,
};

export * from './hyperliquid';
