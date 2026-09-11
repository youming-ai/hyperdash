// Better Auth tables (generated via `bun run auth:generate`). Re-exported so the
// Drizzle client built in the Worker includes auth tables alongside business tables.
export {
  account,
  accountRelations,
  session,
  sessionRelations,
  user,
  userRelations,
  verification,
  walletAddress,
  walletAddressRelations,
} from './auth-schema';

import {
  boolean,
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Trader statistics table
export const traderStats = pgTable(
  'trader_stats',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    traderId: uuid('trader_id').notNull().unique(),
    address: text('address').notNull().unique(),

    // Equity and PnL
    equityUsd: decimal('equity_usd', { precision: 20, scale: 2 }).default('0'),
    pnl7d: decimal('pnl_7d', { precision: 10, scale: 2 }).default('0'),
    pnl30d: decimal('pnl_30d', { precision: 10, scale: 2 }).default('0'),
    pnlAll: decimal('pnl_all', { precision: 10, scale: 2 }).default('0'),

    // Performance metrics
    winrate: decimal('winrate', { precision: 5, scale: 2 }).default('0'),
    totalTrades: integer('total_trades').default(0),
    winningTrades: integer('winning_trades').default(0),
    losingTrades: integer('losing_trades').default(0),

    // Risk metrics
    maxDrawdown: decimal('max_drawdown', { precision: 10, scale: 2 }).default('0'),
    avgHoldTimeSeconds: integer('avg_hold_time_seconds').default(0),
    sharpeRatio: decimal('sharpe_ratio', { precision: 8, scale: 4 }),

    // Activity
    lastTradeAt: timestamp('last_trade_at'),
    firstTradeAt: timestamp('first_trade_at'),
    activeDays: integer('active_days').default(0),

    // Position preferences
    longTrades: integer('long_trades').default(0),
    shortTrades: integer('short_trades').default(0),
    avgPositionSizeUsd: decimal('avg_position_size_usd', {
      precision: 18,
      scale: 2,
    }).default('0'),

    // Ranking
    rank7d: integer('rank_7d'),
    rank30d: integer('rank_30d'),
    rankAll: integer('rank_all'),

    // Metadata
    metadata: jsonb('metadata').default('{}'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    traderIdIdx: index('idx_trader_stats_trader_id').on(table.traderId),
    addressIdx: index('idx_trader_stats_address').on(table.address),
    pnl7dIdx: index('idx_trader_stats_pnl_7d').on(table.pnl7d),
    pnl30dIdx: index('idx_trader_stats_pnl_30d').on(table.pnl30d),
    winrateIdx: index('idx_trader_stats_winrate').on(table.winrate),
    lastTradeIdx: index('idx_trader_stats_last_trade').on(table.lastTradeAt),
    rank7dIdx: index('idx_trader_stats_rank_7d').on(table.rank7d),
    rank30dIdx: index('idx_trader_stats_rank_30d').on(table.rank30d),
  }),
);

// Trader trades history table
export const traderTrades = pgTable(
  'trader_trades',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    traderId: uuid('trader_id').notNull(),
    traderAddress: text('trader_address').notNull(),

    // Trade details
    symbol: text('symbol').notNull(),
    side: text('side').notNull(), // 'long' or 'short'
    action: text('action').notNull(), // 'open', 'close', 'increase', 'decrease'

    // Size and price
    size: decimal('size', { precision: 20, scale: 8 }).notNull(),
    entryPrice: decimal('entry_price', { precision: 20, scale: 8 }),
    exitPrice: decimal('exit_price', { precision: 20, scale: 8 }),

    // PnL
    pnl: decimal('pnl', { precision: 20, scale: 2 }).default('0'),
    pnlBps: integer('pnl_bps').default(0),
    feeUsd: decimal('fee_usd', { precision: 18, scale: 2 }).default('0'),

    // Timing
    openedAt: timestamp('opened_at').notNull(),
    closedAt: timestamp('closed_at'),
    holdDurationSeconds: integer('hold_duration_seconds'),

    // Market context
    markPriceAtEntry: decimal('mark_price_at_entry', {
      precision: 20,
      scale: 8,
    }),
    markPriceAtExit: decimal('mark_price_at_exit', { precision: 20, scale: 8 }),

    // Exchange reference
    exchangeTradeId: text('exchange_trade_id'),
    exchange: text('exchange').default('hyperliquid'),

    // Metadata
    metadata: jsonb('metadata').default('{}'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    traderIdIdx: index('idx_trader_trades_trader_id').on(table.traderId),
    addressIdx: index('idx_trader_trades_address').on(table.traderAddress),
    symbolIdx: index('idx_trader_trades_symbol').on(table.symbol),
    openedAtIdx: index('idx_trader_trades_opened_at').on(table.openedAt),
    closedAtIdx: index('idx_trader_trades_closed_at').on(table.closedAt),
    sideIdx: index('idx_trader_trades_side').on(table.side),
  }),
);

