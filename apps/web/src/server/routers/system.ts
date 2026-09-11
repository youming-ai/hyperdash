import { zValidator } from '@hono/zod-validator';
import { users } from '@hyperdash/database/schema';
import { schemas } from '@hyperdash/shared-types';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { Db } from '~/db';
import { requireSession } from '~/server/middleware/auth';
import type { AppEnv } from '~/server/types';

const servicesEnum = z.enum(['all', 'database', 'cache', 'streaming', 'copyEngine']);
const adminServiceEnum = z.enum(['database', 'cache', 'streaming', 'copyEngine', 'apiGateway']);
const controlServiceEnum = z.enum(['copyEngine', 'dataIngestion', 'analytics']);
const controlActionEnum = z.enum(['restart', 'stop', 'start']);
const logServiceEnum = z.enum([
  'all',
  'apiGateway',
  'database',
  'cache',
  'streaming',
  'copyEngine',
  'analytics',
]);
const logLevelEnum = z.enum(['debug', 'info', 'warn', 'error']);

const metricsQuery = z.object({
  timeframe: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
  granularity: z.enum(['minute', 'hour', 'day']).default('hour'),
});

const configQuery = z.object({
  service: servicesEnum.default('all'),
});

const updateConfigBody = z.object({
  service: adminServiceEnum,
  config: z.record(z.string(), z.unknown()),
});

const serviceControlBody = z.object({
  service: controlServiceEnum,
  action: controlActionEnum,
});

const logsQuery = z.object({
  service: logServiceEnum.default('all'),
  level: logLevelEnum.default('info'),
  limit: z.coerce.number().min(1).max(1000).default(100),
  offset: z.coerce.number().min(0).default(0),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});

const auditQuery = z.object({
  userId: z.string().optional(),
  resourceType: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});

const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const db = c.get('db');
  const rows = await db
    .select({ kycLevel: users.kycLevel })
    .from(users)
    .where(eq(users.walletAddress, session.walletAddress))
    .limit(1);

  if (rows[0]?.kycLevel !== 3) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  await next();
});

