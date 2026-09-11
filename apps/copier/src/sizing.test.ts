import { describe, expect, test } from 'bun:test';
import { computeDeltas } from './reconcile';
import { computeTargetPositions, mergeStrategyTargets } from './sizing';
import type { CurrentPosition, StrategyRisk, TargetPosition } from './types';

const RISK: StrategyRisk = {
  maxPositionUsd: 100_000,
  maxLeverage: 3,
  slippageBps: 10,
  minOrderUsd: 10,
  followNewEntriesOnly: false,
};

/** Build a target map from a compact spec. */
function targets(
  entries: Array<[symbol: string, side: 'long' | 'short', quantity: number, notional?: number]>,
): Map<string, TargetPosition> {
  return new Map(
    entries.map(([symbol, side, quantity, notional]) => [
      `${symbol}:${side}`,
      { symbol, side, quantity, notionalUsd: notional ?? quantity },
    ]),
  );
}

describe('mergeStrategyTargets', () => {
  test('cancels opposing legs of equal size so nothing is traded', () => {
    // The oscillation case: two strategies wanting opposite exposure to BTC.
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['BTC', 'long', 1]]) },
      { strategyId: 'b', risk: RISK, targets: targets([['BTC', 'short', 1]]) },
    ]);

    expect(plan.targets.size).toBe(0);
    // Both are still recorded as wanting exposure, which is what the order
    // attribution uses to decide it cannot name a single owner.
    expect(plan.contributors.get('BTC')).toEqual(['a', 'b']);
  });

  test('nets opposing legs of different size into one leg', () => {
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['BTC', 'long', 2]]) },
      { strategyId: 'b', risk: RISK, targets: targets([['BTC', 'short', 0.5]]) },
    ]);

    // computeDeltas nets by symbol, so both legs survive the merge and resolve
    // to +1.5 there. What matters is that the pair is represented, not that the
    // merge itself subtracts.
    const net =
      (plan.targets.get('BTC:long')?.quantity ?? 0) -
      (plan.targets.get('BTC:short')?.quantity ?? 0);
    expect(net).toBeCloseTo(1.5, 8);
  });

  test('sums same-direction legs from several strategies', () => {
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['ETH', 'long', 1, 100]]) },
      { strategyId: 'b', risk: RISK, targets: targets([['ETH', 'long', 2, 200]]) },
    ]);

    expect(plan.targets.get('ETH:long')?.quantity).toBe(3);
    expect(plan.targets.get('ETH:long')?.notionalUsd).toBe(300);
    expect(plan.contributors.get('ETH')).toEqual(['a', 'b']);
  });

  test('keeps symbols that only one strategy wants', () => {
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['SOL', 'short', 5]]) },
      { strategyId: 'b', risk: RISK, targets: targets([['BTC', 'long', 1]]) },
    ]);

    expect(plan.targets.size).toBe(2);
    expect(plan.contributors.get('SOL')).toEqual(['a']);
    expect(plan.contributors.get('BTC')).toEqual(['b']);
  });

  test('does not double-count a strategy that repeats a symbol', () => {
    const plan = mergeStrategyTargets([
      {
        strategyId: 'a',
        risk: RISK,
        targets: targets([
          ['BTC', 'long', 1],
          ['BTC', 'long', 1],
        ]),
      },
    ]);

    // Two allocations in one strategy aggregate to a single 2-unit leg...
    expect(plan.targets.size).toBe(1);
    // ...but the strategy is listed once, not twice.
    expect(plan.contributors.get('BTC')).toEqual(['a']);
  });

  test('takes the conservative value when strategies disagree on risk', () => {
    // A merged order must not exceed what either contributor would accept:
    // the strictest minimum (least churn) and the tightest band (least slippage).
    const plan = mergeStrategyTargets([
      {
        strategyId: 'a',
        risk: { ...RISK, minOrderUsd: 10, slippageBps: 10 },
        targets: targets([['BTC', 'long', 1]]),
      },
      {
        strategyId: 'b',
        risk: { ...RISK, minOrderUsd: 500, slippageBps: 50 },
        targets: targets([['BTC', 'long', 1]]),
      },
    ]);

    expect(plan.riskFor('BTC').minOrderUsd).toBe(500);
    expect(plan.riskFor('BTC').slippageBps).toBe(10);
  });

  test('falls back to a sane risk for an unknown symbol', () => {
    const plan = mergeStrategyTargets([]);
    expect(plan.riskFor('NOTHING').minOrderUsd).toBeGreaterThan(0);
  });
});

