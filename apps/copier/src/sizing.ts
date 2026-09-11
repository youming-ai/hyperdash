/**
 * Target position sizing.
 *
 * Follows the standard copy-trading approach: scale the lead's *position*
 * (never replay the lead's orders) by the follower's capital relative to the
 * lead's, then clamp with the follower's own risk config. Two consequences are
 * intentional:
 *
 *  - The follower's caps win over the lead's appetite. A lead running 20x with
 *    a follower capped at 5x must not drag the follower to 20x — not tracking
 *    perfectly is the correct outcome.
 *  - A scaled position below the minimum order size is skipped rather than
 *    rounded up, because rounding up would silently exceed the user's intent.
 */

import type { Allocation, StrategyRisk, TargetPosition } from './types';

/** A lead position as read from Postgres (`trader_positions`). */
export interface SourcePosition {
  traderId: string;
  symbol: string;
  side: string;
  quantity: number;
  markPrice: number;
  positionValueUsd: number;
}

export interface SizingInput {
  risk: StrategyRisk;
  allocations: Allocation[];
  sourcePositions: SourcePosition[];
}

/**
 * Compute the follower's desired positions, aggregated across all allocations.
 *
 * Keyed by `${symbol}:${side}` so opposing views from different leads are held
 * as separate legs rather than silently netting into an unintended position.
 */
export function computeTargetPositions(input: SizingInput): Map<string, TargetPosition> {
  const targets = new Map<string, TargetPosition>();

  const byTrader = new Map<string, SourcePosition[]>();
  for (const p of input.sourcePositions) {
    const list = byTrader.get(p.traderId);
    if (list) list.push(p);
    else byTrader.set(p.traderId, [p]);
  }

  for (const allocation of input.allocations) {
    if (allocation.weight <= 0) continue;
    if (allocation.leadEquityUsd <= 0) continue;

    const positions = byTrader.get(allocation.traderId);
    if (!positions) continue;

    const allocationCapital = input.risk.maxPositionUsd * allocation.weight;

    for (const position of positions) {
      if (position.markPrice <= 0) continue;

      // How much of the lead's own book this position represents.
      const exposureRatio = position.positionValueUsd / allocation.leadEquityUsd;
      if (exposureRatio <= 0) continue;

      const rawNotional = allocationCapital * exposureRatio;
      const leveredCap = allocationCapital * input.risk.maxLeverage;
      const targetNotionalUsd = Math.min(rawNotional, leveredCap);

      if (targetNotionalUsd < input.risk.minOrderUsd) continue;

      const side: 'long' | 'short' = position.side === 'short' ? 'short' : 'long';
      const key = `${position.symbol}:${side}`;
      const quantity = targetNotionalUsd / position.markPrice;

      const existing = targets.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.notionalUsd += targetNotionalUsd;
      } else {
        targets.set(key, {
          symbol: position.symbol,
          side,
          quantity,
          notionalUsd: targetNotionalUsd,
        });
      }
    }
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Account-level merge
// ---------------------------------------------------------------------------

/** Per-symbol risk derived from the strategies that wanted exposure to it. */
export interface DeltaRisk {
  minOrderUsd: number;
  slippageBps: number;
}

export interface MergedPlan {
  /**
   * Targets for the whole account, keyed by `symbol:side`.
   *
   * Opposing legs are kept separate here on purpose: `computeDeltas` nets them
   * per symbol, which is exactly the behaviour needed to stop two strategies
   * from trading against each other.
   */
  targets: Map<string, TargetPosition>;
  /** Symbol -> the strategies that asked for exposure (either side). */
  contributors: Map<string, string[]>;
  /** Risk to apply to a symbol's netted delta. */
  riskFor: (symbol: string) => DeltaRisk;
}

/**
 * Merge the targets of every strategy writing to one account.
 *
 * This is the fix for a real and expensive failure: reconciling strategy by
 * strategy made each one measure the *account's* positions against its own
 * targets, so two strategies on one account kept undoing each other. Measured
 * before this change: 5,092 orders in 40 seconds, with one symbol bought and
 * sold 26 times each.
 *
 * Where strategies disagree on parameters the merge takes the more conservative
 * value — the strictest minimum order size (less fee churn) and the tightest
 * slippage band (less slippage paid) — so a merged order never exceeds what any
 * contributing strategy would have accepted on its own.
 */
export function mergeStrategyTargets(
  inputs: Array<{ strategyId: string; risk: StrategyRisk; targets: Map<string, TargetPosition> }>,
): MergedPlan {
  const targets = new Map<string, TargetPosition>();
  const contributors = new Map<string, string[]>();
  const risksBySymbol = new Map<string, DeltaRisk[]>();

  const fallback: DeltaRisk = { minOrderUsd: 10, slippageBps: 10 };

  for (const { strategyId, risk, targets: strategyTargets } of inputs) {
    for (const [key, target] of strategyTargets) {
      const existing = targets.get(key);
      if (existing) {
        existing.quantity += target.quantity;
        existing.notionalUsd += target.notionalUsd;
      } else {
        targets.set(key, { ...target });
      }

      const symbolContributors = contributors.get(target.symbol);
      if (!symbolContributors) contributors.set(target.symbol, [strategyId]);
      else if (!symbolContributors.includes(strategyId)) symbolContributors.push(strategyId);

      const symbolRisks = risksBySymbol.get(target.symbol);
      const riskEntry: DeltaRisk = {
        minOrderUsd: risk.minOrderUsd,
        slippageBps: risk.slippageBps,
      };
      if (symbolRisks) symbolRisks.push(riskEntry);
      else risksBySymbol.set(target.symbol, [riskEntry]);
    }
  }

  // Drop legs that net to exactly nothing so they cannot produce an order on
  // their own. Omitting them is safe: `computeDeltas` unions target and current
  // symbols, so a symbol the account still holds is closed against a target of
  // zero, and a symbol it does not hold yields no delta at all.
  for (const [key, target] of [...targets]) {
    if (target.side !== 'long') continue; // handle each pair once
    const shortKey = `${target.symbol}:short`;
    const opposite = targets.get(shortKey);
    if (!opposite) continue;

    if (Math.abs(target.quantity - opposite.quantity) < 1e-12) {
      targets.delete(key);
      targets.delete(shortKey);
    }
  }

  return {
    targets,
    contributors,
    riskFor: (symbol: string): DeltaRisk => {
      const risks = risksBySymbol.get(symbol);
      if (!risks || risks.length === 0) return fallback;
      return {
        // Strictest minimum (least churn), tightest band (least slippage).
        minOrderUsd: Math.max(...risks.map((r) => r.minOrderUsd)),
        slippageBps: Math.min(...risks.map((r) => r.slippageBps)),
      };
    },
  };
}
