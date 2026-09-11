import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight, BarChart3, Crosshair, Users } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Badge } from '~/components/ui/badge';
import { buttonVariants } from '~/components/ui/button';
import { PageHeader } from '~/components/ui/page-header';
import { Panel, PanelHeader } from '~/components/ui/panel';
import { StatCard, StatGrid } from '~/components/ui/stat-card';
import { PanelState } from '~/components/ui/state';
import { type SortOrder, TableWrap, Td, Th } from '~/components/ui/table';
import { api, readJson } from '~/lib/api-client';
import {
  cn,
  formatFundingRate,
  formatPercent,
  formatPrice,
  formatUsd,
  toNumber,
} from '~/lib/utils';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

interface MarketMeta {
  symbol: string;
  markPrice: number;
  fundingRate: number;
  volume24h: number;
  prevDayPx: number;
}

interface TraderRow {
  address: string;
  pnl7d?: string | number | null;
  winrate?: string | number | null;
  equityUsd?: string | number | null;
}

type MarketSort = 'volume24h' | 'symbol' | 'markPrice' | 'change';

function changePct(market: MarketMeta): number {
  const prev = toNumber(market.prevDayPx);
  if (prev <= 0) return Number.NaN;
  return ((toNumber(market.markPrice) - prev) / prev) * 100;
}

