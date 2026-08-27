import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { FEED_REST_BASE, type FeedHistoryPoint, fetchFeedHistory } from '~/lib/feed-client';
import { formatUsd } from '~/lib/utils';

interface WhaleFlowPoint extends FeedHistoryPoint {
  netNotionalUsd: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
}

export function WhaleFlows() {
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
                      className="absolute inset-y-0 left-1/2 bg-[hsl(var(--success))]/70"
                      style={{ width: `${(r.net / maxAbs) * 50}%` }}
                    />
                  ) : (
                    <div
                      className="absolute inset-y-0 right-1/2 bg-[hsl(var(--destructive))]/70"
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
