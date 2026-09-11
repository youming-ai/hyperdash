/**
 * A/B comparison of per-strategy vs per-account reconciliation.
 *
 * The oscillation fix rests on a claim about *why* the old behaviour was
 * expensive, so this reproduces both algorithms against the same database state
 * and the same simulated book. It deliberately does not touch the engine: the
 * point is to measure the two strategies side by side under identical inputs.
 *
 *   bun src/cli/compare-oscillation.ts
 */

import { loadConfig } from '../config';
import { createDb } from '../db';
import { createSharedClients, getAllMids, roundSize } from '../hyperliquid';
import { computeDeltas } from '../reconcile';
import { computeTargetPositions, mergeStrategyTargets } from '../sizing';
import { loadSourcePositions, loadTradingAccounts } from '../store';
import type { CurrentPosition } from '../types';

/** Minimal in-memory book standing in for the paper executor. */
class Book {
  private readonly positions = new Map<string, number>();
  orders = 0;

  apply(symbol: string, delta: number): void {
    this.positions.set(symbol, (this.positions.get(symbol) ?? 0) + delta);
    this.orders += 1;
  }

  snapshot(mids: Record<string, number>): Map<string, CurrentPosition> {
    const out = new Map<string, CurrentPosition>();
    for (const [symbol, qty] of this.positions) {
      if (qty === 0) continue;
      const mark = mids[symbol] ?? 0;
      out.set(`${symbol}:${qty > 0 ? 'long' : 'short'}`, {
        symbol,
        side: qty > 0 ? 'long' : 'short',
        quantity: Math.abs(qty),
        entryPrice: mark,
        markPrice: mark,
        notionalUsd: Math.abs(qty) * mark,
        leverage: 1,
      });
    }
    return out;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, client } = createDb(config.databaseUrl);
  const shared = await createSharedClients();
  const mids = await getAllMids(shared.info);

  const accounts = await loadTradingAccounts(db);
  const multi = accounts.filter((a) => a.strategies.length > 1);

  console.log(`accounts: ${accounts.length}, of which multi-strategy: ${multi.length}`);
  if (multi.length === 0) {
    console.log('no account carries more than one strategy; nothing to compare');
  }

  const sweeps = Number(process.argv[2] ?? 6);

  for (const account of multi) {
    console.log(
      `\n=== account ${account.agentWalletId.slice(0, 8)} — ${account.strategies.length} strategies ===`,
    );

    const traderIds = [
      ...new Set(account.strategies.flatMap((s) => s.allocations.map((a) => a.traderId))),
    ];
    const raw = await loadSourcePositions(db, traderIds);
    const sourcePositions = raw.map((p) => {
      const mid = mids[p.symbol];
      return mid && mid > 0 ? { ...p, markPrice: mid, positionValueUsd: p.quantity * mid } : p;
    });

    const placeableSizeFor = (symbol: string, quantity: number): number | null => {
      const szDecimals = shared.converter.getSzDecimals(symbol) ?? 0;
      const formatted = roundSize(Math.abs(quantity), szDecimals);
      if (formatted === null) return null;
      const value = Number(formatted);
      return Number.isFinite(value) ? Math.sign(quantity) * value : null;
    };

    const perStrategy = account.strategies.map((strategy) => ({
      strategyId: strategy.id,
      risk: strategy.risk,
      targets: computeTargetPositions({
        risk: strategy.risk,
        allocations: strategy.allocations,
        sourcePositions,
      }),
    }));

    // --- A: per-strategy reconcile (the previous behaviour) ----------------
    {
      const book = new Book();
      for (let sweep = 0; sweep < sweeps; sweep++) {
        const current = book.snapshot(mids);
        for (const { risk, targets } of perStrategy) {
          const deltas = computeDeltas(current, targets, {
            minOrderUsdFor: () => risk.minOrderUsd,
            mids,
            driftThresholdPct: config.driftThresholdPct,
            placeableSizeFor,
          });
          for (const d of deltas) book.apply(d.symbol, d.deltaQty);
        }
      }
      console.log(`  A per-strategy : ${book.orders} orders over ${sweeps} sweeps`);
    }

    // --- B: per-account merge (the fix) ------------------------------------
    {
      const book = new Book();
      const plan = mergeStrategyTargets(perStrategy);
      for (let sweep = 0; sweep < sweeps; sweep++) {
        const current = book.snapshot(mids);
        const deltas = computeDeltas(current, plan.targets, {
          minOrderUsdFor: (symbol) => plan.riskFor(symbol).minOrderUsd,
          mids,
          driftThresholdPct: config.driftThresholdPct,
          placeableSizeFor,
        });
        for (const d of deltas) book.apply(d.symbol, d.deltaQty);
      }
      console.log(`  B per-account  : ${book.orders} orders over ${sweeps} sweeps`);
    }

    // Show where the two disagree most, which is the netting at work.
    const merged = mergeStrategyTargets(perStrategy);
    const legCount = perStrategy.reduce((n, s) => n + s.targets.size, 0);
    console.log(`  legs before merge: ${legCount}, after merge: ${merged.targets.size}`);
    const contested = [...merged.contributors.entries()].filter(([, ids]) => ids.length > 1);
    console.log(`  symbols wanted by >1 strategy: ${contested.length}`);
  }

  await shared.close();
  await client.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
