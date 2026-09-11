import { ingestTraderAddresses } from './jobs/ingest-traders';
import { FeedRecorder } from './services/feed-recorder';
import { RedisClient, type RedisConfig } from './services/redis';
import { WhaleDiscovery } from './services/whale-discovery';
import { getLogger } from './utils/logger';
import { getHyperliquidFeed } from './websockets/hyperliquid-feed';

const logger = getLogger();
const PORT = Number(process.env.PORT ?? 3001);

function createRedis(): RedisClient | null {
  const raw = process.env.REDIS_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const config: RedisConfig = {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: url.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    };
    const client = new RedisClient(config, {
      debug: (message) => logger.debug(message),
      info: (message) => logger.info(message),
      warn: (message, context) => logger.warn(message, context as never),
      error: (message, error, context) => logger.error(message, error as never, context as never),
    });
    void client.connect();
    return client;
  } catch {
    logger.warn('Feed store disabled: invalid REDIS_URL');
    return null;
  }
}

const feed = getHyperliquidFeed();
const store = createRedis();
const recorder = new FeedRecorder(feed, store);
const discovery = new WhaleDiscovery(feed);

feed.start();
recorder.start();
// WhaleDiscovery Cron — every 10m, ingest top whales (skill: Cron Triggers)
// In Workers, this would be `scheduled(event, env, ctx)`; here setInterval for Container.
const runIngestCron = async () => {
  if (!discovery.isReady()) return;
  const whales = discovery.getTopWhales(20);
  if (whales.length === 0) return;
  try {
    await ingestTraderAddresses(
      whales.map((w) => w.address),
      { concurrency: 5 },
    );
    logger.info('Ingest cron complete', { whales: whales.length });
  } catch (e) {
    logger.warn(`Ingest cron failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};
setTimeout(
  () => {
    void runIngestCron();
    setInterval(() => void runIngestCron(), 10 * 60 * 1000);
  },
  5 * 60 * 1000,
);

logger.info('Ingest worker started', { port: PORT });

// Demand-driven upstream subscriptions: book:/candle: channels pull new
// Hyperliquid shards; everything else (mids/ctx/trades) is always streaming.
const DEMAND_CHANNELS: Record<
  string,
  { sub: (coin: string) => void; unsub: (coin: string) => void }
> = {
  'book:': { sub: (c) => feed.subscribeBook(c), unsub: (c) => feed.unsubscribeBook(c) },
  'candle:': { sub: (c) => feed.subscribeCandle(c), unsub: (c) => feed.unsubscribeCandle(c) },
};

function demandFor(channel: string) {
  const prefix = Object.keys(DEMAND_CHANNELS).find((p) => channel.startsWith(p));
  return prefix ? { ...DEMAND_CHANNELS[prefix], coin: channel.slice(prefix.length) } : null;
}

const server = Bun.serve<{ channels: Set<string> }>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req, {
        data: { channels: new Set<string>() },
      });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        feed: feed.buildState ? feed.buildState() : { connected: true },
        whales: discovery.trackedAddressCount,
        ready: discovery.isReady(),
      });
    }
    if (url.pathname === '/metrics') {
      return Response.json({
        whales: discovery.getTopWhales(10),
        sampleSeconds: discovery.sampleSeconds,
      });
    }
    return new Response('Hyperdash Ingest', { status: 200 });
  },
  websocket: {
    open(ws) {
      ws.send(
        JSON.stringify({
          type: 'welcome',
          timestamp: new Date().toISOString(),
        }),
      );
    },
    message(ws, message) {
      try {
        const msg = JSON.parse(String(message));
        if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
          for (const ch of msg.channels) {
            const channel = String(ch);
            ws.data.channels.add(channel);
            ws.subscribe(channel);
            const demand = demandFor(channel);
            if (demand) demand.sub(demand.coin);
          }
          ws.send(JSON.stringify({ type: 'subscribed', channels: Array.from(ws.data.channels) }));
          if (msg.channels.includes('state') || msg.channels.includes('mids')) {
            const state = feed.buildState?.();
            if (state) ws.send(JSON.stringify({ type: 'state', data: state }));
          }
        } else if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
          for (const ch of msg.channels) {
            const channel = String(ch);
            ws.data.channels.delete(channel);
            ws.unsubscribe(channel);
            const demand = demandFor(channel);
            if (demand) demand.unsub(demand.coin);
          }
          ws.send(JSON.stringify({ type: 'unsubscribed', channels: Array.from(ws.data.channels) }));
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid json' }));
      }
    },
    close(ws) {
      for (const channel of ws.data.channels) {
        const demand = demandFor(channel);
        if (demand) demand.unsub(demand.coin);
      }
      ws.data.channels.clear();
    },
  },
});

feed.on('mids', (mids) => {
  server.publish('mids', JSON.stringify({ type: 'data', channel: 'mids', data: { mids } }));
});

feed.on('ctx', (ctx) => {
  const payload = JSON.stringify({ type: 'data', channel: 'ctx', data: ctx });
  server.publish('ctx', payload);
  server.publish(`ctx:${ctx.coin}`, payload);
});

feed.on('trades', (trades) => {
  if (!trades.length) return;
  const coin = trades[0]?.coin;
  if (!coin) return;
  server.publish(
    `trades:${coin}`,
    JSON.stringify({ type: 'data', channel: 'trades', data: trades }),
  );
});

feed.on('book', (book) => {
  server.publish(
    `book:${book.coin}`,
    JSON.stringify({ type: 'data', channel: 'book', data: book }),
  );
});

feed.on('candle', (candle) => {
  server.publish(
    `candle:${candle.s}`,
    JSON.stringify({ type: 'data', channel: 'candle', data: { coin: candle.s, candle } }),
  );
});

process.on('SIGINT', () => {
  logger.info('Shutting down ingest...');
  discovery.stop();
  recorder.stop?.();
  feed.stop?.();
  process.exit(0);
});
