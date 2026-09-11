import { describe, expect, test } from 'bun:test';
import {
  EM_DASH,
  formatCompactNumber,
  formatDuration,
  formatFundingRate,
  formatNumber,
  formatPercent,
  formatPnL,
  formatPrice,
  formatSignedPercent,
  formatTimeHms,
  formatUsd,
  formatUsdFull,
  isRecentlyActive,
  shortenAddress,
  toNumber,
  toNumberOrNull,
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

  test('non-finite renders as em dash', () => {
    expect(formatCompactNumber(Number.NaN)).toBe(EM_DASH);
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

  test('never puts the sign after the dollar sign', () => {
    expect(formatPnL(-1_234)).toBe('-$1,234');
    expect(formatPnL(-1_234)).not.toContain('$-');
  });

  test('non-finite renders as em dash', () => {
    expect(formatPnL(Number.NaN)).toBe(EM_DASH);
  });
});

describe('formatNumber', () => {
  test('thousands separators with 2 decimals for large values', () => {
    expect(formatNumber(78850.5)).toBe('78,850.5');
  });

  test('4 decimals for values >= 1', () => {
    expect(formatNumber(1.23456)).toBe('1.2346');
  });

  test('6 decimals for small values', () => {
    expect(formatNumber(0.000123456)).toBe('0.000123');
  });

  test('non-finite renders as em dash', () => {
    expect(formatNumber(Number.NaN)).toBe(EM_DASH);
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
  });

  test('honours an explicit precision', () => {
    expect(formatNumber(1234.5678, 0)).toBe('1,235');
  });
});

describe('formatUsd', () => {
  test('compacts with dollar sign', () => {
    expect(formatUsd(2_500_000)).toBe('$2.5M');
    expect(formatUsd(22_698_022.74)).toBe('$22.7M');
  });

  test('exact variant keeps separators', () => {
    expect(formatUsdFull(22_698_022.74)).toBe('$22,698,023');
  });
});

describe('formatPrice', () => {
  test('scales precision by magnitude', () => {
    expect(formatPrice(78_850.5)).toBe('78,850.5');
    expect(formatPrice(1.23456)).toBe('1.235');
    expect(formatPrice(0.00012345)).toBe('0.00012345');
  });
});

describe('formatPercent', () => {
  test('formats with a fixed precision', () => {
    expect(formatPercent(46.04)).toBe('46.0%');
    expect(formatPercent(46.04, 2)).toBe('46.04%');
  });

  test('missing values render as em dash, not 0%', () => {
    expect(formatPercent(null)).toBe(EM_DASH);
    expect(formatPercent(undefined)).toBe(EM_DASH);
    expect(formatPercent(Number.NaN)).toBe(EM_DASH);
  });

  test('signed variant leads with the sign', () => {
    expect(formatSignedPercent(1.234)).toBe('+1.23%');
    expect(formatSignedPercent(-1.234)).toBe('-1.23%');
  });
});

describe('formatFundingRate', () => {
  test('converts a fractional rate to a percentage', () => {
    expect(formatFundingRate(0.0000123)).toBe('0.0012%');
    expect(formatFundingRate(-0.0001)).toBe('-0.0100%');
  });

  test('missing values render as em dash', () => {
    expect(formatFundingRate(null)).toBe(EM_DASH);
  });
});

describe('formatDuration', () => {
  test('humanises seconds through to days', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(7200)).toBe('2.0h');
    expect(formatDuration(86400 * 2)).toBe('2.0d');
  });

  test('missing values render as em dash', () => {
    expect(formatDuration(null)).toBe(EM_DASH);
  });
});

describe('shortenAddress', () => {
  test('trims to first 6 and last 4 with a real ellipsis', () => {
    expect(shortenAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
  });

  test('short strings pass through', () => {
    expect(shortenAddress('0x123')).toBe('0x123');
  });
});

describe('toNumber', () => {
  test('coerces DB numerics and falls back to 0', () => {
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('nonsense')).toBe(0);
  });

  test('toNumberOrNull preserves the missing case', () => {
    expect(toNumberOrNull('12.5')).toBe(12.5);
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull('nonsense')).toBeNull();
  });
});

describe('isRecentlyActive', () => {
  test('true inside the window, false outside', () => {
    const now = Date.now();
    expect(isRecentlyActive(new Date(now - 60_000).toISOString())).toBe(true);
    expect(isRecentlyActive(new Date(now - 30 * 24 * 3600 * 1000).toISOString())).toBe(false);
    expect(isRecentlyActive(null)).toBe(false);
  });
});

describe('formatTimeHms', () => {
  test('extracts UTC HH:MM:SS', () => {
    expect(formatTimeHms(Date.UTC(2026, 0, 1, 13, 45, 9))).toBe('13:45:09');
  });
});
