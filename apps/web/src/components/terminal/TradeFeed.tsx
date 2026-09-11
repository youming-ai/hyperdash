import type { FeedTrade } from '@hyperdash/shared-types';
import { formatNumber, formatTimeHms, shortenAddress } from '~/lib/utils';

interface TradeFeedProps {
  trades: FeedTrade[];
  limit?: number;
  compact?: boolean;
}

/**
 * Scrolling live trade tape. Green rows are taker buys (aggressed the ask),
 * red rows taker sells, per Hyperliquid's `side` convention ('A' = buy).
 */
export function TradeFeed({ trades, limit = 50, compact = false }: TradeFeedProps) {
  const rows = trades.slice(-limit).reverse();

  if (rows.length === 0) {
    return <div className="p-6 text-center text-sm opacity-50">Waiting for live trades…</div>;
  }

  return (
    <div className={compact ? 'text-xs' : 'text-sm'}>
      <div className="flex items-center justify-between px-3 pb-1 pt-2 text-xs opacity-60">
        <span>Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      <div className="space-y-px overflow-hidden">
        {rows.slice(0, limit).map((trade) => {
          const price = parseFloat(trade.px);
          const size = parseFloat(trade.sz);
          const buy = trade.side === 'A';
          return (
            <div
              key={`${trade.tid ?? 'x'}-${trade.time}`}
              className="flex items-center justify-between px-3 py-[3px] font-mono"
            >
              <span className={`w-20 tabular-nums ${buy ? 'text-success' : 'text-destructive'}`}>
                {formatNumber(price)}
              </span>
              <span className="opacity-80 tabular-nums">{formatNumber(size)}</span>
              {!compact && trade.users?.length ? (
                <span className="opacity-40 max-w-[110px] truncate hidden md:inline">
                  {shortenAddress(trade.users[0] ?? '')}
                </span>
              ) : null}
              <span className="opacity-50 tabular-nums">{formatTimeHms(trade.time)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
