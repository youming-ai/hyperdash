import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatTimeHms } from '~/lib/utils';
import { diverging, HeatmapGrid, lastNHourBuckets } from './HeatmapGrid';

export function FundingHeatmap() {
  const { data } = useQuery({
    queryKey: ['feed-hist-funding'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/funding', { hours: 24 }),
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
      byCoin.get(coin)?.set(hourTs, p.funding as number);
    }
    const coins = [...byCoin.keys()].sort((a, b) => {
      const la = byCoin.get(a);
      const lb = byCoin.get(b);
      return (
        Math.abs(lb?.get(buckets[buckets.length - 1]?.ts ?? 0) ?? 0) -
        Math.abs(la?.get(buckets[buckets.length - 1]?.ts ?? 0) ?? 0)
      );
    });
    const maxMag = Math.max(0.0005, ...points.map((p) => Math.abs(p.funding as number)));
    const series = coins.map((coin) => {
      const map = byCoin.get(coin) ?? new Map();
      return {
        coin,
        label: coin,
        cells: buckets.map((b) => ({
          ts: b.ts,
          value: map.get(b.ts) ?? null,
          hint: `${coin} funding ${new Date(b.ts).toISOString().slice(0, 13)}:00 UTC · ${map.get(b.ts) === undefined ? 'n/a' : `${(Number(map.get(b.ts)) * 100).toFixed(4)}%`}`,
        })),
      };
    });
    return { series, maxMag, cols: buckets.map((b) => b.ts) };
  }, [data]);

  return (
    <HeatmapGrid
      title="Funding Rate Heatmap"
      describe="Hourly funding per market over the last 24h (green positive — longs pay; red negative)."
      columns={model.cols.map((ts) => formatTimeHms(ts))}
      series={model.series}
      color={diverging(model.maxMag)}
      legendNote="Live funding data accumulates from the feed recorder; cells appear as hours are recorded."
    />
  );
}
