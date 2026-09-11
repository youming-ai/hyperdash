import type { FeedCandle } from '@hyperdash/shared-types';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Activity, BookOpen, Radio } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CandlestickChart } from '~/components/terminal/CandlestickChart';
import { OrderBook } from '~/components/terminal/OrderBook';
import { TradeFeed } from '~/components/terminal/TradeFeed';
import { WhalePositions } from '~/components/terminal/WhalePositions';
import { useCoinFeed } from '~/hooks/useCoinFeed';
import { api } from '~/lib/api-client';
import { FEED_REST_BASE } from '~/lib/feed-client';
import { formatNumber, formatUsd } from '~/lib/utils';

export const Route = createFileRoute('/terminal')({
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

const DEFAULT_COIN = 'BTC';

function TerminalPage() {
  const [selected, setSelected] = useState(DEFAULT_COIN);

  const { data: metasData } = useQuery({
    queryKey: ['market-metas'],
    queryFn: async () => {
      const res = await api.market.metas.$get({ query: { limit: '60', minVolume: '5000000' } });
      if (!res.ok) return { metas: [] as MetaRow[] };
      return res.json() as Promise<{ metas: MetaRow[] }>;
    },
  });

  const topCoins = useMemo(() => {
    const metas = metasData?.metas ?? [];
    return [...metas].sort((a, b) => b.volume24h - a.volume24h).slice(0, 16);
  }, [metasData]);

  const coin = selected;
  const feed = useCoinFeed(coin);
  const metas = metasData?.metas ?? [];
  const meta = metas.find((m) => m.symbol === coin);

  // Backfill candle history over REST, then merge live feed updates on top.
  const { data: historyCandles } = useQuery({
    queryKey: ['ohlcv', coin, '1m'],
    queryFn: async () => {
      const res = await api.market.ohlcv.$get({
        query: { symbol: coin, timeframe: '1m', limit: '200' },
      });
      if (!res.ok) return [] as FeedCandle[];
      const rows = (await res.json()) as Array<{
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        tradeCount?: number;
      }>;
      return rows.map((r) => ({
        t: new Date(r.timestamp).getTime(),
        T: new Date(r.timestamp).getTime() + 60_000,
        s: coin,
        i: '1m',
        o: String(r.open),
        c: String(r.close),
        h: String(r.high),
        l: String(r.low),
        v: String(r.volume),
        n: r.tradeCount ?? 0,
      }));
    },
  });

  const candles = useMemo(() => {
    const live = feed.candles;
    const liveTimes = new Set(live.map((c) => c.t));
    const history = (historyCandles ?? []).filter((c) => !liveTimes.has(c.t));
    return [...history, ...live].sort((a, b) => a.t - b.t).slice(-220);
  }, [feed.candles, historyCandles]);

  const ctx = feed.ctx;
  const funding = ctx ? parseFloat(ctx.funding) : 0;
  const oi = ctx ? parseFloat(ctx.openInterest) : 0;
  const vol24h = ctx ? parseFloat(ctx.dayNtlVlm) : 0;
  const prevDay = ctx ? parseFloat(ctx.prevDayPx) : 0;
  const mark = ctx ? parseFloat(ctx.midPx ?? ctx.markPx) : 0;
  const changePct = prevDay > 0 && mark > 0 ? ((mark - prevDay) / prevDay) * 100 : 0;
  // funding is hourly; annualize: (1+r)^(24*365) - 1
  const fundingApy = funding !== 0 ? Math.min((1 + funding) ** (24 * 365) - 1, 999) : 0;

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="w-5 h-5" /> Trading Terminal
          </h1>
          <p className="text-sm opacity-60 mt-0.5">
            Live Hyperliquid order flow · book depth · whale positioning
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className={`badge ${feed.connected ? 'badge-up' : 'badge-neutral'}`}>
            <Radio className="h-3 w-3" />
            {feed.connected ? 'Feed live' : 'Feed reconnecting…'}
          </span>
          <Link
            to="/strategies/new"
            className="px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-primary-foreground font-medium hover:opacity-90"
          >
            Copy this market →
          </Link>
        </div>
      </div>

      {/* Coin selector */}
      <div className="dock mb-4 w-fit">
        {topCoins.map((c) => (
          <button
            key={c.symbol}
            type="button"
            onClick={() => setSelected(c.symbol)}
            className="dock-tab dock-tab-accent num"
            data-active={c.symbol === coin}
          >
            {c.symbol}
          </button>
        ))}
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <Stat label="Mark" value={mark > 0 ? formatNumber(mark) : '-'} accent={changePct >= 0} />
        <Stat
          label="24h"
          value={`${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`}
          accent={changePct >= 0}
          bare={!ctx}
        />
        <Stat
          label="Funding"
          value={ctx ? `${(funding * 100).toFixed(4)}%` : '-'}
          hint={funding !== 0 ? `${(fundingApy * 100).toFixed(1)}% APY` : undefined}
          accent={funding >= 0}
        />
        <Stat label="Open Interest" value={ctx ? formatUsd(oi) : '-'} />
        <Stat label="24h Volume" value={ctx ? formatUsd(vol24h) : '-'} />
        <Stat label="Oracle" value={ctx && meta ? formatNumber(meta.oraclePrice) : '-'} />
      </div>

      {/* Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-3 space-y-4">
          <Panel title={`Orderbook · ${coin}`} badge={<BookOpen className="w-3.5 h-3.5" />}>
            <OrderBook book={feed.book} />
          </Panel>
          <Panel title={`Whale Positions · ${coin}`}>
            <WhalePositions symbol={coin} />
          </Panel>
        </div>

        <div className="lg:col-span-6">
          <Panel title={`${coin} · 1m`}>
            <CandlestickChart candles={candles} />
          </Panel>
        </div>

        <div className="lg:col-span-3">
          <Panel title={`Trades · ${coin}`}>
            <TradeFeed trades={feed.trades} />
          </Panel>
        </div>
      </div>

      <p className="mt-4 text-xs opacity-40">
        Data: Hyperliquid public feed via api-gateway{FEED_REST_BASE ? ` (${FEED_REST_BASE})` : ''}.
        Not financial advice.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
  bare,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  bare?: boolean;
}) {
  return (
    <div className="panel p-3">
      <div className="text-xs opacity-60 mb-0.5">{label}</div>
      <div
        className={`text-lg font-mono font-semibold ${
          bare !== true
            ? accent === true
              ? 'text-success'
              : accent === false
                ? 'text-destructive'
                : ''
            : ''
        }`}
      >
        {value}
      </div>
      {hint ? <div className="text-[11px] opacity-50">{hint}</div> : null}
    </div>
  );
}

function Panel({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 panel-header text-xs uppercase tracking-wide opacity-70">
        {badge}
        {title}
      </div>
      {children}
    </div>
  );
}
