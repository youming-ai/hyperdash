import postgres from 'postgres';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/hyperdash';

async function runMigrations() {
  console.log('Creating trader stats tables...');

  const client = postgres(connectionString, { max: 1 });

  try {
    // Create trader_stats table - stores calculated trader metrics
    await client`
      CREATE TABLE IF NOT EXISTS trader_stats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trader_id UUID NOT NULL UNIQUE,
        address TEXT NOT NULL UNIQUE,

        -- Equity and PnL
        equity_usd DECIMAL(20, 2) DEFAULT 0,
        pnl_7d DECIMAL(10, 2) DEFAULT 0,
        pnl_30d DECIMAL(10, 2) DEFAULT 0,
        pnl_all DECIMAL(10, 2) DEFAULT 0,

        -- Performance metrics
        winrate DECIMAL(5, 2) DEFAULT 0 CHECK (winrate >= 0 AND winrate <= 100),
        total_trades INTEGER DEFAULT 0,
        winning_trades INTEGER DEFAULT 0,
        losing_trades INTEGER DEFAULT 0,

        -- Risk metrics
        max_drawdown DECIMAL(10, 2) DEFAULT 0,
        avg_hold_time_seconds INTEGER DEFAULT 0,
        sharpe_ratio DECIMAL(8, 4),

        -- Activity
        last_trade_at TIMESTAMPTZ,
        first_trade_at TIMESTAMPTZ,
        active_days INTEGER DEFAULT 0,

        -- Position preferences
        long_trades INTEGER DEFAULT 0,
        short_trades INTEGER DEFAULT 0,
        avg_position_size_usd DECIMAL(18, 2) DEFAULT 0,

        -- Ranking
        rank_7d INTEGER,
        rank_30d INTEGER,
        rank_all INTEGER,

        -- Metadata
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    console.log('✅ trader_stats table created');

    // Create trader_trades table - stores individual trade history
    await client`
      CREATE TABLE IF NOT EXISTS trader_trades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trader_id UUID NOT NULL,
        trader_address TEXT NOT NULL,

        -- Trade details
        symbol VARCHAR(20) NOT NULL,
        side VARCHAR(10) NOT NULL CHECK (side IN ('long', 'short')),
        action VARCHAR(20) NOT NULL CHECK (action IN ('open', 'close', 'increase', 'decrease')),

        -- Size and price
        size DECIMAL(20, 8) NOT NULL,
        entry_price DECIMAL(20, 8),
        exit_price DECIMAL(20, 8),

        -- PnL
        pnl DECIMAL(20, 2) DEFAULT 0,
        pnl_bps INTEGER DEFAULT 0,
        fee_usd DECIMAL(18, 2) DEFAULT 0,

        -- Timing
        opened_at TIMESTAMPTZ NOT NULL,
        closed_at TIMESTAMPTZ,
        hold_duration_seconds INTEGER,

        -- Market context
        mark_price_at_entry DECIMAL(20, 8),
        mark_price_at_exit DECIMAL(20, 8),

        -- Exchange reference
        exchange_trade_id TEXT,
        exchange TEXT DEFAULT 'hyperliquid',

        -- Metadata
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    console.log('✅ trader_trades table created');

    // Create trader_positions table - stores current trader positions
    await client`
      CREATE TABLE IF NOT EXISTS trader_positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trader_id UUID NOT NULL REFERENCES trader_stats(trader_id) ON DELETE CASCADE,
        trader_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity NUMERIC(20, 8) NOT NULL,
        entry_price NUMERIC(20, 8) NOT NULL,
        mark_price NUMERIC(20, 8) NOT NULL,
        position_value_usd NUMERIC(20, 2) NOT NULL,
        unrealized_pnl NUMERIC(20, 2) DEFAULT '0',
        margin_used NUMERIC(20, 2) DEFAULT '0',
        leverage NUMERIC(8, 2) DEFAULT '1',
        liquidation_price NUMERIC(20, 8),
        metadata JSONB DEFAULT '{}',
        last_updated_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `;
    console.log('✅ trader_positions table created');

    // Add encrypted_private_key to agent_wallets if not exists
    await client`
      ALTER TABLE agent_wallets ADD COLUMN IF NOT EXISTS encrypted_private_key TEXT;
    `;
    console.log('✅ agent_wallets.encrypted_private_key column added');

    // Create ai_recommendations table
    await client`
      CREATE TABLE IF NOT EXISTS ai_recommendations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        strategy_id uuid REFERENCES copy_strategies(id) ON DELETE SET NULL,
        type text NOT NULL,
        input_data jsonb NOT NULL,
        recommendations jsonb NOT NULL,
        reasoning text NOT NULL,
        confidence numeric(5, 2) NOT NULL,
        status text DEFAULT 'pending' NOT NULL,
        reviewed_at timestamp,
        review_notes text,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      );
    `;
    console.log('✅ ai_recommendations table created');

    await client`CREATE INDEX IF NOT EXISTS idx_ai_recommendations_user_id ON ai_recommendations(user_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_ai_recommendations_strategy_id ON ai_recommendations(strategy_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_ai_recommendations_status ON ai_recommendations(status);`;

    // Create indexes
    console.log('Creating indexes...');

    await client`CREATE INDEX IF NOT EXISTS idx_trader_stats_trader_id ON trader_stats(trader_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_stats_address ON trader_stats(address);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_stats_pnl_7d ON trader_stats(pnl_7d DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_stats_pnl_30d ON trader_stats(pnl_30d DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_stats_winrate ON trader_stats(winrate DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_stats_last_trade ON trader_stats(last_trade_at DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_stats_rank_7d ON trader_stats(rank_7d);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_stats_rank_30d ON trader_stats(rank_30d);`;

    await client`CREATE INDEX IF NOT EXISTS idx_trader_trades_trader_id ON trader_trades(trader_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_trades_address ON trader_trades(trader_address);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_trades_symbol ON trader_trades(symbol);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_trades_opened_at ON trader_trades(opened_at DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_trades_closed_at ON trader_trades(closed_at DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_trades_side ON trader_trades(side);`;

    await client`CREATE INDEX IF NOT EXISTS idx_trader_positions_trader_id ON trader_positions(trader_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_positions_address ON trader_positions(trader_address);`;
    await client`CREATE INDEX IF NOT EXISTS idx_trader_positions_symbol ON trader_positions(symbol);`;
    await client`CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_positions_unique ON trader_positions(trader_id, symbol, side);`;

    // Create trigger for updated_at
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    await client.unsafe(`
      DROP TRIGGER IF EXISTS update_trader_stats_updated_at ON trader_stats;
      CREATE TRIGGER update_trader_stats_updated_at
        BEFORE UPDATE ON trader_stats
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

    console.log('✅ Trader stats migrations completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await client.end();
  }
}

// Run migrations if called directly
if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('✅ All migrations completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

export default runMigrations;
