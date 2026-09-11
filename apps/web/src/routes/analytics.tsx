import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Flame, LineChart, Scale, Waves, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '~/lib/api-client';
import { FEED_REST_BASE, type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatNumber, formatTimeHms, formatUsd } from '~/lib/utils';

export const Route = createFileRoute('/analytics')({
  component: AnalyticsPage,
});

type Tab = 'oi' | 'funding' | 'price' | 'stress' | 'whales';

interface MetaRow {
  symbol: string;
  markPrice: number;
  oraclePrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
  prevDayPx: number;
}

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: 'oi', label: 'Open Interest', icon: <Scale className="w-3.5 h-3.5" /> },
  { id: 'funding', label: 'Funding Heatmap', icon: <Zap className="w-3.5 h-3.5" /> },
  { id: 'price', label: 'Price Heatmap', icon: <LineChart className="w-3.5 h-3.5" /> },
  { id: 'stress', label: 'Stress (liquidation-like)', icon: <Flame className="w-3.5 h-3.5" /> },
  { id: 'whales', label: 'Whale Flows', icon: <Waves className="w-3.5 h-3.5" /> },
];

function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('oi');

  return (
    <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Market Analytics</h1>
        <p className="text-sm opacity-60 mt-0.5">
          Open interest, funding, price and stress heatmaps across Hyperliquid markets
        </p>
      </div>

      <div className="dock mb-5 w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className="dock-tab flex items-center gap-1.5"
            data-active={tab === t.id}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'oi' && <OiPanel />}
      {tab === 'funding' && <FundingHeatmap />}
      {tab === 'price' && <PriceHeatmap />}
      {tab === 'stress' && <StressHeatmap />}
      {tab === 'whales' && <WhaleFlows />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open Interest
// ---------------------------------------------------------------------------

function OiPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics-metas'],
    queryFn: async () => {
      const res = await api.market.metas.$get({ query: { limit: '200' } });
      if (!res.ok) return { metas: [] as MetaRow[] };
      return res.json() as Promise<{ metas: MetaRow[] }>;
    },
    refetchInterval: 30_000,
  });

  const { data: oiHistory } = useQuery({
    queryKey: ['feed-hist-oi'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/oi', { hours: 24 }),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    const metas = [...(data?.metas ?? [])].sort((a, b) => b.openInterest - a.openInterest);
    const oiFirstByCoin = new Map<string, number>();
    const oiByCoin = new Map<string, Array<{ ts: number; oi: number }>>();
    for (const point of oiHistory ?? []) {
      const coin = String(point.coin);
      if (!oiByCoin.has(coin)) oiByCoin.set(coin, []);
      oiByCoin.get(coin)?.push({ ts: point.ts as number, oi: point.openInterest as number });
    }
    for (const [coin, list] of oiByCoin) {
      list.sort((a, b) => a.ts - b.ts);
      oiFirstByCoin.set(coin, list[0]?.oi ?? 0);
    }
    return metas.map((m) => {
      const first = oiFirstByCoin.get(m.symbol);
      const change =
        first !== undefined && first > 0 ? ((m.openInterest - first) / first) * 100 : null;
      return { ...m, oiChangePct: change };
    });
  }, [data, oiHistory]);

  if (isLoading) {
    return <div className="p-10 text-center opacity-50">Loading open interest…</div>;
  }

  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 panel-header text-xs uppercase tracking-wide opacity-70">
        Top {rows.length} markets by open interest
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-xs opacity-60 border-b border-border">
              <th className="text-left px-4 py-2">Coin</th>
              <th className="text-right px-4 py-2">Mark</th>
              <th className="text-right px-4 py-2">Funding</th>
              <th className="text-right px-4 py-2">Open Interest</th>
              <th className="text-right px-4 py-2">OI 24h</th>
              <th className="text-right px-4 py-2">24h Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 60).map((m) => (
              <tr
                key={m.symbol}
                className="border-b border-[hsl(var(--border))]/40 hover:bg-[hsl(var(--muted))]/20"
              >
                <td className="px-4 py-1.5">{m.symbol}</td>
                <td className="px-4 py-1.5 text-right text-success">{formatNumber(m.markPrice)}</td>
                <td
                  className={`px-4 py-1.5 text-right ${
                    m.fundingRate > 0 ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {(m.fundingRate * 100).toFixed(4)}%
                </td>
                <td className="px-4 py-1.5 text-right">{formatUsd(m.openInterest)}</td>
                <td
                  className={`px-4 py-1.5 text-right ${
                    m.oiChangePct === null
                      ? 'opacity-40'
                      : m.oiChangePct >= 0
                        ? 'text-success'
                        : 'text-destructive'
                  }`}
                >
                  {m.oiChangePct === null
                    ? '-'
                    : `${m.oiChangePct >= 0 ? '+' : ''}${m.oiChangePct.toFixed(1)}%`}
                </td>
                <td className="px-4 py-1.5 text-right opacity-80">{formatUsd(m.volume24h)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heatmap primitives
// ---------------------------------------------------------------------------

interface HeatmapProps {
  title: string;
  describe: string;
  series: Array<{
    coin: string;
    label: string;
    cells: Array<{ ts: number; value: number | null; hint?: string }>;
  }>;
  color: (value: number) => string;
  columns?: string[];
  emptyLabel?: string;
  legendNote?: string;
}

function HeatmapGrid({
  title,
  describe,
  series,
  color,
  columns,
  emptyLabel,
  legendNote,
}: HeatmapProps) {
  if (series.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center opacity-60">
        {emptyLabel ??
          `No ${title.toLowerCase()} history yet — the feed recorder needs to run for a while.`}
      </div>
    );
  }
  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 panel-header text-xs uppercase tracking-wide opacity-70">
        {title} {columns ? `· ${columns.length} buckets` : ''}
      </div>
      <div className="p-3 overflow-x-auto">
        <p className="text-xs opacity-50 mb-3">{describe}</p>
        {legendNote ? <p className="text-[11px] opacity-40 mb-2">{legendNote}</p> : null}
        <table className="border-separate border-spacing-[2px]">
          <tbody>
            {series.map((row) => (
              <tr key={row.coin}>
                <td className="pr-2 text-xs font-mono whitespace-nowrap">{row.coin}</td>
                {row.cells.map((cell) => (
                  <td
                    key={cell.ts}
                    title={
                      cell.hint ??
                      `${row.coin} ${new Date(cell.ts).toISOString().slice(0, 13)}:00 · ${cell.value === null ? 'n/a' : cell.value}`
                    }
                    className="w-8 h-8 rounded-sm border border-black/10"
                    style={{
                      background:
                        cell.value === null ? 'rgba(148,163,184,0.08)' : color(cell.value),
                    }}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** diverging: negative → red, positive → green (clamped to ±maxMag). */
function diverging(maxMag: number) {
  return (value: number) => {
    const t = Math.max(-1, Math.min(1, value / maxMag));
    if (t < 0) {
      return `hsl(var(--destructive) / ${(Math.abs(t) * 0.85).toFixed(2)})`;
    }
    return `hsl(var(--success) / ${(t * 0.85).toFixed(2)})`;
  };
}

function lastNHourBuckets(hours: number): Array<{ ts: number }> {
  const now = Date.now();
  const buckets: Array<{ ts: number }> = [];
  for (let h = hours - 1; h >= 0; h--) {
    const ts = Math.floor(now / 3_600_000) * 3_600_000 - h * 3_600_000;
    buckets.push({ ts });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Funding heatmap
// ---------------------------------------------------------------------------

function FundingHeatmap() {
  const { data } = useQuery({
    queryKey: ['feed-hist-funding'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/funding', { hours: 24 }),
    refetchInterval: 60_000,
  });

  const model = useMemo(() => {
    const points = data ?? [];
    const buckets = lastNHourBuckets(24);
    const byCoin = new Map<string, Map<number, number>>();
    for (const p of points) {
      const coin = String(p.coin);
      if (!byCoin.has(coin)) byCoin.set(coin, new Map());
      const hourTs = Math.floor((p.ts as number) / 3_600_000) * 3_600_000;
      byCoin.get(coin)?.set(hourTs, p.funding as number);
    }
    // sort coins by latest funding magnitude
    const coins = [...byCoin.keys()].sort((a, b) => {
      const la = byCoin.get(a);
      const lb = byCoin.get(b);
      return (
        Math.abs(lb?.get(buckets[buckets.length - 1]?.ts ?? 0) ?? 0) -
        Math.abs(la?.get(buckets[buckets.length - 1]?.ts ?? 0) ?? 0)
      );
    });
    const maxMag = Math.max(0.0005, ...points.map((p) => Math.abs(p.funding as number)));
    const series = coins.map((coin) => {
      const map = byCoin.get(coin) ?? new Map();
      return {
        coin,
        label: coin,
        cells: buckets.map((b) => ({
          ts: b.ts,
          value: map.get(b.ts) ?? null,
          hint: `${coin} funding ${new Date(b.ts).toISOString().slice(0, 13)}:00 UTC · ${map.get(b.ts) === undefined ? 'n/a' : `${(Number(map.get(b.ts)) * 100).toFixed(4)}%`}`,
        })),
      };
    });
    return { series, maxMag, cols: buckets.map((b) => b.ts) };
  }, [data]);

  return (
    <HeatmapGrid
      title="Funding Rate Heatmap"
      describe="Hourly funding per market over the last 24h (green positive — longs pay; red negative)."
      columns={model.cols.map((ts) => formatTimeHms(ts))}
      series={model.series}
      color={diverging(model.maxMag)}
      legendNote="Live funding data accumulates from the feed recorder; cells appear as hours are recorded."
    />
  );
}

// ---------------------------------------------------------------------------
// Price heatmap
// ---------------------------------------------------------------------------

function PriceHeatmap() {
  const { data } = useQuery({
    queryKey: ['feed-hist-price'],
    queryFn: () => fetchFeedHistory<FeedHistoryPoint>('/price', { hours: 24 }),
    refetchInterval: 60_000,
  });

  const model = useMemo(() => {
    const points = data ?? [];
    const buckets = lastNHourBuckets(24);
    const byCoin = new Map<string, Map<number, number>>();
    for (const p of points) {
      const coin = String(p.coin);
      if (!byCoin.has(coin)) byCoin.set(coin, new Map());
      const hourTs = Math.floor((p.ts as number) / 3_600_000) * 3_600_000;
      byCoin.get(coin)?.set(hourTs, p.markPx as number);
    }
    const coins = [...byCoin.keys()].sort();
    const series = coins.map((coin) => {
      const map = byCoin.get(coin) ?? new Map();
      let prev: number | null = null;
      return {
        coin,
        label: coin,
        cells: buckets.map((b) => {
          const px = map.get(b.ts);
          const change = px !== undefined && prev !== null ? ((px - prev) / prev) * 100 : null;
          if (px !== undefined) prev = px;
          return {
            ts: b.ts,
            value: change,
            hint: `${coin} ${new Date(b.ts).toISOString().slice(0, 13)}:00 UTC · hourly ${
              change === null ? 'n/a' : `${change.toFixed(2)}%`
            }`,
          };
        }),
      };
    });
    return { series, cols: buckets.map((b) => b.ts) };
  }, [data]);

  return (
    <HeatmapGrid
      title="Price Heatmap"
      describe="Hourly price change (%) per market over the last 24h — green up, red down."
      columns={model.cols.map((ts) => formatTimeHms(ts))}
      series={model.series}
      color={diverging(1.5)}
    />
  );
}

// ---------------------------------------------------------------------------
// Stress (liquidation-like) heatmap
// ---------------------------------------------------------------------------

interface StressPoint extends FeedHistoryPoint {
  trades: number;
  notionalUsd: number;
  maxJumpPct: number;
  spikeScore: number;
}

function StressHeatmap() {
  const { data } = useQuery({
    queryKey: ['feed-hist-stress'],
    queryFn: () => fetchFeedHistory<StressPoint>('/stress', { minutes: 180 }),
    refetchInterval: 30_000,
  });

  const model = useMemo(() => {
    const points = data ?? [];
    const buckets: Array<{ ts: number }> = [];
    for (let m = 29; m >= 0; m--) {
      buckets.push({ ts: Math.floor(Date.now() / 60_000) * 60_000 - m * 60_000 });
    }
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

// ---------------------------------------------------------------------------
// Whale flows
// ---------------------------------------------------------------------------

interface WhaleFlowPoint extends FeedHistoryPoint {
  netNotionalUsd: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
}

function WhaleFlows() {
  const { data } = useQuery({
    queryKey: ['feed-hist-whales'],
    queryFn: () => fetchFeedHistory<WhaleFlowPoint>('/whale-flow', { minutes: 60 }),
    refetchInterval: 30_000,
  });

  const { data: whales } = useQuery({
    queryKey: ['feed-whales'],
    queryFn: async () => {
      try {
        const res = await fetch(`${FEED_REST_BASE}/feed/whales`, { cache: 'no-store' });
        if (!res.ok) return { addresses: [] as string[] };
        return res.json() as Promise<{ addresses: string[] }>;
      } catch {
        return { addresses: [] as string[] };
      }
    },
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    const map = new Map<string, { buy: number; sell: number; net: number }>();
    for (const p of data ?? []) {
      const coin = String(p.coin);
      const cur = map.get(coin) ?? { buy: 0, sell: 0, net: 0 };
      cur.buy += p.buyNotionalUsd as number;
      cur.sell += p.sellNotionalUsd as number;
      cur.net += p.netNotionalUsd as number;
      map.set(coin, cur);
    }
    return [...map.entries()]
      .map(([coin, v]) => ({ coin, ...v }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, 30);
  }, [data]);

  const maxAbs = Math.max(10_000, ...rows.map((r) => Math.abs(r.net)));

  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 panel-header text-xs uppercase tracking-wide opacity-70">
        Tracked-whale taker flow · last 60 min
      </div>
      <div className="p-4">
        <p className="text-xs opacity-50 mb-4">
          Net USDT notional pushed by configured whale wallets as takers, per market. Configure
          wallets via <code className="opacity-70">HL_WHALE_ADDRESSES</code> or the leaderboard seed
          list ({whales?.addresses.length ?? 0} tracked).
        </p>
        {rows.length === 0 ? (
          <div className="text-center py-8 opacity-60 text-sm">
            No whale flow recorded yet — enable <code>HL_WHALE_ADDRESSES</code> and wait for trades
            from tracked wallets.
          </div>
        ) : (
          <div className="space-y-1.5">
            {rows.map((r) => (
              <div key={r.coin} className="flex items-center gap-3 text-sm">
                <span className="w-12 font-mono text-xs">{r.coin}</span>
                <div className="flex-1 h-5 relative bg-[hsl(var(--muted))]/40 rounded overflow-hidden">
                  {r.net >= 0 ? (
                    <div
                      className="absolute inset-y-0 left-1/2 bg-green-500/70"
                      style={{ width: `${(r.net / maxAbs) * 50}%` }}
                    />
                  ) : (
                    <div
                      className="absolute inset-y-0 right-1/2 bg-red-500/70"
                      style={{ width: `${(Math.abs(r.net) / maxAbs) * 50}%` }}
                    />
                  )}
                </div>
                <span
                  className={`w-32 text-right font-mono text-xs ${r.net >= 0 ? 'text-success' : 'text-destructive'}`}
                >
                  {r.net >= 0 ? '+' : ''}
                  {formatUsd(r.net)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
