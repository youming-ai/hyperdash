import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatNumber, formatTimeHms, toNumber } from '~/lib/utils';
import { HeatmapGrid, type HeatmapStatus } from './HeatmapGrid';

interface StressHeatmapProps {
  /**
   * Query lifecycle supplied by the caller. When omitted the state is read
   * from this component's own query, so a failed request never falls through
   * to the "no data" copy.
   */
  status?: HeatmapStatus;
  onRetry?: () => void;
}

interface StressPoint extends FeedHistoryPoint {
  trades: number;
  notionalUsd: number;
  maxJumpPct: number;
  spikeScore: number;
}

/** One-minute buckets in the window — the same number the query asks for. */
const STRESS_BUCKETS = 30;
/** Spike score that maps to full saturation on the one-sided ramp. */
const SCORE_SATURATION = 10;

/** Module-level so React.memo on HeatmapGrid can skip renders. */
const formatScore = (value: number) => formatNumber(value, 1);

export function StressHeatmap({ status, onRetry }: StressHeatmapProps) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['feed-hist-stress'],
    queryFn: () => fetchFeedHistory<StressPoint>('/stress', { minutes: STRESS_BUCKETS }),
    refetchInterval: 30_000,
  });

  const model = useMemo(() => {
    const points = data ?? [];
    const minutes = Math.floor(Date.now() / 60_000) * 60_000;
    const buckets: number[] = [];
    for (let m = STRESS_BUCKETS - 1; m >= 0; m--) buckets.push(minutes - m * 60_000);
    const byCoin = new Map<string, Map<number, number>>();
    for (const point of points) {
      const coin = String(point.coin);
      let map = byCoin.get(coin);
      if (!map) {
        map = new Map();
        byCoin.set(coin, map);
      }
      map.set(point.ts, toNumber(point.spikeScore));
    }
    // All-null rows are dropped and rows are ordered by peak inside HeatmapGrid.
    const series = [...byCoin].map(([coin, map]) => ({
      coin,
      label: coin,
      cells: buckets.map((bucket) => ({ ts: bucket, value: map.get(bucket) ?? null })),
    }));
    return { series, columns: buckets.map((bucket) => formatTimeHms(bucket).slice(0, 5)) };
  }, [data]);

  const queryStatus: HeatmapStatus = isPending ? 'loading' : isError ? 'error' : 'empty';

  return (
    <HeatmapGrid
      title="Stress Heatmap (liquidation-like events, approximate)"
      describe="Per-minute volatility and volume spikes over the last 30 minutes. Hyperliquid publishes no liquidation feed, so this approximates cascades from abnormal volume against a 5-minute baseline plus the largest price jump in the minute."
      columns={model.columns}
      series={model.series}
      scale="ramp"
      maxScore={SCORE_SATURATION}
      valueLabel="spike score"
      formatValue={formatScore}
      status={status ?? queryStatus}
      onRetry={onRetry ?? (() => void refetch())}
      emptyLabel="No stress events in the last 30 minutes."
    />
  );
}
