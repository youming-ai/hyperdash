import { useEffect, useRef, useState } from 'react';

import { Panel, PanelHeader } from '~/components/ui/panel';
import { FEED_COINS, getFeedClient } from '~/lib/feed-client';
import { cn, formatPrice, formatQty, formatTimeHms } from '~/lib/utils';

interface TapeTrade {
  id: number;
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
}

/** Shape published on the `trades:COIN` channels (the id is assigned here). */
type TapeTradePayload = Omit<TapeTrade, 'id'>;

/** Newest-first window; older rows fall off the end. */
const MAX_ROWS = 60;
/** Rows kept from each inbound batch — the feed bursts on reconnect. */
const ROWS_PER_BATCH = 8;
/** How often the client's socket state is re-read (it has no close event). */
const CONNECTION_POLL_MS = 5_000;

/**
 * LiveMarketTape — the real-time trade strip shown under the leaderboard.
 *
 * The panel chrome renders from first paint, so the connecting / reconnecting
 * state is visible exactly when it matters; the rows themselves are decorative
 * churn, so the strip is a `role="log"` with `aria-live="off"` rather than a
 * stream of announcements. Scrollable by keyboard as well as pointer.
 */
export function LiveMarketTape({ className }: { className?: string }) {
  const [trades, setTrades] = useState<TapeTrade[]>([]);
  const [connected, setConnected] = useState(false);
  const nextId = useRef(0);

  useEffect(() => {
    const client = getFeedClient();
    const channels = FEED_COINS.map((coin) => `trades:${coin}`);
    const syncConnection = () => setConnected(client.isConnected);

    client.subscribe(channels);
    syncConnection();

    const off = client.on((message) => {
      if (message.type !== 'data' || message.channel !== 'trades') return;
      const batch = (message.data as TapeTradePayload[])
        .slice(-ROWS_PER_BATCH)
        .reverse()
        .map((trade) => {
          nextId.current += 1;
          return { ...trade, id: nextId.current };
        });
      if (batch.length === 0) return;
      setTrades((previous) => [...batch, ...previous].slice(0, MAX_ROWS));
      setConnected(true);
    });

    void client.fetchState();
    const poll = setInterval(syncConnection, CONNECTION_POLL_MS);

    return () => {
      off();
      client.unsubscribe(channels);
      clearInterval(poll);
    };
  }, []);

  return (
    <Panel className={cn('mt-3', className)}>
      <PanelHeader
        title="Live market tape"
        actions={
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-2xs',
              connected ? 'text-success' : 'text-warning',
            )}
          >
            <span
              className={cn('status-dot', connected ? 'status-dot-live' : 'status-dot-warn')}
              aria-hidden="true"
            />
            {connected ? 'Feed live' : 'Reconnecting'}
          </span>
        }
      />
      {trades.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-fg-quaternary">
          {connected
            ? 'Connected — waiting for the first trades from the feed.'
            : 'Connecting to the live feed…'}
        </p>
      ) : (
        <div
          role="log"
          aria-live="off"
          aria-label="Live market tape"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the strip scrolls horizontally, so it must be keyboard-focusable to be scrollable without a pointer.
          tabIndex={0}
          className="scroll-x num flex gap-4 px-3 py-2"
        >
          {trades.map((trade) => {
            const price = formatPrice(Number.parseFloat(trade.px));
            const size = formatQty(Number.parseFloat(trade.sz));
            // Hyperliquid reports the taker side: 'A' = taker bought, 'B' = taker sold.
            const side = trade.side === 'A' ? 'buy' : 'sell';
            return (
              <div
                key={trade.id}
                title={`${formatTimeHms(trade.time)} · ${trade.coin} ${side} ${price} · ${size}`}
                className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs"
              >
                <span className="font-semibold text-fg-secondary">{trade.coin}</span>
                <span className={trade.side === 'A' ? 'text-up' : 'text-down'}>{price}</span>
                <span className="text-fg-quaternary">{size}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
