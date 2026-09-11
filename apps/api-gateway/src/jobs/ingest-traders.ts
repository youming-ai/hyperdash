/**
 * Data Ingestion Job for Trader Data
 *
 * This module contains functions to fetch trader data from Hyperliquid API
 * and store it in the database for the Whale Tracker application.
 *
 * Usage:
 *   pnpm ingest:traders                    # Ingest known whale addresses
 *   pnpm ingest:traders --address 0x...    # Ingest specific address
 */

import { createPostgresConnection, traderStats, traderTrades } from '@hyperdash/database';
import { and, eq } from 'drizzle-orm';
import { LEADERBOARD_TRADER_SEEDS } from '../config/leaderboard-traders';
import {
  assetPositionToTraderPositionRow,
  fetchTraderData,
  fillToTraderTradeRow,
  getAllMids,
} from '../services/hyperliquid';
import { replaceTraderPositions } from '../services/trader-positions';

const KNOWN_WHALE_ADDRESSES = LEADERBOARD_TRADER_SEEDS.map((seed) => seed.address);

// Configuration
const INGESTION_CONFIG = {
  batchSize: 10, // Process this many addresses concurrently
  retryAttempts: 3,
  retryDelayMs: 1000,
};

interface IngestionResult {
  successful: number;
  failed: number;
  skipped: number;
  errors: Array<{ address: string; error: string }>;
  duration: number;
}

/**
 * Ingest data for a single trader address
 */
async function ingestTraderAddress(
  address: string,
  db: ReturnType<ReturnType<typeof createPostgresConnection>['getDatabase']>,
  mids: Record<string, string>,
): Promise<{ success: boolean; error?: string; updated: boolean }> {
  const maxRetries = INGESTION_CONFIG.retryAttempts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Fetch data from Hyperliquid API
      const traderData = await fetchTraderData(address);

      if (!traderData) {
        return {
          success: false,
          error: 'No data returned from API',
          updated: false,
        };
      }

      const { stats, fills, state } = traderData;

      if (!stats) {
        return { success: false, error: 'No stats available', updated: false };
      }

      // Check if trader exists
      const existing = await db
        .select()
        .from(traderStats)
        .where(eq(traderStats.address, address))
        .limit(1);

      const existingTrader = existing[0];
      const traderId = existingTrader?.traderId || crypto.randomUUID();

      // Prepare stats data
      const statsData = {
        traderId,
        address: stats.address,
        equityUsd: stats.equity?.toString() || '0',
        pnl7d: stats.pnl7d?.toString() || '0',
        pnl30d: stats.pnl30d?.toString() || '0',
        pnlAll: stats.pnlAllTime?.toString() || '0',
        winrate: stats.winRate?.toString() || '0',
        totalTrades: stats.totalTrades || 0,
        winningTrades: stats.winningTrades || 0,
        losingTrades: stats.losingTrades || 0,
        sharpeRatio: stats.sharpeRatio?.toString() || '0',
        maxDrawdown: stats.maxDrawdown?.toString() || '0',
        lastTradeAt: stats.lastTradeAt ? new Date(stats.lastTradeAt) : null,
        firstTradeAt:
          existingTrader?.firstTradeAt || (stats.lastTradeAt ? new Date(stats.lastTradeAt) : null),
        activeDays: existingTrader?.activeDays || 0,
        longTrades: existingTrader?.longTrades || 0,
        shortTrades: existingTrader?.shortTrades || 0,
        avgPositionSizeUsd: existingTrader?.avgPositionSizeUsd?.toString() || '0',
        rank7d: existingTrader?.rank7d || null,
        rank30d: existingTrader?.rank30d || null,
        rankAll: existingTrader?.rankAll || null,
        metadata: existingTrader?.metadata || {},
        updatedAt: new Date(),
      };

      // Upsert trader stats
      if (existingTrader) {
        await db.update(traderStats).set(statsData).where(eq(traderStats.address, address));
      } else {
        await db.insert(traderStats).values({
          ...statsData,
          createdAt: new Date(),
        } as any);
      }

      // Insert new trades, deduplicating on (traderId, exchangeTradeId).
      // Each fill becomes one trader_trades row via fillToTraderTradeRow.
      if (fills.length > 0) {
        for (const fill of fills) {
          const row = fillToTraderTradeRow(fill, traderId, address);

          const existingTrades = await db
            .select({ id: traderTrades.id })
            .from(traderTrades)
            .where(
              and(
                eq(traderTrades.traderId, traderId),
                eq(traderTrades.exchangeTradeId, row.exchangeTradeId),
              ),
            )
            .limit(1);

          if (existingTrades.length === 0) {
            await db.insert(traderTrades).values(row as any);
          }
        }
      }

      // Persist current trader positions after stats and trades are written.
      try {
        if (state) {
          const positionRows = state.assetPositions
            .filter((assetPosition) => Number(assetPosition.position.szi) !== 0)
            .map((assetPosition) =>
              assetPositionToTraderPositionRow(
                assetPosition,
                traderId,
                address,
                mids[assetPosition.position.coin] ?? assetPosition.position.entryPx,
              ),
            );

          await replaceTraderPositions(db as any, traderId, positionRows);
        }
      } catch (error) {
        console.error(`Failed to persist positions for ${address}:`, error);
      }

      return { success: true, updated: !!existingTrader };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (attempt === maxRetries) {
        return { success: false, error: errorMessage, updated: false };
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, INGESTION_CONFIG.retryDelayMs * attempt));
    }
  }

  return { success: false, error: 'Max retries exceeded', updated: false };
}

