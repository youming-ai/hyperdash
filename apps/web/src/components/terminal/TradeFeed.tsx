import type { FeedTrade } from '@hyperdash/shared-types';
import { memo, useMemo } from 'react';

import { PanelState } from '~/components/ui/state';
import { TableWrap, Td, Th } from '~/components/ui/table';
import { cn, EM_DASH, formatPrice, formatQty, formatTimeHms, toNumberOrNull } from '~/lib/utils';

/** Connection lifecycle of the feed that supplies the tape. */
export type TapeStatus = 'connecting' | 'live' | 'offline';

type ColumnKey = 'price' | 'size' | 'trader' | 'time';

interface Column {
  key: ColumnKey;
  label: string;
  align: 'left' | 'right';
  title?: string;
}

const LEADING_COLUMNS: ReadonlyArray<Column> = [
  { key: 'price', label: 'Price', align: 'right' },
  { key: 'size', label: 'Size', align: 'right' },
];

const TIME_COLUMN: Column = { key: 'time', label: 'Time', align: 'right', title: 'UTC' };

const TRADER_COLUMN: Column = { key: 'trader', label: 'Trader', align: 'left' };

const CELL_CLASS: Record<ColumnKey, string> = {
  price: 'text-fg-secondary',
  size: 'text-fg-secondary',
  trader: 'text-fg-tertiary',
  time: 'text-fg-quaternary',
};

interface TradeFeedProps {
  trades: FeedTrade[];
  /** Newest trades kept in the DOM. */
  limit?: number;
  status?: TapeStatus;
  szDecimals?: number;
  /** Caps the scroll region so a busy tape cannot stretch the page. */
  maxHeight?: string;
}

/**
 * Scrolling live trade tape. Green rows are taker buys (aggressed the ask),
 * red rows taker sells, per Hyperliquid's `side` convention ('A' = buy).
 * Direction also carries an ▲/▼ glyph, so it never depends on colour alone.
 *
 * The header and the rows are generated from ONE column template, so adding
 * the trader column can never desynchronise them.
 */
export function TradeFeed({
  trades,
  limit = 50,
  status = 'live',
  szDecimals = 4,
  maxHeight = '480px',
}: TradeFeedProps) {
  const rows = useMemo(() => trades.slice(-limit).reverse(), [trades, limit]);

  const showTrader = useMemo(() => rows.some((trade) => (trade.users?.length ?? 0) > 0), [rows]);

  const columns = useMemo<ReadonlyArray<Column>>(
    () =>
      showTrader
        ? [...LEADING_COLUMNS, TRADER_COLUMN, TIME_COLUMN]
        : [...LEADING_COLUMNS, TIME_COLUMN],
    [showTrader],
  );

  if (rows.length === 0) {
    if (status === 'connecting') {
      return <PanelState state="loading" title="Loading trade tape…" />;
    }
    if (status === 'offline') {
      return (
        <PanelState
          state="error"
          title="Trade tape offline"
          description="The live feed is disconnected, so no prints are arriving. Trades resume automatically when the socket reconnects."
        />
      );
    }
    return (
      <PanelState
        state="empty"
        title="No trades for this market yet"
        description="The feed is connected but has not printed a trade since it started."
      />
    );
  }

  return (
    <TableWrap label="Live trades" maxHeight={maxHeight}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <Th key={column.key} align={column.align} title={column.title}>
                {column.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => (
            <TradeRow
              key={
                trade.tid !== undefined
                  ? String(trade.tid)
                  : `${trade.time}-${trade.px}-${trade.sz}-${trade.hash ?? 'nohash'}`
              }
              columns={columns}
              px={toNumberOrNull(trade.px)}
              sz={toNumberOrNull(trade.sz)}
              time={trade.time}
              buy={trade.side === 'A'}
              trader={trade.users?.[0] ?? null}
              szDecimals={szDecimals}
            />
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * One tape row. All props are primitives (plus a memoised column array), so a
 * tick that prints one new trade re-renders one row instead of fifty.
 */
const TradeRow = memo(function TradeRow({
  columns,
  px,
  sz,
  time,
  buy,
  trader,
  szDecimals,
}: {
  columns: ReadonlyArray<Column>;
  px: number | null;
  sz: number | null;
  time: number;
  buy: boolean;
  trader: string | null;
  szDecimals: number;
}) {
  const sizeText = sz === null ? EM_DASH : formatQty(sz, szDecimals);
  const timeText = formatTimeHms(time);

  function renderCell(key: ColumnKey) {
    switch (key) {
      case 'price':
        return (
          <span className="inline-flex items-center gap-1">
            <span aria-hidden="true" className={buy ? 'text-up' : 'text-down'}>
              {buy ? '▲' : '▼'}
            </span>
            <span className="sr-only">{buy ? 'Buy' : 'Sell'}</span>
            <span className={cn('num', buy ? 'text-up' : 'text-down')}>
              {px === null ? EM_DASH : formatPrice(px)}
            </span>
          </span>
        );
      case 'size':
        return sizeText;
      case 'trader':
        return trader ?? EM_DASH;
      case 'time':
        return <span title={`${timeText} UTC`}>{timeText}</span>;
    }
  }

  return (
    <tr>
      {columns.map((column) => (
        <Td key={column.key} align={column.align} className={CELL_CLASS[column.key]}>
          {renderCell(column.key)}
        </Td>
      ))}
    </tr>
  );
});
