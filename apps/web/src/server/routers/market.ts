import { zValidator } from '@hono/zod-validator';
import { traderPositions } from '@hyperdash/database/schema';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '~/server/types';

// ---------------------------------------------------------------------------
// Hyperliquid Info API helpers.
// ---------------------------------------------------------------------------

interface HyperliquidUniverseItem {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

interface HyperliquidMeta {
  universe: HyperliquidUniverseItem[];
}

interface HyperliquidAssetCtx {
  dayNtlVlm: string;
  funding: string;
  markPx: string;
  midPx?: string | null;
  openInterest: string;
  oraclePx: string;
  prevDayPx: string;
}

type HyperliquidMetaAndAssetCtxs = [HyperliquidMeta, HyperliquidAssetCtx[]];

interface HyperliquidCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const TIMEFRAME_INTERVALS: Record<string, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '8h': '8h',
  '12h': '12h',
  '1d': '1d',
  '3d': '3d',
  '1w': '1w',
  '1M': '1M',
};

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

function resolveInfoUrl(raw: string): string {
  return raw.endsWith('/info') ? raw : `${raw.replace(/\/$/, '')}/info`;
}

async function hyperliquidRequest<T>(apiUrl: string, body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(resolveInfoUrl(apiUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Hyperliquid info(${String(body.type)}) failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Input validation.
// ---------------------------------------------------------------------------

const overviewQuery = z.object({
  symbol: z.string(),
});

const ohlcvQuery = z.object({
  symbol: z.string(),
  timeframe: z.string(),
  limit: z.coerce.number().default(100),
});

const heatmapQuery = z.object({
  symbol: z.string(),
  window: z.string(),
  binCount: z.coerce.number().default(50),
});

const tickerParam = z.object({
  symbol: z.string(),
});

const pricesQuery = z.object({
  symbols: z.string().optional(),
});

const metasQuery = z.object({
  limit: z.coerce.number().min(1).max(500).default(200),
  minVolume: z.coerce.number().optional(),
});

const positionsQuery = z.object({
  symbol: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(10),
});

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

export const marketRouter = new Hono<AppEnv>()
  .get('/overview', zValidator('query', overviewQuery), async (c) => {
    const { symbol } = c.req.valid('query');
    try {
      const [meta, assetCtxs] = await hyperliquidRequest<HyperliquidMetaAndAssetCtxs>(
        c.env.HYPERLIQUID_API_URL,
        { type: 'metaAndAssetCtxs' },
      );
      const idx = meta.universe.findIndex((u) => u.name === symbol);
      const ctx = idx >= 0 ? assetCtxs[idx] : null;
      const price = ctx ? parseFloat(ctx.midPx ?? ctx.markPx) : 0;

      return c.json({
        symbol,
        exchange: 'hyperliquid',
        timestamp: new Date().toISOString(),
        price,
        markPrice: ctx ? parseFloat(ctx.markPx) : 0,
        indexPrice: ctx ? parseFloat(ctx.oraclePx) : 0,
        fundingRate: ctx ? parseFloat(ctx.funding) : 0,
        nextFundingTime: new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString(),
        openInterest: ctx ? parseFloat(ctx.openInterest) : 0,
        volume24h: ctx ? parseFloat(ctx.dayNtlVlm) : 0,
        longShortRatio: 0,
        volatility24h: 0,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Upstream error' }, 502);
    }
  })
  .get('/ohlcv', zValidator('query', ohlcvQuery), async (c) => {
    const { symbol, timeframe, limit } = c.req.valid('query');
    const interval = TIMEFRAME_INTERVALS[timeframe] ?? '1h';
    const intervalMs = TIMEFRAME_MS[interval] ?? TIMEFRAME_MS['1h'];
    const endTime = Date.now();
    const startTime = endTime - limit * intervalMs;

    try {
      const candles = await hyperliquidRequest<HyperliquidCandle[]>(c.env.HYPERLIQUID_API_URL, {
        type: 'candleSnapshot',
        req: {
          coin: symbol,
          interval,
          startTime,
          endTime,
        },
      });

      const data = candles.map((candle) => ({
        timestamp: new Date(candle.t).toISOString(),
        open: parseFloat(candle.o),
        high: parseFloat(candle.h),
        low: parseFloat(candle.l),
        close: parseFloat(candle.c),
        volume: parseFloat(candle.v),
        tradeCount: candle.n,
      }));

      return c.json(data);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Upstream error' }, 502);
    }
  })
  .get('/heatmap', zValidator('query', heatmapQuery), async (c) => {
    const { symbol, binCount } = c.req.valid('query');
    void symbol;
    void binCount;
    return c.json([]);
  })
  .get('/ticker/:symbol', zValidator('param', tickerParam), async (c) => {
    const { symbol } = c.req.valid('param');
    try {
      const [meta, assetCtxs] = await hyperliquidRequest<HyperliquidMetaAndAssetCtxs>(
        c.env.HYPERLIQUID_API_URL,
        { type: 'metaAndAssetCtxs' },
      );
      const idx = meta.universe.findIndex((u) => u.name === symbol);
      const ctx = idx >= 0 ? assetCtxs[idx] : null;
      const price = ctx ? parseFloat(ctx.midPx ?? ctx.markPx) : 0;
      const prevPrice = ctx ? parseFloat(ctx.prevDayPx) : 0;

      return c.json({
        symbol,
        price,
        change24h: ctx ? price - prevPrice : 0,
        volume24h: ctx ? parseFloat(ctx.dayNtlVlm) : 0,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Upstream error' }, 502);
    }
  })
  .get('/prices', zValidator('query', pricesQuery), async (c) => {
    const { symbols } = c.req.valid('query');
    const requested = symbols
      ? symbols
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    try {
      const [meta, assetCtxs] = await hyperliquidRequest<HyperliquidMetaAndAssetCtxs>(
        c.env.HYPERLIQUID_API_URL,
        { type: 'metaAndAssetCtxs' },
      );

      const prices: Record<string, number> = {};
      for (let i = 0; i < meta.universe.length; i++) {
        const item = meta.universe[i];
        if (!item) continue;
        if (requested && !requested.includes(item.name)) continue;
        const ctx = assetCtxs[i];
        if (!ctx) continue;
        prices[item.name] = parseFloat(ctx.midPx ?? ctx.markPx);
      }

      return c.json(prices);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Upstream error' }, 502);
    }
  })
  .get('/symbols', async (c) => {
    try {
      const meta = await hyperliquidRequest<HyperliquidMeta>(c.env.HYPERLIQUID_API_URL, {
        type: 'meta',
      });
      const symbols = meta.universe.filter((u) => !u.isDelisted).map((u) => u.name);
      return c.json(symbols);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Upstream error' }, 502);
    }
  })
  .get('/metas', zValidator('query', metasQuery), async (c) => {
    const { limit, minVolume } = c.req.valid('query');
    try {
      const [meta, assetCtxs] = await hyperliquidRequest<HyperliquidMetaAndAssetCtxs>(
        c.env.HYPERLIQUID_API_URL,
        { type: 'metaAndAssetCtxs' },
      );

      const rows = [];
      for (let i = 0; i < meta.universe.length; i++) {
        const item = meta.universe[i];
        const ctx = assetCtxs[i];
        if (!item || item.isDelisted || !ctx) continue;
        const volume24h = parseFloat(ctx.dayNtlVlm);
        if (minVolume !== undefined && volume24h < minVolume) continue;
        rows.push({
          symbol: item.name,
          szDecimals: item.szDecimals,
          maxLeverage: item.maxLeverage,
          markPrice: parseFloat(ctx.markPx),
          midPrice: ctx.midPx ? parseFloat(ctx.midPx) : parseFloat(ctx.markPx),
          oraclePrice: parseFloat(ctx.oraclePx),
          fundingRate: parseFloat(ctx.funding),
          openInterest: parseFloat(ctx.openInterest),
          volume24h,
          prevDayPx: parseFloat(ctx.prevDayPx),
        });
        if (rows.length >= limit) break;
      }

      return c.json({ metas: rows, total: rows.length, timestamp: new Date().toISOString() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Upstream error' }, 502);
    }
  })
  .get('/positions', zValidator('query', positionsQuery), async (c) => {
    // Top trader positions (from ingested whale tracking data) for a symbol —
    // powers the "whale positioning" panel in the terminal.
    const { symbol, limit } = c.req.valid('query');
    const db = c.get('db');
    const rows = await db
      .select()
      .from(traderPositions)
      .where(symbol ? eq(traderPositions.symbol, symbol) : undefined)
      .orderBy(desc(traderPositions.positionValueUsd))
      .limit(limit);

    const positions = rows.map((row) => ({
      traderAddress: row.traderAddress,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      entryPrice: row.entryPrice,
      markPrice: row.markPrice,
      positionValueUsd: row.positionValueUsd,
      unrealizedPnl: row.unrealizedPnl,
      leverage: row.leverage,
      liquidationPrice: row.liquidationPrice,
      lastUpdatedAt: row.lastUpdatedAt,
    }));

    return c.json({ positions });
  });