export const traderPositions = pgTable(
  'trader_positions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    traderId: uuid('trader_id')
      .notNull()
      .references(() => traderStats.traderId, { onDelete: 'cascade' }),
    traderAddress: text('trader_address').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    quantity: decimal('quantity', { precision: 20, scale: 8 }).notNull(),
    entryPrice: decimal('entry_price', { precision: 20, scale: 8 }).notNull(),
    markPrice: decimal('mark_price', { precision: 20, scale: 8 }).notNull(),
    positionValueUsd: decimal('position_value_usd', {
      precision: 20,
      scale: 2,
    }).notNull(),
    unrealizedPnl: decimal('unrealized_pnl', { precision: 20, scale: 2 }).default('0'),
    marginUsed: decimal('margin_used', { precision: 20, scale: 2 }).default('0'),
    leverage: decimal('leverage', { precision: 8, scale: 2 }).default('1'),
    liquidationPrice: decimal('liquidation_price', { precision: 20, scale: 8 }),
    metadata: jsonb('metadata').default('{}'),
    lastUpdatedAt: timestamp('last_updated_at').defaultNow(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    traderIdIdx: index('idx_trader_positions_trader_id').on(table.traderId),
    addressIdx: index('idx_trader_positions_address').on(table.traderAddress),
    symbolIdx: index('idx_trader_positions_symbol').on(table.symbol),
    uniquePosition: uniqueIndex('idx_trader_positions_unique').on(
      table.traderId,
      table.symbol,
      table.side,
    ),
  }),
);

// Types
export type TraderStats = typeof traderStats.$inferSelect;
export type NewTraderStats = typeof traderStats.$inferInsert;
export type TraderTrades = typeof traderTrades.$inferSelect;
export type NewTraderTrades = typeof traderTrades.$inferInsert;
export type TraderPosition = typeof traderPositions.$inferSelect;
export type NewTraderPosition = typeof traderPositions.$inferInsert;

// ============================================================================
// COPY TRADING TABLES
// ============================================================================

// Users table - stores user account information
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    walletAddress: text('wallet_address').notNull().unique(),

    // Account status
    status: text('status').default('active').notNull(), // 'active', 'suspended', 'closed'
    kycLevel: integer('kyc_level').default(0), // 0=none, 1=basic, 2=intermediate, 3=full

    // Preferences
    preferences: jsonb('preferences').default('{}'),

    // Timestamps
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    walletIdx: index('idx_users_wallet').on(table.walletAddress),
    statusIdx: index('idx_users_status').on(table.status),
  }),
);

// Agent wallets - user's trading wallets on exchanges
export const agentWallets = pgTable(
  'agent_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Exchange info
    exchange: text('exchange').default('hyperliquid').notNull(),
    address: text('address').notNull(),

    // Wallet settings
    status: text('status').default('active').notNull(), // 'active', 'inactive', 'suspended'
    minOrderUsd: decimal('min_order_usd', { precision: 18, scale: 8 }).default('5'),
    maxLeverage: integer('max_leverage').default(5),

    // Permissions
    permissions: jsonb('permissions').default('{ "trade": true, "withdraw": false }'),
    encryptedPrivateKey: text('encrypted_private_key'),

    // Metadata
    metadata: jsonb('metadata').default('{}'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_agent_wallets_user_id').on(table.userId),
    addressIdx: index('idx_agent_wallets_address').on(table.address),
    statusIdx: index('idx_agent_wallets_status').on(table.status),
  }),
);

