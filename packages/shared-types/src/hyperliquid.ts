import { z } from 'zod';

// ponytail: single Hyperliquid Info client — retry + timeout lives here, callers just pass {type, ...}. Add new methods as thin wrappers.

export class HyperliquidApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'HyperliquidApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveInfoUrl(raw: string): string {
  const r = raw.trim();
  return r.endsWith('/info') ? r : `${r.replace(/\/$/, '')}/info`;
}

export async function hyperliquidRequest<T>(
  infoUrl: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = resolveInfoUrl(infoUrl);
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) return (await res.json()) as T;
      if (res.status !== 429 && res.status < 500) {
        const text = await res.text().catch(() => '');
        throw new HyperliquidApiError(
          `Hyperliquid info(${String(body.type)}) failed: ${res.status} ${res.statusText}`,
          res.status,
          text,
        );
      }
      lastError = new HyperliquidApiError(
        `Hyperliquid info(${String(body.type)}) transient: ${res.status} ${res.statusText}`,
        res.status,
      );
    } catch (err) {
      clearTimeout(timeout);
      if (
        err instanceof HyperliquidApiError &&
        err.status !== undefined &&
        err.status !== 429 &&
        err.status < 500
      )
        throw err;
      lastError = err;
    }
    if (attempt < MAX_RETRIES) {
      const base = 250 * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 100) - 50;
      await sleep(base + jitter);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new HyperliquidApiError('Hyperliquid info request failed after retries');
}

// Common schemas
export const HyperliquidMetaSchema = z.object({
  universe: z.array(
    z.object({
      name: z.string(),
      szDecimals: z.number(),
      maxLeverage: z.number(),
      onlyIsolated: z.boolean().optional(),
      isDelisted: z.boolean().optional(),
    }),
  ),
});

export type HyperliquidMeta = z.infer<typeof HyperliquidMetaSchema>;

export const HyperliquidAssetCtxSchema = z.object({
  dayNtlVlm: z.string(),
  funding: z.string(),
  markPx: z.string(),
  midPx: z.string().nullable().optional(),
  openInterest: z.string(),
  oraclePx: z.string(),
  prevDayPx: z.string(),
});

export type HyperliquidAssetCtx = z.infer<typeof HyperliquidAssetCtxSchema>;

export interface HyperliquidFill {
  coin: string;
  side: 'A' | 'B';
  px: string;
  sz: string;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  fee: string;
  hash: string;
  oid: number;
  tid: number;
  crossed: boolean;
}

export interface HyperliquidAssetPosition {
  type: string;
  position: {
    coin: string;
    szi: string;
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    marginUsed: string;
    liquidationPx: string | null;
    returnOnEquity: string;
    leverage: { type: 'cross' | 'isolated'; value: number };
  };
}

export interface HyperliquidMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface HyperliquidClearinghouseState {
  assetPositions: HyperliquidAssetPosition[];
  crossMarginSummary: HyperliquidMarginSummary;
  marginSummary: HyperliquidMarginSummary;
  withdrawable: string;
}

export interface TraderStatsSummary {
  address: string;
  equity: number;
  pnl1d: number;
  pnl7d: number;
  pnl30d: number;
  pnl90d: number;
  pnlAllTime: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  sharpeRatio: number;
  maxDrawdown: number;
  isActive: boolean;
  lastTradeAt: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function calculateTraderStats(
  fills: HyperliquidFill[],
  state: HyperliquidClearinghouseState | null,
  address: string,
): TraderStatsSummary | null {
  if (fills.length === 0) return null;

  const now = Date.now();
  const windowStart = {
    d1: now - 1 * MS_PER_DAY,
    d7: now - 7 * MS_PER_DAY,
    d30: now - 30 * MS_PER_DAY,
    d90: now - 90 * MS_PER_DAY,
  };

  const pnl = { d1: 0, d7: 0, d30: 0, d90: 0, all: 0 };
  let winningTrades = 0;
  let losingTrades = 0;
  let lastTradeTime = 0;

  for (const fill of fills) {
    if (fill.time > lastTradeTime) lastTradeTime = fill.time;
    if (!fill.dir.startsWith('Close')) continue;

    const realized = Number.parseFloat(fill.closedPnl ?? '0') - Number.parseFloat(fill.fee ?? '0');
    pnl.all += realized;
    if (fill.time >= windowStart.d1) pnl.d1 += realized;
    if (fill.time >= windowStart.d7) pnl.d7 += realized;
    if (fill.time >= windowStart.d30) pnl.d30 += realized;
    if (fill.time >= windowStart.d90) pnl.d90 += realized;

    if (realized > 0) winningTrades++;
    else if (realized < 0) losingTrades++;
  }

  const totalClosedTrades = winningTrades + losingTrades;
  const winRate = totalClosedTrades > 0 ? (winningTrades / totalClosedTrades) * 100 : 0;
  const equity = state ? Number.parseFloat(state.crossMarginSummary?.accountValue ?? '0') : 0;

  return {
    address,
    equity,
    pnl1d: pnl.d1,
    pnl7d: pnl.d7,
    pnl30d: pnl.d30,
    pnl90d: pnl.d90,
    pnlAllTime: pnl.all,
    winRate,
    totalTrades: totalClosedTrades,
    winningTrades,
    losingTrades,
    sharpeRatio: 0,
    maxDrawdown: 0,
    isActive: lastTradeTime >= windowStart.d1,
    lastTradeAt: lastTradeTime > 0 ? new Date(lastTradeTime).toISOString() : null,
  };
}

export function fillToTraderTradeRow(
  fill: HyperliquidFill,
  traderId: string,
  traderAddress: string,
) {
  const isClose = fill.dir.startsWith('Close');
  const side: 'long' | 'short' = fill.dir.includes('Long') || fill.dir === 'Buy' ? 'long' : 'short';
  const ts = new Date(fill.time);

  return {
    traderId,
    traderAddress,
    symbol: fill.coin,
    side,
    action: isClose ? 'close' : 'open',
    size: fill.sz,
    entryPrice: isClose ? null : fill.px,
    exitPrice: isClose ? fill.px : null,
    pnl: fill.closedPnl ?? '0',
    feeUsd: fill.fee ?? '0',
    openedAt: ts,
    closedAt: isClose ? ts : null,
    exchangeTradeId: fill.hash ?? String(fill.tid),
    exchange: 'hyperliquid',
  };
}

export function assetPositionToTraderPositionRow(
  assetPosition: HyperliquidAssetPosition,
  traderId: string,
  traderAddress: string,
  markPrice: string,
) {
  const position = assetPosition.position;
  const side: 'long' | 'short' = position.szi.startsWith('-') ? 'short' : 'long';
  const quantity = position.szi.replace(/^[+-]/, '');

  return {
    traderId,
    traderAddress,
    symbol: position.coin,
    side,
    quantity,
    entryPrice: position.entryPx,
    markPrice,
    positionValueUsd: position.positionValue,
    unrealizedPnl: position.unrealizedPnl,
    marginUsed: position.marginUsed,
    leverage: String(position.leverage.value),
    liquidationPrice: position.liquidationPx,
    metadata: {
      marginMode: position.leverage.type,
      returnOnEquity: position.returnOnEquity,
    },
    lastUpdatedAt: new Date(),
  };
}
