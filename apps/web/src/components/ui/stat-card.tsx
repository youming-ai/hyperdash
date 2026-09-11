import type { ReactNode } from 'react';

import { cn } from '~/lib/utils';

export type Tone = 'neutral' | 'up' | 'down' | 'accent';

/**
 * Tone → text colour. Exported so table cells can colour a value by the same
 * tone a `StatCard` would use, instead of mapping it a second time.
 */
export const TONE_TEXT_CLASS: Record<Tone, string> = {
  neutral: 'text-foreground',
  up: 'text-up',
  down: 'text-down',
  accent: 'text-fg-accent',
};

/**
 * StatCard — one metric tile. Replaces the four divergent StatCard
 * implementations that had grown across the trader and strategy routes.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('panel p-3', className)}>
      <div className="flex items-center gap-1.5">
        {icon ? <span className="text-fg-quaternary [&_svg]:size-3.5">{icon}</span> : null}
        <span className="panel-title truncate">{label}</span>
      </div>
      <div className={cn('num mt-2 text-xl leading-none', TONE_TEXT_CLASS[tone])}>{value}</div>
      {hint ? <div className="mt-1.5 truncate text-2xs text-fg-quaternary">{hint}</div> : null}
    </div>
  );
}

/** Responsive grid that never forces more than two columns on a phone. */
export function StatGrid({
  children,
  className,
  cols = 4,
}: {
  children: ReactNode;
  className?: string;
  cols?: 3 | 4 | 5;
}) {
  const lg = cols === 3 ? 'lg:grid-cols-3' : cols === 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-4';
  return (
    <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3', lg, className)}>{children}</div>
  );
}
