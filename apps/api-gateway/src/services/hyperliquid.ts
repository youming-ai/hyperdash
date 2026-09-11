/**
 * Hyperliquid Info API client.
 *
 * Every Info query is `POST {origin}/info` with a JSON body `{ "type": "...",
 * ...args }`. We wrap fetch with a per-request timeout, exponential backoff on
 * 5xx / 429 / transport errors, and basic address validation.
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */

// ---------------------------------------------------------------------------
// Response types — shaped to match the real API, not our earlier guesses.
// ---------------------------------------------------------------------------

/**
 * A single user fill. `closedPnl` is non-zero only on fills that close or
 * reduce a position; opens always report "0.0". `fee` is the taker fee in USD.
 */
export interface HyperliquidFill {
  coin: string;
  /** `A` = taker matched an ask (taker bought); `B` = taker matched a bid (taker sold). */
  side: 'A' | 'B';
  /** Fill price. */
  px: string;
  /** Absolute fill size. */
  sz: string;
  /** Epoch milliseconds. */
  time: number;
  /** Position size before this fill (signed). */
  startPosition: string;
  /** Human-readable direction: "Open Long" | "Close Long" | "Open Short" | "Close Short" | "Buy" | "Sell". */
  dir: string;
  closedPnl: string;
  fee: string;
  hash: string;
  oid: number;
  tid: number;
  crossed: boolean;
}

export interface HyperliquidAssetPosition {
  type: 'oneWay' | string;
  position: {
    coin: string;
    /** Signed position size: positive = long, negative = short. */
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

export interface HyperliquidMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage: number;
    onlyIsolated?: boolean;
    isDelisted?: boolean;
  }>;
}

export type HyperliquidAllMids = Record<string, string>;

// ---------------------------------------------------------------------------
// HTTP layer.
// ---------------------------------------------------------------------------

/** Thrown for any non-2xx response or transport failure. */
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

/**
 * Resolve the Info endpoint. `HYPERLIQUID_API_URL` may point to the full
 * `/info` URL (as in our .env.example) or just the origin; accept both.
 */
function resolveInfoUrl(): string {
  const raw = process.env.HYPERLIQUID_API_URL ?? 'https://api.hyperliquid.xyz';
  return raw.endsWith('/info') ? raw : `${raw.replace(/\/$/, '')}/info`;
}

/**
 * Make one POST /info call with timeout + retries on 5xx/429/transport errors.
 * 4xx (except 429) fail fast — those are caller mistakes and won't fix with time.
 */
async function infoRequest<T>(body: Record<string, unknown>): Promise<T> {
  const url = resolveInfoUrl();
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'hyperdash-api-gateway/1.0',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        return (await res.json()) as T;
      }

      // Non-retryable client error — surface immediately.
      if (res.status !== 429 && res.status < 500) {
        const text = await res.text().catch(() => '');
        throw new HyperliquidApiError(
          `Hyperliquid info(${String(body.type)}) failed: ${res.status} ${res.statusText}`,
          res.status,
          text,
        );
      }

      // Retryable (5xx or 429): loop after backoff.
      lastError = new HyperliquidApiError(
        `Hyperliquid info(${String(body.type)}) transient: ${res.status} ${res.statusText}`,
        res.status,
      );
    } catch (err) {
      clearTimeout(timeout);
      // A non-retryable HyperliquidApiError we just threw — bubble up.
      if (
        err instanceof HyperliquidApiError &&
        err.status &&
        err.status !== 429 &&
        err.status < 500
      ) {
        throw err;
      }
      lastError = err;
    }

    if (attempt < MAX_RETRIES) {
      // Exponential backoff with jitter: ~250ms, ~500ms, ~1000ms.
      const base = 250 * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 100) - 50;
      await sleep(base + jitter);
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new HyperliquidApiError('Hyperliquid info request failed after retries');
}

// ---------------------------------------------------------------------------
// Public API wrappers.
// ---------------------------------------------------------------------------

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

function assertAddress(address: string): void {
  if (!ADDRESS_REGEX.test(address)) {
    throw new HyperliquidApiError(`Invalid Hyperliquid address: ${address}`);
  }
}

/** Recent fills for a user. Returns `[]` if the user has never traded. */
export async function getUserFills(address: string): Promise<HyperliquidFill[]> {
  assertAddress(address);
  const data = await infoRequest<HyperliquidFill[] | null>({ type: 'userFills', user: address });
  return Array.isArray(data) ? data : [];
}

/** Perp account state: open positions, margin summary, withdrawable balance. */
export async function getClearinghouseState(
  address: string,
): Promise<HyperliquidClearinghouseState> {
  assertAddress(address);
  return infoRequest<HyperliquidClearinghouseState>({ type: 'clearinghouseState', user: address });
}

/** All mid-market prices, as a flat `{ COIN: priceString }` map. */
export async function getAllMids(): Promise<HyperliquidAllMids> {
  return infoRequest<HyperliquidAllMids>({ type: 'allMids' });
}