/**
 * Ingest data for multiple trader addresses
 */
export async function ingestTraderAddresses(
  addresses: string[],
  options: {
    concurrency?: number;
    onProgress?: (current: number, total: number) => void;
  } = {},
): Promise<IngestionResult> {
  const startTime = Date.now();
  const { concurrency = INGESTION_CONFIG.batchSize, onProgress } = options;

  // Initialize database connection
  const dbConn = createPostgresConnection();
  await dbConn.initialize();
  const db = dbConn.getDatabase();

  const result: IngestionResult = {
    successful: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    duration: 0,
  };

  try {
    // Fetch market mid-prices once for this ingestion run.
    const mids = await getAllMids().catch(() => ({}) as Record<string, string>);

    // Process addresses in batches
    for (let i = 0; i < addresses.length; i += concurrency) {
      const batch = addresses.slice(i, i + concurrency);

      const batchResults = await Promise.allSettled(
        batch.map((address) => ingestTraderAddress(address.trim(), db, mids)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const batchResult = batchResults[j];
        const address = batch[j];

        if (batchResult.status === 'fulfilled') {
          const { success, error, updated } = batchResult.value;

          if (success) {
            result.successful++;
            if (!updated) {
              console.log(`✅ Imported new trader: ${address}`);
            } else {
              console.log(`🔄 Updated trader: ${address}`);
            }
          } else {
            result.failed++;
            result.errors.push({ address, error: error || 'Unknown error' });
            console.error(`❌ Failed to ingest ${address}: ${error}`);
          }
        } else {
          result.failed++;
          result.errors.push({
            address,
            error: batchResult.reason?.message || String(batchResult.reason),
          });
          console.error(`❌ Error processing ${address}:`, batchResult.reason);
        }
      }

      // Report progress
      if (onProgress) {
        onProgress(Math.min(i + concurrency, addresses.length), addresses.length);
      }
    }
  } finally {
    // Close database connection
    await dbConn.close();
  }

  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Ingest known whale addresses
 */
export async function ingestKnownWhales(options?: {
  concurrency?: number;
  onProgress?: (current: number, total: number) => void;
}): Promise<IngestionResult> {
  if (KNOWN_WHALE_ADDRESSES.length === 0) {
    console.warn('⚠️ No known whale addresses configured. Add addresses to KNOWN_WHALE_ADDRESSES.');
    return {
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      duration: 0,
    };
  }

  console.log(`🐋 Starting ingestion of ${KNOWN_WHALE_ADDRESSES.length} known whale addresses...`);
  return ingestTraderAddresses(KNOWN_WHALE_ADDRESSES, options);
}

/**
 * CLI entry point for running ingestion
 */
export async function runIngestion(args: string[] = []): Promise<void> {
  const addressArg = args.find((a) => a.startsWith('--address='));
  const concurrencyArg = args.find((a) => a.startsWith('--concurrency='));

  let addresses: string[] = [];
  let concurrency: number | undefined;

  // Parse arguments
  if (addressArg) {
    addresses = [addressArg.split('=')[1]];
    console.log(`🎯 Ingesting single address: ${addresses[0]}`);
  } else {
    addresses = KNOWN_WHALE_ADDRESSES;
  }

  if (concurrencyArg) {
    concurrency = parseInt(concurrencyArg.split('=')[1], 10);
  }

  // Run ingestion
  const result = await ingestTraderAddresses(addresses, {
    concurrency,
    onProgress: (current, total) => {
      console.log(`📊 Progress: ${current}/${total} (${Math.round((current / total) * 100)}%)`);
    },
  });

  // Print summary
  console.log(`\n${'='.repeat(50)}`);
  console.log('📋 Ingestion Summary');
  console.log('='.repeat(50));
  console.log(`✅ Successful: ${result.successful}`);
  console.log(`❌ Failed: ${result.failed}`);
  console.log(`⏭️ Skipped: ${result.skipped}`);
  console.log(`⏱️ Duration: ${(result.duration / 1000).toFixed(2)}s`);

  if (result.errors.length > 0) {
    console.log('\n❌ Errors:');
    for (const { address, error } of result.errors.slice(0, 10)) {
      console.log(`  ${address}: ${error}`);
    }
    if (result.errors.length > 10) {
      console.log(`  ... and ${result.errors.length - 10} more errors`);
    }
  }

  console.log('='.repeat(50));

  // Exit with error code if any failures
  if (result.failed > 0) {
    process.exit(1);
  }
}

// Allow running as standalone script
if (require.main === module) {
  runIngestion(process.argv.slice(2)).catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}
