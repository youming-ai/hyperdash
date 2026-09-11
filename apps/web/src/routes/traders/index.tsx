import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowUpDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '~/lib/api-client';
import { FEED_COINS, getFeedClient } from '~/lib/feed-client';
import { formatCompactNumber, formatNumber, formatPnL } from '~/lib/utils';

export const Route = createFileRoute('/traders/')({
  component: TradersPage,
});

type Timeframe = '7d' | '30d' | 'all';
type SortBy = 'pnl' | 'winrate' | 'trades' | 'sharpe';
type SortOrder = 'asc' | 'desc';

interface Trader {
  rank?: number;
  address: string;
  traderId: string;
  lastTradeAt: string | null;
  equityUsd?: string | number | null;
  winrate?: string | number | null;
  sharpeRatio?: string | number | null;
  maxDrawdown?: string | number | null;
  pnl7d?: string | number | null;
  pnl30d?: string | number | null;
  pnlAll?: string | number | null;
  totalTrades?: number | null;
}

function isRecentlyActive(lastTradeAt: string | null | undefined): boolean {
  if (!lastTradeAt) return false;
  const ms = Date.now() - new Date(lastTradeAt).getTime();
  return ms >= 0 && ms < 7 * 24 * 60 * 60 * 1000;
}

function pnlForTimeframe(trader: Trader, timeframe: Timeframe): number {
  if (timeframe === '30d') return Number(trader.pnl30d ?? 0);
  if (timeframe === 'all') return Number(trader.pnlAll ?? trader.pnl30d ?? 0);
  return Number(trader.pnl7d ?? 0);
}

