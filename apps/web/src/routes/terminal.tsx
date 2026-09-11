import type { FeedCandle } from '@hyperdash/shared-types';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { CandlestickChart, type ChartStatus } from '~/components/terminal/CandlestickChart';
import { OrderBook } from '~/components/terminal/OrderBook';
import { TradeFeed } from '~/components/terminal/TradeFeed';
import { WhalePositions } from '~/components/terminal/WhalePositions';
import { Badge } from '~/components/ui/badge';
import { buttonVariants } from '~/components/ui/button';
import { PageHeader } from '~/components/ui/page-header';
import { Panel, PanelHeader } from '~/components/ui/panel';
import { Segmented } from '~/components/ui/segmented';
import { StatCard, type Tone } from '~/components/ui/stat-card';
import { ErrorNotice, SkeletonBlock } from '~/components/ui/state';
import { useCoinFeed } from '~/hooks/useCoinFeed';
import { api, readJson } from '~/lib/api-client';
import {
  cn,
  EM_DASH,
  formatFundingApy,
  formatFundingRate,
  formatPrice,
  formatSignedPercent,
  formatUsd,
  toNumberOrNull,
} from '~/lib/utils';

export interface TerminalSearch {
  coin?: string;
}

export const Route = createFileRoute('/terminal')({
  // The selected market is deep-linkable, so a refresh or a shared link keeps
  // the symbol instead of silently resetting to BTC.
  validateSearch: (search: Record<string, unknown>): TerminalSearch => {
    const coin = typeof search.coin === 'string' ? search.coin.trim().toUpperCase() : '';
    return coin ? { coin } : {};
  },
  component: TerminalPage,
});

interface MetaRow {
  symbol: string;
  szDecimals: number;
  maxLeverage: number;
  markPrice: number;
  midPrice: number;
  oraclePrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
}

interface OhlcvRow {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount?: number;
}

type FeedStatus = 'connecting' | 'live' | 'offline';

const DEFAULT_COIN = 'BTC';
const CHART_BARS = 220;
const SKELETON_CHIPS = [0, 1, 2, 3, 4, 5, 6, 7];

const FEED_STATUS: Record<
  FeedStatus,
  { variant: 'neutral' | 'up' | 'warning'; label: string; dot: string }
> = {
  connecting: { variant: 'neutral', label: 'Feed connecting…', dot: 'status-dot-idle' },
  live: { variant: 'up', label: 'Feed live', dot: 'status-dot-live' },
  offline: { variant: 'warning', label: 'Feed offline · reconnecting', dot: 'status-dot-warn' },
};

