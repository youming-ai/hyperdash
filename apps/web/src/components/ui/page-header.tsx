import type { ReactNode } from 'react';

import { cn } from '~/lib/utils';

/**
 * PageHeader — one title size, one spacing rhythm, and an actions slot that
 * wraps under the title on narrow viewports instead of overflowing.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="min-w-0 truncate text-2xl font-medium tracking-[-0.02em]">{title}</h1>
          {meta}
        </div>
        {description ? <p className="mt-1 text-sm text-fg-tertiary">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
