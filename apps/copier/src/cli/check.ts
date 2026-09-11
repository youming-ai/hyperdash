/**
 * Dry-run diagnostic: show exactly what the reconciler would do.
 *
 * Prints the sizing chain (lead equity → exposure ratio → scaled notional →
 * target quantity) and the resulting deltas without submitting anything. Use it
 * to sanity-check a strategy before letting the engine trade, and to explain a
 * "nothing happened" outcome when a delta is rejected by a deadband.
 *
 *   bun src/cli/check.ts
 */

import { loadConfig } from '../config';
import { createDb } from '../db';
import { createSharedClients, getAllMids, roundSize } from '../hyperliquid';
import { setLogLevel } from '../log';
import { computeDeltas } from '../reconcile';
import { computeTargetPositions } from '../sizing';
import { loadActiveStrategies, loadMasterAddress, loadSourcePositions } from '../store';

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel('warn');

  const { db, client } = createDb(config.databaseUrl);
  const shared = await createSharedClients();

  const mids = await getAllMids(shared.info);
  console.log(`mids: ${Object.keys(mids).length} symbols`);

  const strategies = await loadActiveStrategies(db);
  console.log(`active strategies: ${strategies.length}\n`);

  for (const strategy of strategies) {
    console.log('='.repeat(72));
    console.log(`strategy ${strategy.name}  (${strategy.id})`);
    console.log(`  mode=${strategy.mode}  allocations=${strategy.allocations.length}`);

    const master = await loadMasterAddress(db, strategy.userId);
    console.log(`  master=${master ?? 'NONE (cannot trade)'}`);
    console.log(
      `  risk: capital=$${strategy.risk.maxPositionUsd} lev=${strategy.risk.maxLeverage} ` +
        `min=$${strategy.risk.minOrderUsd} slip=${strategy.risk.slippageBps}bps`,
    );

    const traderIds = strategy.allocations.map((a) => a.traderId);
    const sourcePositions = await loadSourcePositions(db, traderIds);

    // Revalue against live mids so stale DB marks do not distort the target.
    const revalued = sourcePositions.map((p) => {
      const mid = mids[p.symbol];
      return mid && mid > 0 ? { ...p, markPrice: mid, positionValueUsd: p.quantity * mid } : p;
    });

    console.log(`  lead positions in DB: ${revalued.length}`);
    for (const allocation of strategy.allocations) {
      const owned = revalued.filter((p) => p.traderId === allocation.traderId);
      console.log(
        `    alloc weight=${allocation.weight} leadEquity=$${allocation.leadEquityUsd.toFixed(0)} ` +
          `positions=${owned.length}`,
      );
      for (const p of owned.slice(0, 8)) {
        const ratio =
          allocation.leadEquityUsd > 0 ? p.positionValueUsd / allocation.leadEquityUsd : 0;
        console.log(
          `      ${p.symbol.padEnd(6)} ${p.side.padEnd(5)} qty=${p.quantity.toFixed(4).padStart(12)} ` +
            `notional=$${p.positionValueUsd.toFixed(0).padStart(10)} exposure=${(ratio * 100).toFixed(3)}%`,
        );
      }
      if (owned.length > 8) console.log(`      ... ${owned.length - 8} more`);
    }

    const targets = computeTargetPositions({
      risk: strategy.risk,
      allocations: strategy.allocations,
      sourcePositions: revalued,
    });

    console.log(`  -> targets: ${targets.size}`);
    for (const t of targets.values()) {
      console.log(
        `     ${t.symbol.padEnd(6)} ${t.side.padEnd(5)} qty=${t.quantity.toFixed(6).padStart(14)} ` +
          `notional=$${t.notionalUsd.toFixed(2)}`,
      );
    }

    // Current positions come from the chain when a master is configured;
    // otherwise assume flat, which is what paper mode starts from.
    let current = new Map();
    if (master) {
      const { getCurrentPositions } = await import('../hyperliquid');
      current = await getCurrentPositions(shared.info, master, mids);
      console.log(`  current on-chain positions: ${current.size}`);
    } else {
      console.log('  current on-chain positions: (no master; assuming flat)');
    }

    const deltas = computeDeltas(current, targets, {
      minOrderUsdFor: () => strategy.risk.minOrderUsd,
      mids,
      driftThresholdPct: config.driftThresholdPct,
      placeableSizeFor: (symbol, quantity) => {
        const szDecimals = shared.converter.getSzDecimals(symbol) ?? 0;
        const formatted = roundSize(Math.abs(quantity), szDecimals);
        if (formatted === null) return null;
        const value = Number(formatted);
        return Number.isFinite(value) ? Math.sign(quantity) * value : null;
      },
    });

    console.log(
      `  -> deltas: ${deltas.length}  (minOrderUsd=$${strategy.risk.minOrderUsd}, drift=${config.driftThresholdPct}%)`,
    );
    for (const d of deltas) {
      console.log(
        `     ${d.symbol.padEnd(6)} ${d.deltaQty > 0 ? 'BUY ' : 'SELL'} ` +
          `delta=${d.deltaQty.toFixed(6).padStart(14)} ` +
          `current=${d.currentQty.toFixed(6)} -> target=${d.targetQty.toFixed(6)}` +
          `${d.reduceOnly ? '  reduceOnly' : ''}`,
      );
    }

    if (deltas.length === 0 && targets.size > 0) {
      console.log('  (targets exist but no delta clears the deadbands — see below)');
    }
    if (targets.size === 0) {
      console.log('  (no targets: check lead equity > 0 and position notionals)');
    }
    console.log('');
  }

  await client.end();
  await shared.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
