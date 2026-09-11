import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { api } from '~/lib/api-client';

export const Route = createFileRoute('/strategies/')({
  component: StrategiesPage,
});

// Status badge component
function StatusBadge({ status }: { status: string }) {
  const styles = {
    active: 'bg-green-500/20 text-green-500',
    paused: 'bg-yellow-500/20 text-yellow-500',
    error: 'bg-red-500/20 text-red-500',
    terminated: 'bg-gray-500/20 text-gray-500',
  };
  const style = styles[status.toLowerCase() as keyof typeof styles] || styles.paused;
  return <span className={`px-2 py-0.5 text-xs rounded-full ${style}`}>{status}</span>;
}

function StrategiesPage() {
  const { data: strategiesData, isLoading } = useQuery({
    queryKey: ['strategies', { status: 'all' }],
    queryFn: async () => {
      const res = await api.strategies.$get({ query: { status: 'all' } });
      if (!res.ok) throw new Error('failed to load strategies');
      return res.json();
    },
  });

  const strategies = strategiesData?.strategies ?? [];

  // Calculate summary stats
  const totalAllocation = strategies.reduce((sum, s) => {
    const allocValue = s.allocations.reduce(
      (a, alloc) => a + (alloc.performance.allocatedPnl || 0),
      0,
    );
    return sum + allocValue + (s.performance.totalFees || 0);
  }, 0);

  const totalPnl = strategies.reduce((sum, s) => sum + (s.performance.totalPnl || 0), 0);
  const activeCount = strategies.filter((s) => s.status === 'active').length || 0;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Copy Trading Strategies</h1>
          <p className="text-sm opacity-60 mt-1">Manage your automated copy trading strategies</p>
        </div>
        <Link
          to="/strategies/new"
          className="px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm font-medium hover:opacity-90 transition-opacity"
        >
          + New Strategy
        </Link>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-6">
          <p className="text-sm opacity-60 mb-1">Total Allocated</p>
          <p className="text-2xl font-bold">${totalAllocation?.toLocaleString() || '0'}</p>
        </div>
        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-6">
          <p className="text-sm opacity-60 mb-1">Total PnL</p>
          <p
            className={`text-2xl font-bold ${totalPnl && totalPnl >= 0 ? 'text-success' : 'text-destructive'}`}
          >
            {totalPnl && totalPnl >= 0 ? '+' : ''}${totalPnl?.toLocaleString() || '0'}
          </p>
        </div>
        <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-6">
          <p className="text-sm opacity-60 mb-1">Active Strategies</p>
          <p className="text-2xl font-bold">
            {activeCount} / {strategies?.length || 0}
          </p>
        </div>
      </div>

      {/* Strategies List */}
      {isLoading ? (
        <div className="text-center py-12 opacity-60">Loading strategies...</div>
      ) : (
        <div className="space-y-4">
          {strategies?.map((strategy) => (
            <div
              key={strategy.id}
              className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl p-6 hover:border-[hsl(var(--primary))] transition-colors"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-lg">{strategy.name}</h3>
                    <StatusBadge status={strategy.status} />
                    <span className="px-2 py-0.5 text-xs rounded-full bg-blue-500/20 text-blue-500">
                      {strategy.mode === 'portfolio' ? 'Portfolio' : 'Single'}
                    </span>
                  </div>
                  {strategy.description && (
                    <p className="text-sm opacity-60">{strategy.description}</p>
                  )}
                </div>
              </div>

              {/* Traders being copied */}
              <div className="mb-4">
                <p className="text-xs opacity-60 mb-2">
                  Copying {strategy.allocations.length} trader
                  {strategy.allocations.length > 1 ? 's' : ''}:
                </p>
                <div className="flex flex-wrap gap-2">
                  {strategy.allocations.map((alloc) => (
                    <span
                      key={alloc.traderId}
                      className="px-2 py-1 text-xs rounded-md bg-[hsl(var(--muted)/0.5)] font-mono"
                    >
                      {alloc.traderId} ({Math.round(alloc.weight * 100)}%)
                    </span>
                  ))}
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
                <div>
                  <p className="text-xs opacity-60">PnL</p>
                  <p
                    className={`font-medium ${strategy.performance.totalPnl >= 0 ? 'text-success' : 'text-destructive'}`}
                  >
                    {strategy.performance.totalPnl >= 0 ? '+' : ''}$
                    {strategy.performance.totalPnl.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs opacity-60">Trades</p>
                  <p className="font-medium">{strategy.performance.totalTrades}</p>
                </div>
                <div>
                  <p className="text-xs opacity-60">Alignment</p>
                  <p className="font-medium">{strategy.performance.alignmentRate}%</p>
                </div>
                <div>
                  <p className="text-xs opacity-60">Max Leverage</p>
                  <p className="font-medium">{strategy.riskParams.maxLeverage}x</p>
                </div>
                <div>
                  <p className="text-xs opacity-60">Rebalance</p>
                  <p className="font-medium">
                    {strategy.settings.autoRebalance ? 'Auto' : 'Manual'}
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <Link
                  to="/strategies/$id"
                  params={{ id: strategy.id }}
                  className="px-3 py-1.5 text-sm rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] transition-colors"
                >
                  View Details
                </Link>
                {strategy.status === 'active' ? (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-sm rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] transition-colors"
                  >
                    Pause
                  </button>
                ) : strategy.status === 'paused' ? (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-sm rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] transition-colors"
                  >
                    Resume
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
