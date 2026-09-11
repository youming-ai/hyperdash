import type { FeedCandle } from '@hyperdash/shared-types';
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { PanelState, SkeletonBlock } from '~/components/ui/state';
import {
  cn,
  EM_DASH,
  formatCompactNumber,
  formatDateTime,
  formatNumber,
  formatPrice,
  formatSignedPercent,
  formatTimeHms,
  toNumberOrNull,
} from '~/lib/utils';

/** Lifecycle of the candle history request, so the chart can look the part. */
export type ChartStatus = 'loading' | 'ready' | 'error';

interface CandlestickChartProps {
  candles: FeedCandle[];
  /** Market symbol — required so the accessible name is never generic. */
  symbol: string;
  timeframe?: string;
  /** Query lifecycle. `ready` + no candles renders the genuine empty state. */
  status?: ChartStatus;
  errorMessage?: string;
  onRetry?: () => void;
  /** A background refetch is in flight while bars are already on screen. */
  isRefreshing?: boolean;
  showVolume?: boolean;
}

interface Bar {
  key: string;
  x: number;
  up: boolean;
  hasWick: boolean;
  wickY1: number;
  wickY2: number;
  hasBody: boolean;
  bodyY: number;
  bodyH: number;
  bodyW: number;
  volumeY: number;
  volumeH: number;
  time: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

interface PriceTick {
  price: number;
  y: number;
  label: string;
}

interface TimeTick {
  x: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}

interface ChartModel {
  bars: Bar[];
  priceTicks: PriceTick[];
  timeTicks: TimeTick[];
  priceTop: number;
  priceBottom: number;
  firstTime: number;
  lastTime: number;
  lastClose: number | null;
  changePct: number | null;
}

/**
 * Real responsive pixel size of the plot frame. The chart previously derived
 * its height from a 1000x360 viewBox aspect ratio, which collapsed to ~123px
 * on a phone; measuring the frame lets the SVG fill an explicit CSS height and
 * keeps 1 SVG unit equal to 1px, so axis text never stretches.
 */
function useFrameSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { ref, width: size.width, height: size.height };
}

const FRAME_CLASS = 'relative h-[240px] md:h-[320px] lg:h-[380px]';
const FALLBACK_WIDTH = 800;
const FALLBACK_HEIGHT = 320;
/** Bottom strip reserved for the x-axis time labels. */
const AXIS_HEIGHT = 16;
const TOP_PAD = 10;
const VOLUME_FRACTION = 0.22;

/**
 * Lightweight SVG candlestick chart. No charting dependency — candlesticks,
 * wicks and optional volume bars are drawn directly.
 *
 * Direction is never colour-only: up candles are filled, down candles are
 * hollow, and the header carries a matching legend. All colours resolve from
 * theme tokens so light mode renders correctly.
 */
