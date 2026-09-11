import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatSignedPercent, formatTimeHms, toNumber } from '~/lib/utils';
import {
  type HeatmapCell,
  HeatmapGrid,
  type HeatmapSeries,
  type HeatmapStatus,
  lastNHourBuckets,
} from './HeatmapGrid';

interface PriceHeatmapProps {
  /**
   * Query lifecycle supplied by the caller. When omitted the state is read
   * from this component's own query, so a failed request never falls through
   * to the "no data" copy.
   */
  status?: HeatmapStatus;
  onRetry?: () => void;
}

/**
 * Hourly move (%) that maps to full saturation. Named and surfaced in the
 * grid's legend so "solid green" always means the same size of move.
 */
const PRICE_SATURATION_PCT = 1.5;

export function PriceHeatmap({ status, onRetry }: PriceHeatmapProps) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['feed-hist-price'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/price', { hours: 24 }),
    refetchInterval: 60_000,
  });

  const model = useMemo(() => {
    const points = data ?? [];
    const buckets = lastNHourBuckets(24);
    const byCoin = new Map<string, Map<number, number>>();
    for (const point of points) {
      const coin = String(point.coin);
      let map = byCoin.get(coin);
      if (!map) {
        map = new Map();
        byCoin.set(coin, map);
      }
      map.set(Math.floor(point.ts / 3_600_000) * 3_600_000, toNumber(point.markPx));
    }
    // Rows are ordered by magnitude inside HeatmapGrid so every tab agrees.
    const series: HeatmapSeries[] = [];
    for (const [coin, map] of byCoin) {
      const cells: HeatmapCell[] = [];
      let prev: number | null = null;
      for (const bucket of buckets) {
        const price = map.get(bucket.ts);
        if (price === undefined) {
          cells.push({ ts: bucket.ts, value: null });
          continue;
        }
        // The first recorded hour has no baseline, so its change is unknown.
        const change = prev === null || prev === 0 ? null : ((price - prev) / prev) * 100;
        cells.push({ ts: bucket.ts, value: change });
        prev = price;
      }
      series.push({ coin, label: coin, cells });
    }
    return { series, columns: buckets.map((bucket) => formatTimeHms(bucket.ts).slice(0, 5)) };
  }, [data]);

  const queryStatus: HeatmapStatus = isPending ? 'loading' : isError ? 'error' : 'empty';

  return (
    <HeatmapGrid
      title="Price Heatmap"
      describe={`Hourly price change over the last 24h. Green (+) is up, red (−) is down, full saturation at ±${PRICE_SATURATION_PCT}%.`}
      columns={model.columns}
      series={model.series}
      scale="diverging"
      maxMag={PRICE_SATURATION_PCT}
      valueLabel="hourly change"
      // Module-level formatters keep React.memo on HeatmapGrid effective.
      formatValue={formatSignedPercent}
      status={status ?? queryStatus}
      onRetry={onRetry ?? (() => void refetch())}
    />
  );
}
