import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Single em-dash sentinel for every "no value" case in the UI. */
export const EM_DASH = '—';

/**
 * A value read from the database. Drizzle returns `numeric` columns as strings,
 * so every formatter accepts the string form rather than forcing each call site
 * to coerce (and risk leaking NaN when it forgets).
 */
export type NumericLike = string | number | null | undefined;

/** A trader is "active" when they traded inside this window. */
export const RECENT_ACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;

/** Coerce a DB numeric (string | number | null) to a number, else null. */
export function toNumberOrNull(value: NumericLike): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a DB numeric to a number, falling back to 0. */
export function toNumber(value: NumericLike): number {
  return toNumberOrNull(value) ?? 0;
}

/**
 * Compact notation (1.2K / 1.5M / 2.3B). Renders an em dash for
 * non-finite input so a bad column never reaches the screen as "NaN".
 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return EM_DASH;
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Plain number with locale separators and magnitude-adaptive precision.
 * `maxDigits` lets a column pin its own precision instead of guessing.
 */
export function formatNumber(value: number, maxDigits?: number): string {
  if (!Number.isFinite(value)) return EM_DASH;
  const abs = Math.abs(value);
  const digits = maxDigits ?? (abs >= 1000 ? 2 : abs >= 1 ? 4 : 6);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Price formatting: more precision as the magnitude drops. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return EM_DASH;
  const abs = Math.abs(value);
  if (abs >= 1000) return formatNumber(value, 1);
  if (abs >= 1) return formatNumber(value, 3);
  if (abs >= 0.01) return formatNumber(value, 5);
  return formatNumber(value, 8);
}

/** Quantity formatting driven by the market's szDecimals. */
export function formatQty(value: number, szDecimals = 4): string {
  if (!Number.isFinite(value)) return EM_DASH;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, szDecimals),
  }).format(value);
}

/** Compact USD, e.g. $2.5M. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return EM_DASH;
  return `$${formatCompactNumber(value)}`;
}

/** Exact USD with separators, e.g. $22,698,023. */
export function formatUsdFull(value: number, maxDigits = 0): string {
  if (!Number.isFinite(value)) return EM_DASH;
  return `$${formatNumber(value, maxDigits)}`;
}

/**
 * Signed PnL with the sign ahead of the symbol: +$1,234 / -$1,234.
 * Never renders "$-1,234", and returns an em dash for non-finite input.
 */
export function formatPnL(value: number, options?: { compact?: boolean }): string {
  if (!Number.isFinite(value)) return EM_DASH;
  const magnitude = options?.compact
    ? formatCompactNumber(Math.abs(value))
    : formatNumber(Math.abs(value), 0);
  return `${value < 0 ? '-' : '+'}$${magnitude}`;
}

/** Signed compact USD where the sign leads: +$12.3M / -$12.3M. */
export function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return EM_DASH;
  return `${value < 0 ? '-' : '+'}$${formatCompactNumber(Math.abs(value))}`;
}

/** Percentage with an explicit precision; null/NaN render as an em dash. */
export function formatPercent(value: NumericLike, digits = 1): string {
  const n = toNumberOrNull(value);
  if (n === null) return EM_DASH;
  return `${n.toFixed(digits)}%`;
}

/** Signed percentage, sign leading: +12.3% / -4.5%. */
export function formatSignedPercent(value: NumericLike, digits = 2): string {
  const n = toNumberOrNull(value);
  if (n === null) return EM_DASH;
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/**
 * Perpetual funding rate as a percentage. Hyperliquid reports the hourly
 * rate as a fraction, so 0.0000123 -> "0.0012%".
 */
export function formatFundingRate(rate: NumericLike, digits = 4): string {
  const n = toNumberOrNull(rate);
  if (n === null) return EM_DASH;
  return `${(n * 100).toFixed(digits)}%`;
}

/** Annualised funding APY, capped so ordinary rates don't print absurd values. */
export function formatFundingApy(rate: NumericLike, cap = 999): string {
  const n = toNumberOrNull(rate);
  if (n === null) return EM_DASH;
  const apy = Math.max(-cap, Math.min(cap, n * 24 * 365 * 100));
  return `${apy.toFixed(1)}%`;
}

/** Humanised duration from seconds: 45s / 12m / 3.0h / 2.0d. */
export function formatDuration(seconds: NumericLike): string {
  const n = toNumberOrNull(seconds);
  if (n === null || n < 0) return EM_DASH;
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${Math.round(n / 60)}m`;
  if (n < 86400) return `${(n / 3600).toFixed(n < 36000 ? 1 : 0)}h`;
  return `${(n / 86400).toFixed(n < 864000 ? 1 : 0)}d`;
}

/** Time-of-day label for an epoch-ms timestamp (HH:MM:SS UTC). */
export function formatTimeHms(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

const DATE_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** Deterministic (UTC, locale-pinned) date-time so SSR and client agree. */
export function formatDateTime(iso: string | number | Date | null | undefined): string {
  if (iso === null || iso === undefined) return EM_DASH;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return DATE_TIME_FMT.format(d);
}

/** Relative-to-now label for recency cues: "just now" / "12m ago" / "3d ago". */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return EM_DASH;
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** First 6 / last 4 characters with a real ellipsis: 0x1234…5678. */
export function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Whether a trader traded inside RECENT_ACTIVITY_MS (a clock-skew-safe check). */
export function isRecentlyActive(lastTradeAt: string | null | undefined): boolean {
  if (!lastTradeAt) return false;
  const ms = Date.now() - new Date(lastTradeAt).getTime();
  return ms >= 0 && ms < RECENT_ACTIVITY_MS;
}
