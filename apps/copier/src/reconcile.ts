/**
 * Reconcile current positions toward target positions.
 *
 * The whole design rests on one decision: drive toward *target state* instead
 * of replaying orders. A missed event, a partial fill, or a user poking their
 * account manually all become self-correcting on the next pass, because the
 * computation never depends on having seen every event. It also makes the
 * operation idempotent — running it twice does nothing the second time.
 *
 * Hysteresis (min notional + drift threshold) is essential: without deadbands a
 * perfectly correct reconciler still bleeds fees by re-trading market noise.
 * Both the event fast path and the periodic sweep must share these exact rules,
 * or the two fight each other and become a fee-burning oscillator.
 */

import type { CurrentPosition, PositionDelta, TargetPosition } from './types';

/** Signed net exposure for a symbol: long positive, short negative. */
function signedQuantity(
  symbol: string,
  positions: Iterable<CurrentPosition | TargetPosition>,
): number {
  let signed = 0;
  for (const p of positions) {
    if (p.symbol !== symbol) continue;
    signed += p.side === 'long' ? p.quantity : -p.quantity;
  }
  return signed;
}

export interface DeltaOptions {
  /**
   * Deadband for a symbol's delta, in USD.
   *
   * A resolver rather than a constant because an account can carry several
   * strategies with different minimums; the merged order should respect the
   * strictest one that contributed to that symbol.
   */
  minOrderUsdFor: (symbol: string) => number;
  mids: Record<string, number>;
  /** Skip deltas below this % of target notional (0 disables). */
  driftThresholdPct: number;
  /**
   * The size actually placeable for a symbol, or null when the delta cannot be
   * expressed at the asset's lot size.
   *
   * Required rather than optional on purpose. Without it a delta below one lot
   * is proposed again on every sweep and rejected by the exchange every time —
   * an endless retry loop that also writes a failure row per pass. Observed with
   * a $11.5 target on an asset whose lot is $12.2: four rejected orders in 30
   * seconds, forever.
   */
  placeableSizeFor: (symbol: string, quantity: number) => number | null;
}

/**
 * Deltas required to move each symbol from its current net position to target.
 *
 * Net-per-symbol rather than per-`symbol:side` key, because a long→short flip
 * must be executed as a single larger order instead of two independent ones.
 */
export function computeDeltas(
  current: Map<string, CurrentPosition>,
  targets: Map<string, TargetPosition>,
  options: DeltaOptions,
): PositionDelta[] {
  const symbols = new Set<string>();
  for (const p of current.values()) symbols.add(p.symbol);
  for (const p of targets.values()) symbols.add(p.symbol);

  const deltas: PositionDelta[] = [];

  for (const symbol of symbols) {
    const midPrice = options.mids[symbol] ?? 0;
    if (midPrice <= 0) continue;

    const currentSigned = signedQuantity(
      symbol,
      [...current.values()].filter((p) => p.symbol === symbol),
    );
    const targetSigned = signedQuantity(
      symbol,
      [...targets.values()].filter((p) => p.symbol === symbol),
    );

    const rawDelta = targetSigned - currentSigned;
    if (rawDelta === 0) continue;

    // Only propose orders that can actually be placed: a size below one lot
    // would be rejected on every pass, forever.
    const deltaQty = options.placeableSizeFor(symbol, rawDelta);
    if (deltaQty === null || deltaQty === 0) continue;

    const absQty = Math.abs(deltaQty);
    const deltaNotional = absQty * midPrice;

    // Deadband 1: never trade an economically meaningless clip.
    if (deltaNotional < options.minOrderUsdFor(symbol)) continue;

    // Deadband 2: ignore drift that is small relative to the intended position.
    const targetNotional = Math.abs(targetSigned) * midPrice;
    if (
      options.driftThresholdPct > 0 &&
      targetNotional > 0 &&
      deltaNotional / targetNotional < options.driftThresholdPct / 100
    ) {
      continue;
    }

    // The side of the *resulting* position decides direction.
    const side: 'long' | 'short' = targetSigned >= 0 ? 'long' : 'short';

    deltas.push({
      symbol,
      deltaQty,
      side,
      currentQty: currentSigned,
      targetQty: targetSigned,
      // A delta that shrinks absolute exposure must not open new risk.
      reduceOnly:
        Math.abs(targetSigned) < Math.abs(currentSigned) &&
        Math.sign(targetSigned) === Math.sign(currentSigned) &&
        targetSigned !== 0,
    });
  }

  return deltas;
}

/** Order direction implied by a signed delta. */
export function isBuyDelta(delta: number): boolean {
  return delta > 0;
}
