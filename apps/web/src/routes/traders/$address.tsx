import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  DollarSign,
  TrendingUp,
} from 'lucide-react';
import { z } from 'zod';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { api } from '~/lib/api-client';
import { formatCompactNumber, formatPnL } from '~/lib/utils';

// Type-safe route with address validation
export const Route = createFileRoute('/traders/$address')({
  parseParams: (params) => ({
    address: z.string().min(42).max(42).parse(params.address),
  }),
  component: TraderDetailPage,
});

interface TraderDetail {
  address: string;
  traderId: string;
  nickname?: string;
  isActive: boolean;
  lastTradeAt: string | null;
  equity: number;
  pnl7d: number;
  pnl30d: number;
  winRate: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgPositionSizeUsd: number;
  longTrades: number;
  shortTrades: number;
  avgHoldTimeSeconds: number;
}

interface Position {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  positionValueUsd: number;
  unrealizedPnl: number;
}

interface Trade {
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  closedAt: string | null;
}

function isRecentlyActive(lastTradeAt: string | null | undefined): boolean {
  if (!lastTradeAt) return false;
  const ms = Date.now() - new Date(lastTradeAt).getTime();
  return ms >= 0 && ms < 7 * 24 * 60 * 60 * 1000;
}

function StatCard({
  label,
  value,
  icon: Icon,
  positive,
  negative,
  description,
}: {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
  positive?: boolean;
  negative?: boolean;
  description?: string;
}) {
  let colorClass = '';
  if (positive) colorClass = 'text-success';
  if (negative) colorClass = 'text-destructive';

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm opacity-60">{label}</p>
          {Icon && <Icon className="w-4 h-4 opacity-60" />}
        </div>
        <p className={`text-2xl font-bold ${colorClass}`}>{value}</p>
        {description && <p className="text-xs opacity-60 mt-1">{description}</p>}
      </CardContent>
    </Card>
  );
}

