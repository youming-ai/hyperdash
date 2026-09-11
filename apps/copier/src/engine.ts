/**
 * The reconciler engine.
 *
 * One function — `reconcile` — is shared by both entry points:
 *
 *   - the event fast path, triggered when a lead fills
 *   - the periodic sweep, triggered on a timer
 *
 * Sharing it is not just DRY. If the two paths applied different sizing or
 * deadband rules they would take turns undoing each other's work, and the
 * account would burn fees oscillating around a target neither agrees on.
 *
 * **The unit of reconciliation is the trading account, not the strategy.**
 * A single account can carry several strategies, and each only knows its own
 * desired positions. Reconciling them one at a time made every strategy measure
 * the whole account against its own targets and undo the others — measured at
 * 5,092 orders in 40 seconds with the same symbol bought and sold 26 times. So
 * an account's strategies are merged (netting opposing views) and executed once.
 *
 * That is also what makes multi-tenancy safe: accounts share no execution state,
 * so strategies belonging to different users can never touch each other's
 * positions, and one account's failure (a bad key, a rejected signature) is
 * contained to that account.
 */

import type { InfoClient } from '@nktkas/hyperliquid';
import type { CopierConfig } from './config';
import type { Db } from './db';
import type { ExecutorRegistry } from './execution';
import { getAllMids, roundSize, type SharedClients } from './hyperliquid';
import { log } from './log';
import { computeDeltas, isBuyDelta } from './reconcile';
import { computeTargetPositions, mergeStrategyTargets } from './sizing';
import { loadSourcePositions, loadTradingAccounts, recordOrder, syncCopyPositions } from './store';
import type { LoadedStrategy, TradingAccount } from './types';

export interface MidsCache {
  get(): Record<string, number>;
  refresh(): Promise<Record<string, number>>;
}

export function createMidsCache(info: InfoClient): MidsCache {
  let cache: Record<string, number> = {};
  return {
    get: () => cache,
    refresh: async () => {
      try {
        const next = await getAllMids(info);
        if (Object.keys(next).length > 0) cache = next;
      } catch (error) {
        log.warn('mid refresh failed, using cache', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return cache;
    },
  };
}

export interface EngineDeps {
  db: Db;
  config: CopierConfig;
  shared: SharedClients;
  registry: ExecutorRegistry;
  mids: MidsCache;
}

/**
 * Run tasks with a bounded number in flight.
 *
 * The exchange rate-limits per IP, and every account in this process shares one
 * egress IP, so unbounded concurrency would let a busy day on one account starve
 * the rest. Accounts are independent (their own positions, their own signer), so
 * a small degree of parallelism is both safe and useful.
 */
async function runBounded<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length));

  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });

  await Promise.all(runners);
}

export class CopierEngine {
  private accounts: TradingAccount[] = [];
  /** Accounts currently reconciling; a second pass would act on stale positions. */
  private readonly inFlight = new Set<string>();
  private running = false;

  constructor(private readonly deps: EngineDeps) {}

