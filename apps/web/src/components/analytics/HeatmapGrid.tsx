import { memo, useMemo } from 'react';

import { Panel, PanelHeader, PanelState, TableWrap } from '~/components/ui';
import { cn } from '~/lib/utils';

/** One time bucket of a heatmap row. `hint` overrides the derived tooltip. */
export interface HeatmapCell {
  ts: number;
  value: number | null;
  hint?: string;
}

export interface HeatmapSeries {
  coin: string;
  label: string;
  cells: HeatmapCell[];
}

/** How a value maps onto colour: signed around zero, or a one-sided ramp. */
type HeatmapScale = 'diverging' | 'ramp';

/**
 * Query lifecycle a caller hands down. Without it a pending or failed request
 * is indistinguishable from a genuinely empty window — the bug this prop fixes.
 */
export type HeatmapStatus = 'loading' | 'empty' | 'error';

interface HeatmapGridProps {
  title: string;
  describe: string;
  series: HeatmapSeries[];
  scale: HeatmapScale;
  /** Value whose magnitude reaches full saturation on the `diverging` scale. */
  maxMag?: number;
  /** Value that reaches full saturation on the `ramp` scale. */
  maxScore?: number;
  columns?: string[];
  /** Noun for a cell value in tooltips and screen-reader text, e.g. "funding". */
  valueLabel: string;
  /**
   * Formats a value for legend ticks and cell text alternatives. Pass a
   * module-level function so `React.memo` below can actually skip renders.
   */
  formatValue: (value: number) => string;
  status?: HeatmapStatus;
  onRetry?: () => void;
  emptyLabel?: string;
  note?: string;
}

/** Beyond this many rows a heatmap stops informing and starts being a canvas. */
const MAX_ROWS = 30;
/** Roughly the number of time labels that fit before adjacent ones collide. */
const MAX_TIME_LABELS = 8;
/** Tint alpha at full saturation, and the faintest tint the one-sided ramp uses. */
const MAX_TINT = 0.85;
const RAMP_MIN_TINT = 0.15;

