import type { FeedBook, FeedCandle, FeedCtx, FeedState, FeedTrade } from '@hyperdash/shared-types';

/**
 * Typed client for the api-gateway real-time feed.
 *
 * Server (api-gateway, long-lived) subscribes to Hyperliquid and fans out to
 * browsers over `ws://<host>/ws`. Channels:
 *   'mids' | 'ctx' | 'ctx:COIN' | 'trades:COIN' | 'book:COIN' | 'candle:COIN' | 'state'
 *
 * The WS URL is `VITE_WS_URL` (default ws://localhost:3000/ws in dev). The
 * feed's REST history endpoints live on the same host (http://…/feed/…).
 */

export const FEED_WS_URL: string = import.meta.env.VITE_WS_URL ?? 'ws://localhost:3000/ws';

/** Coins with static feed coverage (ctx + trades) on the api-gateway. */
export const FEED_COINS: string[] = [
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
];

export const FEED_REST_BASE: string = (() => {
  try {
    const url = new URL(FEED_WS_URL);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'http://localhost:3000';
  }
})();

export type FeedDataMessage =
  | { type: 'data'; channel: 'mids'; data: { mids: Record<string, string> } }
  | { type: 'data'; channel: 'ctx'; data: FeedCtx }
  | { type: 'data'; channel: 'trades'; data: FeedTrade[] }
  | {
      type: 'data';
      channel: 'candle';
      data: { coin: string; candle?: FeedCandle; candles?: FeedCandle[] };
    }
  | { type: 'data'; channel: 'book'; data: FeedBook }
  | { type: 'state'; data: FeedState }
  | { type: 'subscribed' | 'unsubscribed' | 'welcome' | 'pong' | 'error'; [key: string]: unknown };

type Handler = (message: FeedDataMessage) => void;

class FeedClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Set<Handler>();
  private readonly channels = new Set<string>();

  get isConnected(): boolean {
    return this.connected;
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  subscribe(channels: string[]): void {
    for (const channel of channels) this.channels.add(channel);
    this.send({ type: 'subscribe', channels });
  }

  unsubscribe(channels: string[]): void {
    for (const channel of channels) this.channels.delete(channel);
    this.send({ type: 'unsubscribe', channels });
  }

  /** Fetch the full feed snapshot over REST (server state including buffers). */
  async fetchState(): Promise<FeedState | null> {
    try {
      const res = await fetch(`${FEED_REST_BASE}/feed/state`, { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()) as FeedState;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------

  private open(): void {
    try {
      const ws = new WebSocket(FEED_WS_URL);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.connected = true;
        this.reconnectAttempts = 0;
        // re-issue all channels after (re)connect
        if (this.channels.size > 0) {
          this.send({ type: 'subscribe', channels: [...this.channels] });
        }
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        try {
          const message = JSON.parse(String(event.data)) as FeedDataMessage;
          for (const handler of this.handlers) handler(message);
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.ws = null;
        if (this.stopped) return;
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
        this.reconnectAttempts += 1;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.open(), delay);
      };

      ws.onerror = () => {
        // 'close' follows; nothing to do here
      };
    } catch {
      // WebSocket constructor can throw on invalid URLs; retry later
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.open(), 5000);
      }
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}

let feedClient: FeedClient | null = null;

export function getFeedClient(): FeedClient {
  if (!feedClient) {
    feedClient = new FeedClient();
    feedClient.connect();
  }
  return feedClient;
}

/** Hook-oriented helpers --------------------------------------------------- */

export interface FeedHistoryPoint {
  coin: string;
  ts: number;
  [key: string]: number | string;
}

export async function fetchFeedHistory<T extends FeedHistoryPoint>(
  path: '/funding' | '/price' | '/oi' | '/volume' | '/stress' | '/whale-flow',
  params: Record<string, string | number>,
): Promise<T[]> {
  try {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${FEED_REST_BASE}/feed/history${path}?${query.toString()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

export type { FeedBook, FeedCandle, FeedCtx, FeedState, FeedTrade };
export { FeedClient };
