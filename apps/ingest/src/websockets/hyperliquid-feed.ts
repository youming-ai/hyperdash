/**
 * Hyperliquid real-time feed client (sharded).
 *
 * Hyperliquid's public WS gateway closes connections that exceed roughly
 * 13-14 subscriptions (empirically confirmed). To stream many coins we keep
 * multiple parallel connections ("shards"), each capped at 12 subscriptions:
 *
 *   shard 0: allMids + activeAssetCtx for the first half of the coin list
 *   shard 1: activeAssetCtx for the second half
 *   shard 2: trades for the first half          shard 3: trades for the second half
 *   shard 4: candle for the first half          shard 5: candle for the second half
 *   shard 6+: demand-driven l2Book (one shard per 12 books, refcounted)
 *
 * Each shard reconnects independently (exponential backoff) and re-runs its
 * own subscription list. In-memory snapshots are merged across shards.
 */

import { EventEmitter } from 'node:events';
import type { FeedBook, FeedCandle, FeedCtx, FeedState, FeedTrade } from '@hyperdash/shared-types';
import WebSocket from 'ws';
import { getLogger } from '../utils/logger';

export const DEFAULT_FEED_COINS = [
  'BTC',
  'ETH',
  'SOL',
  'HYPE',
  'DOGE',
  'XRP',
  'SUI',
  'ARB',
  'OP',
  'BNB',
  'ADA',
  'LINK',
] as const;

export interface HyperliquidFeedOptions {
  /** Defaults to HYPERLIQUID_WS_URL env or wss://api.hyperliquid.xyz/ws */
  url?: string;
  coins?: string[];
  candleInterval?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  pingMs?: number;
  maxTradesPerCoin?: number;
  maxCandlesPerCoin?: number;
  /** Max subscriptions per shard (server kills beyond ~13-14). */
  shardSubsLimit?: number;
}

type FeedEventMap = {
  mids: [mids: Record<string, string>];
  ctx: [ctx: FeedCtx];
  trades: [trades: FeedTrade[]];
  candle: [candle: FeedCandle];
  book: [book: FeedBook];
  status: [connected: boolean, details?: string];
};

interface ShardSub {
  request: object;
  /** stable key used to re-issue the subscription on reconnect */
  key: string;
}

class FeedShard {
  ws: WebSocket | null = null;
  connected = false;
  attempts = 0;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  pingTimer: ReturnType<typeof setInterval> | null = null;
  constructor(
    readonly id: string,
    readonly subs: ShardSub[],
    private readonly connectImpl: (shard: FeedShard) => void,
    private readonly pingMs: number,
  ) {}

  connect(): void {
    this.connectImpl(this);
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, this.pingMs);
  }

  stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

export class HyperliquidFeed extends EventEmitter {
  private readonly url: string;
  private readonly coins: string[];
  private readonly candleInterval: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly pingMs: number;
  private readonly maxTradesPerCoin: number;
  private readonly maxCandlesPerCoin: number;
  private readonly shardSubsLimit: number;

  private readonly shards: FeedShard[] = [];
  private readonly demandShards: FeedShard[] = [];
  /** demand key -> [shard, refcount] for on-demand subscriptions (book/candle) */
  private readonly demandRefs = new Map<string, { shard: FeedShard; refs: number }>();
  private stopped = false;

  // ---- in-memory snapshot state ----
  private mids: Record<string, string> = {};
  private ctxs = new Map<string, FeedCtx>();
  private books = new Map<string, FeedBook>();
  private tradesByCoin = new Map<string, FeedTrade[]>();
  private candlesByCoin = new Map<string, FeedCandle[]>();

