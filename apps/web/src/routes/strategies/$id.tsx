import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type ReactNode, useMemo } from 'react';
import { type StrategyStatus, StrategyStatusBadge } from '~/components/StrategyStatusBadge';
import { AddressText } from '~/components/ui/address';
import { Badge } from '~/components/ui/badge';
import { Button, buttonVariants } from '~/components/ui/button';
import { PageHeader } from '~/components/ui/page-header';
import { Panel, PanelBody, PanelHeader } from '~/components/ui/panel';
import { StatCard, StatGrid } from '~/components/ui/stat-card';
import { ErrorNotice, PanelState, SkeletonBlock } from '~/components/ui/state';
import {
  type StrategyStatusAction,
  useStrategyStatusMutation,
} from '~/hooks/useStrategyStatusMutation';
import { ApiError, api, readJson } from '~/lib/api-client';
import { cn, formatDateTime, formatPercent, formatPnL, formatUsdFull, toNumber } from '~/lib/utils';

export const Route = createFileRoute('/strategies/$id')({
  component: StrategyDetailPage,
});

/** Stable keys for the placeholder tiles rendered while loading. */
const SKELETON_TILES = ['total-pnl', 'fees', 'net-pnl'] as const;

interface AllocationRow {
  traderId: string;
  weight: number;
  /**
   * Hydrated by the server from the allocation's joined trader stats. Optional
   * here because a row is still rendered when the join finds no trader.
   */
  trader?: { address: string } | null;
  performance: { allocatedPnl: number; allocatedFees: number };
}

interface StrategyDetail {
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

/** One row of the settings description list. Values arrive pre-formatted. */
function SettingRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

function StrategyDetailPage() {
  const { id } = Route.useParams();

  const {
    data: strategy,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['strategy', id],
    queryFn: async () => {
      const res = await api.strategies[':id'].$get({ param: { id } });
      return readJson<StrategyDetail>(res, 'Strategy');
    },
  });

  const statusMutation = useStrategyStatusMutation();
  const statusVariable = statusMutation.isError ? statusMutation.variables : undefined;

  const nextStatus: StrategyStatusAction | null =
    strategy?.status === 'active'
      ? 'paused'
      : strategy === undefined || strategy.status === 'terminated'
        ? null
        : 'active';

  const summary = useMemo(() => {
    if (!strategy) return { netPnl: 0, allocatedPnl: 0 };
    let allocatedPnl = 0;
    for (const allocation of strategy.allocations) {
      allocatedPnl += toNumber(allocation.performance.allocatedPnl);
    }
    return { netPnl: allocatedPnl - toNumber(strategy.performance.totalFees), allocatedPnl };
  }, [strategy]);