// Copy strategies - user's copy trading configurations
export const copyStrategies = pgTable(
  'copy_strategies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Strategy info
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').default('paused').notNull(), // 'paused', 'active', 'error', 'terminated'

    // Strategy mode
    mode: text('mode').default('portfolio').notNull(), // 'portfolio' (multiple traders) or 'single_trader'

    // Risk settings
    maxLeverage: decimal('max_leverage', { precision: 5, scale: 2 }).default('5'),
    maxPositionUsd: decimal('max_position_usd', { precision: 18, scale: 8 }),
    slippageBps: integer('slippage_bps').default(10), // 0.10% slippage tolerance
    minOrderUsd: decimal('min_order_usd', { precision: 18, scale: 8 }).default('5'),

    // Copy settings
    followNewEntriesOnly: boolean('follow_new_entries_only').default(true),
    autoRebalance: boolean('auto_rebalance').default(true),
    rebalanceThresholdBps: integer('rebalance_threshold_bps').default(50), // 0.5%

    // Performance tracking
    totalPnl: decimal('total_pnl', { precision: 18, scale: 8 }).default('0'),
    totalFees: decimal('total_fees', { precision: 18, scale: 8 }).default('0'),
    alignmentRate: decimal('alignment_rate', {
      precision: 5,
      scale: 2,
    }).default('100'), // % of trades copied

    // Agent wallet to use
    agentWalletId: uuid('agent_wallet_id').references(() => agentWallets.id, {
      onDelete: 'set null',
    }),

    // Metadata
    metadata: jsonb('metadata').default('{}'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_copy_strategies_user_id').on(table.userId),
    statusIdx: index('idx_copy_strategies_status').on(table.status),
    agentWalletIdx: index('idx_copy_strategies_agent_wallet').on(table.agentWalletId),
    totalPnlIdx: index('idx_copy_strategies_total_pnl').on(table.totalPnl),
  }),
);

// Copy allocations - which traders to copy in a strategy
export const copyAllocations = pgTable(
  'copy_allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => copyStrategies.id, { onDelete: 'cascade' }),
    traderId: uuid('trader_id')
      .notNull()
      .references(() => traderStats.traderId, { onDelete: 'cascade' }),

    // Allocation weight (0-1, sum should be 1 for portfolio mode)
    weight: decimal('weight', { precision: 5, scale: 4 }).notNull(),

    // Status
    status: text('status').default('active').notNull(), // 'active', 'paused'

    // Performance tracking
    allocatedPnl: decimal('allocated_pnl', { precision: 18, scale: 8 }).default('0'),
    allocatedFees: decimal('allocated_fees', {
      precision: 18,
      scale: 8,
    }).default('0'),

    // Timestamps
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    strategyIdIdx: index('idx_copy_allocations_strategy_id').on(table.strategyId),
    traderIdIdx: index('idx_copy_allocations_trader_id').on(table.traderId),
    statusIdx: index('idx_copy_allocations_status').on(table.status),
    uniqueAllocation: index('idx_copy_allocations_unique').on(table.strategyId, table.traderId),
  }),
);

// Copy orders - orders placed by copy trading
export const copyOrders = pgTable(
  'copy_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id').references(() => copyStrategies.id, {
      onDelete: 'set null',
    }),
    agentWalletId: uuid('agent_wallet_id').references(() => agentWallets.id, {
      onDelete: 'set null',
    }),

    // Source trade
    sourceTraderId: uuid('source_trader_id').references(() => traderStats.traderId),
    sourceTradeId: uuid('source_trade_id').references(() => traderTrades.id),

    // Order details
    exchange: text('exchange').default('hyperliquid').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(), // 'buy' or 'sell'
    orderType: text('order_type').notNull(), // 'market', 'limit'

    // Size and price
    quantity: decimal('quantity', { precision: 20, scale: 8 }).notNull(),
    price: decimal('price', { precision: 20, scale: 8 }),

    // Execution
    status: text('status').default('pending').notNull(), // 'pending', 'submitted', 'filled', 'partial', 'cancelled', 'failed'
    filledQuantity: decimal('filled_quantity', {
      precision: 20,
      scale: 8,
    }).default('0'),
    averagePrice: decimal('average_price', { precision: 20, scale: 8 }),

    // P&L for filled orders
    pnl: decimal('pnl', { precision: 18, scale: 2 }).default('0'),
    feeUsd: decimal('fee_usd', { precision: 18, scale: 2 }).default('0'),

    // Exchange reference
    exchangeOrderId: text('exchange_order_id'),

    // Error info
    errorCode: text('error_code'),
    errorMessage: text('error_message'),

    // Timestamps
    createdAt: timestamp('created_at').defaultNow(),
    submittedAt: timestamp('submitted_at'),
    filledAt: timestamp('filled_at'),
    cancelledAt: timestamp('cancelled_at'),
  },
  (table) => ({
    userIdIdx: index('idx_copy_orders_user_id').on(table.userId),
    strategyIdIdx: index('idx_copy_orders_strategy_id').on(table.strategyId),
    agentWalletIdx: index('idx_copy_orders_agent_wallet').on(table.agentWalletId),
    sourceTraderIdIdx: index('idx_copy_orders_source_trader').on(table.sourceTraderId),
    statusIdx: index('idx_copy_orders_status').on(table.status),
    symbolIdx: index('idx_copy_orders_symbol').on(table.symbol),
    createdAtIdx: index('idx_copy_orders_created_at').on(table.createdAt),
  }),
);

