import type { FeedCandle } from '@hyperdash/shared-types';
import { useMemo } from 'react';

interface CandlestickChartProps {
  candles: FeedCandle[];
  height?: number;
  showVolume?: boolean;
}

const UP_COLOR = '#5cc09b';
const DOWN_COLOR = '#d44b62';
const GRID_COLOR = 'hsl(var(--border))';

/**
 * Lightweight SVG candlestick chart. No charting dependency — candlesticks,
 * wicks and optional volume bars are drawn directly.
 */
export function CandlestickChart({
  candles,
  height = 360,
  showVolume = true,
}: CandlestickChartProps) {
  const width = 1000; // internal coordinate space, scaled by CSS

  const model = useMemo(() => {
    const sorted = [...candles].sort((a, b) => a.t - b.t);
    if (sorted.length === 0) return null;
    const volumeMax = Math.max(1, ...sorted.map((c) => parseFloat(c.v)));
    const prices = sorted.flatMap((c) => [parseFloat(c.h), parseFloat(c.l)]);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = (max - min || 1) * 0.06;
    const chartBottom = showVolume ? height * 0.8 : height;
    // candle width is implicitly controlled by the viewBox
    const span = max - min + pad * 2;
    const yOf = (px: number) => chartBottom - ((px - min + pad) / span) * (chartBottom - 8);
    const xOf = (i: number) => (i + 0.5) * (width / sorted.length);

    const bars = sorted.map((c, i) => {
      const open = parseFloat(c.o);
      const close = parseFloat(c.c);
      const high = parseFloat(c.h);
      const low = parseFloat(c.l);
      const up = close >= open;
      const color = up ? UP_COLOR : DOWN_COLOR;
      const x = xOf(i);
      return {
        key: `${c.t}-${c.i}`,
        open,
        close,
        high,
        low,
        up,
        color,
        x,
        bodyY: Math.min(yOf(open), yOf(close)),
        bodyH: Math.max(1, Math.abs(yOf(close) - yOf(open))),
        wickY1: yOf(high),
        wickY2: yOf(low),
        volumeH: (parseFloat(c.v) / volumeMax) * (height * 0.18),
        time: c.t,
      };
    });

    return {
      bars,
      min,
      max,
      yOf,
      priceStep: niceStep((max - min) / 5),
      lastClose: sorted[sorted.length - 1]?.c ?? '0',
      lastChangePct:
        sorted.length > 1 && parseFloat(sorted[0].o) > 0
          ? ((parseFloat(sorted[sorted.length - 1]?.c ?? '0') - parseFloat(sorted[0].o)) /
              parseFloat(sorted[0].o)) *
            100
          : 0,
    };
  }, [candles, height, showVolume]);

  if (!model) {
    return (
      <div style={{ height }} className="flex items-center justify-center text-sm opacity-50">
        Waiting for candle data…
      </div>
    );
  }

  const gridYs = [0.2, 0.4, 0.6, 0.8].map((f) => height * f);

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-3 py-1.5 text-xs">
        <span className="opacity-70">1m candles · last {model.bars.length}</span>
        <span
          className={`font-mono font-semibold ${model.lastChangePct >= 0 ? 'text-success' : 'text-destructive'}`}
        >
          {model.lastClose} ({model.lastChangePct >= 0 ? '+' : ''}
          {model.lastChangePct.toFixed(2)}%)
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto select-none"
        style={{ maxHeight: height }}
        role="img"
        aria-label="Candlestick chart"
      >
        {gridYs.map((y) => (
          <g key={y}>
            <line x1={0} x2={width} y1={y} y2={y} stroke={GRID_COLOR} strokeWidth={1} />
            <text x={6} y={y - 4} fill="rgba(148,163,184,0.5)" fontSize={10}>
              {model
                .yOf(model.max - (y / height) * (model.max - model.min))
                .toFixed(model.priceStep >= 1 ? 0 : 4)}
            </text>
          </g>
        ))}

        {model.bars.map((bar) => (
          <g key={bar.key}>
            <line
              x1={bar.x}
              x2={bar.x}
              y1={bar.wickY1}
              y2={bar.wickY2}
              stroke={bar.color}
              strokeWidth={1}
            />
            <rect x={bar.x - 1} y={bar.bodyY} width={2} height={bar.bodyH} fill={bar.color} />
            {showVolume && (
              <rect
                x={bar.x - 1}
                y={height - bar.volumeH}
                width={2}
                height={bar.volumeH}
                fill={bar.color}
                opacity={0.25}
              />
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  if (unit < 1.5) return pow;
  if (unit < 3) return 2 * pow;
  if (unit < 7) return 5 * pow;
  return 10 * pow;
}
