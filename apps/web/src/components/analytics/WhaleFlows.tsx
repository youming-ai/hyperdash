import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Panel, PanelHeader } from '~/components/ui/panel';
import { PanelState } from '~/components/ui/state';
import { type FeedHistoryPoint, fetchFeedHistory, fetchWhaleDiscovery } from '~/lib/feed-client';
import { cn, formatCompactNumber, formatSignedUsd, toNumber } from '~/lib/utils';

interface WhaleFlowPoint extends FeedHistoryPoint {
  netNotionalUsd: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
}

/** Below this the bar scale is meaningless, so we clamp instead of hiding bars. */
const MIN_BAR_SCALE_USD = 100_000;
/** A bar narrower than this is invisible, so keep a visible stub. */
const MIN_BAR_WIDTH_PCT = 0.6;

interface FlowRow {
  coin: string;
  buy: number;
  sell: number;
  net: number;
}

export function WhaleFlows() {
  const flows = useQuery({
    queryKey: ['feed-hist-whales'],
    queryFn: () => fetchFeedHistory<WhaleFlowPoint>('/whale-flow', { minutes: 60 }),
    refetchInterval: 30_000,
  });

  const whales = useQuery({
    queryKey: ['feed-whales'],
    queryFn: () => fetchWhaleDiscovery(),
    refetchInterval: 60_000,
  });

  const rows = useMemo<FlowRow[]>(() => {
    const map = new Map<string, FlowRow>();
    for (const point of flows.data ?? []) {
      const coin = String(point.coin);
      const row = map.get(coin) ?? { coin, buy: 0, sell: 0, net: 0 };
      row.buy += toNumber(point.buyNotionalUsd);
      row.sell += toNumber(point.sellNotionalUsd);
      row.net += toNumber(point.netNotionalUsd);
      map.set(coin, row);
    }
    return [...map.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 30);
  }, [flows.data]);

  const maxAbs = useMemo(
    () => Math.max(MIN_BAR_SCALE_USD, ...rows.map((row) => Math.abs(row.net))),
    [rows],
  );

  const tracked = whales.data?.discovered.length ?? 0;
  const topNet = rows[0];

  return (
    <Panel>
      <PanelHeader
        title="Tracked-whale taker flow · last 60 min"
        actions={
          <span className="text-2xs text-fg-quaternary">
            {whales.isPending
              ? 'checking wallets…'
              : `${tracked} wallet${tracked === 1 ? '' : 's'} tracked`}
          </span>
        }
      />

      {flows.isPending ? (
        <PanelState state="loading" title="Loading whale flow…" />
      ) : flows.isError ? (
        <PanelState
          state="error"
          title="Whale flow is unavailable"
          description={flows.error instanceof Error ? flows.error.message : undefined}
          onRetry={() => void flows.refetch()}
        />
      ) : rows.length === 0 ? (
        <PanelState
          state="empty"
          title="No whale flow in the last hour"
          description={
            tracked === 0
              ? 'No whale wallets are being tracked yet, so there is nothing to attribute.'
              : `${tracked} wallets are tracked, but none traded as a taker in the last hour.`
          }
        />
      ) : (
        <div className="p-3">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <p className="text-2xs text-fg-quaternary">
              Net USDT notional pushed by tracked whale wallets as takers, per market.
            </p>
            {topNet ? (
              <p className="shrink-0 text-2xs text-fg-quaternary">
                largest {topNet.coin} {formatSignedUsd(topNet.net)}
              </p>
            ) : null}
          </div>

          {/* Zero-centred divergence bar: sells left, buys right. */}
          <div className="mb-1 flex items-center gap-3 text-2xs uppercase tracking-[0.06em] text-fg-quaternary">
            <span className="w-12 shrink-0 sm:w-16">Market</span>
            <span className="flex-1 text-center">← net sell · net buy →</span>
            <span className="w-20 shrink-0 text-right sm:w-32">Net</span>
          </div>

          <div className="space-y-1">
            {rows.map((row) => {
              const up = row.net >= 0;
              const widthPct = Math.max(MIN_BAR_WIDTH_PCT, (Math.abs(row.net) / maxAbs) * 50);
              return (
                <div
                  key={row.coin}
                  className="flex items-center gap-3"
                  title={`${row.coin}: buy ${formatCompactNumber(row.buy)} / sell ${formatCompactNumber(row.sell)} / net ${formatSignedUsd(row.net)}`}
                >
                  <span className="w-12 shrink-0 truncate text-xs font-medium sm:w-16">
                    {row.coin}
                  </span>
                  <div className="relative h-4 flex-1 overflow-hidden rounded-sm bg-inset">
                    <span className="absolute inset-y-0 left-1/2 w-px bg-[var(--border-strong)]" />
                    <span
                      className={cn(
                        'absolute inset-y-0',
                        up ? 'left-1/2 bg-up' : 'right-1/2 bg-down',
                      )}
                      style={{ width: `${widthPct}%`, opacity: 0.7 }}
                    />
                  </div>
                  <span
                    className={cn(
                      'num w-20 shrink-0 text-right text-xs sm:w-32',
                      up ? 'text-up' : 'text-down',
                    )}
                  >
                    {formatSignedUsd(row.net)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}
