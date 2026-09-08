import { describe, expect, test } from 'bun:test';
import {
  assetPositionToTraderPositionRow,
  calculateTraderStats,
  fillToTraderTradeRow,
  type HyperliquidAssetPosition,
  type HyperliquidFill,
} from './hyperliquid';

const now = Date.now();
const h = 60 * 60 * 1000;
const day = 24 * h;

function fill(overrides: Partial<HyperliquidFill>): HyperliquidFill {
  return {
    coin: 'BTC',
    side: 'A',
    px: '100',
    sz: '1',
    time: now,
    startPosition: '0',
    dir: 'Close Long',
    closedPnl: '50',
    fee: '1',
    hash: '0xabc',
    oid: 1,
    tid: 2,
    crossed: true,
    ...overrides,
  };
}

const emptyState = {
  assetPositions: [],
  crossMarginSummary: {
    accountValue: '1000',
    totalNtlPos: '0',
    totalRawUsd: '0',
    totalMarginUsed: '0',
  },
  marginSummary: {
    accountValue: '1000',
    totalNtlPos: '0',
    totalRawUsd: '0',
    totalMarginUsed: '0',
  },
  withdrawable: '1000',
};

describe('calculateTraderStats', () => {
  test('returns null when the trader has no fills', () => {
    expect(calculateTraderStats([], emptyState, '0xabc')).toBeNull();
  });

  test('counts only close fills as trades and nets pnl minus fees', () => {
    const stats = calculateTraderStats(
      [
        fill({ dir: 'Open Long', closedPnl: '0' }),
        fill({ dir: 'Close Long', closedPnl: '100', fee: '2' }),
        fill({ dir: 'Close Short', closedPnl: '-30', fee: '1' }),
      ],
      emptyState,
      '0xabc',
    );
    expect(stats).not.toBeNull();
    expect(stats?.totalTrades).toBe(2);
    expect(stats?.winningTrades).toBe(1);
    expect(stats?.losingTrades).toBe(1);
    expect(stats?.winRate).toBeCloseTo(50);
    expect(stats?.pnlAllTime).toBeCloseTo(100 - 2 - 30 - 1);
    expect(stats?.equity).toBe(1000);
  });

  test('windows pnl into 1d/7d/30d buckets', () => {
    const stats = calculateTraderStats(
      [
        fill({ dir: 'Close Long', closedPnl: '10', fee: '0', time: now - 2 * h }),
        fill({ dir: 'Close Long', closedPnl: '20', fee: '0', time: now - 3 * day }),
        fill({ dir: 'Close Long', closedPnl: '40', fee: '0', time: now - 20 * day }),
      ],
      null,
      '0xabc',
    );
    expect(stats?.pnl1d).toBeCloseTo(10);
    expect(stats?.pnl7d).toBeCloseTo(30);
    expect(stats?.pnl30d).toBeCloseTo(70);
    expect(stats?.pnlAllTime).toBeCloseTo(70);
    expect(stats?.isActive).toBe(true);
  });

  test('marks inactive when the last close is older than 24h', () => {
    const stats = calculateTraderStats(
      [fill({ dir: 'Close Long', closedPnl: '10', time: now - 3 * day })],
      null,
      '0xabc',
    );
    expect(stats?.isActive).toBe(false);
    expect(stats?.lastTradeAt).toBe(new Date(now - 3 * day).toISOString());
  });
});

describe('fillToTraderTradeRow', () => {
  test('maps a close fill to exit price + pnl', () => {
    const row = fillToTraderTradeRow(fill({ dir: 'Close Short', px: '99' }), 't1', '0xabc');
    expect(row.side).toBe('short');
    expect(row.action).toBe('close');
    expect(row.exitPrice).toBe('99');
    expect(row.entryPrice).toBeNull();
    expect(row.exchangeTradeId).toBe('0xabc');
  });

  test('maps an open fill to entry price, direction from dir', () => {
    const row = fillToTraderTradeRow(fill({ dir: 'Open Long' }), 't1', '0xabc');
    expect(row.side).toBe('long');
    expect(row.action).toBe('open');
    expect(row.entryPrice).toBe('100');
    expect(row.exitPrice).toBeNull();
  });
});

describe('assetPositionToTraderPositionRow', () => {
  test('maps signed szi to side and absolute quantity', () => {
    const position: HyperliquidAssetPosition = {
      type: 'oneWay',
      position: {
        coin: 'ETH',
        szi: '-2.5',
        entryPx: '3000',
        positionValue: '7500',
        unrealizedPnl: '-10',
        marginUsed: '750',
        liquidationPx: '4000',
        returnOnEquity: '-0.01',
        leverage: { type: 'cross', value: 10 },
      },
    };
    const row = assetPositionToTraderPositionRow(position, 't1', '0xabc', '2999');
    expect(row.side).toBe('short');
    expect(row.quantity).toBe('2.5');
    expect(row.markPrice).toBe('2999');
    expect(row.leverage).toBe('10');
  });
});
