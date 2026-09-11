import type { Tone } from '~/components/ui/stat-card';

/**
 * Presentation rules for trader metrics.
 *
 * These lived as two near-identical copies (one per trader route, returning a
 * class name in one and a `Tone` in the other). The rules themselves are what
 * matter — the neutral band, "zero is not a direction", and the fact that a
 * true zero drawdown must not print as `-0.0%` — so they are defined once here
 * and mapped to either output by the caller.
 */

/** Inside this band a Sharpe ratio is noise rather than a signal. */
const SHARPE_NEUTRAL_BAND = 0.5;

/** Direction of a PnL value. Missing and exactly-zero values stay neutral. */
export function pnlTone(value: number | null): Tone {
  if (value === null || value === 0) return 'neutral';
  return value > 0 ? 'up' : 'down';
}

/** Sharpe is only coloured once it is meaningfully away from zero. */
export function sharpeTone(value: number | null): Tone {
  if (value === null || Math.abs(value) < SHARPE_NEUTRAL_BAND) return 'neutral';
  return value > 0 ? 'up' : 'down';
}

/**
 * Drawdown is a decline, so it is rendered as a negative percentage — except
 * for a true zero, which stays `0.0%` rather than the `-0.0%` that
 * `-Math.abs(0)` would print.
 */
export function drawdownValue(value: number | null): number | null {
  if (value === null) return null;
  return value === 0 ? 0 : -Math.abs(value);
}

/** Tone for an already-normalised drawdown value. */
export function drawdownTone(value: number | null): Tone {
  return value !== null && value < 0 ? 'down' : 'neutral';
}