function TraderDetailPage() {
  const { address } = Route.useParams();

  // Fetch trader profile data
  const { data: traderResponse, isLoading: isLoadingProfile } = useQuery({
    queryKey: ['trader', address],
    queryFn: async () => {
      const res = await api.traders[':address'].$get({ param: { address } });
      if (!res.ok) throw new Error('failed to load trader');
      const body = (await res.json()) as unknown as {
        trader: {
          address: string;
          traderId: string;
          lastTradeAt: string | null;
          equityUsd?: string | number | null;
          pnl7d?: string | number | null;
          pnl30d?: string | number | null;
          pnlAll?: string | number | null;
          winrate?: string | number | null;
          sharpeRatio?: string | number | null;
          maxDrawdown?: string | number | null;
          totalTrades?: number | null;
          winningTrades?: number | null;
          losingTrades?: number | null;
          avgPositionSizeUsd?: string | number | null;
          longTrades?: number | null;
          shortTrades?: number | null;
          avgHoldTimeSeconds?: number | null;
        };
      };
      return body;
    },
    staleTime: 30_000, // 30 seconds
  });

  const trader: TraderDetail | undefined = traderResponse?.trader
    ? {
        ...traderResponse.trader,
        isActive: isRecentlyActive(traderResponse.trader.lastTradeAt),
        equity: Number(traderResponse.trader.equityUsd ?? 0),
        pnl7d: Number(traderResponse.trader.pnl7d ?? 0),
        pnl30d: Number(traderResponse.trader.pnl30d ?? 0),
        winRate: Number(traderResponse.trader.winrate ?? 0),
        sharpeRatio: Number(traderResponse.trader.sharpeRatio ?? 0),
        maxDrawdown: Number(traderResponse.trader.maxDrawdown ?? 0),
        totalTrades: Number(traderResponse.trader.totalTrades ?? 0),
        winningTrades: Number(traderResponse.trader.winningTrades ?? 0),
        losingTrades: Number(traderResponse.trader.losingTrades ?? 0),
        avgPositionSizeUsd: Number(traderResponse.trader.avgPositionSizeUsd ?? 0),
        longTrades: Number(traderResponse.trader.longTrades ?? 0),
        shortTrades: Number(traderResponse.trader.shortTrades ?? 0),
        avgHoldTimeSeconds: Number(traderResponse.trader.avgHoldTimeSeconds ?? 0),
      }
    : undefined;

  // Fetch trader positions
  const { data: positionsResponse, isLoading: isLoadingPositions } = useQuery({
    queryKey: ['trader', address, 'positions'],
    queryFn: async () => {
      const res = await api.traders[':address'].positions.$get({ param: { address } });
      if (!res.ok) throw new Error('failed to load positions');
      const body = (await res.json()) as unknown as {
        positions: Array<{
          id: string;
          symbol: string;
          side: string;
          quantity: string | number;
          positionValueUsd: string | number;
          unrealizedPnl: string | number;
        }>;
      };
      return body;
    },
  });

  const positions: Position[] =
    positionsResponse?.positions.map((position) => ({
      ...position,
      quantity: Number(position.quantity),
      positionValueUsd: Number(position.positionValueUsd),
      unrealizedPnl: Number(position.unrealizedPnl),
    })) ?? [];

  // Fetch trader trades
  const { data: tradesResponse, isLoading: isLoadingTrades } = useQuery({
    queryKey: ['trader', address, 'trades'],
    queryFn: async () => {
      const res = await api.traders[':address'].trades.$get({
        param: { address },
        query: { limit: '10' },
      });
      if (!res.ok) throw new Error('failed to load trades');
      const body = (await res.json()) as unknown as {
        trades: Array<{
          symbol: string;
          side: string;
          size: string | number;
          entryPrice: string | number | null;
          exitPrice: string | number | null;
          pnl: string | number;
          closedAt: string | null;
        }>;
      };
      return body;
    },
    staleTime: 30_000,
  });

  const trades: Trade[] =
    tradesResponse?.trades.map((trade) => ({
      ...trade,
      size: Number(trade.size),
      entryPrice: Number(trade.entryPrice ?? 0),
      exitPrice: Number(trade.exitPrice ?? 0),
      pnl: Number(trade.pnl ?? 0),
      side: trade.side?.toUpperCase() ?? 'LONG',
    })) ?? [];

  if (isLoadingProfile) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-center py-12 opacity-60">Loading trader data...</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link to="/traders">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Traders
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold font-mono">{trader?.address}</h1>
            {trader?.nickname && <Badge variant="secondary">{trader.nickname}</Badge>}
            {trader?.isActive && (
              <Badge variant="success" className="text-xs">
                Active
              </Badge>
            )}
          </div>
          <p className="text-sm opacity-60 mt-1">
            Last trade:{' '}
            {trader?.lastTradeAt ? new Date(trader.lastTradeAt).toLocaleString() : 'N/A'}
          </p>
        </div>
        <Button className="gap-2">
          <TrendingUp className="w-4 h-4" />
          Copy This Trader
        </Button>
      </div>

      {/* Performance Stats */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Performance</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Equity"
            value={`$${formatCompactNumber(trader?.equity ?? 0)}`}
            icon={DollarSign}
          />
          <StatCard
            label="7d PnL"
            value={formatPnL(trader?.pnl7d ?? 0)}
            icon={Activity}
            positive={(trader?.pnl7d ?? 0) >= 0}
          />
          <StatCard
            label="30d PnL"
            value={formatPnL(trader?.pnl30d ?? 0)}
            icon={BarChart3}
            positive={(trader?.pnl30d ?? 0) >= 0}
          />
          <StatCard
            label="Win Rate"
            value={`${trader?.winRate}%`}
            description={`${trader?.winningTrades}W / ${trader?.losingTrades}L`}
          />
          <StatCard
            label="Sharpe Ratio"
            value={(trader?.sharpeRatio ?? 0).toFixed(2)}
            positive={(trader?.sharpeRatio ?? 0) >= 0}
          />
          <StatCard
            label="Max Drawdown"
            value={`${trader?.maxDrawdown}%`}
            icon={AlertTriangle}
            negative
          />
          <StatCard label="Total Trades" value={`${trader?.totalTrades.toLocaleString() ?? '0'}`} />
          <StatCard
            label="Avg Position Size"
            value={`$${formatCompactNumber(trader?.avgPositionSizeUsd ?? 0)}`}
          />
        </div>
      </div>

      {/* Trading Style */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Trading Style</CardTitle>
          <CardDescription>Position preferences and trading patterns</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm opacity-60 mb-1">Long vs Short</p>
              <p className="text-lg font-bold">
                {trader?.longTrades}L / {trader?.shortTrades}S
              </p>
            </div>
            <div>
              <p className="text-sm opacity-60 mb-1">Avg Holding Time</p>
              <p className="text-lg font-bold">{trader?.avgHoldTimeSeconds}s</p>
            </div>
            <div>
              <p className="text-sm opacity-60 mb-1">Long Bias</p>
              <p className="text-lg font-bold">
                {(((trader?.longTrades ?? 0) / (trader?.totalTrades ?? 1)) * 100).toFixed(0)}%
              </p>
            </div>
            <div>
              <p className="text-sm opacity-60 mb-1">Activity Level</p>
              <p className="text-lg font-bold">
                {trader?.totalTrades && trader.totalTrades > 1000
                  ? 'Very High'
                  : trader?.totalTrades && trader.totalTrades > 500
                    ? 'High'
                    : 'Moderate'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Open Positions */}
      <section className="mt-8">
        <h2 className="text-xl font-semibold mb-4">Current Positions</h2>
        {isLoadingPositions ? (
          <div className="text-sm opacity-60">Loading positions...</div>
        ) : positions.length === 0 ? (
          <div className="text-sm opacity-60">No open positions.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left">Symbol</th>
                  <th className="px-4 py-3 text-left">Side</th>
                  <th className="px-4 py-3 text-right">Qty</th>
                  <th className="px-4 py-3 text-right">Value</th>
                  <th className="px-4 py-3 text-right">PnL</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={position.id} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">{position.symbol}</td>
                    <td className="px-4 py-3 capitalize">{position.side}</td>
                    <td className="px-4 py-3 text-right">{position.quantity}</td>
                    <td className="px-4 py-3 text-right">
                      ${position.positionValueUsd.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      ${position.unrealizedPnl.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent Trades */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Trade History</CardTitle>
          <CardDescription>Last {trades.length} closed positions</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingTrades ? (
            <div className="text-center py-8 opacity-60">Loading trades...</div>
          ) : trades.length === 0 ? (
            <div className="text-center py-8 opacity-60">No trade history available</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-sm opacity-60 border-b border-[hsl(var(--border))]">
                    <th className="pb-3">Symbol</th>
                    <th className="pb-3">Side</th>
                    <th className="pb-3 text-right">Size</th>
                    <th className="pb-3 text-right">Entry</th>
                    <th className="pb-3 text-right">Exit</th>
                    <th className="pb-3 text-right">PnL</th>
                    <th className="pb-3 text-right">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <tr
                      key={`${trade.symbol}-${trade.closedAt}`}
                      className="border-b border-[hsl(var(--border))] last:border-0"
                    >
                      <td className="py-3 font-medium">{trade.symbol}</td>
                      <td className="py-3">
                        <Badge
                          variant={trade.side === 'LONG' ? 'success' : 'destructive'}
                          className="text-xs"
                        >
                          {trade.side}
                        </Badge>
                      </td>
                      <td className="py-3 text-right">{trade.size}</td>
                      <td className="py-3 text-right">${trade.entryPrice.toLocaleString()}</td>
                      <td className="py-3 text-right">${trade.exitPrice.toLocaleString()}</td>
                      <td
                        className={`py-3 text-right font-medium ${trade.pnl >= 0 ? 'text-success' : 'text-destructive'}`}
                      >
                        {formatPnL(trade.pnl)}
                      </td>
                      <td className="py-3 text-right text-sm opacity-60">
                        {trade.closedAt ? new Date(trade.closedAt).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
