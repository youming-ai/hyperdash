import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '~/lib/utils';
import { Button } from './button';

/**
 * Stable keys for skeleton rows. Real keys rather than array indices keep
 * React from recycling shimmer nodes when the row count changes.
 */
const SKELETON_KEYS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'] as const;

/** Skeleton rows sized to the table they stand in for — no layout jump. */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-1.5 p-3', className)} aria-hidden="true">
      {SKELETON_KEYS.slice(0, rows).map((key, i) => (
        <div
          key={key}
          className="skeleton h-6"
          style={{ width: `${100 - (i % 3) * 8}%`, opacity: 1 - i * 0.06 }}
        />
      ))}
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" />;
}

/**
 * PanelState — the three states every data panel must distinguish:
 * loading, empty (a successful response with nothing in it) and error.
 *
 * Reporting a failed request as "no data" is the single most damaging UI bug
 * class in a trading app, so error is a first-class branch here.
 */
export function PanelState({
  state,
  title,
  description,
  onRetry,
  className,
}: {
  state: 'loading' | 'empty' | 'error';
  title: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  if (state === 'loading') {
    return (
      <div className={cn('p-3', className)} role="status" aria-busy="true">
        <span className="sr-only">{title}</span>
        <div className="space-y-1.5">
          {SKELETON_KEYS.slice(0, 5).map((key, i) => (
            <div key={key} className="skeleton h-6" style={{ opacity: 1 - i * 0.08 }} />
          ))}
        </div>
      </div>
    );
  }

  const isError = state === 'error';
  const Icon = isError ? AlertTriangle : Inbox;

  return (
    <div
      className={cn('flex flex-col items-center gap-2 px-4 py-10 text-center', className)}
      role={isError ? 'alert' : 'status'}
    >
      <Icon
        className={cn('size-5', isError ? 'text-destructive' : 'text-fg-quaternary')}
        strokeWidth={1.6}
        aria-hidden="true"
      />
      <p className={cn('text-sm font-medium', isError ? 'text-destructive' : 'text-fg-secondary')}>
        {title}
      </p>
      {description ? <p className="max-w-md text-xs text-fg-tertiary">{description}</p> : null}
      {isError && onRetry ? (
        <Button size="sm" variant="outline" className="mt-1" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Inline error line for panels that already render their own chrome. */
export function ErrorNotice({
  message,
  onRetry,
  className,
}: {
  message: ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)] px-2.5 py-1.5 text-xs text-destructive',
        className,
      )}
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry ? (
        <Button size="sm" variant="ghost" className="text-destructive" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