/** Saturation denominators must be positive and finite or every cell saturates. */
function saturation(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The whole colour scale, driven by the `scale` identifier — no per-render arrows. */
function tintFor(value: number, scale: HeatmapScale, maxMag: number, maxScore: number): string {
  if (scale === 'ramp') {
    const t = Math.min(1, Math.max(0, value / maxScore));
    const alpha = RAMP_MIN_TINT + t * (MAX_TINT - RAMP_MIN_TINT);
    return `hsl(var(--destructive) / ${alpha.toFixed(2)})`;
  }
  const t = Math.min(1, Math.max(-1, value / maxMag));
  return t < 0
    ? `hsl(var(--destructive) / ${(Math.abs(t) * MAX_TINT).toFixed(2)})`
    : `hsl(var(--success) / ${(t * MAX_TINT).toFixed(2)})`;
}

interface LegendTick {
  value: number;
  /** Non-colour sign cue so the scale survives colour blindness. */
  glyph: string;
}

function legendTicks(scale: HeatmapScale, maxMag: number, maxScore: number): LegendTick[] {
  if (scale === 'ramp') {
    return [
      { value: 0, glyph: '' },
      { value: maxScore / 2, glyph: '' },
      { value: maxScore, glyph: '' },
    ];
  }
  return [
    { value: -maxMag, glyph: '−' },
    { value: -maxMag / 2, glyph: '−' },
    { value: 0, glyph: '0' },
    { value: maxMag / 2, glyph: '+' },
    { value: maxMag, glyph: '+' },
  ];
}

/**
 * HeatmapGrid — rows of markets against a shared time axis.
 *
 * Ordered and capped here (one magnitude pass, one shared rule for every tab),
 * with a real `<thead>` time axis, a sticky market column, a sticky header, a
 * numeric legend and an `sr-only` text alternative on every cell.
 */
export const HeatmapGrid = memo(function HeatmapGrid({
  title,
  describe,
  series,
  scale,
  maxMag,
  maxScore,
  columns = [],
  valueLabel,
  formatValue,
  status = 'empty',
  onRetry,
  emptyLabel,
  note,
}: HeatmapGridProps) {
  const magCap = saturation(maxMag, 1);
  const scoreCap = saturation(maxScore, 1);

  const view = useMemo(() => {
    const populated: Array<HeatmapSeries & { magnitude: number }> = [];
    for (const row of series) {
      let magnitude = 0;
      let hasValue = false;
      for (const cell of row.cells) {
        if (cell.value === null) continue;
        hasValue = true;
        const abs = Math.abs(cell.value);
        if (abs > magnitude) magnitude = abs;
      }
      // A row that is empty across the whole window only pads the grid.
      if (hasValue) populated.push({ ...row, magnitude });
    }
    populated.sort((a, b) => b.magnitude - a.magnitude);
    return { rows: populated.slice(0, MAX_ROWS), total: populated.length };
  }, [series]);

  if (status === 'loading') {
    return (
      <Panel>
        <PanelHeader title={title} />
        <PanelState state="loading" title={`Loading ${title.toLowerCase()}`} />
      </Panel>
    );
  }

  if (status === 'error') {
    return (
      <Panel>
        <PanelHeader title={title} />
        <PanelState
          state="error"
          title={`Could not load ${title.toLowerCase()}`}
          description="The market feed did not respond. Check your connection and try again."
          onRetry={onRetry}
        />
      </Panel>
    );
  }

  if (view.rows.length === 0) {
    return (
      <Panel>
        <PanelHeader title={title} />
        <PanelState
          state="empty"
          title={emptyLabel ?? `No ${title.toLowerCase()} recorded yet.`}
          description={describe}
        />
      </Panel>
    );
  }

  const labelEvery = Math.max(1, Math.ceil(columns.length / MAX_TIME_LABELS));
  const ticks = legendTicks(scale, magCap, scoreCap);

  return (
    <Panel>
      <PanelHeader
        title={title}
        actions={
          <span className="text-2xs text-fg-quaternary">
            {view.total > view.rows.length
              ? `Showing ${view.rows.length} of ${view.total} markets`
              : `${view.total} markets`}
          </span>
        }
      />
      <p className="px-3 pt-2 text-xs text-fg-tertiary">{describe}</p>
      {note ? <p className="px-3 text-2xs text-fg-quaternary">{note}</p> : null}
      <TableWrap label={`${title} by market and time bucket`} className="p-3">
        <table
          className="data-table table-fixed w-full"
          // `.data-table` pins border-spacing to 0 outside the Tailwind layers,
          // so the heatmap gap has to be set inline to win the cascade.
          style={{ borderSpacing: '2px', borderCollapse: 'separate' }}
        >
          <caption className="sr-only">
            {`${title}. Rows are markets, columns are the last ${columns.length} time buckets. ${describe}`}
          </caption>
          <colgroup>
            <col className="w-20" />
            {/* A 24px floor keeps buckets readable on narrow screens; above it
                `table-fixed` shares the surplus, so wide screens never scroll. */}
            {columns.map((column) => (
              <col key={column} className="w-6" />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="sticky-col">
                Market
              </th>
              {columns.map((column, index) => (
                <th
                  key={column}
                  scope="col"
                  aria-label={column}
                  // `.data-table th` pins text-align outside the Tailwind
                  // layers, so the axis is centred inline to survive it.
                  style={{ textAlign: 'center' }}
                >
                  {index % labelEvery === 0 ? column : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.coin}>
                <th
                  scope="row"
                  // `top` is reset because `.data-table th` makes every `th`
                  // sticky to the top; a row header must only stick to the left.
                  style={{ top: 'auto' }}
                  className="sticky-col"
                >
                  {row.label}
                </th>
                {row.cells.map((cell, index) => {
                  const column = columns[index] ?? String(cell.ts);
                  const formatted = cell.value === null ? null : formatValue(cell.value);
                  return (
                    <td
                      key={cell.ts}
                      title={
                        cell.hint ?? `${row.label} ${column} · ${valueLabel} ${formatted ?? 'n/a'}`
                      }
                      className={cn('h-5 rounded-sm', cell.value === null && 'bg-inset')}
                      style={{
                        background:
                          cell.value === null
                            ? undefined
                            : tintFor(cell.value, scale, magCap, scoreCap),
                      }}
                    >
                      <span className="sr-only">
                        {formatted === null
                          ? `${row.label} ${column}: no ${valueLabel} recorded`
                          : `${row.label} ${column}: ${valueLabel} ${formatted}`}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-2xs text-fg-tertiary">
        <span className="sr-only">Colour scale</span>
        {ticks.map((tick) => (
          <span key={`tick-${tick.value}`} className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="size-3 rounded-sm border border-border"
              style={{ background: tintFor(tick.value, scale, magCap, scoreCap) }}
            />
            {tick.glyph ? (
              <span aria-hidden="true" className="text-fg-secondary">
                {tick.glyph}
              </span>
            ) : null}
            <span className="tabular-nums">{formatValue(tick.value)}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="size-3 rounded-sm border border-border bg-inset" />
          <span>no data</span>
        </span>
      </div>
    </Panel>
  );
});

/** Last N hourly buckets, oldest first, aligned to the top of the hour. */
export function lastNHourBuckets(hours: number): Array<{ ts: number }> {
  const now = Date.now();
  const buckets: Array<{ ts: number }> = [];
  for (let h = hours - 1; h >= 0; h--) {
    const ts = Math.floor(now / 3_600_000) * 3_600_000 - h * 3_600_000;
    buckets.push({ ts });
  }
  return buckets;
}
