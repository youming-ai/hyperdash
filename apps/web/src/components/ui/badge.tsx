import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '~/lib/utils';

/**
 * Badge — the single badge primitive. Direction is communicated by the label
 * and an optional icon, never by colour alone.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 h-[18px] text-2xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'text-fg-tertiary bg-raised',
        outline: 'text-fg-secondary border border-[var(--border-strong)]',
        accent: 'text-fg-accent bg-[color-mix(in_oklab,var(--accent)_14%,transparent)]',
        up: 'text-up bg-[color-mix(in_oklab,var(--up)_14%,transparent)]',
        down: 'text-down bg-[color-mix(in_oklab,var(--down)_14%,transparent)]',
        warning: 'text-warning bg-[color-mix(in_oklab,var(--warning)_14%,transparent)]',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
