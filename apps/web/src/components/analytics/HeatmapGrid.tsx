interface HeatmapProps {
  title: string;
  describe: string;
  series: Array<{
    coin: string;
    label: string;
    cells: Array<{ ts: number; value: number | null; hint?: string }>;
  }>;
  color: (value: number) => string;
  columns?: string[];
  emptyLabel?: string;
  legendNote?: string;
}

export function HeatmapGrid({
  title,
  describe,
  series,
  color,
  columns,
  emptyLabel,
  legendNote,
}: HeatmapProps) {
  if (series.length === 0) {
    return (
      <div className="panel p-10 text-center text-sm text-fg-tertiary">
        {emptyLabel ??
          `No ${title.toLowerCase()} history yet — the feed recorder needs to run for a while.`}
      </div>
    );
  }
  return (
    <div className="panel overflow-hidden">
      <div className="px-4 py-2.5 panel-header text-xs uppercase tracking-wide opacity-70">
        {title} {columns ? `· ${columns.length} buckets` : ''}
      </div>
      <div className="p-3 overflow-x-auto">
        <p className="text-xs opacity-50 mb-3">{describe}</p>
        {legendNote ? <p className="text-[11px] opacity-40 mb-2">{legendNote}</p> : null}
        <table className="border-separate border-spacing-[2px]">
          <tbody>
            {series.map((row) => (
              <tr key={row.coin}>
                <td className="pr-2 text-xs font-mono whitespace-nowrap">{row.coin}</td>
                {row.cells.map((cell) => (
                  <td
                    key={cell.ts}
                    title={
                      cell.hint ??
                      `${row.coin} ${new Date(cell.ts).toISOString().slice(0, 13)}:00 · ${cell.value === null ? 'n/a' : cell.value}`
                    }
                    className="w-8 h-8 rounded-sm border border-[hsl(var(--border))]"
                    style={{
                      background:
                        cell.value === null ? 'hsl(var(--muted) / 0.5)' : color(cell.value),
                    }}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** diverging: negative → red, positive → green (clamped to ±maxMag). */
export function diverging(maxMag: number) {
  return (value: number) => {
    const t = Math.max(-1, Math.min(1, value / maxMag));
    if (t < 0) return `hsl(var(--destructive) / ${(Math.abs(t) * 0.85).toFixed(2)})`;
    return `hsl(var(--success) / ${(t * 0.85).toFixed(2)})`;
  };
}

export function lastNHourBuckets(hours: number): Array<{ ts: number }> {
  const now = Date.now();
  const buckets: Array<{ ts: number }> = [];
  for (let h = hours - 1; h >= 0; h--) {
    const ts = Math.floor(now / 3_600_000) * 3_600_000 - h * 3_600_000;
    buckets.push({ ts });
  }
  return buckets;
}
