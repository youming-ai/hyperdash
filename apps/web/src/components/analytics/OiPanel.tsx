import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import {
  ErrorNotice,
  Panel,
  PanelHeader,
  PanelState,
  SkeletonRows,
  type SortOrder,
  TableWrap,
  Td,
  Th,
} from '~/components/ui';
import { api } from '~/lib/api-client';
import { type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import {
  EM_DASH,
  formatFundingRate,
  formatNumber,
  formatSignedPercent,
  formatUsd,
  toNumber,
} from '~/lib/utils';

interface MetaRow {
  symbol: string;
  markPrice: number;
  oraclePrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
  prevDayPx: number;
}

interface RankedMeta extends MetaRow {
  /** openInterest arrives in coin units; this is the USD notional it represents. */
  notional: number;
  oiChangePct: number | null;
}

/** The table renders exactly this many rows, and the header counts the same number. */
const VISIBLE_ROWS = 60;

export function OiPanel() {
  const [order, setOrder] = useState<SortOrder>('desc');

  const { data, isPending, isError, isFetching, refetch } = useQuery({
    queryKey: ['analytics-metas'],
    queryFn: async () => {
      const res = await api.market.metas.$get({ query: { limit: '200' } });
      // Throwing is what makes `isError` reachable; returning [] would render
      // an outage as "no markets".
      if (!res.ok) throw new Error(`Market metadata failed with HTTP ${res.status}.`);
      return res.json() as Promise<{ metas: MetaRow[] }>;
    },
    refetchInterval: 30_000,
  });

  const {
    data: oiHistory,
    isError: isOiHistoryError,
    refetch: refetchOiHistory,
  } = useQuery({
    queryKey: ['feed-hist-oi'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/oi', { hours: 24 }),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    const firstOiByCoin = new Map<string, { ts: number; oi: number }>();
    for (const point of oiHistory ?? []) {
      const coin = String(point.coin);
      const ts = toNumber(point.ts);
      const seen = firstOiByCoin.get(coin);
      if (seen === undefined || ts < seen.ts) {
        firstOiByCoin.set(coin, { ts, oi: toNumber(point.openInterest) });
      }
    }
    const ranked: RankedMeta[] = (data?.metas ?? []).map((meta) => {
      const notional = toNumber(meta.openInterest) * toNumber(meta.markPrice);
      const first = firstOiByCoin.get(meta.symbol);
      // Both sides are coin units, so the ratio is price-independent.
      const oiChangePct =
        first !== undefined && first.oi > 0
          ? ((toNumber(meta.openInterest) - first.oi) / first.oi) * 100
          : null;
      return { ...meta, notional, oiChangePct };
    });
    ranked.sort((a, b) => (order === 'desc' ? b.notional - a.notional : a.notional - b.notional));
    return ranked;
  }, [data, oiHistory, order]);

  if (isPending) {
    return (
      <Panel>
        <PanelHeader title="Markets by open interest" />
        <SkeletonRows rows={8} />
      </Panel>
    );
  }

  if (isError) {
    return (
      <Panel>
        <PanelHeader title="Markets by open interest" />
        <PanelState
          state="error"
          title="Could not load market metadata"
          description="The market API did not respond. Check your connection and try again."
          onRetry={() => void refetch()}
        />
      </Panel>
    );
  }

  const visible = rows.slice(0, VISIBLE_ROWS);

  return (
    <Panel>
      <PanelHeader
        title={`Top ${visible.length} markets by open interest`}
        actions={isFetching ? <span className="text-2xs text-fg-quaternary">updating…</span> : null}
      />
      {isOiHistoryError ? (
        <ErrorNotice
          className="mx-3 mt-3"
          message="24h open-interest history is unavailable, so the OI 24h column is blank."
          onRetry={() => void refetchOiHistory()}
        />
      ) : null}
      {visible.length === 0 ? (
        <PanelState state="empty" title="No markets returned." />
      ) : (
        <TableWrap label="Markets ranked by open-interest notional">
          <table className="data-table">
            <caption className="sr-only">
              Markets ranked by open-interest notional, with mark price, hourly funding, 24h
              open-interest change and 24h volume.
            </caption>
            <thead>
              <tr>
                <Th>Coin</Th>
                <Th align="right">Mark price</Th>
                <Th align="right" title="Positive: longs pay shorts. Negative: shorts pay longs.">
                  Funding
                </Th>
                <Th
                  align="right"
                  sortable
                  active
                  order={order}
                  onSort={() => setOrder((current) => (current === 'desc' ? 'asc' : 'desc'))}
                  title="Open interest as USD notional (coin units × mark price)"
                >
                  Open interest
                </Th>
                <Th align="right" title="Change in open interest over the last 24 hours">
                  OI 24h
                </Th>
                <Th align="right">24h volume</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((meta) => {
                const fundingTone =
                  meta.fundingRate > 0
                    ? 'text-up'
                    : meta.fundingRate < 0
                      ? 'text-down'
                      : 'text-fg-tertiary';
                const changeTone =
                  meta.oiChangePct === null
                    ? 'text-fg-quaternary'
                    : meta.oiChangePct >= 0
                      ? 'text-up'
                      : 'text-down';
                return (
                  <tr key={meta.symbol}>
                    <th
                      scope="row"
                      // `.data-table th` sticks every `th` to the top, but a row
                      // header must only stick to the left.
                      style={{ top: 'auto' }}
                      className="sticky-col"
                    >
                      {meta.symbol}
                    </th>
                    <Td align="right">{formatNumber(meta.markPrice)}</Td>
                    <Td align="right" className={fundingTone}>
                      {formatFundingRate(meta.fundingRate)}
                    </Td>
                    <Td align="right">{formatUsd(meta.notional)}</Td>
                    <Td
                      align="right"
                      className={changeTone}
                      title={meta.oiChangePct === null ? 'no 24h history' : undefined}
                    >
                      {meta.oiChangePct === null
                        ? EM_DASH
                        : formatSignedPercent(meta.oiChangePct, 1)}
                    </Td>
                    <Td align="right">{formatUsd(meta.volume24h)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Panel>
  );
}