  constructor(options: HyperliquidFeedOptions = {}) {
    super();
    this.url = options.url ?? process.env.HYPERLIQUID_WS_URL ?? 'wss://api.hyperliquid.xyz/ws';
    this.coins = options.coins
      ? [...options.coins]
      : process.env.HL_FEED_COINS
        ? process.env.HL_FEED_COINS.split(',')
            .map((c) => c.trim())
            .filter(Boolean)
        : [...DEFAULT_FEED_COINS];
    this.candleInterval = options.candleInterval ?? '1m';
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 120_000;
    this.pingMs = options.pingMs ?? 20_000;
    this.maxTradesPerCoin = options.maxTradesPerCoin ?? 2000;
    this.maxCandlesPerCoin = options.maxCandlesPerCoin ?? 500;
    this.shardSubsLimit = options.shardSubsLimit ?? 12;
    this.buildShards();
  }

  override on<K extends keyof FeedEventMap>(
    event: K,
    listener: (...args: FeedEventMap[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof FeedEventMap>(event: K, ...args: FeedEventMap[K]): boolean {
    return super.emit(event, ...args);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    this.stopped = false;
    const all = [...this.shards, ...this.demandShards];
    // Stagger connection attempts so subscription bursts don't trip the
    // per-IP rolling quota all at once.
    for (let i = 0; i < all.length; i++) {
      const shard = all[i];
      if (!shard) continue;
      setTimeout(() => shard.connect(), i * 1500);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const shard of [...this.shards, ...this.demandShards]) shard.disconnect();
    this.emit('status', false, 'stopped');
  }

  isConnected(): boolean {
    return this.shards.some((s) => s.connected);
  }

  getShardStatus(): Array<{ id: string; connected: boolean; subs: number }> {
    return [...this.shards, ...this.demandShards].map((s) => ({
      id: s.id,
      connected: s.connected,
      subs: s.subs.length,
    }));
  }

  // ---------------------------------------------------------------------------
  // Demand-driven subscriptions (l2Book + candle share one pool of shards;
  // candles are only streamed for coins a client is actually watching)
  // ---------------------------------------------------------------------------

  subscribeBook(coin: string): number {
    return this.subscribeDemand(`book:${coin}`, { type: 'l2Book', coin });
  }

  unsubscribeBook(coin: string): number {
    return this.unsubscribeDemand(`book:${coin}`, { type: 'l2Book', coin });
  }

  subscribeCandle(coin: string): number {
    return this.subscribeDemand(`candle:${coin}`, {
      type: 'candle',
      coin,
      interval: this.candleInterval,
    });
  }

  unsubscribeCandle(coin: string): number {
    return this.unsubscribeDemand(`candle:${coin}`, {
      type: 'candle',
      coin,
      interval: this.candleInterval,
    });
  }

  private subscribeDemand(key: string, subscription: object): number {
    const existing = this.demandRefs.get(key);
    if (existing) {
      existing.refs += 1;
      return existing.refs;
    }
    const shard = this.demandShards.find((s) => s.subs.length < this.shardSubsLimit);
    const target = shard ?? this.createDemandShard();
    target.subs.push({ request: subscription, key });
    this.demandRefs.set(key, { shard: target, refs: 1 });
    this.sendSubscription(target, subscription);
    return 1;
  }

  private unsubscribeDemand(key: string, subscription: object): number {
    const entry = this.demandRefs.get(key);
    if (!entry) return 0;
    entry.refs -= 1;
    if (entry.refs > 0) return entry.refs;
    this.demandRefs.delete(key);
    const shard = entry.shard;
    const idx = shard.subs.findIndex((s) => s.key === key);
    if (idx >= 0) shard.subs.splice(idx, 1);
    this.sendUnsubscription(shard, subscription);
    if (shard.subs.length === 0) {
      shard.disconnect();
      const si = this.demandShards.indexOf(shard);
      if (si >= 0) this.demandShards.splice(si, 1);
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // State accessors
  // ---------------------------------------------------------------------------

  getCoins(): string[] {
    return [...this.coins];
  }

  getMid(coin: string): string | undefined {
    return this.mids[coin];
  }

  getCtx(coin: string): FeedCtx | undefined {
    return this.ctxs.get(coin);
  }

  getBook(coin: string): FeedBook | undefined {
    return this.books.get(coin);
  }

  getRecentTrades(coin: string, limit = 100): FeedTrade[] {
    return (this.tradesByCoin.get(coin) ?? []).slice(-limit);
  }

  getCandles(coin: string, limit = 300): FeedCandle[] {
    return (this.candlesByCoin.get(coin) ?? []).slice(-limit);
  }

  buildState(): FeedState {
    const books: Record<string, FeedBook> = {};
    for (const [coin, book] of this.books) books[coin] = book;
    const ctx: Record<string, FeedCtx> = {};
    for (const [coin, value] of this.ctxs) ctx[coin] = value;
    const trades: Record<string, FeedTrade[]> = {};
    for (const [coin, list] of this.tradesByCoin) trades[coin] = list.slice(-200);
    const candles: Record<string, FeedCandle[]> = {};
    for (const [coin, list] of this.candlesByCoin) candles[coin] = list.slice(-300);
    return {
      connected: this.isConnected(),
      wsUrl: this.url,
      coins: [...this.coins],
      serverTime: Date.now(),
      mids: { ...this.mids },
      ctx,
      books,
      trades,
      candles,
    };
  }

  // ---------------------------------------------------------------------------
  // Shard construction & wiring
  // ---------------------------------------------------------------------------

  private buildShards(): void {
    const coins = this.coins;

    // Two static connections (a 3rd is consistently reaped on shared IPs):
    //   feed-1: allMids + activeAssetCtx for all coins  (1 + N ≤ ~13)
    //   feed-2: trades for all coins                    (N ≤ 12)
    const shard1: ShardSub[] = [{ request: { type: 'allMids' }, key: 'allMids' }];
    for (const coin of coins) {
      shard1.push({ request: { type: 'activeAssetCtx', coin }, key: `ctx:${coin}` });
    }
    const shard2: ShardSub[] = coins.map((coin) => ({
      request: { type: 'trades', coin },
      key: `trades:${coin}`,
    }));
    this.shards.push(this.createShard('feed-1', shard1));
    this.shards.push(this.createShard('feed-2', shard2));
  }

  private createShard(id: string, subs: ShardSub[]): FeedShard {
    return new FeedShard(id, subs, (shard) => this.connectShard(shard), this.pingMs);
  }

  private createDemandShard(): FeedShard {
    const shard = this.createShard(`demand-${this.demandShards.length + 1}`, []);
    this.demandShards.push(shard);
    if (!this.stopped) shard.connect();
    return shard;
  }

  private connectShard(shard: FeedShard): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    shard.ws = ws;

    ws.on('open', () => {
      if (shard.ws !== ws) return;
      shard.connected = true;
      shard.attempts = 0;
      shard.startPing();
      getLogger().info(`Feed shard ${shard.id} open`, { subs: shard.subs.length });
      this.emit('status', this.isConnected(), 'shard open');
      this.resubscribeShard(shard);
    });

    ws.on('message', (raw) => {
      if (shard.ws !== ws) return;
      try {
        this.handleMessage(JSON.parse(raw.toString()));
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('error', () => {
      // 'close' always follows; nothing to do here.
    });

    ws.on('close', (code, reason) => {
      if (shard.ws !== ws) return;
      shard.connected = false;
      shard.ws = null;
      shard.stopPing();
      getLogger().warn(`Feed shard ${shard.id} closed`, {
        code,
        reason: reason.toString().slice(0, 60),
      });
      this.emit('status', this.isConnected(), `shard ${shard.id} closed ${code}`);
      if (this.stopped) return;
      // Hyperliquid throttles by IP (30 new connections/min, 1000 subs/IP).
      // Back off with increasing delay + jitter so retry storms don't burn the
      // budget; abnormal close (1006) backs off harder.
      const base = code === 1006 ? 10_000 : this.reconnectBaseMs;
      const delay =
        Math.min(base * 2 ** Math.min(shard.attempts, 4), this.reconnectMaxMs) +
        Math.floor(Math.random() * 2000);
      shard.attempts += 1;
      if (shard.reconnectTimer) clearTimeout(shard.reconnectTimer);
      shard.reconnectTimer = setTimeout(() => this.connectShard(shard), delay);
    });
  }

  private resubscribeShard(shard: FeedShard): void {
    for (const sub of shard.subs) {
      this.sendSubscription(shard, sub.request);
    }
  }

  private sendSubscription(shard: FeedShard, subscription: object): void {
    if (shard.ws && shard.ws.readyState === WebSocket.OPEN) {
      shard.ws.send(JSON.stringify({ method: 'subscribe', subscription }));
    }
  }

  private sendUnsubscription(shard: FeedShard, subscription: object): void {
    if (shard.ws && shard.ws.readyState === WebSocket.OPEN) {
      shard.ws.send(JSON.stringify({ method: 'unsubscribe', subscription }));
    }
  }

  // ---------------------------------------------------------------------------
  // Message dispatch
  // ---------------------------------------------------------------------------

  private handleMessage(msg: { channel?: string; data?: unknown }): void {
    const channel = msg.channel;
    if (!channel || msg.data === undefined) return;
    const data = msg.data as Record<string, unknown>;

    switch (channel) {
      case 'allMids': {
        const mids = data.mids as Record<string, string> | undefined;
        if (mids) {
          this.mids = mids;
          this.emit('mids', mids);
        }
        break;
      }
      case 'activeAssetCtx': {
        const coin = data.coin as string | undefined;
        const ctx = data.ctx as Omit<FeedCtx, 'coin'> | undefined;
        if (!coin || !ctx) break;
        const full: FeedCtx = { ...(ctx as FeedCtx), coin };
        this.ctxs.set(coin, full);
        this.emit('ctx', full);
        break;
      }
      case 'trades': {
        const tradesRaw = Array.isArray(data) ? data : (data as { trades?: FeedTrade[] }).trades;
        if (!Array.isArray(tradesRaw) || tradesRaw.length === 0) break;
        // coin lives on each trade element, not on the envelope
        const coin = tradesRaw[0]?.coin as string | undefined;
        if (!coin) break;
        const list = this.tradesByCoin.get(coin) ?? [];
        const withCoin = tradesRaw.map((t) => ({ ...t, coin }));
        list.push(...withCoin);
        if (list.length > this.maxTradesPerCoin) {
          list.splice(0, list.length - this.maxTradesPerCoin);
        }
        this.tradesByCoin.set(coin, list);
        this.emit('trades', withCoin);
        break;
      }
      case 'candle': {
        const candle = data as FeedCandle;
        if (!candle?.s) break;
        const list = this.candlesByCoin.get(candle.s) ?? [];
        const last = list[list.length - 1];
        if (last && last.t === candle.t) {
          list[list.length - 1] = candle; // live update for the current candle
        } else {
          list.push(candle);
          if (list.length > this.maxCandlesPerCoin) list.shift();
        }
        this.candlesByCoin.set(candle.s, list);
        this.emit('candle', candle);
        break;
      }
      case 'l2Book': {
        const coin = data.coin as string | undefined;
        if (!coin) break;
        const levels = data.levels as
          | [
              Array<{ px: string; sz: string; n: number }>,
              Array<{ px: string; sz: string; n: number }>,
            ]
          | undefined;
        if (!levels || levels.length < 2) break;
        const book: FeedBook = {
          coin,
          time: Number(data.time ?? Date.now()),
          bids: levels[0] ?? [],
          asks: levels[1] ?? [],
        };
        this.books.set(coin, book);
        this.emit('book', book);
        break;
      }
      default:
        break;
    }
  }
}

let feedInstance: HyperliquidFeed | null = null;

/** Process-wide singleton feed client. */
export function getHyperliquidFeed(options?: HyperliquidFeedOptions): HyperliquidFeed {
  if (!feedInstance) {
    feedInstance = new HyperliquidFeed(options);
  }
  return feedInstance;
}
