import { createClient } from '@clickhouse/client';
import { ALL_TABLES } from './schema';

const clickHouseUrl = process.env.CLICKHOUSE_URL || 'http://localhost:8123';
const clickHouseDatabase = process.env.CLICKHOUSE_DB || 'hyperdash_analytics';

async function runClickHouseMigrations() {
  console.log('Starting ClickHouse migrations...');

  const client = createClient({
    url: clickHouseUrl,
    database: clickHouseDatabase,
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
  });

  try {
    // Test connection
    console.log('Testing ClickHouse connection...');
    await client.ping();
    console.log('✅ ClickHouse connection successful');

    // Create database if it doesn't exist
    console.log('Creating database if not exists...');
    await client.command({
      query: `CREATE DATABASE IF NOT EXISTS ${clickHouseDatabase}`,
    });
    console.log(`✅ Database '${clickHouseDatabase}' ready`);

    // Create all tables
    console.log('Creating tables...');
    for (const tableSQL of ALL_TABLES) {
      try {
        await client.command({
          query: tableSQL,
        });
      } catch (error: any) {
        // Ignore errors for views that already exist
        if (!error.message.includes('already exists')) {
          throw error;
        }
      }
    }

    console.log('✅ All ClickHouse tables created successfully!');

    // Verify tables exist
    console.log('Verifying table creation...');
    const tables = await client.query({
      query: 'SHOW TABLES',
      format: 'JSONEachRow',
    });

    const tableNames = (await tables.json<{ name: string }>()).map((row) => row.name);
    const expectedTables = [
      'market_ticks_raw',
      'market_ohlcv_1min',
      'trader_events',
      'trader_kpis_day',
      'liq_heatmap_bins',
      'copy_trade_events',
      'mv_ohlcv_1min',
      'mv_trader_kpis_day',
      'mv_liq_heatmap_realtime',
    ];

    for (const tableName of expectedTables) {
      if (tableNames.includes(tableName)) {
        console.log(`✅ Table '${tableName}' verified`);
      } else {
        throw new Error(`❌ Table '${tableName}' not found`);
      }
    }

    console.log('✅ ClickHouse migrations completed successfully!');
  } catch (error) {
    console.error('❌ ClickHouse migration failed:', error);
    throw error;
  }
}

// Additional utility to create optimized indexes
async function createOptimizations() {
  console.log('Creating ClickHouse optimizations...');

  const client = createClient({
    url: clickHouseUrl,
    database: clickHouseDatabase,
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
  });

  try {
    // Create projections for common query patterns
    console.log('Creating projections...');

    // Market data projections
    await client.command({
      query: `
        ALTER TABLE market_ohlcv_1min
        ADD PROJECTION IF NOT EXISTS symbol_hourly (
          SELECT
            toStartOfHour(timestamp) as hour,
            symbol,
            avg(close) as avg_close,
            max(high) as max_high,
            min(low) as min_low,
            sum(volume) as total_volume
          GROUP BY symbol, toStartOfHour(timestamp)
        )
      `,
    });

    // Trader KPI projections
    await client.command({
      query: `
        ALTER TABLE trader_kpis_day
        ADD PROJECTION IF NOT EXISTS trader_monthly (
          SELECT
            toStartOfMonth(date) as month,
            trader_id,
            sum(pnl) as monthly_pnl,
            avg(return_pct) as avg_return,
            count() as trade_count
          GROUP BY trader_id, toStartOfMonth(date)
        )
      `,
    });

    // System optimizations
    console.log('Applying system optimizations...');

    // Optimize for high-throughput ingestion
    await client.command({
      query: `
        ALTER TABLE market_ticks_raw
        MODIFY SETTING max_insert_threads = 8,
                              max_insert_block_size = 1048576
      `,
    });

    await client.command({
      query: `
        ALTER TABLE trader_events
        MODIFY SETTING max_insert_threads = 4,
                              max_insert_block_size = 524288
      `,
    });

    // Create distributed table if using cluster (optional)
    if (process.env.CLICKHOUSE_CLUSTER) {
      const cluster = process.env.CLICKHOUSE_CLUSTER;
      console.log(`Creating distributed tables for cluster '${cluster}'...`);

      const distributedTables = [
        'market_ticks_raw_distributed',
        'market_ohlcv_1min_distributed',
        'trader_events_distributed',
        'trader_kpis_day_distributed',
      ];

      for (const distributedTable of distributedTables) {
        const sourceTable = distributedTable.replace('_distributed', '');

        await client.command({
          query: `
            CREATE TABLE IF NOT EXISTS ${distributedTable}
            ON CLUSTER ${cluster} AS ${sourceTable}
            ENGINE = Distributed(${cluster}, ${clickHouseDatabase}, ${sourceTable}, cityHash64(symbol))
          `,
        });

        console.log(`✅ Distributed table '${distributedTable}' created`);
      }
    }

    console.log('✅ ClickHouse optimizations completed!');
  } catch (error) {
    console.error('❌ Optimization failed:', error);
    // Don't fail the migration for optimization errors
    console.warn('⚠️ Continuing despite optimization errors');
  } finally {
    await client.close();
  }
}

// Run migrations if called directly
if (require.main === module) {
  runClickHouseMigrations()
    .then(async () => {
      console.log('✅ Creating optimizations...');
      await createOptimizations();
      console.log('✅ All ClickHouse operations completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ ClickHouse migration failed:', error);
      process.exit(1);
    });
}

export { createOptimizations, runClickHouseMigrations };
export default runClickHouseMigrations;