export function CandlestickChart({
  candles,
  symbol,
  timeframe = '1m',
  status = 'ready',
  errorMessage,
  onRetry,
  isRefreshing = false,
  showVolume = true,
}: CandlestickChartProps) {
  const { ref, width, height } = useFrameSize();
  const [active, setActive] = useState<number | null>(null);
  const [keyboardMode, setKeyboardMode] = useState(false);

  const w = width || FALLBACK_WIDTH;
  const h = height || FALLBACK_HEIGHT;

  const model = useMemo<ChartModel | null>(() => {
    const sorted = [...candles].sort((a, b) => a.t - b.t);
    if (sorted.length === 0) return null;

    const volumes: number[] = [];
    let max = Number.NEGATIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    for (const candle of sorted) {
      const high = toNumberOrNull(candle.h);
      const low = toNumberOrNull(candle.l);
      if (high !== null) max = Math.max(max, high);
      if (low !== null) min = Math.min(min, low);
      const volume = toNumberOrNull(candle.v);
      if (volume !== null) volumes.push(volume);
    }
    if (!Number.isFinite(max) || !Number.isFinite(min)) return null;

    const volumeArea = showVolume ? (h - AXIS_HEIGHT) * VOLUME_FRACTION : 0;
    const priceTop = TOP_PAD;
    const priceBottom = h - AXIS_HEIGHT - volumeArea;

    const range = max - min || Math.max(Math.abs(max) * 0.001, 1);
    const pad = range * 0.06;
    const span = range + pad * 2;
    const yOf = (price: number) =>
      priceBottom - ((price - min + pad) / span) * (priceBottom - priceTop);

    const slot = w / sorted.length;
    const bodyW = Math.max(1, slot * 0.7);
    const volumeMax = Math.max(1, ...volumes);

    const bars: Bar[] = sorted.map((candle, index) => {
      const open = toNumberOrNull(candle.o);
      const close = toNumberOrNull(candle.c);
      const high = toNumberOrNull(candle.h);
      const low = toNumberOrNull(candle.l);
      const volume = toNumberOrNull(candle.v);
      const openY = open === null ? null : yOf(open);
      const closeY = close === null ? null : yOf(close);
      const bodyTop = openY === null || closeY === null ? null : Math.min(openY, closeY);
      const volumeH = volume === null ? 0 : (volume / volumeMax) * volumeArea;
      return {
        key: `${candle.t}-${index}`,
        x: (index + 0.5) * slot,
        up: open === null || close === null ? true : close >= open,
        hasWick: high !== null && low !== null,
        wickY1: high === null ? 0 : yOf(high),
        wickY2: low === null ? 0 : yOf(low),
        hasBody: bodyTop !== null,
        bodyY: bodyTop ?? 0,
        bodyH: openY === null || closeY === null ? 0 : Math.max(1, Math.abs(closeY - openY)),
        bodyW,
        volumeY: h - AXIS_HEIGHT - volumeH,
        volumeH,
        time: candle.t,
        open,
        high,
        low,
        close,
        volume,
      };
    });

    // Ticks are placed at nice multiples of the price step and positioned with
    // the same mapping as the candles, so a label always sits on its gridline.
    const step = niceStep(range / 4);
    const digits = Math.max(0, Math.min(8, -Math.floor(Math.log10(step))));
    const priceTicks: PriceTick[] = [];
    for (
      let i = Math.ceil(min / step);
      i <= Math.floor(max / step) && priceTicks.length < 10;
      i++
    ) {
      const price = i * step;
      priceTicks.push({ price, y: yOf(price), label: formatNumber(price, digits) });
    }
    if (priceTicks.length === 0) {
      const mid = (min + max) / 2;
      priceTicks.push({ price: mid, y: yOf(mid), label: formatNumber(mid, digits) });
    }

    const lastIndex = sorted.length - 1;
    const timeIndexes = [...new Set([0, Math.floor(lastIndex / 2), lastIndex])];
    const timeTicks: TimeTick[] = timeIndexes.map((index) => ({
      x: bars[index].x,
      label: formatTimeHms(bars[index].time).slice(0, 5),
      anchor: index === 0 ? 'start' : index === lastIndex ? 'end' : 'middle',
    }));

    const firstOpen = bars[0].open;
    const lastClose = bars[lastIndex].close;
    const changePct =
      firstOpen !== null && firstOpen > 0 && lastClose !== null
        ? ((lastClose - firstOpen) / firstOpen) * 100
        : null;

    return {
      bars,
      priceTicks,
      timeTicks,
      priceTop,
      priceBottom,
      firstTime: bars[0].time,
      lastTime: bars[lastIndex].time,
      lastClose,
      changePct,
    };
  }, [candles, w, h, showVolume]);

  if (status === 'loading') {
    return (
      <div className="flex flex-col" role="status" aria-busy="true">
        <span className="sr-only">Loading {symbol} candles…</span>
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          <SkeletonBlock className="h-3 w-40" />
          <SkeletonBlock className="h-3 w-24" />
        </div>
        <div className="border-b border-border px-3 py-1">
          <SkeletonBlock className="h-2.5 w-56" />
        </div>
        <div ref={ref} className={cn(FRAME_CLASS, 'p-3')}>
          <SkeletonBlock className="h-full w-full" />
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          <span className="text-xs font-medium text-fg-secondary">
            {symbol} · {timeframe}
          </span>
          <span className="text-2xs text-fg-quaternary">unavailable</span>
        </div>
        <div ref={ref} className={cn(FRAME_CLASS, 'border-b border-border')}>
          <PanelState
            state="error"
            title={`${symbol} candles unavailable`}
            description={errorMessage ?? 'The candle history request failed.'}
            onRetry={onRetry}
            className="h-full justify-center"
          />
        </div>
      </div>
    );
  }

  if (!model) {
    return (
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          <span className="text-xs font-medium text-fg-secondary">
            {symbol} · {timeframe}
          </span>
          <span className="text-2xs text-fg-quaternary">no bars</span>
        </div>
        <div ref={ref} className={cn(FRAME_CLASS, 'border-b border-border')}>
          <PanelState
            state="empty"
            title={`No ${timeframe} candles for ${symbol} yet`}
            description="The feed answered successfully but returned no candle history for this market."
            className="h-full justify-center"
          />
        </div>
      </div>
    );
  }

  const safeActive = active !== null && active < model.bars.length ? active : null;
  const lastBar = model.bars[model.bars.length - 1];
  const readout = safeActive === null ? lastBar : model.bars[safeActive];
  const changeText = formatSignedPercent(model.changePct);
  const changeTone =
    model.changePct === null ? 'text-fg-tertiary' : model.changePct >= 0 ? 'text-up' : 'text-down';
  const lastPriceText = model.lastClose === null ? EM_DASH : formatPrice(model.lastClose);
  const rangeLabel = `${formatDateTime(model.firstTime)} → ${formatDateTime(model.lastTime)} UTC`;
  const chartLabel = `${symbol} ${timeframe} candlestick chart. ${model.bars.length} bars, ${rangeLabel}. Last ${lastPriceText}, ${changeText} versus the first bar's open.`;

  const readoutPrice = {
    open: readout.open === null ? EM_DASH : formatPrice(readout.open),
    high: readout.high === null ? EM_DASH : formatPrice(readout.high),
    low: readout.low === null ? EM_DASH : formatPrice(readout.low),
    close: readout.close === null ? EM_DASH : formatPrice(readout.close),
    volume: readout.volume === null ? EM_DASH : formatCompactNumber(readout.volume),
  };
  const readoutLabel = `${formatDateTime(readout.time)} UTC — open ${readoutPrice.open}, high ${readoutPrice.high}, low ${readoutPrice.low}, close ${readoutPrice.close}, volume ${readoutPrice.volume}.`;

  const ohlc: Array<[string, string]> = [
    ['O', readoutPrice.open],
    ['H', readoutPrice.high],
    ['L', readoutPrice.low],
    ['C', readoutPrice.close],
    ['V', readoutPrice.volume],
  ];

  function handleMouseMove(event: MouseEvent<HTMLDivElement>) {
    const count = model?.bars.length ?? 0;
    if (count === 0) return;
    setKeyboardMode(false);
    const rect = event.currentTarget.getBoundingClientRect();
    const slot = rect.width / count;
    const index = Math.min(count - 1, Math.max(0, Math.floor((event.clientX - rect.left) / slot)));
    setActive(index);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const count = model?.bars.length ?? 0;
    if (count === 0) return;
    const current = safeActive ?? count - 1;
    let next: number;
    if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
    else if (event.key === 'ArrowRight') next = Math.min(count - 1, current + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else if (event.key === 'Escape') {
      setActive(null);
      return;
    } else return;
    event.preventDefault();
    setKeyboardMode(true);
    setActive(next);
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 py-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-fg-secondary">
              {symbol} · {timeframe}
            </span>
            {isRefreshing ? (
              <span className="text-2xs text-fg-quaternary" role="status">
                Updating…
              </span>
            ) : null}
          </div>
          <p className="truncate text-2xs text-fg-quaternary" title={rangeLabel}>
            {model.bars.length} bars · change measured from the first bar&apos;s open
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-1.5 text-2xs text-fg-tertiary">
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className="shrink-0">
              <rect width="8" height="8" rx="1" className="fill-up" />
            </svg>
            <span>Up</span>
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              aria-hidden="true"
              className="ml-1.5 shrink-0"
            >
              <rect x="0.5" y="0.5" width="7" height="7" rx="1" className="fill-none stroke-down" />
            </svg>
            <span>Down</span>
          </div>
          <span
            className="num text-sm font-medium text-foreground"
            title={`Last close ${lastPriceText} vs first bar open at ${formatDateTime(model.firstTime)} UTC`}
          >
            {lastPriceText} <span className={changeTone}>{changeText}</span>
          </span>
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-y border-border px-3 py-1 text-2xs"
        aria-live={keyboardMode ? 'polite' : 'off'}
      >
        <span className="num text-fg-tertiary" title={`${formatDateTime(readout.time)} UTC`}>
          {formatTimeHms(readout.time)}
        </span>
        {ohlc.map(([label, value]) => (
          <span key={label} className="num text-fg-quaternary">
            {label} <span className="text-fg-secondary">{value}</span>
          </span>
        ))}
      </div>

      <div
        ref={ref}
        className={cn(FRAME_CLASS, 'border-b border-border outline-none')}
        role="slider"
        aria-label={chartLabel}
        aria-valuemin={0}
        aria-valuemax={model.bars.length - 1}
        aria-valuenow={safeActive ?? model.bars.length - 1}
        aria-valuetext={readoutLabel}
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setActive(null)}
        onKeyDown={handleKeyDown}
        onBlur={() => setActive(null)}
      >
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label={chartLabel}
        >
          <title>{chartLabel}</title>

          {model.priceTicks.map((tick) => (
            <g key={`grid-${tick.price}`}>
              <line x1={0} x2={w} y1={tick.y} y2={tick.y} className="chart-grid" strokeWidth={1} />
              <text x={4} y={tick.y - 3} className="num fill-fg-quaternary text-2xs">
                {tick.label}
              </text>
            </g>
          ))}

          {safeActive !== null ? (
            <line
              x1={model.bars[safeActive].x}
              x2={model.bars[safeActive].x}
              y1={model.priceTop}
              y2={h - AXIS_HEIGHT}
              className="stroke-fg-quaternary"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
          ) : null}

          {model.bars.map((bar) => (
            <g key={bar.key}>
              {bar.hasWick ? (
                <line
                  x1={bar.x}
                  x2={bar.x}
                  y1={bar.wickY1}
                  y2={bar.wickY2}
                  className={bar.up ? 'stroke-up' : 'stroke-down'}
                  strokeWidth={1}
                />
              ) : null}
              {bar.hasBody ? (
                <rect
                  x={bar.x - bar.bodyW / 2}
                  y={bar.bodyY}
                  width={bar.bodyW}
                  height={bar.bodyH}
                  className={bar.up ? 'fill-up stroke-up' : 'fill-none stroke-down'}
                  strokeWidth={1}
                />
              ) : null}
              {showVolume && bar.volumeH > 0 ? (
                <rect
                  x={bar.x - bar.bodyW / 2}
                  y={bar.volumeY}
                  width={bar.bodyW}
                  height={bar.volumeH}
                  className={bar.up ? 'fill-up' : 'fill-down'}
                  opacity={0.28}
                />
              ) : null}
            </g>
          ))}

          {model.timeTicks.map((tick) => (
            <text
              key={`time-${tick.x}`}
              x={tick.x}
              y={h - 4}
              textAnchor={tick.anchor}
              className="num fill-fg-tertiary text-2xs"
            >
              {tick.label}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  if (unit < 1.5) return pow;
  if (unit < 3) return 2 * pow;
  if (unit < 7) return 5 * pow;
  return 10 * pow;
}
