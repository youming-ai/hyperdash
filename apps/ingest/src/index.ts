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

Bun.serve({
  fetch(req: Request) {
    const url = new URL(req.url);
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
});

process.on('SIGINT', () => {
  logger.info('Shutting down ingest...');
  discovery.stop();
  recorder.stop?.();
  feed.stop?.();
  process.exit(0);
});
