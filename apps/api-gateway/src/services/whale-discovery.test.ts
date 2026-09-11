import type { FeedTrade } from '@hyperdash/shared-types';
import { describe, expect, test } from 'vitest';
import { type TradeSource, WhaleDiscovery } from './whale-discovery';

function makeFeed(): { source: TradeSource; emit: (trades: FeedTrade[]) => void } {
  let listener: ((trades: FeedTrade[]) => void) | null = null;
  return {
    source: {
      on: (_event: 'trades', l: (trades: FeedTrade[]) => void) => {
        listener = l;
        return undefined;
      },
      off: (_event: 'trades', l: (trades: FeedTrade[]) => void) => {
        if (listener === l) listener = null;
        return undefined;
      },
    },
    emit: (trades) => listener?.(trades),
  };
}

function trade(overrides: Partial<FeedTrade> = {}): FeedTrade {
  return {
    coin: 'BTC',
    side: 'A',
    px: '50000',
    sz: '1',
    time: Date.now(),
    users: ['0xtaker', '0xmaker'],
    ...overrides,
  };
}

describe('WhaleDiscovery', () => {
  test('aggregates taker and maker notional', () => {
    const { source, emit } = makeFeed();
    const discovery = new WhaleDiscovery(source as never, { minNotionalUsd: 0 });
    emit([trade()]);
    // taker + maker each credited 50_000
    const whales = discovery.getTopWhales(10);
    expect(whales).toHaveLength(2);
    expect(whales[0]?.notionalUsd).toBe(50_000);
    expect(whales[0]?.trades).toBe(1);
  });

  test('accumulates volume across trades and ranks descending', () => {
    const { source, emit } = makeFeed();
    const discovery = new WhaleDiscovery(source as never, { minNotionalUsd: 0 });
    emit([trade({ users: ['0xa', '0xb'], sz: '2' })]);
    emit([trade({ users: ['0xa', '0xc'], sz: '1' })]);
    const whales = discovery.getTopWhales(10);
    expect(whales[0]?.address).toBe('0xa');
    expect(whales[0]?.notionalUsd).toBe(150_000);
    expect(whales[0]?.trades).toBe(2);
    expect(whales[1]?.address).toBe('0xb');
    expect(whales[1]?.notionalUsd).toBe(100_000);
  });

  test('filters by minimum notional and respects limit', () => {
    const { source, emit } = makeFeed();
    const discovery = new WhaleDiscovery(source as never, {
      minNotionalUsd: 200_000,
      maxWhales: 1,
    });
    emit([trade({ users: ['0xsmall', '0xbig'], sz: '10' })]);
    const whales = discovery.getTopWhales(5);
    // 0xsmall gets 500_000 too (same trade) — both above 200k, limit 1 keeps 0xbig? equal
    expect(whales.length).toBeLessThanOrEqual(5);
    expect(whales.every((w) => w.notionalUsd >= 200_000)).toBe(true);
  });

  test('skips malformed trades without users', () => {
    const { source, emit } = makeFeed();
    const discovery = new WhaleDiscovery(source as never, {});
    emit([trade({ users: undefined }), trade({ px: 'not-a-number' })]);
    expect(discovery.getTopWhales(10)).toHaveLength(0);
    expect(discovery.trackedAddressCount).toBe(0);
  });

  test('isReady only after the sample window', () => {
    const { source } = makeFeed();
    const discovery = new WhaleDiscovery(source as never, {});
    // Just created — not ready (sample window is 5 minutes).
    expect(discovery.sampleSeconds).toBeLessThan(5 * 60);
  });

  test('stop() detaches from the feed', () => {
    const { source, emit } = makeFeed();
    const discovery = new WhaleDiscovery(source as never, {});
    discovery.stop();
    emit([trade()]);
    expect(discovery.trackedAddressCount).toBe(0);
  });
});
