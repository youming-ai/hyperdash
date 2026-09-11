import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '~/lib/utils';

/**
 * Button.
 *
 * Sizes are 28 / 32 / 36px tall to match the reference terminal's control
 * rhythm. For routing links, compose `buttonVariants()` onto `<Link>` — this
 * avoids pretending to support Radix-style `asChild` slotting without a Slot.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors select-none cursor-pointer disabled:pointer-events-none disabled:opacity-45 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-[var(--accent-solid-hover)]',
        outline: 'border border-[var(--input)] bg-transparent hover:bg-raised text-foreground',
        ghost: 'bg-transparent hover:bg-raised text-fg-tertiary hover:text-foreground',
        subtle: 'bg-inset text-foreground hover:bg-raised',
        danger: 'bg-destructive text-destructive-foreground hover:opacity-90',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3 text-sm [&_svg]:size-3.5',
        lg: 'h-9 px-4 text-base [&_svg]:size-4',
        icon: 'h-8 w-8 [&_svg]:size-4',
        'icon-sm': 'h-7 w-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
