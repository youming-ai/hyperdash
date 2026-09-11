import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a number with compact notation (e.g., 1.2K, 1.5M, 2.3B)
 */
export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Format PnL value with +/- prefix and dollar sign
 */
export function formatPnL(value: number): string {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.abs(value));

  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

/**
 * Shorten Ethereum address to first 6 and last 4 characters
 */
export function shortenAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Format a plain number with locale separators and adaptive precision
 * (fewer decimals for larger magnitudes).
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Format a USDT notional compactly, e.g. 1.23M. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `$${formatCompactNumber(value)}`;
}

/** Time-of-day label for an epoch-ms timestamp (HH:MM:SS UTC). */
export function formatTimeHms(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}
