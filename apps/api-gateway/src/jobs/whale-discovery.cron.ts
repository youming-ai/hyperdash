/**
 * Whale Discovery Cron — decoupled from Express lifecycle.
 *
 * Skill: Scheduled jobs → Cron Triggers in wrangler.toml.
 * Before: setTimeout+setInterval in index.ts (coupled, no backpressure).
 * After: exported handler usable by both Node setInterval and Workers cron.
 *
 * Workers cron binding:
 *   [triggers] crons = ["*\/10 * * * *"]  # every 10m
 *   Then `scheduled(event, env, ctx)` calls `handler()`.
 */

import type { FeedRecorder } from '../services/feed-recorder';
import type { WhaleDiscovery } from '../services/whale-discovery';
import { getLogger } from '../utils/logger';
import { ingestTraderAddresses } from './ingest-traders';

export interface DiscoveryJobOptions {
  topN?: number;
  concurrency?: number;
}

export function createWhaleDiscoveryJob(
  discovery: WhaleDiscovery,
  recorder: Pick<FeedRecorder, 'addWhales'>,
  options: DiscoveryJobOptions = {},
) {
  const topN = options.topN ?? 20;
  const concurrency = options.concurrency ?? 5;
  let ingesting = false;

  const handler = async (): Promise<{
    whales: number;
    successful: number;
    failed: number;
  } | null> => {
    if (ingesting) return null;
    if (!discovery.isReady()) return null;
    ingesting = true;
    try {
      const whales = discovery.getTopWhales(topN);
      if (whales.length === 0) return null;
      recorder.addWhales(whales.map((w) => w.address));
      const result = await ingestTraderAddresses(
        whales.map((w) => w.address),
        { concurrency },
      );
      getLogger().info('Whale discovery cycle complete', {
        whales: whales.length,
        successful: result.successful,
        failed: result.failed,
        tracked: discovery.trackedAddressCount,
      });
      return { whales: whales.length, successful: result.successful, failed: result.failed };
    } catch (error) {
      getLogger().warn(
        `Whale discovery skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      ingesting = false;
    }
  };

  return { handler, isIngesting: () => ingesting };
}