  if (isPending) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8" role="status" aria-busy="true">
        <span className="sr-only">Loading strategy</span>
        <PageHeader title={<SkeletonBlock className="h-7 w-56" />} />
        <StatGrid cols={4} className="mb-4">
          {SKELETON_TILES.map((tile) => (
            <SkeletonBlock key={tile} className="h-20 rounded-lg" />
          ))}
        </StatGrid>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel>
            <PanelState state="loading" title="Loading allocations" />
          </Panel>
          <Panel>
            <PanelState state="loading" title="Loading settings" />
          </Panel>
        </div>
      </div>
    );
  }

  if (isError || strategy === undefined) {
    const failureStatus = error instanceof ApiError ? error.status : 0;
    const signedOut = isError && failureStatus === 401;
    // A 404 (and the unreachable settled-without-data case) is "no such
    // strategy", not a failure — blaming the user's URL for an outage is the
    // bug this branch exists to avoid.
    const missing = !isError || failureStatus === 404;

    return (
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="Strategy" />
        <Panel>
          <PanelState
            state={missing || signedOut ? 'empty' : 'error'}
            title={
              signedOut
                ? 'Sign in to view this strategy'
                : missing
                  ? 'Strategy not found'
                  : 'Could not load this strategy'
            }
            description={
              signedOut
                ? 'Your session has expired or you are signed out, so this strategy cannot be read.'
                : missing
                  ? 'This strategy does not exist, or it belongs to another account.'
                  : error instanceof Error
                    ? error.message
                    : 'The request failed before it reached the server.'
            }
            onRetry={missing || signedOut ? undefined : () => void refetch()}
          />
          <div className="flex justify-center pb-6">
            <Link to="/strategies" className={buttonVariants({ variant: 'outline', size: 'md' })}>
              Back to Strategies
            </Link>
          </div>
        </Panel>
      </div>
    );
  }

  const totalPnl = toNumber(strategy.performance.totalPnl);
  const totalFees = toNumber(strategy.performance.totalFees);
  const slippageBps = toNumber(strategy.riskParams.slippageBps);
  const rebalanceBps = toNumber(strategy.settings.rebalanceThresholdBps);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        title={strategy.name}
        meta={
          <>
            <StrategyStatusBadge status={strategy.status} />
            <Badge variant="accent">
              {strategy.mode === 'portfolio' ? 'Portfolio' : 'Single trader'}
            </Badge>
          </>
        }
        description={
          <>
            {strategy.description ? <span className="block">{strategy.description}</span> : null}
            <span className="mt-1 block text-xs text-fg-tertiary">
              Created{' '}
              <time dateTime={strategy.createdAt}>{formatDateTime(strategy.createdAt)}</time>
              <span aria-hidden="true"> • </span>
              Updated{' '}
              <time dateTime={strategy.updatedAt}>{formatDateTime(strategy.updatedAt)}</time>
            </span>
          </>
        }
        actions={
          <>
            <Link to="/strategies" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Back to Strategies
            </Link>
            {nextStatus ? (
              <Button
                size="sm"
                variant="subtle"
                disabled={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ id, status: nextStatus })}
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
                {statusMutation.isPending
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
          </>
        }
      />

      {statusMutation.isError ? (
        <ErrorNotice
          className="mb-3"
          message={
            statusMutation.error instanceof Error
              ? statusMutation.error.message
              : 'The status change was rejected.'
          }
          onRetry={statusVariable ? () => statusMutation.mutate(statusVariable) : undefined}
        />
      ) : null}

      <StatGrid cols={4} className="mb-4">
        <StatCard
          label="Total PnL"
          value={formatPnL(totalPnl)}
          tone={totalPnl >= 0 ? 'up' : 'down'}
          hint="Realized, before fees"
        />
        <StatCard
          label="Total fees"
          value={formatUsdFull(totalFees)}
          tone="down"
          hint="Paid to the exchange"
        />
        <StatCard
          label="Net PnL (after fees)"
          value={formatPnL(summary.netPnl)}
          tone={summary.netPnl >= 0 ? 'up' : 'down'}
          hint={`Allocated PnL ${formatPnL(summary.allocatedPnl)} − fees`}
        />
        <StatCard
          label="Alignment rate"
          value={formatPercent(toNumber(strategy.performance.alignmentRate), 1)}
          hint="Mirrored exactly as intended"
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Trader allocations" />
          {strategy.allocations.length === 0 ? (
            <PanelState
              state="empty"
              title="No traders allocated"
              description="Without an allocation this strategy has nothing to copy."
            />
          ) : (
            <PanelBody className="space-y-2">
              {strategy.allocations.map((allocation) => {
                const address = allocation.trader?.address;
                const allocatedPnl = toNumber(allocation.performance.allocatedPnl);
                const idTitle = `Trader ID: ${allocation.traderId}`;

                return (
                  <div
                    key={allocation.traderId}
                    className="rounded-md bg-inset p-2.5"
                    title={
                      address ? idTitle : `${idTitle} — the API did not return a wallet address`
                    }
                  >
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      {address ? (
                        <Link
                          to="/traders/$address"
                          params={{ address }}
                          className="min-w-0 text-sm transition-colors hover:text-fg-accent"
                        >
                          <AddressText address={address} showCopy={false} />
                        </Link>
                      ) : (
                        <span className="text-xs text-fg-quaternary">Address unavailable</span>
                      )}
                      <span className="num shrink-0 text-sm font-medium">
                        {formatPercent(toNumber(allocation.weight) * 100, 0)}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
                      <div className="flex justify-between gap-2">
                        <dt className="text-fg-tertiary">Allocated PnL</dt>
                        <dd className={cn('num', allocatedPnl >= 0 ? 'text-up' : 'text-down')}>
                          {formatPnL(allocatedPnl)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-fg-tertiary">Allocated fees</dt>
                        <dd className="num text-fg-secondary">
                          {formatUsdFull(toNumber(allocation.performance.allocatedFees))}
                        </dd>
                      </div>
                    </dl>
                  </div>
                );
              })}
            </PanelBody>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Strategy settings" />
          <PanelBody>
            <dl className="divide-y divide-border text-sm">
              <SettingRow
                label="Mode"
                value={strategy.mode === 'portfolio' ? 'Portfolio' : 'Single trader'}
              />
              <SettingRow
                label="Max leverage"
                value={`${toNumber(strategy.riskParams.maxLeverage).toFixed(1)}x`}
              />
              {strategy.riskParams.maxPositionUsd ? (
                <SettingRow
                  label="Max position"
                  value={formatUsdFull(toNumber(strategy.riskParams.maxPositionUsd))}
                />
              ) : null}
              <SettingRow
                label="Slippage tolerance"
                value={`${slippageBps} bps (${formatPercent(slippageBps / 100, 2)})`}
              />
              <SettingRow
                label="Min order size"
                value={formatUsdFull(toNumber(strategy.riskParams.minOrderUsd))}
              />
              <SettingRow
                label="Follow new entries only"
                value={strategy.settings.followNewEntriesOnly ? 'Yes' : 'No'}
              />
              <SettingRow
                label="Auto rebalance"
                value={strategy.settings.autoRebalance ? 'Yes' : 'No'}
              />
              {strategy.settings.autoRebalance ? (
                <SettingRow
                  label="Rebalance threshold"
                  value={`${rebalanceBps} bps (${formatPercent(rebalanceBps / 100, 2)})`}
                />
              ) : null}
            </dl>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
