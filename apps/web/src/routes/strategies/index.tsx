import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { AgentWalletCard } from '~/components/AgentWalletCard';
import { type StrategyStatus, StrategyStatusBadge } from '~/components/StrategyStatusBadge';
import { AddressText } from '~/components/ui/address';
import { Badge } from '~/components/ui/badge';
import { Button, buttonVariants } from '~/components/ui/button';
import { PageHeader } from '~/components/ui/page-header';
import { Panel, PanelBody } from '~/components/ui/panel';
import { Segmented } from '~/components/ui/segmented';
import { StatCard, StatGrid } from '~/components/ui/stat-card';
import { ErrorNotice, PanelState, SkeletonBlock } from '~/components/ui/state';
import { useStrategyStatusMutation } from '~/hooks/useStrategyStatusMutation';
import { ApiError, api, readJson } from '~/lib/api-client';
import { cn, formatPercent, formatPnL, formatUsdFull, toNumber } from '~/lib/utils';

export const Route = createFileRoute('/strategies/')({
  component: StrategiesPage,
});

/**
 * The strategies API caps `limit` at 50. Ask for the cap explicitly — the old
 * query hard-coded `{status:'all'}` and silently received the server default of
 * 20 with no indicator that anything had been truncated.
 */
const PAGE_LIMIT = 50;

/** Stated verbatim on the Net PnL card so the number can be audited. */
const NET_PNL_FORMULA =
  'Net PnL (after fees) = Σ allocation PnL (allocated_pnl) − Σ strategy fees (total_fees)';

/** Stable keys for the four placeholder tiles rendered while loading. */
const SKELETON_TILES = ['total-pnl', 'net-pnl', 'fees', 'active'] as const;

interface AllocationRow {
  traderId: string;
  weight: number;
  /**
   * Hydrated by the server from the allocation's joined trader stats. Optional
   * here because the row is still rendered when the join finds no trader.
   */
  trader?: { address: string } | null;
  performance: { allocatedPnl: number; allocatedFees: number };
}

interface StrategyListItem {
  id: string;
  name: string;
  description: string | null;
  status: StrategyStatus;
  mode: 'portfolio' | 'single_trader';
  riskParams: {
    maxLeverage: number;
    maxPositionUsd?: number;
    slippageBps: number;
    minOrderUsd: number;
  };
  settings: {
    followNewEntriesOnly: boolean;
    autoRebalance: boolean;
    rebalanceThresholdBps: number;
  };
  performance: {
    totalPnl: number;
    totalFees: number;
    alignmentRate: number;
    totalTrades: number;
  };
  allocations: AllocationRow[];
  createdAt: string;
  updatedAt: string;
}

interface StrategyListResponse {
  strategies: StrategyListItem[];
}

type StatusFilter = 'all' | StrategyStatus;

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'error', label: 'Error' },
  { value: 'terminated', label: 'Terminated' },
];

/**
 * Pause / Resume against PATCH /strategies/:id.
 *
 * The write is applied optimistically so a control on the primary management
 * surface responds immediately, and rolled back from a snapshot when the server
 * rejects it — a dead button, or one that lies about the outcome, is worse than
 * no button.
 */
/**
 * One copied trader. The wallet address — not the internal DB id — is the
 * identity a user can recognise, verify and follow through to the trader page.
 */
function AllocationChip({ allocation }: { allocation: AllocationRow }) {
  const address = allocation.trader?.address;
  const idTitle = `Trader ID: ${allocation.traderId}`;

  return (
    <li
      className="flex min-w-0 items-center gap-1.5 rounded-md bg-inset px-2 py-1 text-2xs"
      title={address ? idTitle : `${idTitle} — the API did not return a wallet address`}
    >
      {address ? (
        <Link
          to="/traders/$address"
          params={{ address }}
          className="min-w-0 text-fg-secondary transition-colors hover:text-foreground"
        >
          <AddressText address={address} showCopy={false} />
        </Link>
      ) : (
        <span className="text-fg-quaternary">Address unavailable</span>
      )}
      <span className="num shrink-0 text-fg-tertiary">
        {formatPercent(toNumber(allocation.weight) * 100, 0)}
      </span>
    </li>
  );
}