async function pingDatabase(db: Db) {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return {
      status: 'healthy',
      latency: Date.now() - start,
      lastCheck: new Date().toISOString(),
    };
  } catch (err: unknown) {
    return {
      status: 'unhealthy',
      latency: Date.now() - start,
      lastCheck: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pingCache(kv: KVNamespace) {
  const start = Date.now();
  try {
    await kv.get('system:kv-ping');
    return {
      status: 'healthy',
      latency: Date.now() - start,
      lastCheck: new Date().toISOString(),
    };
  } catch (err: unknown) {
    return {
      status: 'unhealthy',
      latency: Date.now() - start,
      lastCheck: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const systemRouter = new Hono<AppEnv>()
  .get('/health', async (c) => {
    const db = c.get('db');
    const dbStatus = await pingDatabase(db);
    const cacheStatus = await pingCache(c.env.KV);
    const now = new Date().toISOString();

    const healthStatus = {
      overall:
        dbStatus.status === 'healthy' && cacheStatus.status === 'healthy' ? 'healthy' : 'degraded',
      timestamp: now,
      version: '1.0.0',
      uptime: 0,
      components: {
        database: dbStatus,
        cache: cacheStatus,
        streaming: {
          status: 'unavailable',
          lastCheck: now,
        },
        externalApis: {
          hyperliquid: {
            status: 'unavailable',
            lastCheck: now,
          },
          lastCheck: now,
        },
        copyEngine: {
          status: 'unavailable',
          lastCheck: now,
        },
      },
      metrics: {
        requestsPerMinute: null,
        responseTimeP95: null,
        errorRate: null,
        activeConnections: null,
        memoryUsage: null,
        cpuUsage: null,
      },
    };

    return c.json(schemas.SystemHealth.parse(healthStatus));
  })

  .get('/metrics', zValidator('query', metricsQuery), async (c) => {
    const { timeframe, granularity } = c.req.valid('query');

    const metrics = {
      timeframe,
      granularity,
      generatedAt: new Date().toISOString(),
      system: {
        cpu: [],
        memory: [],
        disk: [],
      },
      application: {
        requests: [],
        database: [],
        cache: [],
        streaming: [],
      },
    };

    return c.json(schemas.SystemMetrics.parse(metrics));
  })

  .get('/status', async (c) => {
    const db = c.get('db');
    const dbStatus = await pingDatabase(db);
    const cacheStatus = await pingCache(c.env.KV);
    const now = new Date().toISOString();

    const status = {
      timestamp: now,
      services: {
        apiGateway: {
          status: 'running',
          version: '1.0.0',
          uptime: 'N/A',
          requestsPerMinute: null,
          activeConnections: null,
        },
        database: dbStatus,
        cache: cacheStatus,
        streaming: {
          status: 'unavailable',
          lastCheck: now,
        },
        analytics: {
          status: 'unavailable',
          lastCheck: now,
        },
        copyEngine: {
          status: 'unavailable',
          lastCheck: now,
        },
        dataIngestion: {
          status: 'unavailable',
          lastCheck: now,
        },
      },
      alerts: [],
      recentEvents: [],
    };

    return c.json(schemas.SystemStatus.parse(status));
  })

  .get('/config', requireSession, requireAdmin, zValidator('query', configQuery), async (c) => {
    const { service } = c.req.valid('query');

    if (service !== 'all') {
      const value = await c.env.KV.get(`system:config:${service}`);
      return c.json(value ? (JSON.parse(value) as Record<string, unknown>) : null);
    }

    const services = [
      'database',
      'cache',
      'streaming',
      'copyEngine',
      'apiGateway',
      'analytics',
    ] as const;
    const entries = await Promise.all(
      services.map(async (svc) => {
        const value = await c.env.KV.get(`system:config:${svc}`);
        return [svc, value ? (JSON.parse(value) as Record<string, unknown>) : null] as const;
      }),
    );

    const config = {
      database: entries[0][1] ?? {
        host: 'unknown',
        port: 5432,
        maxConnections: 20,
        sslEnabled: false,
        version: 'unknown',
      },
      cache: entries[1][1] ?? {
        host: 'unknown',
        port: 6379,
        maxMemory: 256000000,
        ttl: 300,
        version: 'unknown',
      },
      streaming: entries[2][1] ?? {
        brokers: 'unknown',
        topicCount: 15,
        retentionPeriod: '30 days',
        version: 'unknown',
      },
      copyEngine: entries[3][1] ?? {
        maxConcurrency: 100,
        executionInterval: 1,
        alignmentThreshold: 0.02,
        maxLeverage: 5.0,
        version: '1.0.0',
      },
      apiGateway: entries[4][1] ?? {
        port: 3000,
        rateLimit: '100/minute',
        jwtExpiry: 86400,
        version: '1.0.0',
      },
      analytics: entries[5][1] ?? {
        processingParallelism: 8,
        aggregationInterval: 60,
        dataRetention: '90 days',
        version: '1.0.0',
      },
    };

    return c.json(config);
  })

  .post(
    '/config',
    requireSession,
    requireAdmin,
    zValidator('json', updateConfigBody),
    async (c) => {
      const { service, config } = c.req.valid('json');

      await c.env.KV.put(`system:config:${service}`, JSON.stringify(config));

      return c.json({
        success: true,
        service,
        updatedAt: new Date().toISOString(),
        requiresRestart: service !== 'cache',
      });
    },
  )

  .post(
    '/service-control',
    requireSession,
    requireAdmin,
    zValidator('json', serviceControlBody),
    async (c) => {
      const { service, action } = c.req.valid('json');

      console.log(`Service control: ${action} ${service}`);

      return c.json({
        success: true,
        service,
        action,
        timestamp: new Date().toISOString(),
        estimatedDowntime:
          action === 'restart' ? '30 seconds' : action === 'stop' ? '0 seconds' : 'N/A',
      });
    },
  )

  .get('/logs', requireSession, requireAdmin, zValidator('query', logsQuery), async (c) => {
    c.req.valid('query');

    return c.json({
      logs: [],
      total: 0,
      hasMore: false,
    });
  })

  .get('/audit', requireSession, requireAdmin, zValidator('query', auditQuery), async (c) => {
    c.req.valid('query');

    return c.json({
      auditLogs: [],
      total: 0,
      hasMore: false,
    });
  });
