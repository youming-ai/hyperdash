import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  DollarSign,
  ExternalLink,
  TrendingUp,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { z } from 'zod';

import { drawdownTone, drawdownValue, pnlTone, sharpeTone } from '~/components/trader-metrics';
import { AddressText } from '~/components/ui/address';
import { Badge } from '~/components/ui/badge';
import { buttonVariants } from '~/components/ui/button';
import { PageHeader } from '~/components/ui/page-header';
import { Panel, PanelBody, PanelHeader } from '~/components/ui/panel';
import { StatCard, StatGrid, TONE_TEXT_CLASS, type Tone } from '~/components/ui/stat-card';
import { ErrorNotice, PanelState, SkeletonBlock, SkeletonRows } from '~/components/ui/state';
import { type SortOrder, TableWrap, Td, Th } from '~/components/ui/table';
import { ApiError, api, readJson } from '~/lib/api-client';
import {
  cn,
  EM_DASH,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatPnL,
  formatPrice,
  formatQty,
  formatRelativeTime,
  formatUsd,
  isRecentlyActive,
  toNumber,
  toNumberOrNull,
} from '~/lib/utils';

/** A Hyperliquid account address: 0x + 40 hex characters. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export const Route = createFileRoute('/traders/$address')({
  parseParams: (params) => ({
    address: z
      .string()
      .regex(ADDRESS_PATTERN, 'Expected a 0x-prefixed 40-character hex address')
      .parse(params.address),
  }),
  component: TraderDetailPage,
  errorComponent: TraderRouteError,
  notFoundComponent: TraderRouteNotFound,
});

/** Closed trades requested per page. The endpoint has no `offset`, so the
 *  panel states how many of the trader's total closed trades are on screen. */
const TRADES_LIMIT = 25;
const HYPERLIQUID_EXPLORER = 'https://app.hyperliquid.xyz/explorer/address';
/** Named activity thresholds — no magic numbers buried in a ternary chain. */
const ACTIVITY_LEVELS = { veryHigh: 1000, high: 500 } as const;
/** Stable keys for the eight stat placeholders in the loading skeleton. */
const SKELETON_STAT_KEYS = [
  'equity',
  'pnl-7d',
  'pnl-30d',
  'win-rate',
  'sharpe',
  'drawdown',
  'trades',
  'position-size',
] as const;

// ---------------------------------------------------------------------------
// Response shapes (the API returns DB numerics as strings)
// ---------------------------------------------------------------------------

interface RawTrader {
  address: string;
  traderId: string;
  nickname?: string | null;
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
  longTrades?: number | null;
  shortTrades?: number | null;
  avgPositionSizeUsd?: string | number | null;
  avgHoldTimeSeconds?: number | null;
}

interface TraderResponse {
  trader: RawTrader;
}

interface RawPosition {
  id: string;
  symbol: string;
  side: string;
  quantity: string | number;
  positionValueUsd: string | number;
  unrealizedPnl: string | number | null;
}

interface PositionsResponse {
  positions: RawPosition[];
}

interface RawTrade {
  id: string;
  symbol: string;
  side: string;
  size: string | number;
  entryPrice: string | number | null;
  exitPrice: string | number | null;
  pnl: string | number | null;
  closedAt: string | null;
}

interface TradesResponse {
  trades: RawTrade[];
  total: number;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

interface TraderDetail {
  address: string;
  traderId: string;
  nickname: string | null;
  isActive: boolean;
  lastTradeAt: string | null;
  equity: number;
  pnl7d: number | null;
  pnl30d: number | null;
  winRate: number | null;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  longTrades: number;
  shortTrades: number;
  avgPositionSizeUsd: number;
  avgHoldTimeSeconds: number | null;
}

interface Position {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  positionValueUsd: number;
  unrealizedPnl: number | null;
}

interface Trade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnl: number | null;
  closedAt: string | null;
}

interface StatConfig {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
  icon?: ReactNode;
}

interface StyleItem {
  label: string;
  value: string;
}

