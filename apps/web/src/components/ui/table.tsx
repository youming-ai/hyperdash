import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '~/lib/utils';

/** Scroll container that keeps a wide table usable and keyboard-scrollable. */
export function TableWrap({
  children,
  className,
  label,
  maxHeight,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  maxHeight?: string;
}) {
  return (
    <section
      className={cn('overflow-auto', className)}
      style={maxHeight ? { maxHeight } : undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable, otherwise keyboard-only users cannot scroll a wide table.
      tabIndex={0}
      aria-label={label}
    >
      {children}
    </section>
  );
}

export type SortOrder = 'asc' | 'desc';

/**
 * Th — a real `scope="col"` header. When sortable it renders a <button> (not
 * a clickable <th>) and publishes `aria-sort`, so sorting is keyboard- and
 * screen-reader-reachable.
 */
export function Th({
  children,
  align = 'left',
  className,
  width,
  sortable = false,
  active = false,
  order = 'desc',
  onSort,
  title,
  srOnly,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  width?: number;
  sortable?: boolean;
  active?: boolean;
  order?: SortOrder;
  onSort?: () => void;
  title?: string;
  srOnly?: string;
}) {
  const ariaSort = !sortable
    ? undefined
    : active
      ? order === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none';

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      title={title}
      style={width ? { width } : undefined}
      className={cn(align === 'right' && 'text-right', className)}
    >
      {srOnly ? <span className="sr-only">{srOnly}</span> : null}
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            'inline-flex min-h-7 items-center gap-1 rounded-sm px-1 -mx-1 uppercase tracking-[0.06em] hover:text-foreground cursor-pointer',
            align === 'right' && 'flex-row-reverse',
            active && 'text-fg-accent',
          )}
        >
          {children}
          {active ? (
            order === 'asc' ? (
              <ArrowUp className="size-3" aria-hidden="true" />
            ) : (
              <ArrowDown className="size-3" aria-hidden="true" />
            )
          ) : (
            <ArrowUpDown className="size-3 opacity-50" aria-hidden="true" />
          )}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
  title,
  colSpan,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  title?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} title={title} className={cn(align === 'right' && 'num-col', className)}>
      {children}
    </td>
  );
}
