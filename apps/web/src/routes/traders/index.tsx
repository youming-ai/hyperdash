import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { LiveMarketTape } from '~/components/LiveMarketTape';
import { drawdownTone, drawdownValue, pnlTone, sharpeTone } from '~/components/trader-metrics';
import { AddressText } from '~/components/ui/address';
import { Button, buttonVariants } from '~/components/ui/button';
import { PageHeader } from '~/components/ui/page-header';
import { Panel, PanelHeader } from '~/components/ui/panel';
import { Segmented, type SegmentedItem } from '~/components/ui/segmented';
import { TONE_TEXT_CLASS } from '~/components/ui/stat-card';
import { PanelState } from '~/components/ui/state';
import { type SortOrder, TableWrap, Td, Th } from '~/components/ui/table';
import { api, readJson } from '~/lib/api-client';
import {
  cn,
  EM_DASH,
  formatNumber,
  formatPercent,
  formatPnL,
  formatUsd,
  isRecentlyActive,
  toNumber,
  toNumberOrNull,
} from '~/lib/utils';

export const Route = createFileRoute('/traders/')({
  component: TradersPage,
});

type Timeframe = '7d' | '30d' | 'all';
type SortBy = 'pnl' | 'winrate' | 'trades' | 'sharpe';

interface Trader {
  rank: number;
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

interface TradersListResponse {
  traders: Trader[];
}

/** Server-side page size; the API caps `limit` at 100 and supports `offset`. */
const PAGE_SIZE = 50;
const TIMEFRAME_TABS_ID = 'leaderboard-timeframe';
/** `#` column width; the pinned trader column starts exactly after it. */
const RANK_COLUMN_WIDTH = 56;
/** Below this magnitude a Sharpe ratio is noise, so it stays uncoloured. */
const TIMEFRAMES: ReadonlyArray<SegmentedItem<Timeframe>> = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: 'all', label: 'All time' },
];