describe('computeDeltas with merged targets', () => {
  const mids = { BTC: 50_000, ETH: 3_000, DOGE: 0.1 };

  // Mirrors the SDK's formatSize: truncate to the lot, but treat a value that is
  // an exact decimal multiple as exact (0.6 / 1e-5 is 59999.999... in binary).
  const lot =
    (decimals: number) =>
    (quantity: number): number | null => {
      if (!Number.isFinite(quantity) || quantity === 0) return null;
      const step = 10 ** -decimals;
      const exact = Math.abs(quantity) / step;
      const nearest = Math.round(exact);
      const lots = Math.abs(exact - nearest) < 1e-6 ? nearest : Math.floor(exact);
      if (lots === 0) return null;
      return Math.sign(quantity) * Number((lots * step).toFixed(decimals));
    };

  test('produces one netted delta instead of two opposing ones', () => {
    // Without merging, strategy A and B would each emit a delta for BTC and the
    // two orders would cancel out in the market while both paying fees.
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['BTC', 'long', 1]]) },
      { strategyId: 'b', risk: RISK, targets: targets([['BTC', 'short', 0.4]]) },
    ]);

    const deltas = computeDeltas(new Map(), plan.targets, {
      minOrderUsdFor: () => 10,
      mids,
      driftThresholdPct: 0,
      placeableSizeFor: (_s, q) => lot(5)(q),
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0].symbol).toBe('BTC');
    // +1 long and -0.4 short resolve to a single +0.6 buy.
    expect(deltas[0].deltaQty).toBeCloseTo(0.6, 8);
  });

  test('closes a held position when the merged target nets to zero', () => {
    const current = new Map<string, CurrentPosition>([
      [
        'BTC:long',
        {
          symbol: 'BTC',
          side: 'long',
          quantity: 0.5,
          entryPrice: 50_000,
          markPrice: 50_000,
          notionalUsd: 25_000,
          leverage: 1,
        },
      ],
    ]);

    // Equal opposing wants cancel, but the account still holds BTC — so the fix
    // must flatten it rather than doing nothing.
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['BTC', 'long', 1]]) },
      { strategyId: 'b', risk: RISK, targets: targets([['BTC', 'short', 1]]) },
    ]);

    const deltas = computeDeltas(current, plan.targets, {
      minOrderUsdFor: () => 10,
      mids,
      driftThresholdPct: 0,
      placeableSizeFor: (_s, q) => lot(5)(q),
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0].deltaQty).toBeCloseTo(-0.5, 8);
  });

  test('drops a delta below one lot instead of retrying it forever', () => {
    // Regression: a target of 0.0094 on an asset whose lot is 0.01 was proposed
    // on every sweep and rejected every time, writing a failure row per pass.
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['DOGE', 'long', 0.0094]]) },
    ]);

    const deltas = computeDeltas(new Map(), plan.targets, {
      minOrderUsdFor: () => 0, // even with no size deadband
      mids,
      driftThresholdPct: 0,
      placeableSizeFor: (_s, q) => lot(2)(q),
    });

    expect(deltas).toHaveLength(0);
  });

  test('rounds a delta down to a placeable size', () => {
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['BTC', 'long', 1.23456]]) },
    ]);

    const deltas = computeDeltas(new Map(), plan.targets, {
      minOrderUsdFor: () => 10,
      mids,
      driftThresholdPct: 0,
      placeableSizeFor: (_s, q) => lot(3)(q),
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0].deltaQty).toBeCloseTo(1.234, 8);
  });

  test('still applies the notional deadband after lot rounding', () => {
    const plan = mergeStrategyTargets([
      { strategyId: 'a', risk: RISK, targets: targets([['ETH', 'long', 0.004]]) },
    ]);

    const deltas = computeDeltas(new Map(), plan.targets, {
      minOrderUsdFor: () => 10,
      mids,
      driftThresholdPct: 0,
      placeableSizeFor: (_s, q) => lot(3)(q),
    });

    // 0.004 ETH = $12, above the $10 floor, so it should survive.
    expect(deltas).toHaveLength(1);
    expect(deltas[0].deltaQty).toBeCloseTo(0.004, 8);
  });
});

describe('computeTargetPositions', () => {
  test('scales a lead position by the follower capital ratio', () => {
    const result = computeTargetPositions({
      risk: RISK,
      allocations: [
        { traderId: 'lead', traderAddress: '0x0', weight: 1, leadEquityUsd: 1_000_000 },
      ],
      sourcePositions: [
        {
          traderId: 'lead',
          symbol: 'BTC',
          side: 'long',
          quantity: 2,
          markPrice: 50_000,
          positionValueUsd: 100_000,
        },
      ],
    });

    // exposure = 100k / 1M equity = 10%; 10% of $100k capital = $10k → 0.2 BTC.
    const btc = result.get('BTC:long');
    expect(btc).toBeDefined();
    expect(btc?.quantity).toBeCloseTo(0.2, 8);
  });

  test('skips a lead with no equity rather than dividing by zero', () => {
    const result = computeTargetPositions({
      risk: RISK,
      allocations: [{ traderId: 'lead', traderAddress: '0x0', weight: 1, leadEquityUsd: 0 }],
      sourcePositions: [
        {
          traderId: 'lead',
          symbol: 'BTC',
          side: 'long',
          quantity: 10,
          markPrice: 50_000,
          positionValueUsd: 500_000,
        },
      ],
    });

    expect(result.size).toBe(0);
  });
});
