import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { memo, type ReactNode, useMemo } from 'react';

import { AddressText } from '~/components/ui/address';
import { Badge } from '~/components/ui/badge';
import { PanelState } from '~/components/ui/state';
import { TableWrap, Td, Th } from '~/components/ui/table';
import { api, readJson } from '~/lib/api-client';
import {
  cn,
  EM_DASH,
  formatDateTime,
  formatNumber,
  formatPnL,
  formatPrice,
  formatQty,
  formatRelativeTime,
  formatUsd,
  toNumberOrNull,
} from '~/lib/utils';

interface WhalePositionsProps {
  symbol: string;
  /** Market quantity precision, so the size column is consistent per market. */
  szDecimals?: number;
}

interface PositionRow {
  traderAddress: string;
  symbol: string;
  side: string;
  quantity: string;
  entryPrice: string;
  markPrice: string;
  positionValueUsd: string;
  unrealizedPnl: string;
  leverage: string | null;
  liquidationPrice: string | null;
  lastUpdatedAt: string | null;
}

type Side = 'long' | 'short';

interface WhaleColumn {
  key: 'trader' | 'side' | 'size' | 'value' | 'pnl' | 'leverage' | 'liquidation' | 'updated';
  label: string;
  align: 'left' | 'right';
  width: number;
  title?: string;
}

const COLUMNS: ReadonlyArray<WhaleColumn> = [
  { key: 'trader', label: 'Trader', align: 'left', width: 130 },
  { key: 'side', label: 'Side', align: 'left', width: 72 },
  { key: 'size', label: 'Size', align: 'right', width: 96 },
  { key: 'value', label: 'Value', align: 'right', width: 88 },
  { key: 'pnl', label: 'PnL', align: 'right', width: 88 },
  { key: 'leverage', label: 'Lev', align: 'right', width: 52, title: 'Reported leverage' },
  {
    key: 'liquidation',
    label: 'Liq. price',
    align: 'right',
    width: 96,
    title: 'Liquidation price',
  },
  { key: 'updated', label: 'Updated', align: 'right', width: 84, title: 'Position age (UTC)' },
];

/** A position older than this is flagged in the Updated column. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * An unrecognised side must never be guessed: the ingestion job writes exactly
 * 'long' or 'short', so anything else is rendered as a dash rather than being
 * silently promoted to SHORT (a confident, wrong, red label).
 */
function normalizeSide(side: string | null | undefined): Side | null {
  const value = side?.trim().toLowerCase();
  if (value === 'long') return 'long';
  if (value === 'short') return 'short';
  return null;
}

/**
 * Top open positions across ingested whale traders for a symbol — "who is
 * positioned here, and how much". Renders the three query states distinctly so
 * an outage is never presented as an empty pipeline.
 */
export function WhalePositions({ symbol, szDecimals = 4 }: WhalePositionsProps) {
  const query = useQuery({
    queryKey: ['market-positions', symbol],
    queryFn: async () =>
      readJson<{ positions: PositionRow[] }>(
        await api.market.positions.$get({ query: { symbol, limit: '8' } }),
        `Whale positions for ${symbol}`,
      ),
  });

  const rows = useMemo(() => query.data?.positions ?? [], [query.data]);

  if (query.isPending) {
    return <PanelState state="loading" title={`Loading whale positions for ${symbol}…`} />;
  }

  if (query.isError) {
    return (
      <PanelState
        state="error"
        title={`Whale positions unavailable for ${symbol}`}
        description={
          query.error instanceof Error ? query.error.message : 'The whale-position request failed.'
        }
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <PanelState
        state="empty"
        title={`No tracked-whale positions for ${symbol}`}
        description="The request succeeded but no tracked trader currently holds this market. Run the trader ingestion job to populate it."
      />
    );
  }

  return (
    <div className="flex flex-col">
      {query.isFetching ? (
        <p className="px-3 py-1 text-2xs text-fg-quaternary" role="status">
          Updating…
        </p>
      ) : null}
      <TableWrap label={`Whale positions for ${symbol}`} maxHeight="420px">
        <table className="data-table">
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <Th key={column.key} align={column.align} width={column.width} title={column.title}>
                  {column.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <WhaleRow
                key={`${row.traderAddress}-${row.symbol}`}
                row={row}
                szDecimals={szDecimals}
              />
            ))}
          </tbody>
        </table>
      </TableWrap>
    </div>
  );
}

const WhaleRow = memo(function WhaleRow({
  row,
  szDecimals,
}: {
  row: PositionRow;
  szDecimals: number;
}) {
  const side = normalizeSide(row.side);
  const quantity = toNumberOrNull(row.quantity);
  const value = toNumberOrNull(row.positionValueUsd);
  const pnl = toNumberOrNull(row.unrealizedPnl);
  const leverage = toNumberOrNull(row.leverage);
  const liquidation = toNumberOrNull(row.liquidationPrice);
  const updatedAt = row.lastUpdatedAt;
  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
  const stale = Number.isFinite(updatedMs) && Date.now() - updatedMs > STALE_AFTER_MS;

  const values: Record<WhaleColumn['key'], ReactNode> = {
    trader: (
      <Link
        to="/traders/$address"
        params={{ address: row.traderAddress }}
        aria-label={`Open trader ${row.traderAddress}`}
        className="min-w-0 text-fg-secondary transition-colors hover:text-foreground"
      >
        <AddressText address={row.traderAddress} showCopy={false} />
      </Link>
    ),
    side:
      side === null ? (
        <span className="text-fg-quaternary" title={`Unrecognised side: ${row.side}`}>
          {EM_DASH}
        </span>
      ) : (
        <Badge variant={side === 'long' ? 'up' : 'down'}>
          <span aria-hidden="true">{side === 'long' ? '▲' : '▼'}</span>
          {side === 'long' ? 'LONG' : 'SHORT'}
        </Badge>
      ),
    size: quantity === null ? EM_DASH : formatQty(quantity, szDecimals),
    value: value === null ? EM_DASH : formatUsd(value),
    pnl:
      pnl === null ? (
        EM_DASH
      ) : (
        <span className={pnl >= 0 ? 'text-up' : 'text-down'}>
          {formatPnL(pnl, { compact: true })}
        </span>
      ),
    leverage: leverage === null || leverage <= 0 ? EM_DASH : `${formatNumber(leverage, 1)}×`,
    liquidation: liquidation === null || liquidation <= 0 ? EM_DASH : formatPrice(liquidation),
    updated: (
      <span
        className={cn(stale ? 'text-warning' : 'text-fg-quaternary')}
        title={updatedAt ? `${formatDateTime(updatedAt)} UTC` : 'Never updated'}
      >
        {formatRelativeTime(updatedAt)}
      </span>
    ),
  };

  return (
    <tr className={cn(stale && 'bg-warning/10')}>
      {COLUMNS.map((column) => (
        <Td key={column.key} align={column.align}>
          {values[column.key]}
        </Td>
      ))}
    </tr>
  );
});