type PositionSortKey = 'symbol' | 'value' | 'pnl';
interface PositionSort {
  key: PositionSortKey;
  order: SortOrder;
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/** Activity band from the closed-trade count; no trades means no level. */
function activityLevel(totalTrades: number): string {
  if (totalTrades === 0) return EM_DASH;
  if (totalTrades >= ACTIVITY_LEVELS.veryHigh) return 'Very high';
  if (totalTrades >= ACTIVITY_LEVELS.high) return 'High';
  return 'Moderate';
}

function comparePositions(a: Position, b: Position, key: PositionSortKey): number {
  if (key === 'symbol') return a.symbol.localeCompare(b.symbol);
  const left = key === 'value' ? a.positionValueUsd : (a.unrealizedPnl ?? 0);
  const right = key === 'value' ? b.positionValueUsd : (b.unrealizedPnl ?? 0);
  return left - right;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function TraderDetailPage() {
  const { address } = Route.useParams();
  const [positionSort, setPositionSort] = useState<PositionSort>({ key: 'value', order: 'desc' });

  const profileQuery = useQuery({
    queryKey: ['trader', address],
    queryFn: async () =>
      readJson<TraderResponse>(
        await api.traders[':address'].$get({ param: { address } }),
        'Trader profile',
      ),
    staleTime: 30_000,
  });

  const positionsQuery = useQuery({
    queryKey: ['trader', address, 'positions'],
    queryFn: async () =>
      readJson<PositionsResponse>(
        await api.traders[':address'].positions.$get({ param: { address } }),
        'Trader positions',
      ),
    staleTime: 30_000,
  });

  const tradesQuery = useQuery({
    queryKey: ['trader', address, 'trades'],
    queryFn: async () =>
      readJson<TradesResponse>(
        await api.traders[':address'].trades.$get({
          param: { address },
          query: { limit: String(TRADES_LIMIT) },
        }),
        'Trade history',
      ),
    staleTime: 30_000,
  });

  const trader = useMemo<TraderDetail | null>(() => {
    const raw = profileQuery.data?.trader;
    if (!raw) return null;
    return {
      address: raw.address,
      traderId: raw.traderId,
      nickname: raw.nickname ?? null,
      isActive: isRecentlyActive(raw.lastTradeAt),
      lastTradeAt: raw.lastTradeAt,
      equity: toNumber(raw.equityUsd),
      pnl7d: toNumberOrNull(raw.pnl7d),
      pnl30d: toNumberOrNull(raw.pnl30d),
      winRate: toNumberOrNull(raw.winrate),
      sharpeRatio: toNumberOrNull(raw.sharpeRatio),
      maxDrawdown: toNumberOrNull(raw.maxDrawdown),
      totalTrades: toNumber(raw.totalTrades),
      winningTrades: toNumber(raw.winningTrades),
      losingTrades: toNumber(raw.losingTrades),
      longTrades: toNumber(raw.longTrades),
      shortTrades: toNumber(raw.shortTrades),
      avgPositionSizeUsd: toNumber(raw.avgPositionSizeUsd),
      avgHoldTimeSeconds: toNumberOrNull(raw.avgHoldTimeSeconds),
    };
  }, [profileQuery.data]);

  const positions = useMemo<Position[]>(() => {
    const rows = (positionsQuery.data?.positions ?? []).map<Position>((position) => ({
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      quantity: toNumber(position.quantity),
      positionValueUsd: toNumber(position.positionValueUsd),
      unrealizedPnl: toNumberOrNull(position.unrealizedPnl),
    }));
    const direction = positionSort.order === 'asc' ? 1 : -1;
    rows.sort((a, b) => direction * comparePositions(a, b, positionSort.key));
    return rows;
  }, [positionsQuery.data, positionSort]);

  const trades = useMemo<Trade[]>(
    () =>
      (tradesQuery.data?.trades ?? []).map<Trade>((trade) => ({
        id: trade.id,
        symbol: trade.symbol,
        side: trade.side.toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG',
        size: toNumber(trade.size),
        entryPrice: toNumberOrNull(trade.entryPrice),
        exitPrice: toNumberOrNull(trade.exitPrice),
        pnl: toNumberOrNull(trade.pnl),
        closedAt: trade.closedAt,
      })),
    [tradesQuery.data],
  );

  const tradesTotal = tradesQuery.data?.total ?? trades.length;

  const stats = useMemo<StatConfig[]>(() => {
    if (!trader) return [];
    const drawdown = drawdownValue(trader.maxDrawdown);
    return [
      {
        label: 'Equity',
        value: formatUsd(trader.equity),
        icon: <DollarSign aria-hidden="true" />,
      },
      {
        label: '7d PnL',
        value: formatPnL(trader.pnl7d ?? Number.NaN),
        tone: pnlTone(trader.pnl7d),
        icon: <Activity aria-hidden="true" />,
      },
      {
        label: '30d PnL',
        value: formatPnL(trader.pnl30d ?? Number.NaN),
        tone: pnlTone(trader.pnl30d),
        icon: <BarChart3 aria-hidden="true" />,
      },
      {
        label: 'Win rate',
        value: formatPercent(trader.winRate),
        hint: `${formatNumber(trader.winningTrades)}W / ${formatNumber(trader.losingTrades)}L`,
      },
      {
        label: 'Sharpe',
        value: trader.sharpeRatio === null ? EM_DASH : formatNumber(trader.sharpeRatio, 2),
        tone: sharpeTone(trader.sharpeRatio),
      },
      {
        label: 'Max drawdown',
        value: formatPercent(drawdown),
        hint: 'Peak-to-trough equity decline',
        tone: drawdownTone(drawdown),
        icon: <AlertTriangle aria-hidden="true" />,
      },
      { label: 'Total trades', value: formatNumber(trader.totalTrades) },
      { label: 'Avg position size', value: formatUsd(trader.avgPositionSizeUsd) },
    ];
  }, [trader]);

  const styleItems = useMemo<StyleItem[]>(() => {
    if (!trader) return [];
    const hasTrades = trader.totalTrades > 0;
    return [
      {
        label: 'Long vs short',
        value: `${formatNumber(trader.longTrades)}L / ${formatNumber(trader.shortTrades)}S`,
      },
      {
        label: 'Avg holding time',
        value: hasTrades ? formatDuration(trader.avgHoldTimeSeconds) : EM_DASH,
      },
      {
        label: 'Long bias',
        value: hasTrades
          ? formatPercent((trader.longTrades / trader.totalTrades) * 100, 0)
          : EM_DASH,
      },
      { label: 'Activity level', value: activityLevel(trader.totalTrades) },
    ];
  }, [trader]);

  function togglePositionSort(key: PositionSortKey) {
    setPositionSort((previous) =>
      previous.key === key
        ? { key, order: previous.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: key === 'symbol' ? 'asc' : 'desc' },
    );
  }

  if (profileQuery.isPending) return <TraderProfileSkeleton />;

  const isMissing =
    profileQuery.isError &&
    profileQuery.error instanceof ApiError &&
    profileQuery.error.status === 404;

  // A successful response without a trader body is also "not found", not an error.
  if (isMissing || (!profileQuery.isError && trader === null)) {
    return <TraderNotFound address={address} />;
  }

  if (trader === null) {
    return (
      <div>
        <BackToLeaderboard />
        <Panel className="mt-3">
          <PanelState
            state="error"
            title="Could not load this trader"
            description={
              profileQuery.error instanceof Error
                ? profileQuery.error.message
                : 'The traders API did not respond.'
            }
            onRetry={() => void profileQuery.refetch()}
          />
        </Panel>
      </div>
    );
  }

  return (
    <div>
      <BackToLeaderboard />

      {/* A refresh can fail while stale data is still on screen — say so loudly. */}
      {profileQuery.isError ? (
        <ErrorNotice
          className="mb-3"
          message="The latest trader refresh failed. The values below are from the last successful load."
          onRetry={() => void profileQuery.refetch()}
        />
      ) : null}

      <PageHeader
        title={<AddressText address={trader.address} chars={10} />}
        meta={
          <>
            {trader.nickname ? <Badge variant="accent">{trader.nickname}</Badge> : null}
            {trader.isActive ? <Badge variant="up">Active</Badge> : <Badge>Inactive</Badge>}
            <a
              href={`${HYPERLIQUID_EXPLORER}/${trader.address}`}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}
            >
              <ExternalLink aria-hidden="true" />
              Explorer
            </a>
          </>
        }
        description={
          <>
            Last trade{' '}
            <span title={formatDateTime(trader.lastTradeAt)}>
              {formatRelativeTime(trader.lastTradeAt)}
            </span>
            {trader.isActive ? ' · active in the last 7 days' : ' · no trades in 7 days'}
          </>
        }
        actions={
          <Link
            to="/strategies/new"
            search={{ trader: trader.address }}
            className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'w-full sm:w-auto')}
          >
            <TrendingUp aria-hidden="true" />
            Copy this trader
          </Link>
        }
      />