  /**
   * Reload accounts (and their strategies) from Postgres.
   *
   * A read failure is transient and non-fatal: a stale list beats no list.
   */
  async refreshAccounts(): Promise<TradingAccount[]> {
    try {
      this.accounts = await loadTradingAccounts(this.deps.db);
      log.debug('accounts refreshed', {
        accounts: this.accounts.length,
        strategies: this.accounts.reduce((n, a) => n + a.strategies.length, 0),
      });
    } catch (error) {
      log.error('account refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.accounts;
  }

  getAccounts(): TradingAccount[] {
    return this.accounts;
  }

  /** All active strategies across accounts, for reporting. */
  getStrategies(): LoadedStrategy[] {
    return this.accounts.flatMap((a) => a.strategies);
  }

  /** Distinct lead addresses across all accounts. */
  leadAddresses(): `0x${string}`[] {
    const set = new Set<string>();
    for (const account of this.accounts) {
      for (const strategy of account.strategies) {
        for (const allocation of strategy.allocations) {
          if (allocation.traderAddress) set.add(allocation.traderAddress.toLowerCase());
        }
      }
    }
    return [...set] as `0x${string}`[];
  }

  /** Reconcile every account, or the given subset. */
  async reconcile(accounts?: TradingAccount[]): Promise<void> {
    const targets = accounts ?? this.accounts;
    if (targets.length === 0) return;

    await this.deps.mids.refresh();

    await runBounded(targets, this.deps.config.maxConcurrency, async (account) => {
      if (this.inFlight.has(account.agentWalletId)) {
        log.debug('skip reconcile, already in flight', { agentWalletId: account.agentWalletId });
        return;
      }

      this.inFlight.add(account.agentWalletId);
      try {
        await this.reconcileAccount(account);
      } catch (error) {
        // Contained per account on purpose: one user's undecryptable key or
        // revoked authorization must not stop every other user from trading.
        log.error('account reconcile failed', {
          agentWalletId: account.agentWalletId,
          masterAddress: account.masterAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.inFlight.delete(account.agentWalletId);
      }
    });
  }

  /** Reconcile only the accounts copying a specific lead (event fast path). */
  async reconcileLead(leadAddress: string): Promise<void> {
    const address = leadAddress.toLowerCase();
    const affected = this.accounts.filter((account) =>
      account.strategies.some((s) =>
        s.allocations.some((a) => a.traderAddress.toLowerCase() === address),
      ),
    );
    if (affected.length === 0) return;

    log.debug('lead fill detected', { leadAddress: address, accounts: affected.length });
    await this.reconcile(affected);
  }

  /**
   * Bring one account to the merged target of all its strategies.
   *
   * The order of operations matters: every strategy is sized first, their
   * targets are netted, and only then is the account's real position read and
   * diffed once. Diffing per strategy is the oscillation bug.
   */
  private async reconcileAccount(account: TradingAccount): Promise<void> {
    const { db, config, shared, registry, mids: midsCache } = this.deps;

    const execution = await registry.forAccount(account);
    const mids = midsCache.get();
    if (Object.keys(mids).length === 0) {
      log.warn('no mid prices available; skipping account', {
        agentWalletId: account.agentWalletId,
      });
      return;
    }

    // One query for every lead this account copies, then revalue against live
    // mids so a stale DB mark cannot distort the scaled target.
    const traderIds = [
      ...new Set(account.strategies.flatMap((s) => s.allocations.map((a) => a.traderId))),
    ];
    const rawPositions = await loadSourcePositions(db, traderIds);
    const sourcePositions = rawPositions.map((p) => {
      const mid = mids[p.symbol];
      if (!mid || mid <= 0 || p.markPrice <= 0) return p;
      return { ...p, markPrice: mid, positionValueUsd: p.quantity * mid };
    });

    const perStrategy = account.strategies.map((strategy) => ({
      strategyId: strategy.id,
      risk: strategy.risk,
      targets: computeTargetPositions({
        risk: strategy.risk,
        allocations: strategy.allocations,
        sourcePositions,
      }),
    }));

    const plan = mergeStrategyTargets(perStrategy);

    const current = await execution.getCurrentPositions(mids);
    const deltas = computeDeltas(current, plan.targets, {
      minOrderUsdFor: (symbol) => plan.riskFor(symbol).minOrderUsd,
      mids,
      driftThresholdPct: config.driftThresholdPct,
      // Ask the exchange's own lot rules what is placeable, so a sub-lot target
      // is dropped instead of being retried and rejected on every sweep.
      placeableSizeFor: (symbol, quantity) => {
        const szDecimals = shared.converter.getSzDecimals(symbol) ?? 0;
        const formatted = roundSize(Math.abs(quantity), szDecimals);
        if (formatted === null) return null;
        const value = Number(formatted);
        return Number.isFinite(value) ? Math.sign(quantity) * value : null;
      },
    });

    if (deltas.length === 0) {
      log.debug('in sync', {
        agentWalletId: account.agentWalletId,
        strategies: account.strategies.length,
        targets: plan.targets.size,
      });
    }

    let ok = 0;
    let failed = 0;

    for (const delta of deltas) {
      const midPrice = mids[delta.symbol];
      if (!midPrice || midPrice <= 0) {
        log.warn('no mid price for delta, skipping', { symbol: delta.symbol });
        continue;
      }

      const szDecimals = shared.converter.getSzDecimals(delta.symbol) ?? 0;
      const risk = plan.riskFor(delta.symbol);

      const result = await execution.execute(delta, {
        symbol: delta.symbol,
        midPrice,
        szDecimals,
        slippageBps: risk.slippageBps || config.defaultSlippageBps,
        builder: config.builderAddress
          ? { b: config.builderAddress, f: builderFeeTenthsOfBp(config.builderFeeRate) }
          : null,
      });

      if (result.ok) ok += 1;
      else failed += 1;

      // Attribution is exact only when a single strategy drove the symbol; a
      // netted order belongs to the account, not to any one strategy. Recording
      // null is honest — inventing an owner would make per-strategy P&L wrong.
      const owners = plan.contributors.get(delta.symbol) ?? [];
      const strategyId = owners.length === 1 ? owners[0] : null;

      await recordOrder(
        db,
        {
          userId: account.userId,
          strategyId,
          agentWalletId: account.agentWalletId,
          symbol: result.symbol,
          side: isBuyDelta(delta.deltaQty) ? 'buy' : 'sell',
          quantity: result.quantity,
          price: result.price,
          status: result.ok ? 'filled' : 'failed',
          exchangeOrderId: result.orderId,
          errorCode: result.ok ? undefined : 'execution_failed',
          errorMessage: result.error,
        },
        execution.mode,
      );

      if (!result.ok) {
        log.warn('order rejected', {
          agentWalletId: account.agentWalletId,
          symbol: result.symbol,
          error: result.error,
        });
      }
    }

    if (ok > 0 || failed > 0) {
      log.info('reconciled', {
        agentWalletId: account.agentWalletId,
        strategies: account.strategies.length,
        filled: ok,
        failed,
        deltas: deltas.length,
      });
    }

    // Mirror this account's real positions (chain truth, not our last guess).
    if (execution.mode === 'live') {
      const after = await execution.getCurrentPositions(mids);
      await syncCopyPositions(
        db,
        account.userId,
        account.agentWalletId,
        [...after.values()].map((p) => ({
          symbol: p.symbol,
          side: p.side,
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          leverage: p.leverage,
          unrealizedPnl: 0,
        })),
      );
    }
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  markStarted(): void {
    this.running = true;
  }
}

/**
 * Builder fee travels as an integer count of tenths of a basis point, while the
 * config carries the human form ("0.01%") so operators never have to think in
 * protocol units. 0.01% (1 bp) therefore encodes as 10.
 */
export function builderFeeTenthsOfBp(rate: string): number {
  const pct = Number.parseFloat(rate.replace('%', ''));
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  // 1 tenth of a bp = 0.001%
  return Math.round(pct / 0.001);
}