// Copy positions - current open positions from copy trading
export const copyPositions = pgTable(
  'copy_positions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id').references(() => copyStrategies.id, {
      onDelete: 'set null',
    }),
    agentWalletId: uuid('agent_wallet_id').references(() => agentWallets.id, {
      onDelete: 'set null',
    }),
    sourceTraderId: uuid('source_trader_id').references(() => traderStats.traderId),

    // Position details
    exchange: text('exchange').default('hyperliquid').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(), // 'long' or 'short'

    // Size and price
    quantity: decimal('quantity', { precision: 20, scale: 8 }).notNull(),
    entryPrice: decimal('entry_price', { precision: 20, scale: 8 }).notNull(),
    markPrice: decimal('mark_price', { precision: 20, scale: 8 }),

    // P&L
    unrealizedPnl: decimal('unrealized_pnl', {
      precision: 18,
      scale: 2,
    }).default('0'),
    realizedPnl: decimal('realized_pnl', { precision: 18, scale: 2 }).default('0'),

    // Margin
    leverage: decimal('leverage', { precision: 5, scale: 2 }).default('1'),
    marginUsed: decimal('margin_used', { precision: 18, scale: 2 }).default('0'),

    // Timestamps
    openedAt: timestamp('opened_at').defaultNow(),
    lastUpdatedAt: timestamp('last_updated_at').defaultNow(),
    closedAt: timestamp('closed_at'),
  },
  (table) => ({
    userIdIdx: index('idx_copy_positions_user_id').on(table.userId),
    strategyIdIdx: index('idx_copy_positions_strategy_id').on(table.strategyId),
    agentWalletIdx: index('idx_copy_positions_agent_wallet').on(table.agentWalletId),
    symbolIdx: index('idx_copy_positions_symbol').on(table.symbol),
    sideIdx: index('idx_copy_positions_side').on(table.side),
    uniquePosition: index('idx_copy_positions_unique').on(
      table.userId,
      table.agentWalletId,
      table.symbol,
    ),
  }),
);

// AI Recommendations - stores AI-generated trading recommendations
export const aiRecommendations = pgTable(
  'ai_recommendations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyId: uuid('strategy_id').references(() => copyStrategies.id, { onDelete: 'set null' }),

    // Recommendation type
    type: text('type').notNull(), // 'trader_selection', 'weight_rebalance', 'leverage_adjustment'

    // Input data snapshot
    inputData: jsonb('input_data').notNull(),

    // AI output
    recommendations: jsonb('recommendations').notNull(),
    reasoning: text('reasoning').notNull(),
    confidence: decimal('confidence', { precision: 5, scale: 2 }).notNull(),

    // Status
    status: text('status').default('pending').notNull(), // 'pending', 'approved', 'rejected', 'applied'

    // User decision
    reviewedAt: timestamp('reviewed_at'),
    reviewNotes: text('review_notes'),

    // Timestamps
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_ai_recommendations_user_id').on(table.userId),
    strategyIdIdx: index('idx_ai_recommendations_strategy_id').on(table.strategyId),
    statusIdx: index('idx_ai_recommendations_status').on(table.status),
  }),
);

// Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AgentWallet = typeof agentWallets.$inferSelect;
export type NewAgentWallet = typeof agentWallets.$inferInsert;
export type CopyStrategy = typeof copyStrategies.$inferSelect;
export type NewCopyStrategy = typeof copyStrategies.$inferInsert;
export type CopyAllocation = typeof copyAllocations.$inferSelect;
export type NewCopyAllocation = typeof copyAllocations.$inferInsert;
export type CopyOrder = typeof copyOrders.$inferSelect;
export type NewCopyOrder = typeof copyOrders.$inferInsert;
export type CopyPosition = typeof copyPositions.$inferSelect;
export type NewCopyPosition = typeof copyPositions.$inferInsert;
export type AiRecommendation = typeof aiRecommendations.$inferSelect;
export type NewAiRecommendation = typeof aiRecommendations.$inferInsert;