function StrategyCard({
  strategy,
  pendingId,
  onSetStatus,
}: {
  strategy: StrategyListItem;
  pendingId: string | null;
  onSetStatus: (id: string, status: 'active' | 'paused') => void;
}) {
  const pnl = toNumber(strategy.performance.totalPnl);
  const fees = toNumber(strategy.performance.totalFees);
  const busy = pendingId === strategy.id;
  const leverage = toNumber(strategy.riskParams.maxLeverage).toFixed(1);
  const threshold = toNumber(strategy.settings.rebalanceThresholdBps);

  // `terminated` is final: the API accepts no status write for it, so it gets no
  // control rather than a control that cannot work.
  const nextStatus: 'active' | 'paused' | null =
    strategy.status === 'active' ? 'paused' : strategy.status === 'terminated' ? null : 'active';

  const metrics: Array<{ label: string; value: ReactNode }> = [
    {
      label: 'PnL',
      value: <span className={pnl >= 0 ? 'text-up' : 'text-down'}>{formatPnL(pnl)}</span>,
    },
    { label: 'Fees', value: <span className="text-fg-secondary">{formatUsdFull(fees)}</span> },
    {
      label: 'Alignment',
      value: <span>{formatPercent(toNumber(strategy.performance.alignmentRate), 0)}</span>,
    },
    { label: 'Max leverage', value: <span>{leverage}x</span> },
    {
      label: 'Rebalance',
      value: <span>{strategy.settings.autoRebalance ? `Auto · ${threshold} bps` : 'Manual'}</span>,
    },
  ];

  return (
    <Panel className="transition-colors hover:outline hover:outline-1 hover:outline-[var(--border-strong)]">
      <PanelBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Link
                to="/strategies/$id"
                params={{ id: strategy.id }}
                className="min-w-0 truncate text-lg font-medium transition-colors hover:text-fg-accent"
              >
                {strategy.name}
              </Link>
              <StrategyStatusBadge status={strategy.status} />
              <Badge variant="accent">
                {strategy.mode === 'portfolio' ? 'Portfolio' : 'Single trader'}
              </Badge>
            </div>
            {strategy.description ? (
              <p className="mt-1 text-sm text-fg-tertiary">{strategy.description}</p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link
              to="/strategies/$id"
              params={{ id: strategy.id }}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              View details
            </Link>
            {nextStatus ? (
              <Button
                variant="subtle"
                size="sm"
                disabled={busy}
                onClick={() => onSetStatus(strategy.id, nextStatus)}
                className={cn(
                  nextStatus === 'paused'
                    ? 'bg-warning text-warning-foreground hover:bg-warning/90'
                    : 'bg-success text-success-foreground hover:bg-success/90',
                )}
                title={
                  nextStatus === 'paused'
                    ? 'Stop copying new trades for this strategy'
                    : 'Resume copying trades for this strategy'
                }
              >
                {busy
                  ? nextStatus === 'paused'
                    ? 'Pausing…'
                    : 'Resuming…'
                  : nextStatus === 'paused'
                    ? 'Pause'
                    : 'Resume'}
              </Button>
            ) : (
              <span
                className="text-2xs text-fg-tertiary"
                title="A terminated strategy is final and cannot be resumed."
              >
                Final state
              </span>
            )}
          </div>
        </div>

        {strategy.allocations.length > 0 ? (
          <div className="min-w-0">
            <p id={`allocation-caption-${strategy.id}`} className="text-2xs text-fg-tertiary">
              Copying {strategy.allocations.length} trader
              {strategy.allocations.length === 1 ? '' : 's'}:
            </p>
            <ul
              aria-labelledby={`allocation-caption-${strategy.id}`}
              className="mt-1.5 flex flex-wrap gap-1.5"
            >
              {strategy.allocations.map((allocation) => (
                <AllocationChip key={allocation.traderId} allocation={allocation} />
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-2xs text-fg-tertiary">
            No traders allocated yet — open the strategy to add one.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
          {metrics.map((metric) => (
            <div key={metric.label} className="min-w-0">
              <dt className="truncate text-2xs tracking-[0.06em] text-fg-tertiary uppercase">
                {metric.label}
              </dt>
              <dd className="num mt-0.5 truncate text-sm font-medium">{metric.value}</dd>
            </div>
          ))}
        </dl>
      </PanelBody>
    </Panel>
  );
}

function StrategiesPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['strategies', { status: 'all', limit: PAGE_LIMIT }],
    queryFn: async () => {
      const res = await api.strategies.$get({
        query: { status: 'all', limit: String(PAGE_LIMIT) },
      });
      return readJson<StrategyListResponse>(res, 'Strategies');
    },
  });

  const statusMutation = useStrategyStatusMutation();

  const strategies = useMemo(() => data?.strategies ?? [], [data]);

  const counts = useMemo(() => {
    const tally: Record<StrategyStatus, number> = {
      active: 0,
      paused: 0,
      error: 0,
      terminated: 0,
    };
    for (const strategy of strategies) {
      if (Object.hasOwn(tally, strategy.status)) tally[strategy.status] += 1;
    }
    return tally;
  }, [strategies]);

  const summary = useMemo(() => {
    let totalPnl = 0;
    let netPnl = 0;
    let fees = 0;
    for (const strategy of strategies) {
      const strategyFees = toNumber(strategy.performance.totalFees);
      totalPnl += toNumber(strategy.performance.totalPnl);
      fees += strategyFees;
      netPnl -= strategyFees;
      for (const allocation of strategy.allocations) {
        netPnl += toNumber(allocation.performance.allocatedPnl);
      }
    }
    return { totalPnl, netPnl, fees };
  }, [strategies]);

  const visible = useMemo(
    () => (filter === 'all' ? strategies : strategies.filter((s) => s.status === filter)),
    [strategies, filter],
  );

  const truncated = strategies.length >= PAGE_LIMIT;

  const failureStatus = error instanceof ApiError ? error.status : 0;
  const signedOut = failureStatus === 401;
  const failureMessage =
    error instanceof Error ? error.message : 'The request failed before it reached the server.';

  const failedVariables = statusMutation.isError ? statusMutation.variables : undefined;
  const statusErrorMessage =
    statusMutation.error instanceof Error
      ? statusMutation.error.message
      : 'The status change was rejected.';

  const filterItems = STATUS_FILTERS.map((item) => ({
    value: item.value,
    label:
      item.value === 'all'
        ? `${item.label} (${strategies.length})`
        : `${item.label} (${counts[item.value]})`,
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        title="Copy Trading Strategies"
        description="Manage your automated copy trading strategies"
        actions={
          <Link to="/strategies/new" className={buttonVariants({ variant: 'primary', size: 'md' })}>
            <Plus aria-hidden="true" />
            New Strategy
          </Link>
        }
      />

      {isPending ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading strategies</span>
          <StatGrid cols={4} className="mb-4">
            {SKELETON_TILES.map((tile) => (
              <SkeletonBlock key={tile} className="h-20 rounded-lg" />
            ))}
          </StatGrid>
          <Panel className="mb-4">
            <PanelState state="loading" title="Loading your strategies" />
          </Panel>
        </div>
      ) : null}

      {isError ? (
        <Panel className="mb-4">
          <PanelState
            state="error"
            title={signedOut ? 'Sign in to view your strategies' : 'Could not load your strategies'}
            description={
              signedOut
                ? 'Your session has expired or you are signed out. Sign in to see your copy strategies.'
                : failureMessage
            }
            onRetry={signedOut ? undefined : () => void refetch()}
          />
        </Panel>
      ) : null}

      {!isPending && !isError ? (
        <>
          {strategies.length === 0 ? (
            <Panel className="mb-4">
              <PanelState
                state="empty"
                title="No strategies yet"
                description="A strategy follows the traders you pick and copies their entries into your account."
              />
              <div className="flex justify-center pb-6">
                <Link
                  to="/strategies/new"
                  className={buttonVariants({ variant: 'primary', size: 'md' })}
                >
                  <Plus aria-hidden="true" />
                  New Strategy
                </Link>
              </div>
            </Panel>
          ) : (
            <>
              <StatGrid cols={4} className="mb-4">
                <StatCard
                  label="Total PnL"
                  value={formatPnL(summary.totalPnl)}
                  tone={summary.totalPnl >= 0 ? 'up' : 'down'}
                  hint="Across every strategy"
                />
                <div className="min-w-0" title={NET_PNL_FORMULA}>
                  <StatCard
                    label="Net PnL (after fees)"
                    value={formatPnL(summary.netPnl)}
                    tone={summary.netPnl >= 0 ? 'up' : 'down'}
                    hint="Allocated PnL − fees"
                  />
                </div>
                <StatCard
                  label="Total fees"
                  value={formatUsdFull(summary.fees)}
                  tone="down"
                  hint="Paid to the exchange"
                />
                <StatCard
                  label="Active strategies"
                  value={`${counts.active} / ${strategies.length}`}
                  hint="Currently copying"
                />
              </StatGrid>

              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <Segmented
                  items={filterItems}
                  value={filter}
                  onChange={setFilter}
                  label="Filter strategies by status"
                  idBase="strategy-status"
                />
                <p className="text-xs text-fg-tertiary">
                  {filter === 'all'
                    ? `Showing all ${strategies.length}`
                    : `Showing ${visible.length} of ${strategies.length}`}
                  {truncated ? ` (newest ${PAGE_LIMIT} loaded)` : ''}
                </p>
              </div>
            </>
          )}

          {statusMutation.isError ? (
            <ErrorNotice
              className="mb-3"
              message={statusErrorMessage}
              onRetry={failedVariables ? () => statusMutation.mutate(failedVariables) : undefined}
            />
          ) : null}

          {visible.length > 0 ? (
            <div className="space-y-3">
              {visible.map((strategy) => (
                <StrategyCard
                  key={strategy.id}
                  strategy={strategy}
                  pendingId={
                    statusMutation.isPending ? (statusMutation.variables?.id ?? null) : null
                  }
                  onSetStatus={(id, status) => statusMutation.mutate({ id, status })}
                />
              ))}
            </div>
          ) : strategies.length > 0 ? (
            <Panel>
              <PanelState
                state="empty"
                title={`No ${filter} strategies`}
                description="Nothing matches this filter right now. Choose All to see every strategy."
              />
            </Panel>
          ) : null}
        </>
      ) : null}

      <div className="mt-4">
        <AgentWalletCard />
      </div>
    </div>
  );
}
