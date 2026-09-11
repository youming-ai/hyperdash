import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Activity, ArrowRight, BarChart3, Crosshair, Users, Zap } from 'lucide-react';
import { api } from '~/lib/api-client';
import { formatCompactNumber } from '~/lib/utils';

export const Route = createFileRoute('/')({
  component: HomePage,
});

interface MetaRow {
  symbol: string;
  markPrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
  prevDayPx: number;
}

/** Live market strip — polls /api/market/metas, sorted by volume. */
function MarketStrip() {
  const { data } = useQuery({
    queryKey: ['home-metas'],
    queryFn: async () => {
      const res = await api.market.metas.$get({ query: { limit: '100', minVolume: '20000000' } });
      if (!res.ok) return { metas: [] as MetaRow[] };
      return res.json() as Promise<{ metas: MetaRow[] }>;
    },
    refetchInterval: 30_000,
  });

  const top = [...(data?.metas ?? [])].sort((a, b) => b.volume24h - a.volume24h).slice(0, 10);

  return (
    <div className="dock-scroll flex gap-6 overflow-x-auto px-1 py-1">
      {top.map((m) => {
        const change = m.prevDayPx > 0 ? ((m.markPrice - m.prevDayPx) / m.prevDayPx) * 100 : 0;
        const up = change >= 0;
        return (
          <Link key={m.symbol} to="/terminal" className="group flex flex-col gap-0.5 text-xs">
            <span className="font-medium opacity-80 group-hover:text-[hsl(var(--fg-accent))]">
              {m.symbol}
            </span>
            <span className="num text-[13px]">
              {m.markPrice >= 100 ? m.markPrice.toFixed(0) : m.markPrice.toFixed(3)}
              <span className={`ml-1.5 text-[11px] ${up ? 'text-success' : 'text-destructive'}`}>
                {up ? '+' : ''}
                {change.toFixed(2)}%
              </span>
            </span>
            <span className="text-[10.5px] text-fg-quaternary">
              Vol ${formatCompactNumber(m.volume24h)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

const FEATURES = [
  {
    icon: Activity,
    title: 'Trading Terminal',
    desc: 'Live order book, candlesticks and taker flow streamed from the Hyperliquid feed.',
    to: '/terminal',
  },
  {
    icon: Users,
    title: 'Whale Tracking',
    desc: 'Traders auto-discovered by real volume — profiles, positions and PnL ingested continuously.',
    to: '/traders',
  },
  {
    icon: BarChart3,
    title: 'Market Analytics',
    desc: 'Open interest, funding and price heatmaps, volatility-stress events, whale flows.',
    to: '/analytics',
  },
  {
    icon: Crosshair,
    title: 'Copy Trading',
    desc: 'Portfolio or single-trader strategies with leverage, slippage and drawdown controls.',
    to: '/strategies',
  },
] as const;

function HomePage() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
      {/* Market strip */}
      <section className="panel mt-4 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-fg-tertiary">
            Markets
          </span>
          <Link to="/terminal" className="text-[11px] text-fg-accent hover:underline">
            Open terminal →
          </Link>
        </div>
        <MarketStrip />
      </section>

      {/* Hero */}
      <section className="flex flex-col items-center py-16 text-center md:py-24">
        <span className="badge badge-accent mb-5">
          <Zap className="h-3 w-3" /> Built on Hyperliquid
        </span>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight md:text-6xl">
          Advanced trading terminal for{' '}
          <span className="text-[hsl(var(--fg-accent))]">Hyperliquid</span>
        </h1>
        <p className="mt-5 max-w-xl text-base text-fg-tertiary">
          Real-time market analytics, whale tracking and copy trading — streamed live from the
          Hyperliquid order flow.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/terminal"
            className="flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Crosshair className="h-4 w-4" /> Open Terminal
          </Link>
          <Link
            to="/traders"
            className="flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium text-fg-tertiary transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
          >
            Explore Traders <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Feature grid */}
      <section className="grid grid-cols-1 gap-3 pb-16 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <Link
            key={f.title}
            to={f.to}
            className="panel group p-5 transition-shadow hover:shadow-[0_0_0_1px_hsl(var(--fg-accent))]"
          >
            <f.icon className="mb-3 h-5 w-5 text-[hsl(var(--fg-accent))]" strokeWidth={1.8} />
            <h3 className="mb-1.5 text-[15px] font-semibold">{f.title}</h3>
            <p className="text-[13px] leading-relaxed text-fg-tertiary">{f.desc}</p>
            <span className="mt-3 inline-flex items-center gap-1 text-[12px] text-fg-quaternary transition-colors group-hover:text-[hsl(var(--fg-accent))]">
              Open <ArrowRight className="h-3 w-3" />
            </span>
          </Link>
        ))}
      </section>

      {/* Footer */}
      <footer className="flex items-center justify-between border-t border-[hsl(var(--border))] py-5 text-[11.5px] text-fg-quaternary">
        <span>HyperDash — data from the Hyperliquid public API</span>
        <span className="flex items-center gap-1.5">
          <span className="status-dot status-dot-live" /> feed live
        </span>
      </footer>
    </div>
  );
}
