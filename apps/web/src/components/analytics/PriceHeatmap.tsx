import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatTimeHms } from '~/lib/utils';
import { diverging, HeatmapGrid, lastNHourBuckets } from './HeatmapGrid';

export function PriceHeatmap() {
  const { data } = useQuery({
    queryKey: ['feed-hist-price'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/price', { hours: 24 }),
    refetchInterval: 60_000,
  });

  const model = useMemo(() => {
    const points = data ?? [];
    const buckets = lastNHourBuckets(24);
    const byCoin = new Map<string, Map<number, number>>();
    for (const p of points) {
      const coin = String(p.coin);
      if (!byCoin.has(coin)) byCoin.set(coin, new Map());
      const hourTs = Math.floor((p.ts as number) / 3_600_000) * 3_600_000;
      byCoin.get(coin)?.set(hourTs, p.markPx as number);
    }
    const coins = [...byCoin.keys()].sort();
    const series = coins.map((coin) => {
      const map = byCoin.get(coin) ?? new Map();
      let prev: number | null = null;
      return {
        coin,
        label: coin,
        cells: buckets.map((b) => {
          const px = map.get(b.ts);
          const change = px !== undefined && prev !== null ? ((px - prev) / prev) * 100 : null;
          if (px !== undefined) prev = px;
          return {
            ts: b.ts,
            value: change,
            hint: `${coin} ${new Date(b.ts).toISOString().slice(0, 13)}:00 UTC · hourly ${change === null ? 'n/a' : `${change.toFixed(2)}%`}`,
          };
        }),
      };
    });
    return { series, cols: buckets.map((b) => b.ts) };
  }, [data]);

  return (
    <HeatmapGrid
      title="Price Heatmap"
      describe="Hourly price change (%) per market over the last 24h — green up, red down."
      columns={model.cols.map((ts) => formatTimeHms(ts))}
      series={model.series}
      color={diverging(1.5)}
    />
  );
}
