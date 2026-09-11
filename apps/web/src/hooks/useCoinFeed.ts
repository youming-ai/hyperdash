import type { FeedBook, FeedCandle, FeedCtx, FeedState, FeedTrade } from '@hyperdash/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { getFeedClient } from '~/lib/feed-client';

export interface CoinFeed {
  connected: boolean;
  stateLoaded: boolean;
  mids: Record<string, string> | null;
  ctx: FeedCtx | null;
  book: FeedBook | null;
  trades: FeedTrade[];
  candles: FeedCandle[];
  serverTime: number;
}

const EMPTY: CoinFeed = {
  connected: false,
  stateLoaded: false,
  mids: null,
  ctx: null,
  book: null,
  trades: [],
  candles: [],
  serverTime: 0,
};

/**
 * Live market data bundle for a single coin: subscribes to the api-gateway
 * feed (book/trades/candle/ctx), seeds from the REST snapshot, and keeps
 * in-memory streams (capped).
 */
export function useCoinFeed(coin: string | undefined): CoinFeed {
  const [feed, setFeed] = useState<CoinFeed>(EMPTY);
  const [trades, setTrades] = useState<FeedTrade[]>([]);
  const [candles, setCandles] = useState<FeedCandle[]>([]);

  useEffect(() => {
    if (!coin) {
      setFeed(EMPTY);
      setTrades([]);
      setCandles([]);
      return;
    }

    // Reset all state for the new coin (prevents cross-coin contamination).
    setFeed({ ...EMPTY });
    setTrades([]);
    setCandles([]);

    const client = getFeedClient();
    const channels = [`trades:${coin}`, `book:${coin}`, `candle:${coin}`, `ctx:${coin}`];
    client.subscribe(channels);

    const patch = (partial: Partial<CoinFeed>) => setFeed((prev) => ({ ...prev, ...partial }));

    const off = client.on((message) => {
      if (message.type === 'state' && message.data) {
        const state = message.data as FeedState;
        patch({
          connected: state.connected,
          stateLoaded: true,
          mids: state.mids,
          ctx: state.ctx[coin] ?? null,
          book: state.books[coin] ?? null,
          serverTime: state.serverTime,
        });
        const seedTrades = state.trades[coin] ?? [];
        if (seedTrades.length > 0) setTrades((prev) => mergeTrades(prev, seedTrades));
        const seedCandles = state.candles[coin] ?? [];
        if (seedCandles.length > 0) setCandles((prev) => mergeCandles(prev, seedCandles));
        return;
      }
      if (message.type !== 'data') return;
      switch (message.channel) {
        case 'ctx':
          if (message.data.coin === coin) patch({ ctx: message.data as FeedCtx });
          break;
        case 'book':
          if (message.data.coin === coin) patch({ book: message.data as FeedBook });
          break;
        case 'trades':
          setTrades((prev) => mergeTrades(prev, message.data as FeedTrade[]));
          break;
        case 'candle': {
          const payload = message.data as {
            coin: string;
            candle?: FeedCandle;
            candles?: FeedCandle[];
          };
          if (payload.coin !== coin) break;
          const incoming = payload.candles ?? (payload.candle ? [payload.candle] : []);
          if (incoming.length > 0) setCandles((prev) => mergeCandles(prev, incoming));
          break;
        }
        default:
          break;
      }
    });

    // Seed everything from the server snapshot.
    void client.fetchState().then((state) => {
      if (!state) return;
      patch({
        connected: state.connected,
        stateLoaded: true,
        mids: state.mids,
        ctx: state.ctx[coin] ?? null,
        book: state.books[coin] ?? null,
        serverTime: state.serverTime,
      });
      const seedTrades = state.trades[coin] ?? [];
      if (seedTrades.length > 0) setTrades((prev) => mergeTrades(prev, seedTrades));
      const seedCandles = state.candles[coin] ?? [];
      if (seedCandles.length > 0) setCandles((prev) => mergeCandles(prev, seedCandles));
    });

    return () => {
      off();
      client.unsubscribe(channels);
    };
  }, [coin]);

  useEffect(() => {
    const client = getFeedClient();
    // keep `connected` fresh via client state (reconnect without re-select)
    const interval = setInterval(() => {
      setFeed((prev) => ({ ...prev, connected: client.isConnected }));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return useMemo(
    () => ({ ...feed, trades: trades.slice(-250), candles }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, trades, candles],
  );
}

function mergeTrades(prev: FeedTrade[], next: FeedTrade[]): FeedTrade[] {
  if (next.length === 0) return prev;
  const seen = new Set(
    prev.map((t) => (t.tid !== undefined ? String(t.tid) : `${t.time}-${t.px}-${t.sz}`)),
  );
  const fresh = next.filter(
    (t) => !seen.has(t.tid !== undefined ? String(t.tid) : `${t.time}-${t.px}-${t.sz}`),
  );
  return [...prev, ...fresh].slice(-400);
}

function mergeCandles(prev: FeedCandle[], next: FeedCandle[]): FeedCandle[] {
  const byTime = new Map(prev.map((c) => [c.t, c]));
  for (const candle of next) {
    const existing = byTime.get(candle.t);
    if (existing && existing.i === candle.i) {
      // live update for the current candle
      if (candle.T !== existing.T || candle.n >= existing.n) byTime.set(candle.t, candle);
    } else {
      byTime.set(candle.t, candle);
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-400);
}
