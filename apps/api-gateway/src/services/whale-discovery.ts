/**
 * Whale discovery from the live trades feed.
 *
 * Instead of relying on a hand-curated seed list, this service watches every
 * trade flowing through the Hyperliquid feed and aggregates per-address
 * notional volume. The highest-volume addresses over the sampling window are
 * the platform's whales — they feed the auto-ingest job and the whale-flow
 * tracker without any manual curation.
 *
 * Both sides of each trade count: `users[0]` is the taker, `users[1]` the
 * maker — both are active traders whose profiles are worth ingesting.
 */

import type { FeedTrade } from '@hyperdash/shared-types';
import type { HyperliquidFeed } from '../websockets/hyperliquid-feed';

export interface WhaleEntry {
  address: string;
  notionalUsd: number;
  trades: number;
  lastSeen: number;
}

/** Minimal feed surface (allows test doubles) — mirrors HyperliquidFeed.on('trades', fn). */
export interface TradeSource {
  on(event: 'trades', listener: (trades: FeedTrade[]) => void): unknown;
  off(event: 'trades', listener: (trades: FeedTrade[]) => void): unknown;
}

/** Whale ranking is unreliable before this much sample time has elapsed. */
export const MIN_SAMPLE_MS = 5 * 60_000;

export class WhaleDiscovery {
  private readonly feed: HyperliquidFeed;
  private readonly totals = new Map<
    string,
    { notionalUsd: number; trades: number; lastSeen: number }
  >();
  private readonly startedAt = Date.now();
  private readonly listener: (trades: FeedTrade[]) => void;

  constructor(
    feed: HyperliquidFeed,
    private readonly options: {
      maxWhales?: number;
      minNotionalUsd?: number;
      maxTrackedAddresses?: number;
    } = {},
  ) {
    this.feed = feed;
    this.options.maxWhales ??= 50;
    this.options.minNotionalUsd ??= 100_000;
    this.options.maxTrackedAddresses ??= 20_000;
    this.listener = (trades) => this.onTrades(trades);
    feed.on('trades', this.listener);
  }

  stop(): void {
    this.feed.off('trades', this.listener);
  }

  /** Seconds since discovery started — used to warn about short samples. */
  get sampleSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /**
   * Top addresses by notional volume. Call `isReady()` first — before the
   * sample window elapses the ranking is skewed toward whoever traded first.
   */
  isReady(): boolean {
    return this.sampleSeconds >= MIN_SAMPLE_MS / 1000;
  }

  getTopWhales(limit = this.options.maxWhales ?? 50): WhaleEntry[] {
    const minNotional = this.options.minNotionalUsd ?? 100_000;
    return [...this.totals.entries()]
      .map(([address, v]) => ({ address, ...v }))
      .filter((entry) => entry.notionalUsd >= minNotional)
      .sort((a, b) => b.notionalUsd - a.notionalUsd)
      .slice(0, limit);
  }

  get trackedAddressCount(): number {
    return this.totals.size;
  }

  private onTrades(trades: FeedTrade[]): void {
    for (const trade of trades) {
      const px = Number.parseFloat(trade.px);
      const sz = Number.parseFloat(trade.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      const notional = px * sz;
      if (notional <= 0) continue;

      const taker = trade.users?.[0]?.toLowerCase();
      const maker = trade.users?.[1]?.toLowerCase();
      if (!taker && !maker) continue;

      const now = Date.now();
      if (taker) this.record(taker, notional, now);
      if (maker) this.record(maker, notional, now);
    }
  }

  private record(address: string, notional: number, now: number): void {
    const entry = this.totals.get(address);
    if (entry) {
      entry.notionalUsd += notional;
      entry.trades += 1;
      entry.lastSeen = now;
      return;
    }
    // Bound memory: when saturated, evict the smallest holder only if the new
    // trade is meaningful; otherwise skip tracking this address.
    if (this.totals.size >= (this.options.maxTrackedAddresses ?? 20_000)) {
      if (notional < (this.options.minNotionalUsd ?? 100_000) / 10) return;
      let minKey: string | null = null;
      let minNotional = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.totals) {
        if (value.notionalUsd < minNotional) {
          minNotional = value.notionalUsd;
          minKey = key;
        }
      }
      if (minKey && minNotional < notional) this.totals.delete(minKey);
      else return;
    }
    this.totals.set(address, { notionalUsd: notional, trades: 1, lastSeen: now });
  }
}
