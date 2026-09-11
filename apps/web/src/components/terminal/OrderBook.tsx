import type { FeedBook } from '@hyperdash/shared-types';
import { memo, useMemo } from 'react';

import { PanelState } from '~/components/ui/state';
import { TableWrap, Td, Th } from '~/components/ui/table';
import { cn, EM_DASH, formatNumber, formatPrice, formatQty, toNumberOrNull } from '~/lib/utils';

/** Connection lifecycle of the feed that supplies the book. */
export type BookStatus = 'connecting' | 'live' | 'offline';

interface OrderBookProps {
  book: FeedBook | null;
  /** Levels rendered per side. */
  rows?: number;
  status?: BookStatus;
  symbol?: string;
  /** Market quantity precision, so every size column shares one convention. */
  szDecimals?: number;
}

interface LadderRow {
  side: 'bid' | 'ask';
  px: number | null;
  sz: number | null;
  cumulative: number;
  depthPct: number;
}

/**
 * Depth ladder with cumulative-size bars.
 *
 * Bids are listed below the spread, asks above it, and the depth bars mirror
 * from opposite edges (bids anchor right, asks anchor left). Both sides share
 * ONE depth scale, so a full-width bar means the same size on either side.
 */
export function OrderBook({
  book,
  rows = 12,
  status = 'live',
  symbol,
  szDecimals = 4,
}: OrderBookProps) {
  const model = useMemo(() => {
    if (!book) return null;

    const build = (levels: FeedBook['bids'], side: 'bid' | 'ask'): LadderRow[] => {
      let cumulative = 0;
      return levels.slice(0, rows).map((level) => {
        const sz = toNumberOrNull(level.sz);
        cumulative += sz ?? 0;
        return {
          side,
          px: toNumberOrNull(level.px),
          sz,
          cumulative,
          depthPct: 0,
        };
      });
    };

    const bids = build(book.bids ?? [], 'bid');
    const asks = build(book.asks ?? [], 'ask');
    const maxDepth = Math.max(
      bids[bids.length - 1]?.cumulative ?? 0,
      asks[asks.length - 1]?.cumulative ?? 0,
      1,
    );
    const scaled = (rowsIn: LadderRow[]): LadderRow[] =>
      rowsIn.map((row) => ({ ...row, depthPct: Math.min(100, (row.cumulative / maxDepth) * 100) }));

    const bidBest = bids[0]?.px ?? null;
    const askBest = asks[0]?.px ?? null;
    const mid =
      bidBest !== null && askBest !== null ? (bidBest + askBest) / 2 : (bidBest ?? askBest);
    // The spread row is ask − bid, not the mid: showing the mid under the
    // label "Spread" is wrong data in a trading UI.
    const spread = bidBest !== null && askBest !== null ? askBest - bidBest : null;
    const spreadBps = spread !== null && mid !== null && mid > 0 ? (spread / mid) * 10_000 : null;

    return {
      bids: scaled(bids),
      asks: scaled(asks),
      mid,
      spread,
      spreadBps,
      hasLevels: bids.length > 0 || asks.length > 0,
    };
  }, [book, rows]);

  if (!model?.hasLevels) {
    if (status === 'connecting') {
      return <PanelState state="loading" title="Loading order book…" />;
    }
    if (!model && status === 'offline') {
      return (
        <PanelState
          state="error"
          title="Order book offline"
          description="The live feed is disconnected, so there is no depth snapshot to show. Depth resumes automatically when the socket reconnects."
        />
      );
    }
    if (!model) {
      return (
        <PanelState
          state="empty"
          title="No depth snapshot yet"
          description="The feed is connected but has not published a book for this market."
        />
      );
    }
    return (
      <PanelState
        state="empty"
        title="Order book is empty"
        description="There are no resting orders on either side of this market."
      />
    );
  }

  const spreadText = model.spread === null ? EM_DASH : formatPrice(model.spread);
  const bpsText = model.spreadBps === null ? EM_DASH : `${formatNumber(model.spreadBps, 1)} bps`;
  const midText = model.mid === null ? EM_DASH : formatPrice(model.mid);

  return (
    <div className="flex flex-col">
      <p className="px-3 py-1 text-2xs text-fg-quaternary">
        Bids anchor right, asks anchor left · both sides share one depth scale
      </p>

      <TableWrap label={`Order book${symbol ? ` for ${symbol}` : ''}`} maxHeight="420px">
        <table className="data-table">
          <thead>
            <tr>
              <Th align="right">Price</Th>
              <Th align="right">Size</Th>
              <Th align="right" title="Cumulative size from the top of book">
                Cumulative
              </Th>
            </tr>
          </thead>
          <tbody>
            {[...model.asks].reverse().map((row, index) => (
              <LadderRow
                key={row.px === null ? `ask-na-${index}` : `ask-${row.px}`}
                px={row.px}
                sz={row.sz}
                cumulative={row.cumulative}
                depthPct={row.depthPct}
                side="ask"
                szDecimals={szDecimals}
              />
            ))}

            <tr className="bg-inset">
              <Td colSpan={3}>
                <div className="flex items-center justify-between gap-2">
                  <span className="panel-title">Spread</span>
                  <span className="num text-xs text-fg-quaternary">Mid {midText}</span>
                  <span className="num text-xs text-fg-secondary">
                    {spreadText} <span className="text-fg-quaternary">({bpsText})</span>
                  </span>
                </div>
              </Td>
            </tr>

            {model.bids.map((row, index) => (
              <LadderRow
                key={row.px === null ? `bid-na-${index}` : `bid-${row.px}`}
                px={row.px}
                sz={row.sz}
                cumulative={row.cumulative}
                depthPct={row.depthPct}
                side="bid"
                szDecimals={szDecimals}
              />
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}

/**
 * One ladder level. Props are primitives so React.memo can skip every level
 * whose price/size did not change on a book tick — the ladder receives several
 * updates per second and should not rediff 24 rows each time.
 */
const LadderRow = memo(function LadderRow({
  px,
  sz,
  cumulative,
  depthPct,
  side,
  szDecimals,
}: {
  px: number | null;
  sz: number | null;
  cumulative: number;
  depthPct: number;
  side: 'bid' | 'ask';
  szDecimals: number;
}) {
  const bid = side === 'bid';
  return (
    <tr>
      <Td align="right" className={bid ? 'text-up' : 'text-down'}>
        <span className="sr-only">{bid ? 'Bid' : 'Ask'} price </span>
        {px === null ? EM_DASH : formatPrice(px)}
      </Td>
      <Td align="right" className="text-fg-secondary">
        <span className="sr-only">Size </span>
        {sz === null ? EM_DASH : formatQty(sz, szDecimals)}
      </Td>
      <Td align="right" className="relative text-fg-tertiary">
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-y-0 rounded-sm',
            bid ? 'right-0 bg-up/15' : 'left-0 bg-down/15',
          )}
          style={{ width: `${depthPct}%` }}
        />
        <span className="relative">
          <span className="sr-only">Cumulative size </span>
          {formatQty(cumulative, szDecimals)}
        </span>
      </Td>
    </tr>
  );
});
