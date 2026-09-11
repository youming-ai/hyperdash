import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatTimeHms } from '~/lib/utils';
import { HeatmapGrid } from './HeatmapGrid';

interface StressPoint extends FeedHistoryPoint {
  trades: number;
  notionalUsd: number;
  maxJumpPct: number;
  spikeScore: number;
}

export function StressHeatmap() {
  const { data } = useQuery({
    queryKey: ['feed-hist-stress'],
    queryFn: () => fetchFeedHistory<StressPoint>('/stress', { minutes: 180 }),
    refetchInterval: 30_000,
  });

  const model = useMemo(() => {
    const points = data ?? [];
    const buckets: Array<{ ts: number }> = [];
    for (let m = 29; m >= 0; m--)
      buckets.push({ ts: Math.floor(Date.now() / 60_000) * 60_000 - m * 60_000 });
    const byCoin = new Map<string, Map<number, number>>();
    for (const p of points) {
      const coin = String(p.coin);
      if (!byCoin.has(coin)) byCoin.set(coin, new Map());
      byCoin.get(coin)?.set(p.ts as number, p.spikeScore as number);
    }
    const coins = [...byCoin.keys()].sort((a, b) => {
      const la = byCoin.get(a);
      const lb = byCoin.get(b);
      const ma = la ? Math.max(...la.values()) : 0;
      const mb = lb ? Math.max(...lb.values()) : 0;
      return mb - ma;
    });
    const series = coins.map((coin) => {
      const map = byCoin.get(coin) ?? new Map();
      return {
        coin,
        label: coin,
        cells: buckets.map((b) => {
          const score = map.get(b.ts) ?? null;
          return {
            ts: b.ts,
            value: score,
            hint: `${coin} ${formatTimeHms(b.ts)} UTC · spike score ${score ?? 'n/a'}`,
          };
        }),
      };
    });
    return { series };
  }, [data]);

  return (
    <HeatmapGrid
      title="Stress Heatmap (liquidation-like events, approximate)"
      describe="Per-minute volatility/volume spikes over the last 30 minutes. Hyperliquid exposes no public liquidation feed, so this approximates liquidation cascades via abnormal volume + price-jump bursts."
      series={model.series}
      color={(value) => `hsl(var(--destructive) / ${Math.min(0.95, 0.25 + value / 10).toFixed(2)})`}
      emptyLabel="No stress events recorded yet — watch a volatile market or wait for the recorder."
      legendNote="Approximation: score reflects volume vs 5-min baseline and max per-minute price move. Not an official liquidation feed."
    />
  );
}
