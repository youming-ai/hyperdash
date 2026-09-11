/** Domain types shared across the copier pipeline. */

/** A desired position, keyed by `${symbol}:${side}`. */
export interface TargetPosition {
  symbol: string;
  side: 'long' | 'short';
  /** Absolute size in coin units (always >= 0). */
  quantity: number;
  notionalUsd: number;
}

/** A verified on-chain position for the follower account. */
export interface CurrentPosition {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  leverage: number;
}

/** A single order to bring one symbol closer to its target. */
export interface PositionDelta {
  symbol: string;
  /** Signed target-vs-current change in coin units; sign encodes direction. */
  deltaQty: number;
  /** The side of the resulting position (not the order direction). */
  side: 'long' | 'short';
  currentQty: number;
  targetQty: number;
  /** True when this delta reduces exposure (close / flip down). */
  reduceOnly: boolean;
}

/** Risk + sizing config resolved for one strategy. */
export interface StrategyRisk {
  maxPositionUsd: number;
  maxLeverage: number;
  slippageBps: number;
  minOrderUsd: number;
  followNewEntriesOnly: boolean;
}

/** One trader allocation inside a strategy. */
export interface Allocation {
  traderId: string;
  traderAddress: string;
  /** 0–1 portfolio weight. */
  weight: number;
  /** Lead account equity in USD, used for proportional scaling. */
  leadEquityUsd: number;
}

/** A strategy loaded from Postgres, in the shape the reconciler needs. */
export interface LoadedStrategy {
  id: string;
  userId: string;
  name: string;
  mode: 'portfolio' | 'single_trader';
  status: 'active' | 'paused' | 'error' | 'terminated';
  agentWalletId: string | null;
  risk: StrategyRisk;
  allocations: Allocation[];
}

/**
 * One trading account, plus every strategy writing to it.
 *
 * This is the unit of reconciliation, not the strategy. A single account can
 * carry several strategies, and each of them only knows its own desired
 * positions — so reconciling strategy-by-strategy makes them fight over the
 * same balance. Measured: two strategies on one account re-issued orders on
 * every sweep, 5,092 orders in 40 seconds, buying and selling the same symbol
 * 26 times each. Netting their targets first and executing once fixes it.
 *
 * It is also what makes multi-tenancy work: accounts share no state, so one
 * user's strategies can never act on another user's positions.
 */
export interface TradingAccount {
  /** Stable identity for the account — the agent wallet that signs for it. */
  agentWalletId: string;
  agentAddress: `0x${string}`;
  /** The master account orders are placed against. */
  masterAddress: `0x${string}`;
  userId: string;
  strategies: LoadedStrategy[];
}

/** Result of attempting an order, paper or live. */
export interface ExecutionResult {
  ok: boolean;
  mode: 'paper' | 'live';
  symbol: string;
  side: 'long' | 'short';
  isBuy: boolean;
  quantity: number;
  price: number;
  notionalUsd: number;
  orderId?: string;
  error?: string;
}
