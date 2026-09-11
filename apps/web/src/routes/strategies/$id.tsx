import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { api } from '~/lib/api-client';

export const Route = createFileRoute('/strategies/$id')({
  component: StrategyDetailPage,
});

function StrategyDetailPage() {
  const { id } = Route.useParams();

  const { data: strategy, isLoading } = useQuery({
    queryKey: ['strategy', id],
    queryFn: async () => {
      const res = await api.strategies[':id'].$get({ param: { id } });
      if (!res.ok) throw new Error('failed to load strategy');
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-center py-12 opacity-60">Loading strategy...</div>
      </div>
    );
  }

  if (!strategy) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-center py-12">
          <p className="text-lg mb-4">Strategy not found</p>
          <Link
            to="/strategies"
            className="px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
          >
            Back to Strategies
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold">{strategy.name}</h1>
            <StatusBadge status={strategy.status} />
            <span className="badge badge-accent">
              {strategy.mode === 'portfolio' ? 'Portfolio' : 'Single'}
            </span>
          </div>
          {strategy.description && <p className="text-sm opacity-60">{strategy.description}</p>}
          <p className="text-xs opacity-40 mt-2">
            Created: {new Date(strategy.createdAt).toLocaleDateString()} • Last updated:{' '}
            {new Date(strategy.updatedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/strategies/new"
            className="px-4 py-2 rounded-lg border border-[hsl(var(--border))] text-sm font-medium hover:bg-[hsl(var(--accent))] transition-colors"
          >
            Edit Settings
          </Link>
          {strategy.status === 'active' ? (
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-yellow-500 text-black text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Pause
            </button>
          ) : strategy.status === 'paused' ? (
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-[hsl(var(--success))] text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Resume
            </button>
          ) : null}
        </div>
      </div>

      {/* Main Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total PnL"
          value={`$${strategy.performance.totalPnl.toLocaleString()}`}
          positive={strategy.performance.totalPnl >= 0}
        />
        <StatCard
          label="Total Fees"
          value={`$${strategy.performance.totalFees.toLocaleString()}`}
        />
        <StatCard label="Total Trades" value={`${strategy.performance.totalTrades}`} />
        <StatCard
          label="Alignment Rate"
          value={`${strategy.performance.alignmentRate}%`}
          positive
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Allocations */}
        <div className="panel p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary mb-4">
            Trader Allocations
          </h2>
          <div className="space-y-4">
            {strategy.allocations.map((alloc) => (
              <div
                key={alloc.traderId}
                className="p-4 rounded-lg bg-[hsl(var(--muted)/0.3)] border border-[hsl(var(--border))]"
              >
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="font-medium font-mono">{alloc.traderId}</p>
                    <p className="text-xs opacity-60">
                      {Math.round(alloc.weight * 100)}% allocation
                    </p>
                  </div>
                  <span className="text-sm font-medium">{Math.round(alloc.weight * 100)}%</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="opacity-60">Allocated PnL:</span>{' '}
                    <span
                      className={
                        alloc.performance.allocatedPnl >= 0 ? 'text-success' : 'text-destructive'
                      }
                    >
                      ${alloc.performance.allocatedPnl.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="opacity-60">Allocated Fees:</span>{' '}
                    <span>${alloc.performance.allocatedFees.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Strategy Settings */}
        <div className="panel p-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary mb-4">
            Strategy Settings
          </h2>
          <div className="space-y-3">
            <SettingRow
              label="Mode"
              value={strategy.mode === 'portfolio' ? 'Portfolio' : 'Single Trader'}
            />
            <SettingRow label="Max Leverage" value={`${strategy.riskParams.maxLeverage}x`} />
            {strategy.riskParams.maxPositionUsd && (
              <SettingRow
                label="Max Position"
                value={`$${strategy.riskParams.maxPositionUsd.toLocaleString()}`}
              />
            )}
            <SettingRow label="Slippage" value={`${strategy.riskParams.slippageBps / 100}%`} />
            <SettingRow label="Min Order" value={`$${strategy.riskParams.minOrderUsd}`} />
            <hr className="border-[hsl(var(--border))]" />
            <SettingRow
              label="New Entries Only"
              value={strategy.settings.followNewEntriesOnly ? 'Yes' : 'No'}
            />
            <SettingRow
              label="Auto Rebalance"
              value={strategy.settings.autoRebalance ? 'Yes' : 'No'}
            />
            {strategy.settings.autoRebalance && (
              <SettingRow
                label="Rebalance Threshold"
                value={`${strategy.settings.rebalanceThresholdBps / 100}%`}
              />
            )}
          </div>
        </div>
      </div>

      {/* Performance Metrics */}
      <div className="panel p-5 mb-6">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary mb-4">
          Performance Metrics
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
          <MetricCard label="Total Trades" value={strategy.performance.totalTrades} />
          <MetricCard label="Alignment Rate" value={`${strategy.performance.alignmentRate}%`} />
        </div>
      </div>

      {/* Recent Copied Trades */}
      <div className="panel p-5">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-fg-tertiary mb-4">
          Recent Copied Trades
        </h2>
        <div className="text-center py-8 opacity-60">No recent copied trades available.</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'badge badge-up',
    paused: 'badge badge-neutral',
    error: 'badge badge-down',
    terminated: 'badge badge-neutral',
  };
  return <span className={map[status.toLowerCase()] ?? 'badge badge-neutral'}>{status}</span>;
}

function StatCard({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="panel p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-tertiary mb-1">
        {label}
      </p>
      <p className={`num text-xl font-bold ${positive ? 'text-success' : ''}`}>{value}</p>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-3 rounded-lg bg-[hsl(var(--muted)/0.3)]">
      <p className="text-xs opacity-60 mb-1">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-2">
      <span className="opacity-60">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