/** Overview — the market dashboard that replaced the old marketing landing page. */
function OverviewPage() {
  const [sortBy, setSortBy] = useState<MarketSort>('volume24h');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const markets = useQuery({
    queryKey: ['overview-markets'],
    queryFn: async () =>
      readJson<{ metas: MarketMeta[] }>(
        await api.market.metas.$get({ query: { limit: '200' } }),
        'Market list',
      ),
    refetchInterval: 30_000,
  });

  const traders = useQuery({
    queryKey: ['overview-traders'],
    queryFn: async () =>
      readJson<{ traders: TraderRow[] }>(
        await api.traders.$get({
          query: {
            limit: '5',
            sortBy: 'pnl',
            sortOrder: 'desc',
            timeframe: '7d',
            isActive: 'false',
          },
        }),
        'Top traders',
      ),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    const list = markets.data?.metas ?? [];
    const sorted = [...list].sort((a, b) => {
      let delta: number;
      if (sortBy === 'symbol') delta = a.symbol.localeCompare(b.symbol);
      else if (sortBy === 'markPrice') delta = toNumber(a.markPrice) - toNumber(b.markPrice);
      else if (sortBy === 'change') delta = changePct(a) - changePct(b);
      else delta = toNumber(a.volume24h) - toNumber(b.volume24h);
      return sortOrder === 'asc' ? delta : -delta;
    });
    return sorted;
  }, [markets.data, sortBy, sortOrder]);

  const summary = useMemo(() => {
    const list = markets.data?.metas ?? [];
    let volume = 0;
    let advancers = 0;
    let decliners = 0;
    let best: MarketMeta | null = null;
    let bestChange = Number.NEGATIVE_INFINITY;
    for (const market of list) {
      volume += toNumber(market.volume24h);
      const change = changePct(market);
      if (!Number.isFinite(change)) continue;
      if (change >= 0) advancers += 1;
      else decliners += 1;
      if (change > bestChange) {
        bestChange = change;
        best = market;
      }
    }
    return { volume, advancers, decliners, best, bestChange, count: list.length };
  }, [markets.data]);

  function toggleSort(next: MarketSort) {
    if (sortBy === next) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortBy(next);
    setSortOrder(next === 'symbol' ? 'asc' : 'desc');
  }

  const visible = rows.slice(0, 25);

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Live Hyperliquid markets, tracked traders and copy strategies at a glance."
        actions={
          <Link to="/terminal" className={cn(buttonVariants({ variant: 'primary' }))}>
            <Crosshair aria-hidden="true" />
            Open terminal
          </Link>
        }
      />

      <StatGrid cols={4} className="mb-3">
        <StatCard
          label="24h volume"
          value={markets.isPending ? '—' : formatUsd(summary.volume)}
          hint="Across all tracked markets"
        />
        <StatCard
          label="Markets"
          value={markets.isPending ? '—' : summary.count}
          hint="Listed on Hyperliquid"
        />
        <StatCard
          label="Advancing"
          value={markets.isPending ? '—' : `${summary.advancers}`}
          hint={markets.isPending ? undefined : `${summary.decliners} declining over 24h`}
          tone={markets.isPending ? 'neutral' : 'up'}
        />
        <StatCard
          label="Top mover"
          value={markets.isPending || !summary.best ? '—' : (summary.best.symbol ?? '—')}
          hint={
            markets.isPending || !Number.isFinite(summary.bestChange)
              ? undefined
              : formatPercent(summary.bestChange, 2)
          }
          tone={
            markets.isPending || !Number.isFinite(summary.bestChange)
              ? 'neutral'
              : summary.bestChange >= 0
                ? 'up'
                : 'down'
          }
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader
            title="Markets"
            actions={
              <span className="text-2xs text-fg-quaternary">
                {markets.isPending ? 'loading' : `${visible.length} of ${rows.length} by volume`}
              </span>
            }
          />
          {markets.isPending ? (
            <PanelState state="loading" title="Loading markets…" />
          ) : markets.isError ? (
            <PanelState
              state="error"
              title="Could not load market data"
              description={markets.error instanceof Error ? markets.error.message : undefined}
              onRetry={() => void markets.refetch()}
            />
          ) : rows.length === 0 ? (
            <PanelState
              state="empty"
              title="No markets returned"
              description="The exchange metadata endpoint responded without any listed markets."
            />
          ) : (
            <TableWrap label="Hyperliquid markets by 24h volume" maxHeight="60vh">
              <table className="data-table">
                <thead>
                  <tr>
                    <Th
                      sortable
                      active={sortBy === 'symbol'}
                      order={sortOrder}
                      onSort={() => toggleSort('symbol')}
                    >
                      Market
                    </Th>
                    <Th
                      align="right"
                      sortable
                      active={sortBy === 'markPrice'}
                      order={sortOrder}
                      onSort={() => toggleSort('markPrice')}
                    >
                      Mark
                    </Th>
                    <Th
                      align="right"
                      sortable
                      active={sortBy === 'change'}
                      order={sortOrder}
                      onSort={() => toggleSort('change')}
                      title="Change in mark price over the last 24 hours"
                    >
                      24h
                    </Th>
                    <Th align="right" title="Hourly funding rate">
                      Funding
                    </Th>
                    <Th
                      align="right"
                      sortable
                      active={sortBy === 'volume24h'}
                      order={sortOrder}
                      onSort={() => toggleSort('volume24h')}
                    >
                      Volume
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((market) => {
                    const change = changePct(market);
                    const hasChange = Number.isFinite(change);
                    return (
                      <tr key={market.symbol}>
                        <Td>
                          <Link
                            to="/terminal"
                            search={{ coin: market.symbol }}
                            className="font-medium hover:text-fg-accent"
                          >
                            {market.symbol}
                          </Link>
                        </Td>
                        <Td align="right">{formatPrice(toNumber(market.markPrice))}</Td>
                        <Td
                          align="right"
                          className={
                            hasChange
                              ? change >= 0
                                ? 'text-up'
                                : 'text-down'
                              : 'text-fg-quaternary'
                          }
                        >
                          {hasChange ? formatPercent(change, 2) : '—'}
                        </Td>
                        <Td align="right" className="text-fg-tertiary">
                          {formatFundingRate(market.fundingRate)}
                        </Td>
                        <Td align="right" className="text-fg-secondary">
                          {formatUsd(toNumber(market.volume24h))}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Panel>

        <div className="flex flex-col gap-3">
          <Panel>
            <PanelHeader
              title="Top traders · 7d"
              actions={
                <Link
                  to="/traders"
                  className="-my-1.5 inline-flex min-h-7 items-center rounded-sm px-1 -mr-1 text-2xs text-fg-accent hover:underline"
                >
                  View all
                </Link>
              }
            />
            {traders.isPending ? (
              <PanelState state="loading" title="Loading traders…" />
            ) : traders.isError ? (
              <PanelState
                state="error"
                title="Could not load traders"
                description={traders.error instanceof Error ? traders.error.message : undefined}
                onRetry={() => void traders.refetch()}
              />
            ) : (traders.data?.traders.length ?? 0) === 0 ? (
              <PanelState
                state="empty"
                title="No traders tracked yet"
                description="Traders are discovered automatically from live Hyperliquid volume."
              />
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {(traders.data?.traders ?? []).map((trader) => {
                  const pnl = toNumber(trader.pnl7d);
                  return (
                    <li key={trader.address}>
                      <Link
                        to="/traders/$address"
                        params={{ address: trader.address }}
                        className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-raised"
                      >
                        <span className="min-w-0">
                          <span className="num block truncate text-sm">
                            {trader.address.slice(0, 6)}…{trader.address.slice(-4)}
                          </span>
                          <span className="text-2xs text-fg-quaternary">
                            win {formatPercent(trader.winrate)}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span
                            className={cn('num block text-sm', pnl >= 0 ? 'text-up' : 'text-down')}
                          >
                            {formatUsd(Math.abs(pnl))}
                          </span>
                          <span className="text-2xs text-fg-quaternary">
                            {formatUsd(toNumber(trader.equityUsd))} equity
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Jump to" />
            <div className="divide-y divide-[var(--border)]">
              <QuickLink
                to="/analytics"
                icon={<BarChart3 className="size-4" aria-hidden="true" />}
                title="Analytics"
                description="Open interest, funding and stress heatmaps"
              />
              <QuickLink
                to="/traders"
                icon={<Users className="size-4" aria-hidden="true" />}
                title="Traders"
                description="Leaderboard with win rate, Sharpe and drawdown"
              />
              <QuickLink
                to="/strategies"
                icon={<Crosshair className="size-4" aria-hidden="true" />}
                title="Strategies"
                description="Automated copy trading with risk controls"
              />
            </div>
          </Panel>

          <Panel className="p-3">
            <div className="flex items-start gap-2">
              <Badge variant="accent">Beta</Badge>
              <p className="text-2xs leading-relaxed text-fg-tertiary">
                Market data is read from the public Hyperliquid API and may be delayed. Nothing here
                is financial advice.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function QuickLink({
  to,
  icon,
  title,
  description,
}: {
  to: '/analytics' | '/traders' | '/strategies';
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="group flex items-center gap-3 px-3 py-2 hover:bg-raised">
      <span className="text-fg-quaternary [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-2xs text-fg-quaternary">{description}</span>
      </span>
      <ArrowRight
        className="size-3.5 shrink-0 text-fg-quaternary transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  );
}
