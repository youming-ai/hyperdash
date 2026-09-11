import { describe, expect, test } from 'bun:test';
import {
  formatCompactNumber,
  formatNumber,
  formatPnL,
  formatTimeHms,
  formatUsd,
  shortenAddress,
} from './utils';

describe('formatCompactNumber', () => {
  test('compacts large numbers', () => {
    expect(formatCompactNumber(1_200)).toBe('1.2K');
    expect(formatCompactNumber(1_500_000)).toBe('1.5M');
    expect(formatCompactNumber(2_300_000_000)).toBe('2.3B');
  });

  test('leaves small numbers as-is', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(0)).toBe('0');
  });
});

describe('formatPnL', () => {
  test('prefixes positive values with +$', () => {
    expect(formatPnL(1234)).toBe('+$1,234');
  });

  test('prefixes negative values with -$', () => {
    expect(formatPnL(-1234)).toBe('-$1,234');
  });

  test('zero renders as +$0', () => {
    expect(formatPnL(0)).toBe('+$0');
  });
});

describe('formatNumber', () => {
  test('thousands separators with 2 decimals for large values', () => {
    expect(formatNumber(78850.5)).toBe('78,850.5');
  });

  test('4 decimals for values >= 1', () => {
    expect(formatNumber(3.14159)).toBe('3.1416');
  });

  test('6 decimals for small values', () => {
    expect(formatNumber(0.000123456)).toBe('0.000123');
  });

  test('non-finite renders as dash', () => {
    expect(formatNumber(Number.NaN)).toBe('-');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatUsd', () => {
  test('compacts with dollar sign', () => {
    expect(formatUsd(2_500_000)).toBe('$2.5M');
    expect(formatUsd(22_698_022.74)).toBe('$22.7M');
  });
});

describe('shortenAddress', () => {
  test('trims to first 6 and last 4', () => {
    expect(shortenAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...5678');
  });

  test('short strings pass through', () => {
    expect(shortenAddress('0x123')).toBe('0x123');
  });
});

describe('formatTimeHms', () => {
  test('extracts UTC HH:MM:SS', () => {
    expect(formatTimeHms(Date.UTC(2026, 0, 1, 13, 45, 9))).toBe('13:45:09');
  });
});
