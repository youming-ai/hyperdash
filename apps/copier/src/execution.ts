/**
 * Execution planes: paper and live.
 *
 * Paper mode is not an afterthought — it is the default because the standard
 * practice (and plain sanity) is to prove a copy-trading pipeline against live
 * market data before it can touch funds. Both planes expose the same two
 * operations the reconciler needs, so the strategy logic is exercised
 * identically and only the order submission differs.
 */

import type { ExchangeClient } from '@nktkas/hyperliquid';
import { agentPrivateKeyOf } from './agent';
import type { Db } from './db';
import type { SharedClients } from './hyperliquid';
import { assetIndexOf, createAccountClients, marketablePrice, roundSize } from './hyperliquid';
import { log } from './log';
import { loadAgentWallet } from './store';
import type { CurrentPosition, ExecutionResult, PositionDelta, TradingAccount } from './types';

export interface ExecuteContext {
  symbol: string;
  midPrice: number;
  szDecimals: number;
  slippageBps: number;
  /** Builder address for fee routing, when configured. */
  builder?: { b: `0x${string}`; f: number } | null;
}

export interface ExecutionPlane {
  readonly mode: 'paper' | 'live';
  /**
   * Ground truth positions for this account.
   *
   * Mids are supplied by the caller so a reconcile pass values every account
   * against one consistent snapshot instead of racing its own refreshes.
   */
  getCurrentPositions(mids: Record<string, number>): Promise<Map<string, CurrentPosition>>;
  /** Submit one delta. Must be safe to call again after a failure. */
  execute(delta: PositionDelta, ctx: ExecuteContext): Promise<ExecutionResult>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Paper plane
// ---------------------------------------------------------------------------

interface PaperPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  side: 'long' | 'short';
}

/**
 * Simulated execution against live prices.
 *
 * Applies the same precision rules as live (lot truncation, minimum notional)
 * so a strategy that cannot place an order in paper mode would not place it
 * live either — the point is to make paper mode a faithful rehearsal.
 */
export class PaperExecutor implements ExecutionPlane {
  readonly mode = 'paper' as const;
  /** This account's simulated positions — never shared between accounts. */
  private readonly book = new Map<string, PaperPosition>();

  async getCurrentPositions(mids: Record<string, number>): Promise<Map<string, CurrentPosition>> {
    const out = new Map<string, CurrentPosition>();
    for (const p of this.book.values()) {
      if (p.quantity === 0) continue;
      const markPrice = mids[p.symbol] ?? p.entryPrice;
      out.set(`${p.symbol}:${p.side}`, {
        symbol: p.symbol,
        side: p.side,
        quantity: Math.abs(p.quantity),
        entryPrice: p.entryPrice,
        markPrice,
        notionalUsd: Math.abs(p.quantity) * markPrice,
        leverage: 1,
      });
    }
    return out;
  }