function TradersPage() {
  const [timeframe, setTimeframe] = useState<Timeframe>('7d');
  const [sortBy, setSortBy] = useState<SortBy>('pnl');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [offset, setOffset] = useState(0);

  const { data, isPending, isPlaceholderData, isError, error, refetch } = useQuery({
    queryKey: ['traders', { sortBy, sortOrder, timeframe, isActive: showActiveOnly, offset }],
    queryFn: async () =>
      readJson<TradersListResponse>(
        await api.traders.$get({
          query: {
            limit: String(PAGE_SIZE),
            offset: String(offset),
            sortBy,
            sortOrder,
            timeframe,
            isActive: showActiveOnly ? 'true' : 'false',
          },
        }),
        'Traders leaderboard',
      ),
    // Keep the current page on screen while the next one loads: sorting,
    // switching timeframe and paging must not blank the table.
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const traders = useMemo(() => data?.traders ?? [], [data]);

  const firstRank = traders[0]?.rank;
  const lastRank = traders[traders.length - 1]?.rank;
  const hasNextPage = traders.length === PAGE_SIZE;
  const showingLabel =
    firstRank === undefined || lastRank === undefined
      ? 'No traders in this view'
      : hasNextPage
        ? `Showing ${formatNumber(firstRank)}–${formatNumber(lastRank)} · more available`
        : `Showing ${formatNumber(firstRank)}–${formatNumber(lastRank)} of ${formatNumber(lastRank)}`;

  function selectTimeframe(next: Timeframe) {
    setTimeframe(next);
    setOffset(0);
  }

  function toggleSort(column: SortBy) {
    if (column === sortBy) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
    setOffset(0);
  }

  function toggleActiveOnly() {
    setShowActiveOnly((previous) => !previous);
    setOffset(0);
  }

  return (
    <div>
      <PageHeader
        title="Leaderboard"
        description="Top Hyperliquid traders, auto-discovered by real volume"
        actions={
          <>
            <Segmented
              items={TIMEFRAMES}
              value={timeframe}
              onChange={selectTimeframe}
              label="PnL timeframe"
              idBase={TIMEFRAME_TABS_ID}
            />
            <Button
              variant={showActiveOnly ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={showActiveOnly}
              title="Only traders with a trade in the last 7 days"
              onClick={toggleActiveOnly}
            >
              <span
                className={cn('status-dot', showActiveOnly ? 'status-dot-live' : 'status-dot-idle')}
                aria-hidden="true"
              />
              Active only
            </Button>
          </>
        }
      />

      <Panel aria-busy={isPending || isPlaceholderData}>
        <PanelHeader
          title="Trader leaderboard"
          actions={
            isPlaceholderData ? (
              <span className="text-2xs text-fg-quaternary">Updating…</span>
            ) : undefined
          }
        />

        {isPending ? (
          <PanelState state="loading" title="Loading traders…" />
        ) : isError ? (
          <PanelState
            state="error"
            title="Could not load the leaderboard"
            description={
              error instanceof Error ? error.message : 'The traders API did not respond.'
            }
            onRetry={() => void refetch()}
          />
        ) : traders.length === 0 ? (
          <PanelState
            state="empty"
            title="No traders yet"
            description="The auto-ingest cycle populates this from the live feed. Try another timeframe, or turn off Active only."
          />
        ) : (
          <>
            <p className="border-b border-border px-3 py-1.5 text-2xs text-fg-quaternary md:hidden">
              Swipe the table sideways — the rank and trader columns stay pinned.
            </p>
            <div id={`${TIMEFRAME_TABS_ID}-panel-${timeframe}`}>
              <TableWrap
                label="Trader leaderboard"
                maxHeight="68vh"
                className={cn('transition-opacity', isPlaceholderData && 'opacity-60')}
              >
                <table className="data-table">
                  <caption className="sr-only">
                    Traders ranked by the selected metric. Use the column headers to re-sort.
                  </caption>
                  <thead>
                    <tr>
                      <Th width={RANK_COLUMN_WIDTH} align="right" className="sticky-col min-w-14">
                        #
                      </Th>
                      <Th className="sticky-col left-14!">Trader</Th>
                      <Th align="right">Equity</Th>
                      <Th
                        align="right"
                        sortable
                        active={sortBy === 'pnl'}
                        order={sortOrder}
                        onSort={() => toggleSort('pnl')}
                      >
                        {timeframe === 'all' ? 'All PnL' : `${timeframe.toUpperCase()} PnL`}
                      </Th>
                      <Th
                        align="right"
                        sortable
                        active={sortBy === 'winrate'}
                        order={sortOrder}
                        onSort={() => toggleSort('winrate')}
                        title="Share of closed round-trips that were profitable"
                      >
                        Win rate
                      </Th>
                      <Th
                        align="right"
                        sortable
                        active={sortBy === 'trades'}
                        order={sortOrder}
                        onSort={() => toggleSort('trades')}
                        title="Completed round-trips (close fills) on record"
                      >
                        Trades
                      </Th>
                      <Th
                        align="right"
                        sortable
                        active={sortBy === 'sharpe'}
                        order={sortOrder}
                        onSort={() => toggleSort('sharpe')}
                        title="Risk-adjusted return; values under 0.5 are treated as noise and left uncoloured"
                      >
                        Sharpe
                      </Th>
                      <Th
                        align="right"
                        title="Maximum peak-to-trough equity decline over the trader's history"
                      >
                        Max DD
                      </Th>
                      <Th width={96} align="right" srOnly="Trader details" />
                    </tr>
                  </thead>
                  <tbody>
                    {traders.map((trader) => {
                      const active = isRecentlyActive(trader.lastTradeAt);
                      const pnl = pnlForTimeframe(trader, timeframe);
                      const sharpe = toNumberOrNull(trader.sharpeRatio);
                      const drawdown = drawdownValue(toNumberOrNull(trader.maxDrawdown));
                      return (
                        <tr key={trader.address}>
                          <Td align="right" className="sticky-col min-w-14 text-fg-quaternary">
                            {formatNumber(trader.rank)}
                          </Td>
                          <Td className="sticky-col left-14!">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'status-dot',
                                  active ? 'status-dot-live' : 'status-dot-idle',
                                )}
                                aria-hidden="true"
                              />
                              <span className="sr-only">
                                {active ? 'Active in the last 7 days' : 'No trades in 7 days'}
                              </span>
                              <Link
                                to="/traders/$address"
                                params={{ address: trader.address }}
                                aria-label={`Open trader ${trader.address}`}
                                className="-my-1.5 inline-flex min-h-7 items-center py-1.5 text-fg-secondary transition-colors hover:text-fg-accent"
                              >
                                <AddressText address={trader.address} showCopy={false} />
                              </Link>
                            </div>
                          </Td>
                          <Td align="right">{formatUsd(toNumber(trader.equityUsd))}</Td>
                          <Td
                            align="right"
                            className={cn('font-medium', TONE_TEXT_CLASS[pnlTone(pnl)])}
                          >
                            {pnl === null ? EM_DASH : formatPnL(pnl)}
                          </Td>
                          <Td align="right">{formatPercent(toNumberOrNull(trader.winrate))}</Td>
                          <Td align="right" className="text-fg-tertiary">
                            {formatNumber(toNumber(trader.totalTrades))}
                          </Td>
                          <Td align="right" className={TONE_TEXT_CLASS[sharpeTone(sharpe)]}>
                            {sharpe === null ? EM_DASH : formatNumber(sharpe, 2)}
                          </Td>
                          <Td align="right" className={TONE_TEXT_CLASS[drawdownTone(drawdown)]}>
                            {formatPercent(drawdown)}
                          </Td>
                          <Td align="right">
                            <Link
                              to="/traders/$address"
                              params={{ address: trader.address }}
                              aria-label={`View details for ${trader.address}`}
                              className={cn(
                                buttonVariants({ variant: 'ghost', size: 'sm' }),
                                'min-w-11 text-fg-accent hover:text-fg-accent',
                              )}
                            >
                              Details
                            </Link>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
              <span className="text-2xs text-fg-quaternary">{showingLabel}</span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasNextPage}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Panel>

      <LiveMarketTape />
    </div>
  );
}

/**
 * PnL for the selected window. `null` means "not reported" and renders as an
 * em dash, so a missing column never masquerades as a real `$0`.
 */
function pnlForTimeframe(trader: Trader, timeframe: Timeframe): number | null {
  if (timeframe === '30d') return toNumberOrNull(trader.pnl30d);
  if (timeframe === 'all') return toNumberOrNull(trader.pnlAll) ?? toNumberOrNull(trader.pnl30d);
  return toNumberOrNull(trader.pnl7d);
}
