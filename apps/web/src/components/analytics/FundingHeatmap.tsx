import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatFundingRate, formatTimeHms, toNumber } from '~/lib/utils';
import { HeatmapGrid, type HeatmapStatus, lastNHourBuckets } from './HeatmapGrid';

interface FundingHeatmapProps {
  /**
   * Query lifecycle supplied by the caller. When omitted the state is read
   * from this component's own query, so a failed request never falls through
   * to the "no data" copy.
   */
  status?: HeatmapStatus;
  onRetry?: () => void;
}

/** A flat window would render every cell transparent, so the scale has a floor. */
const MIN_FUNDING_SCALE = 0.0005;

export function FundingHeatmap({ status, onRetry }: FundingHeatmapProps) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['feed-hist-funding'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/funding', { hours: 24 }),
    refetchInterval: 60_000,
  });

  const model = useMemo(() => {
    const points = data ?? [];
    const buckets = lastNHourBuckets(24);
    const byCoin = new Map<string, Map<number, number>>();
    const recordedBuckets = new Set<number>();
    let maxMag = MIN_FUNDING_SCALE;
    for (const point of points) {
      const coin = String(point.coin);
      const value = toNumber(point.funding);
      let map = byCoin.get(coin);
      if (!map) {
        map = new Map();
        byCoin.set(coin, map);
      }
      const hourTs = Math.floor(point.ts / 3_600_000) * 3_600_000;
      map.set(hourTs, value);
      recordedBuckets.add(hourTs);
      const abs = Math.abs(value);
      if (abs > maxMag) maxMag = abs;
    }
    // Rows are ordered by magnitude inside HeatmapGrid so every tab agrees.
    const series = [...byCoin].map(([coin, map]) => ({
      coin,
      label: coin,
      cells: buckets.map((bucket) => ({ ts: bucket.ts, value: map.get(bucket.ts) ?? null })),
    }));
    const recorded = buckets.filter((bucket) => recordedBuckets.has(bucket.ts)).length;
    return {
      series,
      maxMag,
      columns: buckets.map((bucket) => formatTimeHms(bucket.ts).slice(0, 5)),
      note: `${recorded} of ${buckets.length} hourly buckets recorded.`,
    };
  }, [data]);

  const queryStatus: HeatmapStatus = isPending ? 'loading' : isError ? 'error' : 'empty';

  return (
    <HeatmapGrid
      title="Funding Rate Heatmap"
      describe="Hourly funding per market over the last 24h. Positive (green, +) means longs pay shorts; negative (red, −) means shorts pay longs."
      columns={model.columns}
      series={model.series}
      scale="diverging"
      maxMag={model.maxMag}
      valueLabel="funding"
      // Module-level formatters keep React.memo on HeatmapGrid effective.
      formatValue={formatFundingRate}
      status={status ?? queryStatus}
      onRetry={onRetry ?? (() => void refetch())}
      note={model.note}
    />
  );
}