function TerminalPage() {
  const { coin: coinParam } = Route.useSearch();
  const navigate = useNavigate();
  const coin = coinParam ?? DEFAULT_COIN;

  const selectorRef = useRef<HTMLDivElement | null>(null);

  const metasQuery = useQuery({
    queryKey: ['market-metas'],
    queryFn: async () =>
      readJson<{ metas: MetaRow[] }>(
        await api.market.metas.$get({ query: { limit: '60', minVolume: '5000000' } }),
        'Market list',
      ),
  });

  const metas = useMemo(() => metasQuery.data?.metas ?? [], [metasQuery.data]);
  const topCoins = useMemo(
    () => [...metas].sort((a, b) => b.volume24h - a.volume24h).slice(0, 16),
    [metas],
  );
  const meta = metas.find((row) => row.symbol === coin);

  // A deep-linked market outside the top-volume list still gets a tab, so the
  // segmented control always has a selected (and announced) tab.
  const coinItems = useMemo(() => {
    const symbols = topCoins.map((row) => row.symbol);
    const list = symbols.includes(coin) ? symbols : [coin, ...symbols];
    return list.map((symbol) => ({ value: symbol, label: symbol }));
  }, [topCoins, coin]);

  const feed = useCoinFeed(coin);

  const historyQuery = useQuery({
    queryKey: ['ohlcv', coin, '1m'],
    queryFn: async () => {
      const rows = await readJson<OhlcvRow[]>(
        await api.market.ohlcv.$get({
          query: { symbol: coin, timeframe: '1m', limit: '200' },
        }),
        `${coin} candle history`,
      );
      return rows.map((row) => {
        const start = new Date(row.timestamp).getTime();
        return {
          t: start,
          T: start + 60_000,
          s: coin,
          i: '1m',
          o: String(row.open),
          c: String(row.close),
          h: String(row.high),
          l: String(row.low),
          v: String(row.volume),
          n: row.tradeCount ?? 0,
        } satisfies FeedCandle;
      });
    },
  });

  const candles = useMemo(() => {
    const live = feed.candles;
    const liveTimes = new Set(live.map((candle) => candle.t));
    const history = (historyQuery.data ?? []).filter((candle) => !liveTimes.has(candle.t));
    return [...history, ...live].sort((a, b) => a.t - b.t).slice(-CHART_BARS);
  }, [feed.candles, historyQuery.data]);

  // Keep the active market visible: it can sit past the edge of the scrollable
  // tab strip when a deep link selects a market late in the list.
  const selectCoinTab = useCallback((node: HTMLDivElement | null) => {
    selectorRef.current = node;
    node
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  useEffect(() => {
    const active = selectorRef.current?.querySelector<HTMLElement>(
      `[id="terminal-coin-tab-${coin}"]`,
    );
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [coin]);

  const ctx = feed.ctx;
  const mark = toNumberOrNull(ctx?.midPx) ?? toNumberOrNull(ctx?.markPx);
  const prevDay = toNumberOrNull(ctx?.prevDayPx);
  const funding = toNumberOrNull(ctx?.funding);
  const openInterest = toNumberOrNull(ctx?.openInterest);
  const volume24h = toNumberOrNull(ctx?.dayNtlVlm);
  const oracle = toNumberOrNull(ctx?.oraclePx);
  const changePct =
    mark !== null && prevDay !== null && prevDay > 0 ? ((mark - prevDay) / prevDay) * 100 : null;

  const feedStatus: FeedStatus = !feed.stateLoaded
    ? 'connecting'
    : feed.connected
      ? 'live'
      : 'offline';
  const statusMeta = FEED_STATUS[feedStatus];

  const chartStatus: ChartStatus =
    historyQuery.isError && candles.length === 0
      ? 'error'
      : historyQuery.isPending && candles.length === 0
        ? 'loading'
        : 'ready';

  const stats: Array<{ label: string; value: string; tone: Tone; hint?: string }> = [
    { label: 'Mark', value: mark === null ? EM_DASH : formatPrice(mark), tone: 'neutral' },
    {
      label: '24h change',
      value: formatSignedPercent(changePct),
      tone: changePct === null ? 'neutral' : changePct >= 0 ? 'up' : 'down',
      hint: 'vs prev-day close',
    },
    {
      label: 'Funding (1h)',
      value: funding === null ? EM_DASH : formatFundingRate(funding),
      tone: funding === null ? 'neutral' : funding >= 0 ? 'up' : 'down',
      hint: funding === null ? undefined : `${formatFundingApy(funding)} APY`,
    },
    {
      label: 'Open interest',
      value: openInterest === null ? EM_DASH : formatUsd(openInterest),
      tone: 'neutral',
    },
    {
      label: '24h volume',
      value: volume24h === null ? EM_DASH : formatUsd(volume24h),
      tone: 'neutral',
    },
    {
      label: 'Oracle',
      value: oracle === null ? EM_DASH : formatPrice(oracle),
      tone: 'neutral',
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Activity className="size-5 text-fg-accent" aria-hidden="true" />
            Trading Terminal
          </span>
        }
        description="Live Hyperliquid order flow · book depth · whale positioning"
        meta={
          <Badge variant={statusMeta.variant} role="status" aria-live="polite">
            <span className={cn('status-dot', statusMeta.dot)} aria-hidden="true" />
            {statusMeta.label}
          </Badge>
        }
        actions={
          <Link to="/strategies/new" className={buttonVariants({ variant: 'primary' })}>
            Copy this market →
          </Link>
        }
      />

      <section className="mb-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="panel-title">Market</h2>
          {metasQuery.isFetching && !metasQuery.isPending ? (
            <span className="text-2xs text-fg-quaternary" role="status">
              Updating markets…
            </span>
          ) : null}
        </div>

        {metasQuery.isError ? (
          <ErrorNotice
            message={
              metasQuery.error instanceof Error
                ? metasQuery.error.message
                : 'The market list could not be loaded.'
            }
            onRetry={() => {
              void metasQuery.refetch();
            }}
          />
        ) : metasQuery.isPending ? (
          <div className="flex flex-wrap gap-1.5" role="status">
            <span className="sr-only">Loading markets…</span>
            {SKELETON_CHIPS.map((chip) => (
              <SkeletonBlock key={chip} className="h-7 w-14" />
            ))}
          </div>
        ) : (
          <div ref={selectCoinTab} className="min-w-0">
            <Segmented
              items={coinItems}
              value={coin}
              onChange={(next) => {
                void navigate({ to: '/terminal', search: { coin: next }, replace: true });
              }}
              label="Market"
              idBase="terminal-coin"
            />
          </div>
        )}

        {!metasQuery.isPending && !metasQuery.isError && topCoins.length === 0 ? (
          <p className="text-xs text-fg-quaternary">
            No markets matched the volume filter — showing {coin} only.
          </p>
        ) : null}
      </section>

      <div
        id={`terminal-coin-panel-${coin}`}
        role="tabpanel"
        aria-labelledby={`terminal-coin-tab-${coin}`}
        className="flex flex-col gap-4"
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {stats.map((stat) => (
            <StatCard
              key={stat.label}
              label={stat.label}
              tone={stat.tone}
              hint={stat.hint}
              value={
                <span className="block truncate" title={stat.value}>
                  {stat.value}
                </span>
              }
            />
          ))}
        </div>

        {/* Reading order is chart → order book/tape → whale positions at every
            width; the 12-column terminal layout only applies from lg up. */}
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 lg:grid-cols-12">
          <div className="md:col-span-2 lg:col-span-8">
            <Panel>
              <PanelHeader title={`${coin} · 1m candles`} />
              <CandlestickChart
                candles={candles}
                symbol={coin}
                timeframe="1m"
                status={chartStatus}
                errorMessage={
                  historyQuery.error instanceof Error ? historyQuery.error.message : undefined
                }
                isRefreshing={historyQuery.isFetching && !historyQuery.isPending}
                onRetry={() => {
                  void historyQuery.refetch();
                }}
              />
            </Panel>
          </div>

          <div className="md:col-span-1 lg:col-span-4">
            <Panel>
              <PanelHeader title={`Order book · ${coin}`} />
              <OrderBook
                book={feed.book}
                status={feedStatus}
                symbol={coin}
                szDecimals={meta?.szDecimals ?? 4}
              />
            </Panel>
          </div>

          <div className="md:col-span-1 lg:col-span-4">
            <Panel>
              <PanelHeader title={`Trades · ${coin}`} />
              <TradeFeed
                trades={feed.trades}
                status={feedStatus}
                szDecimals={meta?.szDecimals ?? 4}
              />
            </Panel>
          </div>

          <div className="md:col-span-2 lg:col-span-8">
            <Panel>
              <PanelHeader title={`Whale positions · ${coin}`} />
              <WhalePositions symbol={coin} szDecimals={meta?.szDecimals ?? 4} />
            </Panel>
          </div>
        </div>
      </div>

      <p className="mt-4 text-xs text-fg-quaternary">
        Data: Hyperliquid public feed via the api-gateway. Not financial advice.
      </p>
    </div>
  );
}
