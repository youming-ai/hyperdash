/**
 * Copier configuration.
 *
 * Env is read once at boot. `LIVE` is the single switch that decides whether
 * orders are real: anything other than "1" runs in paper mode, so the whole
 * pipeline (detection → sizing → precision → reconcile → persistence) can be
 * exercised against live market data without risking funds.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export interface CopierConfig {
  /** Postgres connection string (direct, not Hyperdrive — this is a long-lived process). */
  databaseUrl: string;
  /** Run real orders. Anything else is paper mode. */
  live: boolean;
  /** Hyperliquid info API base URL. */
  infoUrl: string;
  /** Builder address for fee routing (optional). */
  builderAddress: `0x${string}` | null;
  /** Builder fee rate, e.g. "0.01%". */
  builderFeeRate: string;
  /** Full sweep interval (ms). The safety net. */
  sweepIntervalMs: number;
  /** Refetch strategies from Postgres every N ms. */
  strategyRefreshMs: number;
  /** Max accounts reconciled concurrently (shared IP rate limits apply). */
  maxConcurrency: number;
  /** Hysteresis: skip deltas below this notional (USD). */
  minOrderUsd: number;
  /** Hysteresis: skip deltas below this % of target notional. */
  driftThresholdPct: number;
  /** Default slippage bound in bps for the IOC limit price. */
  defaultSlippageBps: number;
  /** Per-strategy cap on notional when the strategy row has none. */
  defaultMaxPositionUsd: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(): CopierConfig {
  const live = bool('LIVE', false);

  // Agent keys now come from the database, one per account, so live mode needs
  // no single signing key. ENCRYPTION_KEY (required to decrypt them) is checked
  // at boot, where the failure is actionable.
  return {
    databaseUrl: required('DATABASE_URL'),
    live,
    infoUrl: process.env.HYPERLIQUID_API_URL ?? 'https://api.hyperliquid.xyz/info',
    builderAddress: (process.env.BUILDER_ADDRESS ?? null) as `0x${string}` | null,
    builderFeeRate: process.env.BUILDER_FEE_RATE ?? '0.01%',
    sweepIntervalMs: num('SWEEP_INTERVAL_MS', 60_000),
    strategyRefreshMs: num('STRATEGY_REFRESH_MS', 15_000),
    maxConcurrency: num('MAX_CONCURRENCY', 8),
    minOrderUsd: num('MIN_ORDER_USD', 10),
    driftThresholdPct: num('DRIFT_THRESHOLD_PCT', 1),
    defaultSlippageBps: num('DEFAULT_SLIPPAGE_BPS', 10),
    defaultMaxPositionUsd: num('DEFAULT_MAX_POSITION_USD', 1_000),
    logLevel: (process.env.LOG_LEVEL ?? 'info') as CopierConfig['logLevel'],
  };
}