function TradersPage() {
  const [timeframe, setTimeframe] = useState<Timeframe>('7d');
  const [sortBy, setSortBy] = useState<SortBy>('pnl');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [showActiveOnly, setShowActiveOnly] = useState(false);

  const { data: rawTraders, isLoading } = useQuery({
    queryKey: ['traders', { sortBy, sortOrder, timeframe, isActive: showActiveOnly }],
    queryFn: async () => {
      const res = await api.traders.$get({
        query: {
          limit: '50',
          sortBy,
          sortOrder,
          timeframe,
          isActive: showActiveOnly ? 'true' : 'false',
        },
      });
      if (!res.ok) throw new Error('failed to load traders');
      const body = (await res.json()) as unknown as { traders: Trader[] };
      return body;
    },
    refetchInterval: 30_000,
  });

  const traders = (rawTraders?.traders ?? []).map((trader, i) => ({
    ...trader,
    rank: trader.rank ?? i + 1,
  }));

  const handleSortChange = (newSortBy: SortBy) => {
    if (sortBy === newSortBy) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(newSortBy);
      setSortOrder('desc');
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leaderboard</h1>
          <p className="mt-0.5 text-[13px] text-fg-tertiary">
            Top Hyperliquid traders, auto-discovered by real volume
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowActiveOnly(!showActiveOnly)}
          className="dock-tab"
          data-active={showActiveOnly}
        >
          Active only
        </button>
      </div>

      {/* Timeframe tabs */}
      <div className="dock mb-3 w-fit">
        {(['7d', '30d', 'all'] as const).map((tf) => (
          <button
            key={tf}
            type="button"
            className="dock-tab"
            data-active={timeframe === tf}
            onClick={() => setTimeframe(tf)}
          >
            {tf === 'all' ? 'All time' : tf.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Leaderboard table */}
      <div className="panel overflow-hidden">
        {isLoading ? (
          <div className="py-16 text-center text-sm text-fg-tertiary">Loading traders…</div>
        ) : traders.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-fg-tertiary">
              No traders yet — the auto-ingest cycle populates this from the live feed.
            </p>
          </div>
        ) : (
          <div className="max-h-[68vh] overflow-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 52 }}>#</th>
                  <th>Trader</th>
                  <th className="num-col">Equity</th>
                  <th className="num-col">
                    <SortHeader
                      label={timeframe === 'all' ? 'All PnL' : `${timeframe} PnL`}
                      active={sortBy === 'pnl'}
                      order={sortOrder}
                      onClick={() => handleSortChange('pnl')}
                    />
                  </th>
                  <th className="num-col">
                    <SortHeader
                      label="Win rate"
                      active={sortBy === 'winrate'}
                      order={sortOrder}
                      onClick={() => handleSortChange('winrate')}
                    />
                  </th>
                  <th className="num-col">
                    <SortHeader
                      label="Trades"
                      active={sortBy === 'trades'}
                      order={sortOrder}
                      onClick={() => handleSortChange('trades')}
                    />
                  </th>
                  <th className="num-col">
                    <SortHeader
                      label="Sharpe"
                      active={sortBy === 'sharpe'}
                      order={sortOrder}
                      onClick={() => handleSortChange('sharpe')}
                    />
                  </th>
                  <th className="num-col">Max DD</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {traders.map((trader) => {
                  const active = isRecentlyActive(trader.lastTradeAt);
                  const pnl = pnlForTimeframe(trader, timeframe);
                  const up = pnl >= 0;
                  return (
                    <tr key={trader.address}>
                      <td className="num-col text-fg-quaternary">{trader.rank}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span
                            className="status-dot"
                            style={{
                              background: active
                                ? 'hsl(var(--success))'
                                : 'hsl(var(--fg-quaternary))',
                            }}
                          />
                          <span className="num text-[12.5px]">{shorten(trader.address)}</span>
                        </div>
                      </td>
                      <td className="num-col">
                        ${formatCompactNumber(Number(trader.equityUsd ?? 0))}
                      </td>
                      <td
                        className={`num-col font-medium ${up ? 'text-success' : 'text-destructive'}`}
                      >
                        {formatPnL(pnl)}
                      </td>
                      <td className="num-col">{Number(trader.winrate ?? 0).toFixed(1)}%</td>
                      <td className="num-col text-fg-tertiary">
                        {formatNumber(Number(trader.totalTrades ?? 0))}
                      </td>
                      <td
                        className={`num-col ${Number(trader.sharpeRatio ?? 0) >= 0 ? 'text-success' : 'text-destructive'}`}
                      >
                        {Number(trader.sharpeRatio ?? 0).toFixed(2)}
                      </td>
                      <td className="num-col text-fg-tertiary">
                        {Number(trader.maxDrawdown ?? 0).toFixed(1)}%
                      </td>
                      <td className="num-col">
                        <Link
                          to="/traders/$address"
                          params={{ address: trader.address }}
                          className="text-[11.5px] text-fg-accent hover:underline"
                        >
                          Details
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Live market tape */}
      <LiveMarketTape />
    </div>
  );
}

function SortHeader({
  label,
  active,
  order,
  onClick,
}: {
  label: string;
  active: boolean;
  order: SortOrder;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 ${active ? 'text-[hsl(var(--fg-accent))]' : ''}`}
    >
      {label}
      <ArrowUpDown className="h-3 w-3" strokeWidth={1.8} />
      {active && <span className="text-[9px]">{order === 'asc' ? '↑' : '↓'}</span>}
    </button>
  );
}

function shorten(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Live trade tape across the major feed coins — a real-time window into the
 * market while browsing leaderboards (api-gateway feed; degrades silently).
 */
interface TapeTrade {
  id: number;
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
}

function LiveMarketTape() {
  const [trades, setTrades] = useState<TapeTrade[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const client = getFeedClient();
    const channels = FEED_COINS.map((c) => `trades:${c}`);
    let nextId = 0;
    const nextTradeId = (): number => {
      nextId += 1;
      return nextId;
    };
    const withIds = (list: Array<Omit<TapeTrade, 'id'>>): TapeTrade[] =>
      list.map((t) => ({ ...t, id: nextTradeId() }));
    client.subscribe(channels);
    const off = client.on((message) => {
      if (message.type === 'data' && message.channel === 'trades') {
        const list = message.data as Array<Omit<TapeTrade, 'id'>>;
        setTrades((prev) => [...withIds(list.slice(-8).reverse()), ...prev].slice(0, 60));
        setConnected(true);
      }
    });
    void client.fetchState();
    const poll = setInterval(() => setConnected(client.isConnected), 5000);
    return () => {
      off();
      client.unsubscribe(channels);
      clearInterval(poll);
    };
  }, []);

  if (trades.length === 0) return null;

  return (
    <div className="panel mt-4 overflow-hidden">
      <div className="panel-header flex items-center justify-between px-3 py-2 text-[10.5px] uppercase tracking-[0.08em] text-fg-tertiary">
        <span>Live market tape</span>
        <span className={connected ? 'text-success' : 'text-warning'}>
          {connected ? '● feed live' : '○ reconnecting'}
        </span>
      </div>
      <div className="dock-scroll flex gap-5 overflow-x-auto px-3 py-2">
        {trades.map((t) => (
          <div key={t.id} className="flex items-center gap-2 whitespace-nowrap font-mono text-xs">
            <span className="font-semibold opacity-80">{t.coin}</span>
            <span className={t.side === 'A' ? 'text-success' : 'text-destructive'}>
              {formatNumber(parseFloat(t.px))}
            </span>
            <span className="opacity-60">{formatNumber(parseFloat(t.sz))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
