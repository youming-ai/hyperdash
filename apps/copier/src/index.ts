/**
 * Copier entry point.
 *
 * Wires the two trigger paths around one reconciler:
 *
 *   lead userFills ──┐
 *                    ├──► CopierEngine.reconcile ──► target state ──► IOC orders
 *   periodic sweep ──┘
 *
 * The sweep is the safety net that production write-ups of this problem all
 * insist on: websockets drop, events get lost, users poke their accounts by
 * hand. An event-only design leaves the follower silently wrong after any of
 * those, so the timer re-derives everything from chain state no matter what the
 * fast path believes happened.
 *
 * Defaults to paper mode, which runs the identical pipeline against live market
 * data with simulated fills. Real orders require LIVE=1 and an approved agent.
 *
 * Multi-account by design: strategies are grouped by the agent wallet that
 * executes them, and each account gets its own signer and its own reconcile
 * pass. Read-only clients and the market feed are shared, since those carry no
 * per-account state.
 */

import { loadConfig } from './config';
import { getEncryptionKey } from './crypto';
import { createDb } from './db';
import { CopierEngine, createMidsCache } from './engine';
import { ExecutorRegistry } from './execution';
import { createSharedClients } from './hyperliquid';
import { LeadFeed } from './lead-feed';
import { log, setLogLevel } from './log';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info('Copier starting', {
    mode: config.live ? 'LIVE' : 'PAPER',
    sweepIntervalMs: config.sweepIntervalMs,
    minOrderUsd: config.minOrderUsd,
    driftThresholdPct: config.driftThresholdPct,
    maxConcurrency: config.maxConcurrency,
  });

  const { db, client } = createDb(config.databaseUrl);
  const shared = await createSharedClients();

  const mids = createMidsCache(shared.info);
  await mids.refresh();

  if (Object.keys(mids.get()).length === 0) {
    log.warn('no mid prices retrieved from Hyperliquid; sizing will skip symbols');
  }

  // One execution plane per account. Live mode decrypts each account's agent key
  // on first use, so a single unreadable key fails only that account.
  let encryptionKey: Uint8Array | null = null;
  if (config.live) {
    try {
      encryptionKey = getEncryptionKey();
    } catch (error) {
      log.error('live mode requires ENCRYPTION_KEY; cannot decrypt agent keys', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const registry = new ExecutorRegistry({
    shared,
    db,
    live: config.live,
    encryptionKey,
  });

  const engine = new CopierEngine({ db, config, shared, registry, mids });
  await engine.refreshAccounts();
  engine.markStarted();

  // Live prices keep paper fills, notional checks and slippage bounds honest.
  const midsSub = await shared.subscription
    .allMids((event) => {
      const snapshot = mids.get();
      for (const [coin, px] of Object.entries(event.mids)) {
        const n = Number(px);
        if (Number.isFinite(n) && n > 0) snapshot[coin] = n;
      }
    })
    .catch((error: unknown) => {
      log.warn('allMids subscription failed; REST refresh still applies', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

  const leadFeed = new LeadFeed(shared.subscription, (lead) => engine.reconcileLead(lead));
  await leadFeed.sync(engine.leadAddresses());

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down copier');
    clearInterval(sweepTimer);
    clearInterval(refreshTimer);
    engine.stop();
    await leadFeed.close();
    if (midsSub) await midsSub.unsubscribe().catch(() => {});
    await registry.closeAll();
    await shared.close();
    await client.end();
    process.exit(0);
  };

  // Catch up on boot: the follower may be arbitrarily far from target, and
  // waiting a full sweep interval to notice would be a silent window of drift.
  void engine.reconcile();

  const sweepTimer = setInterval(() => void engine.reconcile(), config.sweepIntervalMs);

  const refreshTimer = setInterval(() => {
    void (async () => {
      try {
        await engine.refreshAccounts();
        await leadFeed.sync(engine.leadAddresses());
      } catch (error) {
        // The tenancy guard throws only in live mode; trading must stop rather
        // than keep running with a cross-tenant position view.
        log.error('halting: strategy refresh rejected', {
          error: error instanceof Error ? error.message : String(error),
        });
        await shutdown();
      }
    })();
  }, config.strategyRefreshMs);

  log.info('Copier running', {
    mode: config.live ? 'live' : 'paper',
    accounts: engine.getAccounts().length,
    strategies: engine.getStrategies().length,
    leadSubscriptions: leadFeed.subscribedCount,
    totalLeads: engine.leadAddresses().length,
  });

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  log.error('Copier crashed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