/** Perp metadata including each coin's szDecimals and maxLeverage. */
export async function getMeta(): Promise<HyperliquidMeta> {
  return infoRequest<HyperliquidMeta>({ type: 'meta' });
}

// ---------------------------------------------------------------------------
// Domain logic — stats derivation and DB row mapping.
// ---------------------------------------------------------------------------

export interface TraderStatsSummary {
  address: string;
  equity: number;
  pnl1d: number;
  pnl7d: number;
  pnl30d: number;
  pnl90d: number;
  pnlAllTime: number;
  /** 0-100. */
  winRate: number;
  /** Count of completed round-trips (i.e. close fills). */
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** Not computable from fills alone; requires an equity timeseries. */
  sharpeRatio: number;
  /** Same as sharpeRatio — requires equity timeseries. */
  maxDrawdown: number;
  /** Traded within the last 24h. */
  isActive: boolean;
  lastTradeAt: string | null;
}

export interface TraderPositionRow {
  traderId: string;
  traderAddress: string;
  symbol: string;
  side: 'long' | 'short';
  quantity: string;
  entryPrice: string;
  markPrice: string;
  positionValueUsd: string;
  unrealizedPnl: string;
  marginUsed: string;
  leverage: string;
  liquidationPrice: string | null;
  metadata: Record<string, unknown>;
  lastUpdatedAt: Date;
}

export function assetPositionToTraderPositionRow(
  assetPosition: HyperliquidAssetPosition,
  traderId: string,
  traderAddress: string,
  markPrice: string,
): TraderPositionRow {
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Derive trader statistics from fills + current clearinghouse state.
 *
 * Only CLOSE fills carry realized PnL; OPEN fills always report
 * `closedPnl = "0"`. We therefore derive win/loss counts from close fills
 * (a "trade" = one completed round-trip) and aggregate `closedPnl - fee` by
 * time window.
 *
 * Sharpe and maxDrawdown would require an equity curve we don't have here
 * (Hyperliquid only exposes point-in-time state, not history). They're left
 * at 0 with a TODO; a future enhancement can compute them from ingested
 * portfolio snapshots.
 */
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

    // PnL is only meaningful on close fills; skip opens.
    if (!fill.dir.startsWith('Close')) continue;

    const realized = parseFloat(fill.closedPnl ?? '0') - parseFloat(fill.fee ?? '0');
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
  const equity = state ? parseFloat(state.crossMarginSummary?.accountValue ?? '0') : 0;

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
    sharpeRatio: 0, // TODO: requires equity timeseries
    maxDrawdown: 0, // TODO: requires equity timeseries
    isActive: lastTradeTime >= windowStart.d1,
    lastTradeAt: lastTradeTime > 0 ? new Date(lastTradeTime).toISOString() : null,
  };
}

/**
 * One row for the `trader_trades` table (see
 * packages/database/postgres/src/schema.ts). Each row represents a single
 * fill/action, not a round-trip position.
 */
export interface TraderTradeRow {
  traderId: string;
  traderAddress: string;
  symbol: string;
  side: 'long' | 'short';
  action: 'open' | 'close';
  size: string;
  entryPrice: string | null;
  exitPrice: string | null;
  pnl: string;
  feeUsd: string;
  openedAt: Date;
  closedAt: Date | null;
  exchangeTradeId: string;
  exchange: 'hyperliquid';
}

/**
 * Map a Hyperliquid fill to a `trader_trades` row.
 *
 * The `dir` field is authoritative for position direction: "Open Long",
 * "Close Long", "Open Short", "Close Short". Spot/non-perp fills may show
 * "Buy"/"Sell" without Open/Close — those are treated as opens of the
 * implied direction (buy = long, sell = short).
 */
export function fillToTraderTradeRow(
  fill: HyperliquidFill,
  traderId: string,
  traderAddress: string,
): TraderTradeRow {
  const isClose = fill.dir.startsWith('Close');
  // `Close Long`/`Open Long`/`Buy` → long; `Close Short`/`Open Short`/`Sell` → short.
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

/**
 * Fetch everything needed to ingest one trader.
 *
 * Returns `null` only when the trader has no fills. API/network/parse errors
 * bubble up as `HyperliquidApiError` so the ingestion job can decide whether
 * to retry (transient) or mark the address as permanently failing.
 */
export async function fetchTraderData(address: string): Promise<{
  stats: TraderStatsSummary;
  fills: HyperliquidFill[];
  state: HyperliquidClearinghouseState | null;
} | null> {
  const [fills, state] = await Promise.all([
    getUserFills(address),
    // A brand-new or non-perp address may 404 on clearinghouseState; that's
    // recoverable — we can still return fill-based stats with equity = 0.
    getClearinghouseState(address).catch((err) => {
      if (err instanceof HyperliquidApiError && err.status === 404) return null;
      throw err;
    }),
  ]);

  const stats = calculateTraderStats(fills, state, address);
  if (!stats) return null;

  return { stats, fills, state };
}
