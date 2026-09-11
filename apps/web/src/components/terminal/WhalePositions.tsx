import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';
import { formatNumber, formatTimeHms, formatUsd, shortenAddress } from '~/lib/utils';

interface WhalePositionsProps {
  symbol: string;
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

/**
 * Top open positions across ingested whale traders for a symbol — "who is
 * positioned here, and how much".
 */
export function WhalePositions({ symbol }: WhalePositionsProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['market-positions', symbol],
    queryFn: async () => {
      const res = await api.market.positions.$get({ query: { symbol, limit: '8' } });
      if (!res.ok) return { positions: [] as PositionRow[] };
      const body = (await res.json()) as unknown;
      return body as { positions: PositionRow[] };
    },
  });

  const rows = data?.positions ?? [];

  if (isLoading) {
    return <div className="p-6 text-center text-sm opacity-50">Loading whale positions…</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="p-6 text-center text-sm opacity-50">
        No tracked-whale positions for {symbol} yet — run the trader ingestion job to populate.
      </div>
    );
  }

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between px-3 pb-1 pt-2 text-xs opacity-60">
        <span>Trader</span>
        <span>Side</span>
        <span>Size</span>
        <span>Value</span>
        <span>PnL</span>
      </div>
      <div className="space-y-px">
        {rows.map((row) => {
          const side = row.side.toLowerCase();
          const long = side === 'long';
          const value = parseFloat(row.positionValueUsd);
          const pnl = parseFloat(row.unrealizedPnl);
          return (
            <div
              key={`${row.traderAddress}-${row.symbol}`}
              className="flex items-center justify-between px-3 py-[3px] font-mono text-xs"
            >
              <span className="opacity-80 max-w-[110px] truncate" title={row.traderAddress}>
                {shortenAddress(row.traderAddress)}
              </span>
              <span className={long ? 'text-success' : 'text-destructive'}>
                {long ? 'LONG' : 'SHORT'} {formatNumber(parseFloat(row.quantity))}
              </span>
              <span className="opacity-70">{formatUsd(value)}</span>
              <span className={pnl >= 0 ? 'text-success' : 'text-destructive'}>
                {pnl >= 0 ? '+' : ''}
                {formatUsd(pnl)}
              </span>
              <span className="opacity-40" title={row.lastUpdatedAt ?? undefined}>
                {row.lastUpdatedAt ? formatTimeHms(new Date(row.lastUpdatedAt).getTime()) : '-'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
