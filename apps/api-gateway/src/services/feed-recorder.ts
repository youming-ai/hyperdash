/**
 * Feed history recorder.
 *
 * Listens to HyperliquidFeed events and persists compact time-series into
 * Redis (best-effort — the pipeline keeps working when Redis is down):
 *
 *  - hourly snapshot zsets: funding / mark price / open interest
 *    (`feed:funding:hist`, `feed:px:hist`, `feed:oi:hist`)
 *  - per-minute volume bucketing (`feed:vol:min`, `feed:vol:buy:min`)
 *  - per-minute volatility-stress events — liquidation-like spikes, used as
 *    an *approximation* for the liquidation heatmap (Hyperliquid exposes no
 *    public liquidation feed) (`feed:stress:min`)
 *  - per-minute net flow of configured whale wallets (`feed:whaleflow:min`,
 *    `feed:whaleflow:buy:min`, `feed:whaleflow:sell:min`)
 *
 * All writes are batched into pipelines flushed every second.
 */

import { createHash } from 'node:crypto';
import type { FeedCtx, FeedTrade } from '@hyperdash/shared-types';
import { LEADERBOARD_TRADER_SEEDS } from '../config/leaderboard-traders';
import { getLogger } from '../utils/logger';
import type { HyperliquidFeed } from '../websockets/hyperliquid-feed';
import type { RedisClient } from './redis';

const log = () => getLogger();

/** Volatility/volume spike above which a minute counts as a "stress" event. */
const STRESS_VOL_RATIO = 3;
const STRESS_JUMP_PCT = 0.004;
const STRESS_MIN_MAX_JOBS = 240;

interface MinuteBucket {
  ts: number;
  notionalUsd: number;
  buyNotionalUsd: number;
  count: number;
  prevPx: number;
  maxJumpPct: number;
  whaleNet: number;
  whaleBuy: number;
  whaleSell: number;
  whaleTrades: number;
  lastFlushedNotional: number;
  lastFlushedBuy: number;
  lastFlushedWhaleNet: number;
  lastFlushedWhaleBuy: number;
  lastFlushedWhaleSell: number;
}

export class FeedRecorder {
  private readonly feed: HyperliquidFeed;
  private readonly store: RedisClient | null;
  private readonly whales: Set<string>;
  private buckets = new Map<string, MinuteBucket>();
  private lastHourByCoin = new Map<string, number>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private logRedisFailureOnce = false;
  private minuteHistory = new Map<string, number[]>();

  constructor(feed: HyperliquidFeed, store: RedisClient | null) {
    this.feed = feed;
    this.store = store;

    const envWhales = (process.env.HL_WHALE_ADDRESSES ?? '')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    this.whales = new Set([
      ...envWhales,
      ...LEADERBOARD_TRADER_SEEDS.map((s) => s.address.toLowerCase()),
    ]);
  }

