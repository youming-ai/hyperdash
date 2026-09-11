import { z } from 'zod';

// ---------------------------------------------------------------------------
// Real-time feed message schemas (Hyperliquid WS → api-gateway → clients)
// Shared by the api-gateway feed pipeline and the web frontend.
// ---------------------------------------------------------------------------

/** One order-book level. `n` = number of orders at the level. */
export const FeedLevelSchema = z.object({
  px: z.string(),
  sz: z.string(),
  n: z.number(),
});

/** Snapshot or incremental l2 book update. Bids = levels[0], asks = levels[1]. */
export const FeedBookSchema = z.object({
  coin: z.string(),
  time: z.number(),
  bids: z.array(FeedLevelSchema),
  asks: z.array(FeedLevelSchema),
});

/**
 * A single trade. `side` follows Hyperliquid convention: `'A'` = taker matched
 * an ask (taker bought), `'B'` = taker matched a bid (taker sold).
 * `users[0]` is the taker, `users[1]` the maker.
 */
export const FeedTradeSchema = z.object({
  coin: z.string(),
  side: z.enum(['A', 'B']),
  px: z.string(),
  sz: z.string(),
  time: z.number(),
  hash: z.string().optional(),
  tid: z.number().optional(),
  users: z.array(z.string()).optional(),
});

/** Candle update (updates in real time during the candle's lifetime). */
export const FeedCandleSchema = z.object({
  t: z.number(),
  T: z.number(),
  s: z.string(),
  i: z.string(),
  o: z.string(),
  c: z.string(),
  h: z.string(),
  l: z.string(),
  v: z.string(),
  n: z.number(),
});

/** Asset context: mark/oracle/mid price, funding, open interest, volumes. */
export const FeedCtxSchema = z.object({
  coin: z.string(),
  funding: z.string(),
  openInterest: z.string(),
  prevDayPx: z.string(),
  dayNtlVlm: z.string(),
  dayBaseVlm: z.string().optional(),
  premium: z.string().optional(),
  oraclePx: z.string(),
  markPx: z.string(),
  midPx: z.string().optional(),
  impactPxs: z.array(z.string()).optional(),
});

/** Full snapshot of the feed pipeline state (sent on `state` subscribe). */
export const FeedStateSchema = z.object({
  connected: z.boolean(),
  wsUrl: z.string(),
  coins: z.array(z.string()),
  serverTime: z.number(),
  mids: z.record(z.string(), z.string()),
  ctx: z.record(z.string(), FeedCtxSchema),
  books: z.record(z.string(), FeedBookSchema),
  trades: z.record(z.string(), z.array(FeedTradeSchema)),
  candles: z.record(z.string(), z.array(FeedCandleSchema)),
});

/** One hourly funding snapshot record. */
export const FundingPointSchema = z.object({
  coin: z.string(),
  ts: z.number(),
  funding: z.number(),
});

/** One hourly mark-price snapshot record. */
export const PricePointSchema = z.object({
  coin: z.string(),
  ts: z.number(),
  markPx: z.number(),
});

/** One hourly open-interest snapshot record. */
export const OiPointSchema = z.object({
  coin: z.string(),
  ts: z.number(),
  openInterest: z.number(),
});

/** Per-minute volume bucket (USD notional; buyer = taker-buy side). */
export const VolumePointSchema = z.object({
  coin: z.string(),
  ts: z.number(),
  notionalUsd: z.number(),
  buyNotionalUsd: z.number(),
});

/** Per-minute "stress" (liquidation-like) event: volume/volatility spike. */
export const StressPointSchema = z.object({
  coin: z.string(),
  ts: z.number(),
  trades: z.number(),
  notionalUsd: z.number(),
  maxJumpPct: z.number(),
  spikeScore: z.number(),
});

/** Per-minute net flow from tracked whale wallets (taker side). */
export const WhaleFlowPointSchema = z.object({
  coin: z.string(),
  ts: z.number(),
  netNotionalUsd: z.number(),
  buyNotionalUsd: z.number(),
  sellNotionalUsd: z.number(),
  trades: z.number(),
});

export const FeedLevel = FeedLevelSchema;
export const FeedBook = FeedBookSchema;
export const FeedTrade = FeedTradeSchema;
export const FeedCandle = FeedCandleSchema;
export const FeedCtx = FeedCtxSchema;
export const FeedState = FeedStateSchema;
export const FundingPoint = FundingPointSchema;
export const PricePoint = PricePointSchema;
export const OiPoint = OiPointSchema;
export const VolumePoint = VolumePointSchema;
export const StressPoint = StressPointSchema;
export const WhaleFlowPoint = WhaleFlowPointSchema;

// Type aliases (values above are the Zod validators; these are the inferred TS types).
export type FeedLevel = z.infer<typeof FeedLevelSchema>;
export type FeedBook = z.infer<typeof FeedBookSchema>;
export type FeedTrade = z.infer<typeof FeedTradeSchema>;
export type FeedCandle = z.infer<typeof FeedCandleSchema>;
export type FeedCtx = z.infer<typeof FeedCtxSchema>;
export type FeedState = z.infer<typeof FeedStateSchema>;
export type FundingPoint = z.infer<typeof FundingPointSchema>;
export type PricePoint = z.infer<typeof PricePointSchema>;
export type OiPoint = z.infer<typeof OiPointSchema>;
export type VolumePoint = z.infer<typeof VolumePointSchema>;
export type StressPoint = z.infer<typeof StressPointSchema>;
export type WhaleFlowPoint = z.infer<typeof WhaleFlowPointSchema>;

export default {
  FeedLevel: FeedLevelSchema,
  FeedBook: FeedBookSchema,
  FeedTrade: FeedTradeSchema,
  FeedCandle: FeedCandleSchema,
  FeedCtx: FeedCtxSchema,
  FeedState: FeedStateSchema,
  FundingPoint: FundingPointSchema,
  PricePoint: PricePointSchema,
  OiPoint: OiPointSchema,
  VolumePoint: VolumePointSchema,
  StressPoint: StressPointSchema,
  WhaleFlowPoint: WhaleFlowPointSchema,
};
