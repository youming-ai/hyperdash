import { createExpressMiddleware } from '@trpc/server/adapters/express';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createWhaleDiscoveryJob } from './jobs/whale-discovery.cron';
import { createContext } from './lib/context';
import { FeedWebSocketManager } from './lib/websocket';
import { appRouter } from './routes';
import { getCopyTradingEngine } from './services/copy-engine';
import { FeedRecorder } from './services/feed-recorder';
import { RedisClient, type RedisConfig } from './services/redis';
import { WhaleDiscovery } from './services/whale-discovery';
import { getLogger } from './utils/logger';
import { getHyperliquidFeed } from './websockets/hyperliquid-feed';

const logger = getLogger();
logger.warn(
  '[DEPRECATED] apps/api-gateway (Express) is deprecated — use apps/web (FE), apps/api (BE Hono), apps/ingest (Worker) and apps/copy-engine (Go) independently. Removal 2026-09-30. See DEPRECATED.md.',
);
const app: express.Express = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// tRPC middleware
app.use(
  '/trpc',
  createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    feedConnected: feed.isConnected(),
    wsClients: wsManager?.getClientCount() ?? 0,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Real-time feed: Hyperliquid WS client + Redis history + browser WS fan-out
// ---------------------------------------------------------------------------

function createRedisFromEnv(): RedisClient | null {
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
    // lazyConnect: commands queue until ready; connect in the background so a
    // missing Redis never blocks the gateway from coming up.
    void client.connect();
    return client;
  } catch {
    logger.warn('Feed store disabled: invalid REDIS_URL');
    return null;
  }
}

const feed = getHyperliquidFeed();
const store = createRedisFromEnv();
const recorder = new FeedRecorder(feed, store);

feed.start();
recorder.start();

// --- Whale auto-discovery + periodic ingestion ---
// Ranks addresses by live taker/maker volume, then periodically ingests their
// full profiles (stats/trades/positions) into Postgres so the leaderboard and
// whale-position panels populate without a hand-curated seed list.
// Decoupled → Cron Trigger (skill: Scheduled jobs → Cron): same handler for
// Node setInterval and Workers `scheduled(event, env, ctx)`.
const discovery = new WhaleDiscovery(feed);
const discoveryJob = createWhaleDiscoveryJob(discovery, recorder);

if (process.env.HL_AUTO_INGEST !== '0') {
  const ingestIntervalMs = Number(process.env.HL_INGEST_INTERVAL_MS ?? 600_000);
  // First run after sample window (5 min), then every interval.
  setTimeout(() => {
    void discoveryJob.handler();
    setInterval(() => void discoveryJob.handler(), ingestIntervalMs);
  }, 5 * 60_000);
}

// HTTP trigger for Workers Cron or manual invocation (`curl -X POST /jobs/whale-discovery`).
// Workers `scheduled()` can call the same `discoveryJob.handler()` directly.
app.post('/jobs/whale-discovery', async (_req, res) => {
  if (discoveryJob.isIngesting()) {
    res.status(429).json({ error: 'ingest already running' });
    return;
  }
  const result = await discoveryJob.handler();
  if (result === null) {
    res.status(202).json({ status: 'skipped', reason: 'not ready or no whales' });
    return;
  }
  res.json({ status: 'ok', ...result });
});

// Optional copy-engine autostart — OFF by default (places real orders).
if (process.env.HL_COPY_ENGINE_AUTOSTART === '1') {
  void getCopyTradingEngine()
    .start()
    .then(() => logger.info('Copy trading engine auto-started'))
    .catch((error: unknown) =>
      logger.warn(
        `Copy engine autostart failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}

// Start server
const server = app.listen(PORT, () => {
  logger.info(`🚀 API Gateway server running on port ${PORT}`);
});

// WebSocket server (real-time feed fan-out)
const wsManager = new FeedWebSocketManager(server, feed);

// --- Feed REST endpoints (used by the analytics/heatmap panels) ---

function safeAsync(handler: (req: express.Request, res: express.Response) => Promise<void>) {
  return async (req: express.Request, res: express.Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'internal error' });
    }
  };
}

app.get('/feed/state', (_req, res) => {
  res.json(feed.buildState());
});

app.get('/feed/whales', (_req, res) => {
  res.json({
    // Statically configured seeds + live-discovered whales (ranked by volume).
    discovered: discovery
      .getTopWhales(50)
      .map((w: { address: string; notionalUsd: number; trades: number }) => ({
        address: w.address,
        notionalUsd: Math.round(w.notionalUsd),
        trades: w.trades,
      })),
    sampleSeconds: discovery.sampleSeconds,
    ready: discovery.isReady(),
  });
});

function hoursParam(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function minutesParam(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

app.get(
  '/feed/history/funding',
  safeAsync(async (req, res) => {
    const hours = hoursParam(req.query.hours, 24, 168);
    res.json(await recorder.fundingHistory(hours));
  }),
);

app.get(
  '/feed/history/price',
  safeAsync(async (req, res) => {
    const hours = hoursParam(req.query.hours, 24, 168);
    res.json(await recorder.priceHistory(hours));
  }),
);

app.get(
  '/feed/history/oi',
  safeAsync(async (req, res) => {
    const hours = hoursParam(req.query.hours, 24, 168);
    res.json(await recorder.oiHistory(hours));
  }),
);

app.get(
  '/feed/history/volume',
  safeAsync(async (req, res) => {
    const minutes = minutesParam(req.query.minutes, 60, 1440);
    res.json(await recorder.volumeHistory(minutes));
  }),
);

app.get(
  '/feed/history/stress',
  safeAsync(async (req, res) => {
    const minutes = minutesParam(req.query.minutes, 180, 720);
    res.json(await recorder.stressHistory(minutes));
  }),
);

app.get(
  '/feed/history/whale-flow',
  safeAsync(async (req, res) => {
    const minutes = minutesParam(req.query.minutes, 60, 1440);
    res.json(await recorder.whaleFlowHistory(minutes));
  }),
);

export type { AppRouter } from './routes';
export { app, server };
