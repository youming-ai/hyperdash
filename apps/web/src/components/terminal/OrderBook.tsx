import type { FeedBook, FeedLevel } from '@hyperdash/shared-types';
import { useMemo } from 'react';
import { formatNumber } from '~/lib/utils';

interface OrderBookProps {
  book: FeedBook | null;
  rows?: number;
}

interface Row extends FeedLevel {
  cumulative: number;
  side: 'bid' | 'ask';
}

/**
 * Depth ladder with cumulative-size bars. Bids (green) descend from the mid;
 * asks (red) ascend. Depth is normalized to the deepest visible level.
 */
export function OrderBook({ book, rows = 12 }: OrderBookProps) {
  const model = useMemo(() => {
    if (!book) return null;
    let bidCum = 0;
    let askCum = 0;
    const bids: Row[] = (book.bids ?? []).slice(0, rows).map((level) => {
      bidCum += parseFloat(level.sz);
      return { ...level, cumulative: bidCum, side: 'bid' };
    });
    const asks: Row[] = (book.asks ?? []).slice(0, rows).map((level) => {
      askCum += parseFloat(level.sz);
      return { ...level, cumulative: askCum, side: 'ask' };
    });
    const maxDepth = Math.max(bidCum, askCum, 1);
    const bidBest = bids[0] ? parseFloat(bids[0].px) : 0;
    const askBest = asks[0] ? parseFloat(asks[0].px) : 0;
    const mid = bidBest > 0 && askBest > 0 ? (bidBest + askBest) / 2 : bidBest || askBest;
    return { bids, asks, maxDepth, mid };
  }, [book, rows]);

  if (!model) {
    return (
      <div className="p-6 text-center text-sm opacity-50">
        Orderbook unavailable — subscribe to the feed to see live depth.
      </div>
    );
  }

  const renderRow = (row: Row) => (
    <div
      key={`${row.side}-${row.px}`}
      className="relative flex items-center justify-between px-3 py-[3px] text-xs font-mono"
    >
      <div
        className="absolute inset-y-0 right-0 rounded-sm"
        style={{
          width: `${(row.cumulative / model.maxDepth) * 100}%`,
          background:
            row.side === 'bid' ? 'hsl(var(--success) / 0.14)' : 'hsl(var(--destructive) / 0.14)',
        }}
      />
      <span className={row.side === 'bid' ? 'text-success' : 'text-destructive'}>
        {formatNumber(parseFloat(row.px))}
      </span>
      <span className="opacity-80">{row.sz}</span>
      <span className="opacity-50">{row.cumulative.toFixed(3)}</span>
    </div>
  );

  return (
    <div className="text-sm">
      <div className="px-3 pb-1 pt-2 flex items-center justify-between text-xs opacity-60">
        <span>Price</span>
        <span>Size</span>
        <span>Cumulative</span>
      </div>
      <div className="space-y-px">
        {[...model.asks].reverse().map(renderRow)}
        <div className="flex items-center justify-between px-3 py-1 text-xs border-y border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40">
          <span className="opacity-70">Spread</span>
          <span className="font-mono">{model.mid > 0 ? formatNumber(model.mid) : '-'}</span>
        </div>
        {model.bids.map(renderRow)}
      </div>
    </div>
  );
}
