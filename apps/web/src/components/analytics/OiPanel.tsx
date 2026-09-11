import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '~/lib/api-client';
import { type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatNumber, formatUsd } from '~/lib/utils';

interface MetaRow {
  symbol: string;
  markPrice: number;
  oraclePrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
  prevDayPx: number;
}

export function OiPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics-metas'],
    queryFn: async () => {
      const res = await api.market.metas.$get({ query: { limit: '200' } });
      if (!res.ok) return { metas: [] as MetaRow[] };
      return res.json() as Promise<{ metas: MetaRow[] }>;
    },
    refetchInterval: 30_000,
  });

  const { data: oiHistory } = useQuery({
    queryKey: ['feed-hist-oi'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/oi', { hours: 24 }),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    const metas = [...(data?.metas ?? [])].sort((a, b) => b.openInterest - a.openInterest);
    const oiFirstByCoin = new Map<string, number>();
    const oiByCoin = new Map<string, Array<{ ts: number; oi: number }>>();
    for (const point of oiHistory ?? []) {
      const coin = String(point.coin);
      if (!oiByCoin.has(coin)) oiByCoin.set(coin, []);
      oiByCoin.get(coin)?.push({ ts: point.ts as number, oi: point.openInterest as number });
    }
    for (const [coin, list] of oiByCoin) {
      list.sort((a, b) => a.ts - b.ts);
      oiFirstByCoin.set(coin, list[0]?.oi ?? 0);
    }
    return metas.map((m) => {
      const first = oiFirstByCoin.get(m.symbol);
      const change =
        first !== undefined && first > 0 ? ((m.openInterest - first) / first) * 100 : null;
      return { ...m, oiChangePct: change };
    });
  }, [data, oiHistory]);

  if (isLoading) return <div className="p-10 text-center opacity-50">Loading open interest…</div>;

  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 panel-header text-xs uppercase tracking-wide opacity-70">
        Top {rows.length} markets by open interest
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Coin</th>
              <th className="num-col">Mark</th>
              <th className="num-col">Funding</th>
              <th className="num-col">Open Interest</th>
              <th className="num-col">OI 24h</th>
              <th className="num-col">24h Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 60).map((m) => (
              <tr key={m.symbol}>
                <td className="num">{m.symbol}</td>
                <td className="num-col text-success">{formatNumber(m.markPrice)}</td>
                <td
                  className={`num-col ${m.fundingRate > 0 ? 'text-success' : 'text-destructive'}`}
                >
                  {(m.fundingRate * 100).toFixed(4)}%
                </td>
                <td className="num-col">{formatUsd(m.openInterest)}</td>
                <td
                  className={`num-col ${m.oiChangePct === null ? 'opacity-40' : m.oiChangePct >= 0 ? 'text-success' : 'text-destructive'}`}
                >
                  {m.oiChangePct === null
                    ? '-'
                    : `${m.oiChangePct >= 0 ? '+' : ''}${m.oiChangePct.toFixed(1)}%`}
                </td>
                <td className="num-col opacity-80">{formatUsd(m.volume24h)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