      <section aria-labelledby="performance-heading">
        <h2 id="performance-heading" className="panel-title mb-2">
          Performance
        </h2>
        <StatGrid cols={4}>
          {stats.map((stat) => (
            <StatCard
              key={stat.label}
              label={stat.label}
              value={stat.value}
              hint={stat.hint}
              tone={stat.tone}
              icon={stat.icon}
            />
          ))}
        </StatGrid>
      </section>

      <Panel className="mt-3" aria-labelledby="trading-style-heading">
        <PanelHeader title="Trading style" titleId="trading-style-heading" />
        <PanelBody>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {styleItems.map((item) => (
              <div key={item.label}>
                <dt className="panel-title">{item.label}</dt>
                <dd className="num mt-1 text-md font-medium">{item.value}</dd>
              </div>
            ))}
          </dl>
        </PanelBody>
      </Panel>

      <Panel className="mt-3" aria-labelledby="positions-heading">
        <PanelHeader
          title="Current positions"
          titleId="positions-heading"
          actions={
            <span className="text-2xs text-fg-quaternary">
              {positionsQuery.isPending ? 'loading' : `${formatNumber(positions.length)} open`}
            </span>
          }
        />
        {positionsQuery.isPending ? (
          <PanelState state="loading" title="Loading open positions…" />
        ) : positionsQuery.isError ? (
          <PanelState
            state="error"
            title="Could not load open positions"
            description={
              positionsQuery.error instanceof Error ? positionsQuery.error.message : undefined
            }
            onRetry={() => void positionsQuery.refetch()}
          />
        ) : positions.length === 0 ? (
          <PanelState
            state="empty"
            title="No open positions"
            description="This trader is flat right now — nothing is currently held on Hyperliquid."
          />
        ) : (
          <TableWrap label="Open positions" maxHeight="45vh">
            <table className="data-table">
              <thead>
                <tr>
                  <Th
                    sortable
                    active={positionSort.key === 'symbol'}
                    order={positionSort.order}
                    onSort={() => togglePositionSort('symbol')}
                  >
                    Symbol
                  </Th>
                  <Th>Side</Th>
                  <Th align="right" title="Position size in the traded asset">
                    Qty
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={positionSort.key === 'value'}
                    order={positionSort.order}
                    onSort={() => togglePositionSort('value')}
                  >
                    Value
                  </Th>
                  <Th
                    align="right"
                    sortable
                    active={positionSort.key === 'pnl'}
                    order={positionSort.order}
                    onSort={() => togglePositionSort('pnl')}
                    title="Unrealized profit and loss at the current mark price"
                  >
                    Unrealized PnL
                  </Th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={position.id}>
                    <Td className="font-medium">{position.symbol}</Td>
                    <Td>
                      <Badge variant={position.side.toLowerCase() === 'short' ? 'down' : 'up'}>
                        {position.side.toUpperCase()}
                      </Badge>
                    </Td>
                    <Td align="right">{formatQty(position.quantity)}</Td>
                    <Td align="right">{formatUsd(position.positionValueUsd)}</Td>
                    <Td align="right" className={TONE_TEXT_CLASS[pnlTone(position.unrealizedPnl)]}>
                      {formatPnL(position.unrealizedPnl ?? Number.NaN)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>

      <Panel className="mt-3" aria-labelledby="trades-heading">
        <PanelHeader
          title="Recent trade history"
          titleId="trades-heading"
          actions={
            <span className="text-2xs text-fg-quaternary">
              {tradesQuery.isPending
                ? 'loading'
                : `Showing ${formatNumber(trades.length)} of ${formatNumber(tradesTotal)}`}
            </span>
          }
        />
        {tradesQuery.isPending ? (
          <PanelState state="loading" title="Loading trade history…" />
        ) : tradesQuery.isError ? (
          <PanelState
            state="error"
            title="Could not load trade history"
            description={tradesQuery.error instanceof Error ? tradesQuery.error.message : undefined}
            onRetry={() => void tradesQuery.refetch()}
          />
        ) : trades.length === 0 ? (
          <PanelState
            state="empty"
            title="No closed trades yet"
            description="Closed round-trips appear here as the auto-ingest cycle records them."
          />
        ) : (
          <TableWrap label="Closed trade history" maxHeight="60vh">
            <table className="data-table">
              <thead>
                <tr>
                  <Th>Symbol</Th>
                  <Th>Side</Th>
                  <Th align="right" title="Position size in the traded asset">
                    Size
                  </Th>
                  <Th align="right">Entry</Th>
                  <Th align="right">Exit</Th>
                  <Th align="right">PnL</Th>
                  <Th align="right">Closed</Th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade) => (
                  <tr key={trade.id}>
                    <Td className="font-medium">{trade.symbol}</Td>
                    <Td>
                      <Badge variant={trade.side === 'SHORT' ? 'down' : 'up'}>{trade.side}</Badge>
                    </Td>
                    <Td align="right">{formatQty(trade.size)}</Td>
                    <Td
                      align="right"
                      title={trade.entryPrice === null ? 'Entry price not recorded' : undefined}
                    >
                      {formatPrice(trade.entryPrice ?? Number.NaN)}
                    </Td>
                    <Td
                      align="right"
                      title={trade.exitPrice === null ? 'Trade not closed' : undefined}
                    >
                      {formatPrice(trade.exitPrice ?? Number.NaN)}
                    </Td>
                    <Td align="right" className={TONE_TEXT_CLASS[pnlTone(trade.pnl)]}>
                      {formatPnL(trade.pnl ?? Number.NaN)}
                    </Td>
                    <Td
                      align="right"
                      className="text-fg-tertiary"
                      title={trade.closedAt ? formatRelativeTime(trade.closedAt) : undefined}
                    >
                      {formatDateTime(trade.closedAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route-level states
// ---------------------------------------------------------------------------

function BackToLeaderboard() {
  return (
    <Link
      to="/traders"
      className="-my-1 mb-2 inline-flex min-h-7 items-center gap-1 rounded-sm px-1 -ml-1 text-xs text-fg-tertiary transition-colors hover:bg-raised hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Back to leaderboard
    </Link>
  );
}

function TraderProfileSkeleton() {
  return (
    <div>
      <SkeletonBlock className="h-7 w-56" />
      <SkeletonBlock className="mt-2 h-4 w-40" />
      <StatGrid cols={4} className="mt-4">
        {SKELETON_STAT_KEYS.map((key) => (
          <SkeletonBlock key={key} className="h-16 rounded-lg" />
        ))}
      </StatGrid>
      <SkeletonRows rows={8} className="mt-3" />
    </div>
  );
}

function TraderNotFound({ address }: { address: string }) {
  return (
    <div>
      <BackToLeaderboard />
      <Panel className="mt-3">
        <PanelState
          state="empty"
          title="Trader not found"
          description={
            <>
              We have no stats for <AddressText address={address} /> yet. The auto-ingest cycle adds
              traders as they trade on Hyperliquid.
            </>
          }
        />
      </Panel>
    </div>
  );
}

function TraderRouteError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div>
      <BackToLeaderboard />
      <Panel className="mt-3">
        <PanelState
          state="error"
          title="This trader page could not be opened"
          description="The address may be malformed, or the page failed to render. Returning to the leaderboard will get you unstuck."
          onRetry={() => {
            void router.invalidate();
            reset();
          }}
        />
        <p
          className="num truncate px-4 pb-4 text-center text-2xs text-fg-quaternary"
          title={error.message}
        >
          {error.message}
        </p>
      </Panel>
    </div>
  );
}

function TraderRouteNotFound() {
  return (
    <div>
      <BackToLeaderboard />
      <Panel className="mt-3">
        <PanelState
          state="empty"
          title="Trader not found"
          description="That address has no matching route on HyperDash."
        />
      </Panel>
    </div>
  );
}