  async execute(delta: PositionDelta, ctx: ExecuteContext): Promise<ExecutionResult> {
    const isBuy = delta.deltaQty > 0;
    const formatted = roundSize(Math.abs(delta.deltaQty), ctx.szDecimals);
    const notionalUsd = Math.abs(delta.deltaQty) * ctx.midPrice;

    if (formatted === null) {
      return {
        ok: false,
        mode: 'paper',
        symbol: delta.symbol,
        side: delta.side,
        isBuy,
        quantity: Math.abs(delta.deltaQty),
        price: ctx.midPrice,
        notionalUsd,
        error: 'size rounds to zero at asset lot size',
      };
    }

    const qty = Number(formatted);
    if (qty * ctx.midPrice < 10) {
      return {
        ok: false,
        mode: 'paper',
        symbol: delta.symbol,
        side: delta.side,
        isBuy,
        quantity: qty,
        price: ctx.midPrice,
        notionalUsd,
        error: 'below Hyperliquid $10 minimum notional',
      };
    }

    // Apply the fill to the simulated book, netting across sides so a flip
    // behaves like a real position reversal.
    const signedNow = this.signedQty(delta.symbol);
    const signedAfter = signedNow + (isBuy ? qty : -qty);
    const side: 'long' | 'short' = signedAfter >= 0 ? 'long' : 'short';

    if (signedAfter === 0) {
      this.book.delete(delta.symbol);
    } else {
      const prior = this.book.get(delta.symbol);
      this.book.set(delta.symbol, {
        symbol: delta.symbol,
        quantity: Math.abs(signedAfter),
        entryPrice: prior?.entryPrice ?? ctx.midPrice,
        side,
      });
    }

    log.info('PAPER fill', {
      symbol: delta.symbol,
      isBuy,
      qty,
      px: ctx.midPrice,
      notionalUsd: Number(notionalUsd.toFixed(2)),
      netQtyAfter: signedAfter,
    });

    return {
      ok: true,
      mode: 'paper',
      symbol: delta.symbol,
      side,
      isBuy,
      quantity: qty,
      price: ctx.midPrice,
      notionalUsd,
      orderId: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  private signedQty(symbol: string): number {
    const p = this.book.get(symbol);
    if (!p) return 0;
    return p.side === 'long' ? p.quantity : -p.quantity;
  }

  async close(): Promise<void> {
    this.book.clear();
  }
}

// ---------------------------------------------------------------------------
// Live plane
// ---------------------------------------------------------------------------

/**
 * Real execution through the agent wallet.
 *
 * Orders are marketable limits with IOC: they cross the book within the
 * slippage band and cancel whatever does not fill, so no stale resting order is
 * left at a price that has moved on. Partial fills are accepted rather than
 * chased — the next reconcile pass closes the remaining gap.
 */
export class LiveExecutor implements ExecutionPlane {
  readonly mode = 'live' as const;

  constructor(
    private readonly shared: SharedClients,
    private readonly exchange: ExchangeClient,
    private readonly account: `0x${string}`,
  ) {}

  async getCurrentPositions(mids: Record<string, number>): Promise<Map<string, CurrentPosition>> {
    const { getCurrentPositions } = await import('./hyperliquid');
    return getCurrentPositions(this.shared.info, this.account, mids);
  }

  async execute(delta: PositionDelta, ctx: ExecuteContext): Promise<ExecutionResult> {
    const exchange = this.exchange;

    const isBuy = delta.deltaQty > 0;
    const formatted = roundSize(Math.abs(delta.deltaQty), ctx.szDecimals);
    const notionalUsd = Math.abs(delta.deltaQty) * ctx.midPrice;

    if (formatted === null) {
      return {
        ok: false,
        mode: 'live',
        symbol: delta.symbol,
        side: delta.side,
        isBuy,
        quantity: Math.abs(delta.deltaQty),
        price: ctx.midPrice,
        notionalUsd,
        error: 'size rounds to zero at asset lot size',
      };
    }

    const assetIndex = assetIndexOf(this.shared.converter, delta.symbol);
    if (assetIndex === null) {
      return {
        ok: false,
        mode: 'live',
        symbol: delta.symbol,
        side: delta.side,
        isBuy,
        quantity: Number(formatted),
        price: ctx.midPrice,
        notionalUsd,
        error: `unknown asset: ${delta.symbol}`,
      };
    }

    const price = marketablePrice(ctx.midPrice, isBuy, ctx.slippageBps, ctx.szDecimals);

    try {
      const result = await exchange.order({
        orders: [
          {
            a: assetIndex,
            b: isBuy,
            p: price,
            s: formatted,
            r: delta.reduceOnly,
            t: { limit: { tif: 'Ioc' } },
          },
        ],
        grouping: 'na',
        ...(ctx.builder ? { builder: ctx.builder } : {}),
      });

      const status = result.response?.data?.statuses?.[0] as
        | { resting?: { oid: number } }
        | { filled?: { oid: number } }
        | { error?: string }
        | undefined;

      if (status && 'error' in status && status.error) {
        return {
          ok: false,
          mode: 'live',
          symbol: delta.symbol,
          side: delta.side,
          isBuy,
          quantity: Number(formatted),
          price: Number(price),
          notionalUsd,
          error: status.error,
        };
      }

      const orderId =
        status && 'filled' in status
          ? status.filled?.oid
          : status && 'resting' in status
            ? status.resting?.oid
            : undefined;

      log.info('LIVE order accepted', {
        symbol: delta.symbol,
        isBuy,
        qty: formatted,
        px: price,
        orderId,
      });

      return {
        ok: true,
        mode: 'live',
        symbol: delta.symbol,
        side: delta.side,
        isBuy,
        quantity: Number(formatted),
        price: Number(price),
        notionalUsd,
        orderId: orderId === undefined ? undefined : String(orderId),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('LIVE order failed', { symbol: delta.symbol, error: message });
      return {
        ok: false,
        mode: 'live',
        symbol: delta.symbol,
        side: delta.side,
        isBuy,
        quantity: Number(formatted),
        price: Number(price),
        notionalUsd,
        error: message,
      };
    }
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Executor registry
// ---------------------------------------------------------------------------

/**
 * One execution plane per trading account.
 *
 * Caching is not just an optimisation here: the exchange nonce is tracked per
 * signing address, so two signers for the same account would race each other's
 * nonces and get orders rejected. Keying by agent wallet guarantees a single
 * signer per account for the life of the process.
 *
 * Paper accounts get their own simulated book too — sharing one book across
 * accounts would let them contaminate each other's positions, which is exactly
 * the class of bug this refactor exists to remove.
 *
 * A failing account must not take the process down with it: key decryption and
 * signer construction errors are thrown to the caller, which skips that account
 * and keeps reconciling the rest.
 */
export class ExecutorRegistry {
  private readonly live = new Map<string, LiveExecutor>();
  private readonly paper = new Map<string, PaperExecutor>();

  constructor(
    private readonly deps: {
      shared: SharedClients;
      db: Db;
      live: boolean;
      encryptionKey: Uint8Array | null;
    },
  ) {}

  /** Number of constructed executors, for diagnostics. */
  get size(): number {
    return this.live.size + this.paper.size;
  }

  async forAccount(account: TradingAccount): Promise<ExecutionPlane> {
    if (!this.deps.live) {
      const existing = this.paper.get(account.agentWalletId);
      if (existing) return existing;
      const created = new PaperExecutor();
      this.paper.set(account.agentWalletId, created);
      return created;
    }

    const existing = this.live.get(account.agentWalletId);
    if (existing) return existing;

    const created = await this.buildLive(account);
    this.live.set(account.agentWalletId, created);
    return created;
  }

  private async buildLive(account: TradingAccount): Promise<LiveExecutor> {
    const { encryptionKey, db } = this.deps;
    if (!encryptionKey) {
      throw new Error('live execution requires ENCRYPTION_KEY to decrypt agent keys');
    }

    const record = await loadAgentWallet(db, account.agentWalletId);
    if (!record) {
      throw new Error(`agent wallet ${account.agentWalletId} not found`);
    }
    if (record.status === 'suspended') {
      throw new Error(`agent wallet ${account.agentWalletId} is suspended`);
    }

    const privateKey = await agentPrivateKeyOf(record, encryptionKey);
    const { exchange } = createAccountClients(privateKey, account.masterAddress);
    return new LiveExecutor(this.deps.shared, exchange, account.masterAddress);
  }

  /** Drop an account's executor so the next pass rebuilds it (e.g. after a key change). */
  evict(agentWalletId: string): void {
    this.live.delete(agentWalletId);
    this.paper.delete(agentWalletId);
  }

  async closeAll(): Promise<void> {
    for (const executor of this.paper.values()) await executor.close();
    this.paper.clear();
    this.live.clear();
  }
}
