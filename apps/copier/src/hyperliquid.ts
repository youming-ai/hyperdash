/**
 * Hyperliquid access layer.
 *
 * All signing is delegated to @nktkas/hyperliquid, which implements both
 * signing schemes correctly (phantom-agent msgpack+keccak for L1 actions,
 * direct EIP-712 for user-signed actions). Hand-rolling either is the classic
 * way to ship orders that are silently rejected, so nothing here reimplements
 * crypto.
 *
 * Precision is likewise delegated: `formatPrice` / `formatSize` /
 * `SymbolConverter` encode Hyperliquid's tick and lot rules (max 5 significant
 * figures on price, <= MAX_DECIMALS - szDecimals decimals, size truncated to
 * szDecimals).
 */

import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from '@nktkas/hyperliquid';
import { formatPrice, formatSize, SymbolConverter } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { log } from './log';
import type { CurrentPosition } from './types';

/**
 * Clients that carry no per-account state.
 *
 * Read access, symbol metadata and the public feed are identical for every
 * account, so they are created once and shared. Only order *signing* differs
 * per account.
 */
export interface SharedClients {
  info: InfoClient;
  subscription: SubscriptionClient;
  converter: SymbolConverter;
  close: () => Promise<void>;
}

/** The signing client for one trading account. */
export interface AccountClients {
  exchange: ExchangeClient;
  /** The master account this signer acts for. */
  account: `0x${string}`;
}

/** Read-only clients, created once and shared by every account. */
export async function createSharedClients(): Promise<SharedClients> {
  const isTestnet = process.env.HYPERLIQUID_TESTNET === '1';

  const httpTransport = new HttpTransport({ isTestnet });
  const info = new InfoClient({ transport: httpTransport });
  const converter = await SymbolConverter.create({ transport: httpTransport });

  const wsTransport = new WebSocketTransport({ isTestnet });
  const subscription = new SubscriptionClient({ transport: wsTransport });

  return {
    info,
    subscription,
    converter,
    close: async () => {
      await wsTransport.close?.();
    },
  };
}

/**
 * Build the signer for one account.
 *
 * Kept separate from the shared clients because the exchange nonce is tracked
 * per signing address: sharing one `ExchangeClient` across accounts would
 * interleave their nonces, and building two for the same account would let them
 * collide. The executor registry keeps exactly one signer per account.
 */
export function createAccountClients(
  agentPrivateKey: `0x${string}`,
  account: `0x${string}`,
): AccountClients {
  const wallet = privateKeyToAccount(agentPrivateKey);
  log.info('Account signer ready', { agentAddress: wallet.address, account });

  return {
    exchange: new ExchangeClient({
      transport: new HttpTransport({ isTestnet: process.env.HYPERLIQUID_TESTNET === '1' }),
      wallet,
    }),
    account,
  };
}

/** Mid prices for every coin, used to value positions and size orders. */
export async function getAllMids(info: InfoClient): Promise<Record<string, number>> {
  const mids = await info.allMids();
  const out: Record<string, number> = {};
  for (const [coin, px] of Object.entries(mids)) {
    const n = Number(px);
    if (Number.isFinite(n) && n > 0) out[coin] = n;
  }
  return out;
}

interface RawAssetPosition {
  position: {
    coin: string;
    szi: string;
    entryPx?: string | null;
    positionValue?: string;
    leverage?: { value?: number };
  };
}

/**
 * Ground-truth positions for an account, read from the chain.
 *
 * This is deliberately *not* derived from our own bookkeeping: the reconciler
 * trusts the exchange, never its own last-known state.
 */
export async function getCurrentPositions(
  info: InfoClient,
  user: `0x${string}`,
  mids: Record<string, number>,
): Promise<Map<string, CurrentPosition>> {
  const state = (await info.clearinghouseState({ user })) as {
    assetPositions?: RawAssetPosition[];
  };

  const positions = new Map<string, CurrentPosition>();

  for (const entry of state.assetPositions ?? []) {
    const p = entry.position;
    const signedSize = Number(p.szi);
    if (!Number.isFinite(signedSize) || signedSize === 0) continue;

    const side: 'long' | 'short' = signedSize > 0 ? 'long' : 'short';
    const quantity = Math.abs(signedSize);
    const markPrice = mids[p.coin] ?? (p.positionValue ? Number(p.positionValue) / quantity : 0);
    const notionalUsd = p.positionValue ? Math.abs(Number(p.positionValue)) : quantity * markPrice;

    positions.set(`${p.coin}:${side}`, {
      symbol: p.coin,
      side,
      quantity,
      entryPrice: p.entryPx ? Number(p.entryPx) : markPrice,
      markPrice,
      notionalUsd,
      leverage: p.leverage?.value ?? 1,
    });
  }

  return positions;
}

/** Account equity in USD (used for proportional sizing). */
export async function getAccountEquity(info: InfoClient, user: `0x${string}`): Promise<number> {
  const state = (await info.clearinghouseState({ user })) as {
    marginSummary?: { accountValue?: string };
  };
  const value = Number(state.marginSummary?.accountValue ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** Resolve the Hyperliquid asset index for a coin; null if the coin is unknown. */
export function assetIndexOf(converter: SymbolConverter, coin: string): number | null {
  const id = converter.getAssetId(coin);
  return id === undefined ? null : id;
}

/** Size decimals for a coin, or null when the symbol is not in the universe. */
export function szDecimalsOf(converter: SymbolConverter, coin: string): number | null {
  const v = converter.getSzDecimals(coin);
  return v === undefined ? null : v;
}

/**
 * Build a marketable limit price inside the allowed slippage band.
 *
 * Hyperliquid has no naked market order with protection: the standard practice
 * is an aggressive limit that crosses the book and relies on IOC to cancel the
 * remainder, so we never leave a stale resting order behind.
 */
export function marketablePrice(
  midPrice: number,
  isBuy: boolean,
  slippageBps: number,
  szDecimals: number,
): string {
  const slip = midPrice * (slippageBps / 10_000);
  const raw = isBuy ? midPrice + slip : midPrice - slip;
  return formatPrice(raw, szDecimals, 'perp');
}

/** Format a size to the asset's lot size, or null when it rounds to zero. */
export function roundSize(quantity: number, szDecimals: number): string | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  try {
    return formatSize(quantity, szDecimals);
  } catch {
    return null;
  }
}