  start(): void {
    this.feed.on('ctx', (ctx) => this.onCtx(ctx));
    this.feed.on('trades', (trades) => this.onTrades(trades));
    this.flushTimer = setInterval(() => {
      void this.flushBuckets();
    }, 1000);
    log().info('FeedRecorder started', {
      whales: this.whales.size,
      redis: this.store ? 'configured' : 'disabled',
    });
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  // ---------------------------------------------------------------------------

  private onCtx(ctx: FeedCtx): void {
    if (!this.store) return;
    const ts = Date.now();
    const hourTs = Math.floor(ts / 3_600_000);

    const markPx = Number.parseFloat(ctx.markPx);
    const funding = Number.parseFloat(ctx.funding);
    const oi = Number.parseFloat(ctx.openInterest);
    if (!Number.isFinite(markPx) || !Number.isFinite(funding) || !Number.isFinite(oi)) return;

    const snapshot = JSON.stringify({ coin: ctx.coin, ts, markPx, funding, oi });
    const pipe = this.store.createPipeline();
    pipe.hset('feed:ctx', ctx.coin, snapshot);
    if (this.lastHourByCoin.get(ctx.coin) !== hourTs) {
      const score = hourTs * 3_600_000;
      pipe.zadd('feed:funding:hist', score, JSON.stringify({ coin: ctx.coin, ts, funding }));
      pipe.zadd('feed:px:hist', score, JSON.stringify({ coin: ctx.coin, ts, markPx }));
      pipe.zadd('feed:oi:hist', score, JSON.stringify({ coin: ctx.coin, ts, openInterest: oi }));
      // Trim history beyond 7 days to bound Redis memory.
      const cutoff = score - 168 * 3_600_000;
      pipe.zremrangebyscore('feed:funding:hist', 0, cutoff);
      pipe.zremrangebyscore('feed:px:hist', 0, cutoff);
      pipe.zremrangebyscore('feed:oi:hist', 0, cutoff);
    }
    pipe.exec().catch(() => this.logRedisFailure());
    this.lastHourByCoin.set(ctx.coin, hourTs);
  }

  private onTrades(trades: FeedTrade[]): void {
    const now = Date.now();
    const minuteTs = Math.floor(now / 60_000);
    for (const trade of trades) {
      const px = Number.parseFloat(trade.px);
      const sz = Number.parseFloat(trade.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      const notional = px * sz;

      const bucket = this.getBucket(trade.coin, minuteTs, px);
      bucket.notionalUsd += notional;
      bucket.count += 1;
      if (trade.side === 'A') bucket.buyNotionalUsd += notional; // 'A' = taker bought
      if (bucket.prevPx > 0) {
        const jump = Math.abs(px - bucket.prevPx) / bucket.prevPx;
        if (jump > bucket.maxJumpPct) bucket.maxJumpPct = jump;
      }
      bucket.prevPx = px;

      // Whale flow: whale as taker (users[0]).
      if (this.whales.size > 0 && trade.users?.length) {
        const taker = trade.users[0]?.toLowerCase();
        if (taker && this.whales.has(taker)) {
          bucket.whaleTrades += 1;
          if (trade.side === 'A') {
            bucket.whaleNet += notional;
            bucket.whaleBuy += notional;
          } else {
            bucket.whaleNet -= notional;
            bucket.whaleSell += notional;
          }
        }
      }
    }
  }

  private getBucket(coin: string, minuteTs: number, seedPx: number): MinuteBucket {
    const key = `${coin}:${minuteTs}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        ts: minuteTs * 60_000,
        notionalUsd: 0,
        buyNotionalUsd: 0,
        count: 0,
        prevPx: seedPx,
        maxJumpPct: 0,
        whaleNet: 0,
        whaleBuy: 0,
        whaleSell: 0,
        whaleTrades: 0,
        lastFlushedNotional: 0,
        lastFlushedBuy: 0,
        lastFlushedWhaleNet: 0,
        lastFlushedWhaleBuy: 0,
        lastFlushedWhaleSell: 0,
      };
      this.buckets.set(key, bucket);
      // Drop anything older than 6 minutes to bound memory.
      const cutoff = minuteTs - 6;
      for (const k of this.buckets.keys()) {
        const parts = k.split(':');
        const ts = Number(parts[parts.length - 1]);
        if (Number.isFinite(ts) && ts < cutoff) this.buckets.delete(k);
      }
    }
    return bucket;
  }

  private async flushBuckets(): Promise<void> {
    if (!this.store || this.buckets.size === 0) return;
    const pipe = this.store.createPipeline();
    const nowMinuteTs = Math.floor(Date.now() / 60_000);
    const lastMinute = new Map<string, MinuteBucket>();

    for (const [key, bucket] of this.buckets) {
      const minuteTs = Number(key.split(':').at(-1));
      const coin = key.slice(0, key.lastIndexOf(':'));
      const member = `${coin}|${minuteTs}`;
      // C3 fix: only flush the delta since last flush (bucket is retained for
      // the current minute and re-flushed each second).
      const dNotional = bucket.notionalUsd - bucket.lastFlushedNotional;
      const dBuy = bucket.buyNotionalUsd - bucket.lastFlushedBuy;
      if (dNotional !== 0) pipe.zincrby('feed:vol:min', dNotional, member);
      if (dBuy !== 0) pipe.zincrby('feed:vol:buy:min', dBuy, member);
      if (bucket.whaleTrades > 0) {
        const dNet = bucket.whaleNet - bucket.lastFlushedWhaleNet;
        const dWhaleBuy = bucket.whaleBuy - bucket.lastFlushedWhaleBuy;
        const dWhaleSell = bucket.whaleSell - bucket.lastFlushedWhaleSell;
        if (dNet !== 0) pipe.zincrby('feed:whaleflow:min', dNet, member);
        if (dWhaleBuy !== 0) pipe.zincrby('feed:whaleflow:buy:min', dWhaleBuy, member);
        if (dWhaleSell !== 0) pipe.zincrby('feed:whaleflow:sell:min', dWhaleSell, member);
      }
      bucket.lastFlushedNotional = bucket.notionalUsd;
      bucket.lastFlushedBuy = bucket.buyNotionalUsd;
      bucket.lastFlushedWhaleNet = bucket.whaleNet;
      bucket.lastFlushedWhaleBuy = bucket.whaleBuy;
      bucket.lastFlushedWhaleSell = bucket.whaleSell;
      // Keep the current minute's bucket in memory for stress detection at close.
      if (minuteTs === nowMinuteTs) {
        lastMinute.set(key, bucket);
      } else {
        this.recordClosedMinute(coin, bucket.notionalUsd);
        this.detectStress(pipe, coin, bucket);
      }
    }

    this.buckets = lastMinute; // non-current buckets are persisted or dropped
    try {
      await pipe.exec();
    } catch {
      this.logRedisFailure();
    }
  }

  private detectStress(
    pipe: import('ioredis').ChainableCommander,
    coin: string,
    bucket: MinuteBucket,
  ): void {
    if (bucket.count === 0) return;
    const volRatio = this.volRatio(coin, bucket);
    if (bucket.maxJumpPct < STRESS_JUMP_PCT && volRatio < STRESS_VOL_RATIO) return;
    const spikeScore = Math.min(
      10,
      Math.round((Math.max(volRatio, 0) + bucket.maxJumpPct * 250) * 10) / 10,
    );
    pipe.zadd(
      'feed:stress:min',
      bucket.ts,
      JSON.stringify({
        coin,
        ts: bucket.ts,
        trades: bucket.count,
        notionalUsd: Math.round(bucket.notionalUsd),
        maxJumpPct: Math.round(bucket.maxJumpPct * 10_000) / 10_000,
        spikeScore,
      }),
    );
    pipe.zremrangebyrank('feed:stress:min', 0, -(STRESS_MIN_MAX_JOBS + 1));
  }

  /** Rolling 5-minute average notional per coin (from finalized minutes). */
  private volRatio(coin: string, bucket: MinuteBucket): number {
    const history = this.minuteHistory.get(coin) ?? [];
    if (history.length === 0) return 0;
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    return avg > 0 ? bucket.notionalUsd / avg : 0;
  }

  /** Record a finalized minute's total for the volRatio baseline. */
  private recordClosedMinute(coin: string, notional: number): void {
    let history = this.minuteHistory.get(coin);
    if (!history) {
      history = [];
      this.minuteHistory.set(coin, history);
    }
    history.push(notional);
    if (history.length > 5) history.shift();
  }

  private logRedisFailure(): void {
    if (!this.logRedisFailureOnce) {
      this.logRedisFailureOnce = true;
      log().warn('FeedRecorder: Redis write failed (history recording degraded)');
    }
  }

  // ---------------------------------------------------------------------------
  // History readers (used by the REST /feed/history/* endpoints)
  // ---------------------------------------------------------------------------

  private async zrangeJson(
    key: string,
    opts: { minTs?: number; maxTs?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.store) return [];
    try {
      const all = await this.store.zrange(key, 0, -1);
      const rows: Array<Record<string, unknown>> = [];
      for (const member of all) {
        try {
          const parsed = JSON.parse(member) as Record<string, unknown>;
          const ts = Number(parsed.ts ?? parsed.t ?? 0);
          if (opts.minTs !== undefined && ts < opts.minTs) continue;
          if (opts.maxTs !== undefined && ts > opts.maxTs) continue;
          rows.push(parsed);
        } catch {
          // skip non-JSON members
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  private async zrangeCsv(
    key: string,
    minTs?: number,
  ): Promise<Array<{ member: string; score: number }>> {
    if (!this.store) return [];
    try {
      const raw = await this.store.zrange(key, 0, -1, true);
      const rows: Array<{ member: string; score: number }> = [];
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const member = raw[i] ?? '';
        const score = Number(raw[i + 1] ?? 0);
        // The member format is `${coin}|${minuteTs}` — filter on the embedded
        // timestamp, NOT the score (which is notional USD for vol/whale-flow).
        if (minTs !== undefined) {
          const sep = member.lastIndexOf('|');
          const memberTs = sep >= 0 ? Number(member.slice(sep + 1)) * 60_000 : 0;
          if (memberTs < minTs) continue;
        }
        rows.push({ member, score });
      }
      return rows;
    } catch {
      return [];
    }
  }

  async fundingHistory(
    hours: number,
  ): Promise<Array<{ coin: string; ts: number; funding: number }>> {
    const minTs = Date.now() - hours * 3_600_000;
    const rows = await this.zrangeJson('feed:funding:hist', { minTs });
    return rows.map((r) => ({
      coin: String(r.coin ?? ''),
      ts: Number(r.ts ?? 0),
      funding: Number(r.funding ?? 0),
    }));
  }

  async priceHistory(hours: number): Promise<Array<{ coin: string; ts: number; markPx: number }>> {
    const minTs = Date.now() - hours * 3_600_000;
    const rows = await this.zrangeJson('feed:px:hist', { minTs });
    return rows.map((r) => ({
      coin: String(r.coin ?? ''),
      ts: Number(r.ts ?? 0),
      markPx: Number(r.markPx ?? 0),
    }));
  }

  async oiHistory(
    hours: number,
  ): Promise<Array<{ coin: string; ts: number; openInterest: number }>> {
    const minTs = Date.now() - hours * 3_600_000;
    const rows = await this.zrangeJson('feed:oi:hist', { minTs });
    return rows.map((r) => ({
      coin: String(r.coin ?? ''),
      ts: Number(r.ts ?? 0),
      openInterest: Number(r.openInterest ?? 0),
    }));
  }

  async volumeHistory(
    minutes: number,
  ): Promise<Array<{ coin: string; ts: number; notionalUsd: number; buyNotionalUsd: number }>> {
    const minTs = Date.now() - minutes * 60_000;
    const [total, buy] = await Promise.all([
      this.zrangeCsv('feed:vol:min', minTs),
      this.zrangeCsv('feed:vol:buy:min', minTs),
    ]);
    const buyByMember = new Map(buy.map((r) => [r.member, r.score]));
    return total.map((r) => {
      const sep = r.member.lastIndexOf('|');
      return {
        coin: r.member.slice(0, sep),
        ts: Number(r.member.slice(sep + 1)) * 60_000,
        notionalUsd: r.score,
        buyNotionalUsd: buyByMember.get(r.member) ?? 0,
      };
    });
  }

  async stressHistory(minutes: number): Promise<
    Array<{
      coin: string;
      ts: number;
      trades: number;
      notionalUsd: number;
      maxJumpPct: number;
      spikeScore: number;
    }>
  > {
    const minTs = Date.now() - minutes * 60_000;
    const rows = await this.zrangeJson('feed:stress:min', { minTs });
    return rows.map((r) => ({
      coin: String(r.coin ?? ''),
      ts: Number(r.ts ?? 0),
      trades: Number(r.trades ?? 0),
      notionalUsd: Number(r.notionalUsd ?? 0),
      maxJumpPct: Number(r.maxJumpPct ?? 0),
      spikeScore: Number(r.spikeScore ?? 0),
    }));
  }

  async whaleFlowHistory(minutes: number): Promise<
    Array<{
      coin: string;
      ts: number;
      netNotionalUsd: number;
      buyNotionalUsd: number;
      sellNotionalUsd: number;
    }>
  > {
    const minTs = Date.now() - minutes * 60_000;
    const [net, buy, sell] = await Promise.all([
      this.zrangeCsv('feed:whaleflow:min', minTs),
      this.zrangeCsv('feed:whaleflow:buy:min', minTs),
      this.zrangeCsv('feed:whaleflow:sell:min', minTs),
    ]);
    const buyMap = new Map(buy.map((r) => [r.member, r.score]));
    const sellMap = new Map(sell.map((r) => [r.member, r.score]));
    return net.map((r) => {
      const sep = r.member.lastIndexOf('|');
      return {
        coin: r.member.slice(0, sep),
        ts: Number(r.member.slice(sep + 1)) * 60_000,
        netNotionalUsd: r.score,
        buyNotionalUsd: buyMap.get(r.member) ?? 0,
        sellNotionalUsd: sellMap.get(r.member) ?? 0,
      };
    });
  }

  /** Dynamically track additional whales (e.g. from live discovery). */
  addWhales(addresses: string[]): number {
    for (const address of addresses) this.whales.add(address.toLowerCase());
    return this.whales.size;
  }

  getWhaleAddresses(): string[] {
    return [...this.whales];
  }
}

/** Stable id helper (kept for future dedup needs). */
export function feedMemberId(coin: string, ts: number): string {
  return createHash('sha1').update(`${coin}|${ts}`).digest('hex').slice(0, 16);
}
