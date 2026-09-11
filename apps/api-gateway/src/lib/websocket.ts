import type { Server as HTTPServer } from 'node:http';
import type { FeedState } from '@hyperdash/shared-types';
import { WebSocket, WebSocketServer as WSServer } from 'ws';
import type { HyperliquidFeed } from '../websockets/hyperliquid-feed';

export { WSServer as WebSocketServer };

/**
 * Per-client subscription state. Channels are strings of the form:
 *   'mids' | 'ctx' | 'ctx:COIN' | 'trades:COIN' | 'book:COIN' | 'candle:COIN' | 'state'
 */
interface ClientState {
  id: string;
  ws: WebSocket;
  channels: Set<string>;
}

const MAX_DEMAND_PER_CLIENT = 4; // max book: + candle: channels per client

const CHANNEL_PATTERN = /^(mids|ctx(:\w+)?|trades:\w+|book:\w+|candle:\w+|state)$/;

export class FeedWebSocketManager {
  private readonly wss: WSServer;
  private readonly clients = new Map<string, ClientState>();
  private readonly feed: HyperliquidFeed;

  constructor(server: HTTPServer, feed: HyperliquidFeed) {
    this.feed = feed;

    this.wss = new WSServer({
      server,
      path: '/ws',
      maxPayload: 1024 * 1024,
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      // Origin check — reject cross-site WebSocket hijacking.
      const origin = req.headers.origin;
      const allowed = (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:3000')
        .split(',')
        .map((o) => o.trim());
      if (origin && !allowed.includes(origin)) {
        ws.close(1008, 'origin not allowed');
        return;
      }
      const state: ClientState = {
        id: Math.random().toString(36).substring(2, 15),
        ws,
        channels: new Set(),
      };
      this.clients.set(state.id, state);
      this.send(state, {
        type: 'welcome',
        clientId: state.id,
        timestamp: new Date().toISOString(),
      });

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          this.handleMessage(state, data);
        } catch {
          this.send(state, { type: 'error', error: 'invalid json' });
        }
      });

      ws.on('close', () => {
        this.cleanup(state);
      });

      ws.on('error', () => {
        this.cleanup(state);
      });
    });

    // Wire the feed to fan out matching messages.
    feed.on('mids', (mids) =>
      this.fanout('mids', { type: 'data', channel: 'mids', data: { mids } }),
    );
    feed.on('ctx', (ctx) =>
      this.fanout(['ctx', `ctx:${ctx.coin}`], { type: 'data', channel: 'ctx', data: ctx }),
    );
    feed.on('trades', (trades) => {
      const coin = trades[0]?.coin;
      if (!coin) return;
      this.fanout(`trades:${coin}`, { type: 'data', channel: 'trades', data: trades });
    });
    feed.on('candle', (candle) =>
      this.fanout(`candle:${candle.s}`, {
        type: 'data',
        channel: 'candle',
        data: { coin: candle.s, candle },
      }),
    );
    feed.on('book', (book) =>
      this.fanout(`book:${book.coin}`, { type: 'data', channel: 'book', data: book }),
    );
  }

  getClientCount(): number {
    return this.clients.size;
  }

  // ---------------------------------------------------------------------------

  private handleMessage(state: ClientState, data: { type?: string; channels?: unknown }): void {
    switch (data.type) {
      case 'subscribe':
        this.subscribe(state, data.channels);
        break;
      case 'unsubscribe':
        this.unsubscribe(state, data.channels);
        break;
      case 'ping':
        this.send(state, { type: 'pong', timestamp: new Date().toISOString() });
        break;
      default:
        this.send(state, { type: 'error', error: `unknown message type: ${String(data.type)}` });
    }
  }

  private subscribe(state: ClientState, channels: unknown): void {
    const list = Array.isArray(channels) ? channels.map(String) : [String(channels)];
    const added: string[] = [];
    for (const channel of list) {
      const normalized = channel.replaceAll(' ', '');
      if (!CHANNEL_PATTERN.test(normalized)) {
        this.send(state, { type: 'error', error: `invalid channel: ${channel}` });
        continue;
      }
      if (state.channels.has(normalized)) continue;
      state.channels.add(normalized);
      added.push(normalized);
      if (normalized.startsWith('book:') || normalized.startsWith('candle:')) {
        const demandCount = [...state.channels].filter(
          (ch) => ch.startsWith('book:') || ch.startsWith('candle:'),
        ).length;
        if (demandCount >= MAX_DEMAND_PER_CLIENT) {
          this.send(state, {
            type: 'error',
            error: `demand subscription limit reached (${MAX_DEMAND_PER_CLIENT})`,
          });
          state.channels.delete(normalized); // undo the add
          continue;
        }
      }
      if (normalized.startsWith('book:')) {
        this.feed.subscribeBook(normalized.slice(5));
      }
      if (normalized.startsWith('candle:')) {
        this.feed.subscribeCandle(normalized.slice(7));
      }
    }
    this.send(state, { type: 'subscribed', channels: added, timestamp: new Date().toISOString() });

    // Push current snapshot immediately for snapshot-style channels.
    if (added.includes('state')) {
      this.send(state, { type: 'state', data: this.feed.buildState() });
    }
    for (const channel of added) {
      if (channel.startsWith('ctx:') && channel !== 'ctx') {
        const coin = channel.slice(4);
        const ctx = this.feed.getCtx(coin);
        if (ctx) this.send(state, { type: 'data', channel: 'ctx', data: ctx });
      }
      if (channel.startsWith('trades:')) {
        const coin = channel.slice(7);
        const trades = this.feed.getRecentTrades(coin, 100);
        if (trades.length > 0) {
          this.send(state, { type: 'data', channel: 'trades', data: trades });
        }
      }
      if (channel.startsWith('book:')) {
        const coin = channel.slice(5);
        const book = this.feed.getBook(coin);
        if (book) this.send(state, { type: 'data', channel: 'book', data: book });
      }
      if (channel.startsWith('candle:')) {
        const coin = channel.slice(7);
        const candles = this.feed.getCandles(coin, 120);
        if (candles.length > 0) {
          this.send(state, { type: 'data', channel: 'candle', data: { coin, candles } });
        }
      }
    }
  }

  private unsubscribe(state: ClientState, channels: unknown): void {
    const list = Array.isArray(channels) ? channels.map(String) : [String(channels)];
    const removed: string[] = [];
    for (const channel of list) {
      if (!state.channels.delete(channel)) continue;
      removed.push(channel);
      if (channel.startsWith('book:')) {
        this.feed.unsubscribeBook(channel.slice(5));
      }
      if (channel.startsWith('candle:')) {
        this.feed.unsubscribeCandle(channel.slice(7));
      }
    }
    this.send(state, {
      type: 'unsubscribed',
      channels: removed,
      timestamp: new Date().toISOString(),
    });
  }

  private cleanup(state: ClientState): void {
    this.clients.delete(state.id);
    for (const channel of state.channels) {
      if (channel.startsWith('book:')) this.feed.unsubscribeBook(channel.slice(5));
      if (channel.startsWith('candle:')) this.feed.unsubscribeCandle(channel.slice(7));
    }
  }

  private fanout(channelOrChannels: string | string[], payload: unknown): void {
    const wanted =
      typeof channelOrChannels === 'string'
        ? (channel: string) => channel === channelOrChannels || channel === 'state'
        : (channel: string) => channelOrChannels.includes(channel) || channel === 'state';
    const message = JSON.stringify(payload);
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      for (const channel of client.channels) {
        if (wanted(channel)) {
          client.ws.send(message);
          break;
        }
      }
    }
  }

  private send(state: ClientState, data: FeedState | Record<string, unknown>): void {
    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(data));
    }
  }
}
