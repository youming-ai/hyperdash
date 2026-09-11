import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/hyperdash';

async function runMigrations() {
  console.log('Starting PostgreSQL migrations...');

  const client = postgres(connectionString, { max: 1 });
  const _db = drizzle(client, { schema });

  try {
    // Create all tables using Drizzle
    console.log('Creating tables...');

    // Note: In production, you'd use drizzle-kit for proper migrations
    // For now, we'll create tables directly

    // Create users table
    await client`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE,
        wallet_addr TEXT UNIQUE NOT NULL,
        kyc_level INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
        preferences JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    console.log('✅ Users table created');

    // Create agent_wallets table
    await client`
      CREATE TABLE IF NOT EXISTS agent_wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        exchange TEXT NOT NULL DEFAULT 'hyperliquid',
        address TEXT NOT NULL UNIQUE,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
        min_order_usd DECIMAL(18, 8) DEFAULT 5.0 CHECK (min_order_usd > 0),
        max_leverage INTEGER DEFAULT 5 CHECK (max_leverage > 0),
        permissions JSONB DEFAULT '{"trade": true, "withdraw": false}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    console.log('✅ Agent wallets table created');

    // Create traders table
    await client`
      CREATE TABLE IF NOT EXISTS traders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        alias TEXT NOT NULL,
        src_uid TEXT NOT NULL,
        addr TEXT,
        exchange TEXT NOT NULL DEFAULT 'hyperliquid',
        tags TEXT[] DEFAULT '{}',
        public_score DECIMAL(5, 2) CHECK (public_score >= 0 AND public_score <= 100),
        is_active BOOLEAN DEFAULT true,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(exchange, src_uid)
      );
    `;
    console.log('✅ Traders table created');

    // Create copy_strategies table
    await client`
      CREATE TABLE IF NOT EXISTS copy_strategies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'paused' CHECK (status IN ('paused', 'active', 'error', 'terminated')),
        mode TEXT DEFAULT 'portfolio' CHECK (mode IN ('portfolio', 'single_trader')),
        max_leverage DECIMAL(5, 2) DEFAULT 5.0 CHECK (max_leverage > 0),
        max_position_usd DECIMAL(18, 8),
        slippage_bps INTEGER DEFAULT 10 CHECK (slippage_bps >= 0),
        min_order_usd DECIMAL(18, 8) DEFAULT 5.0 CHECK (min_order_usd > 0),
        follow_new_entries_only BOOLEAN DEFAULT true,
        auto_rebalance BOOLEAN DEFAULT true,
        rebalance_threshold_bps INTEGER DEFAULT 50,
        total_pnl DECIMAL(18, 8) DEFAULT 0,
        total_fees DECIMAL(18, 8) DEFAULT 0,
        alignment_rate DECIMAL(5, 2) DEFAULT 100.0 CHECK (alignment_rate >= 0 AND alignment_rate <= 100),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    console.log('✅ Copy strategies table created');

    // Create copy_allocations table
    await client`
      CREATE TABLE IF NOT EXISTS copy_allocations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        strategy_id UUID NOT NULL REFERENCES copy_strategies(id) ON DELETE CASCADE,
        trader_id UUID NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
        weight DECIMAL(5, 4) NOT NULL CHECK (weight > 0 AND weight <= 1),
        status TEXT DEFAULT 'active',
        allocated_pnl DECIMAL(18, 8) DEFAULT 0,
        allocated_fees DECIMAL(18, 8) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(strategy_id, trader_id)
      );
    `;
    console.log('✅ Copy allocations table created');

    // Create orders table
    await client`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        strategy_id UUID REFERENCES copy_strategies(id) ON DELETE SET NULL,
        agent_wallet_id UUID REFERENCES agent_wallets(id) ON DELETE SET NULL,
        exchange TEXT NOT NULL DEFAULT 'hyperliquid',
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit', 'stop', 'stop_limit')),
        quantity DECIMAL(18, 8) NOT NULL CHECK (quantity > 0),
        price DECIMAL(18, 8),
        filled_quantity DECIMAL(18, 8) DEFAULT 0 CHECK (filled_quantity >= 0 AND filled_quantity <= quantity),
        average_price DECIMAL(18, 8),
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'partial', 'filled', 'cancelled', 'failed')),
        exchange_order_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        submitted_at TIMESTAMPTZ,
        filled_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        is_copy_trade BOOLEAN DEFAULT false,
        source_trader_id UUID REFERENCES traders(id),
        source_event_id TEXT,
        metadata JSONB DEFAULT '{}'
      );
    `;
    console.log('✅ Orders table created');

    // Create positions table
    await client`
      CREATE TABLE IF NOT EXISTS positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        strategy_id UUID REFERENCES copy_strategies(id) ON DELETE SET NULL,
        agent_wallet_id UUID REFERENCES agent_wallets(id) ON DELETE SET NULL,
        exchange TEXT NOT NULL DEFAULT 'hyperliquid',
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        quantity DECIMAL(18, 8) NOT NULL,
        entry_price DECIMAL(18, 8) NOT NULL,
        mark_price DECIMAL(18, 8),
        unrealized_pnl DECIMAL(18, 8) DEFAULT 0,
        realized_pnl DECIMAL(18, 8) DEFAULT 0,
        leverage DECIMAL(5, 2) DEFAULT 1.0 CHECK (leverage > 0),
        margin_used DECIMAL(18, 8) DEFAULT 0,
        opened_at TIMESTAMPTZ DEFAULT NOW(),
        last_updated_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}',
        UNIQUE(user_id, agent_wallet_id, symbol)
      );
    `;
    console.log('✅ Positions table created');

    // Create fees_ledger table
    await client`
      CREATE TABLE IF NOT EXISTS fees_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
        strategy_id UUID REFERENCES copy_strategies(id) ON DELETE SET NULL,
        fee_type TEXT NOT NULL CHECK (fee_type IN ('trading', 'copy', 'management', 'performance')),
        fee_category TEXT NOT NULL,
        fee_bps INTEGER NOT NULL CHECK (fee_bps >= 0),
        fee_amount DECIMAL(18, 8) NOT NULL CHECK (fee_amount > 0),
        fee_currency TEXT NOT NULL DEFAULT 'USD',
        notional_amount DECIMAL(18, 8),
        calculation_base TEXT,
        transaction_hash TEXT,
        exchange_tx_id TEXT,
        period_start TIMESTAMPTZ,
        period_end TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'
      );
    `;
    console.log('✅ Fees ledger table created');

    // Create audit_logs table
    await client`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id UUID REFERENCES users(id),
        actor_type TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('create_strategy', 'start_copy', 'place_order', 'update_allocation', 'pause_strategy', 'terminate_strategy')),
        resource_type TEXT,
        resource_id UUID,
        old_values JSONB,
        new_values JSONB,
        request_context JSONB,
        status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'partial')),
        error_code TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        ip_address INET,
        user_agent TEXT,
        metadata JSONB DEFAULT '{}'
      );
    `;
    console.log('✅ Audit logs table created');

    // Create indexes for better performance
    console.log('Creating indexes...');

    await client`CREATE INDEX IF NOT EXISTS idx_users_wallet_addr ON users(wallet_addr);`;
    await client`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`;
    await client`CREATE INDEX IF NOT EXISTS idx_users_kyc_level ON users(kyc_level);`;

    await client`CREATE INDEX IF NOT EXISTS idx_agent_wallets_user_id ON agent_wallets(user_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_agent_wallets_address ON agent_wallets(address);`;
    await client`CREATE INDEX IF NOT EXISTS idx_agent_wallets_status ON agent_wallets(status);`;

    await client`CREATE INDEX IF NOT EXISTS idx_traders_src_uid ON traders(src_uid);`;
    await client`CREATE INDEX IF NOT EXISTS idx_traders_exchange ON traders(exchange);`;
    await client`CREATE INDEX IF NOT EXISTS idx_traders_public_score ON traders(public_score DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_traders_is_active ON traders(is_active);`;

    await client`CREATE INDEX IF NOT EXISTS idx_copy_strategies_user_id ON copy_strategies(user_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_copy_strategies_status ON copy_strategies(status);`;
    await client`CREATE INDEX IF NOT EXISTS idx_copy_strategies_total_pnl ON copy_strategies(total_pnl DESC);`;

    await client`CREATE INDEX IF NOT EXISTS idx_copy_allocations_strategy_id ON copy_allocations(strategy_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_copy_allocations_trader_id ON copy_allocations(trader_id);`;

    await client`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_orders_strategy_id ON orders(strategy_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_orders_agent_wallet_id ON orders(agent_wallet_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);`;
    await client`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);`;
    await client`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_orders_source_trader_id ON orders(source_trader_id);`;

    await client`CREATE INDEX IF NOT EXISTS idx_positions_user_id ON positions(user_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_positions_strategy_id ON positions(strategy_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_positions_agent_wallet_id ON positions(agent_wallet_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);`;
    await client`CREATE INDEX IF NOT EXISTS idx_positions_side ON positions(side);`;
    await client`CREATE INDEX IF NOT EXISTS idx_positions_last_updated_at ON positions(last_updated_at DESC);`;

    await client`CREATE INDEX IF NOT EXISTS idx_fees_ledger_user_id ON fees_ledger(user_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_fees_ledger_order_id ON fees_ledger(order_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_fees_ledger_strategy_id ON fees_ledger(strategy_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_fees_ledger_fee_type ON fees_ledger(fee_type);`;
    await client`CREATE INDEX IF NOT EXISTS idx_fees_ledger_created_at ON fees_ledger(created_at DESC);`;

    await client`CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON audit_logs(actor_id);`;
    await client`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);`;
    await client`CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type);`;
    await client`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);`;
    await client`CREATE INDEX IF NOT EXISTS idx_audit_logs_status ON audit_logs(status);`;

    // Create triggers for updated_at columns
    console.log('Creating triggers...');

    await client`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `;

    await client`
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;

    await client`
      DROP TRIGGER IF EXISTS update_agent_wallets_updated_at ON agent_wallets;
      CREATE TRIGGER update_agent_wallets_updated_at
        BEFORE UPDATE ON agent_wallets
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;

    await client`
      DROP TRIGGER IF EXISTS update_traders_updated_at ON traders;
      CREATE TRIGGER update_traders_updated_at
        BEFORE UPDATE ON traders
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;

    await client`
      DROP TRIGGER IF EXISTS update_copy_strategies_updated_at ON copy_strategies;
      CREATE TRIGGER update_copy_strategies_updated_at
        BEFORE UPDATE ON copy_strategies
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;

    await client`
      DROP TRIGGER IF EXISTS update_copy_allocations_updated_at ON copy_allocations;
      CREATE TRIGGER update_copy_allocations_updated_at
        BEFORE UPDATE ON copy_allocations
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;

    await client`
      DROP TRIGGER IF EXISTS update_positions_last_updated_at ON positions;
      CREATE TRIGGER update_positions_last_updated_at
        BEFORE UPDATE ON positions
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `;

    console.log('✅ PostgreSQL migrations completed successfully!');
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
