import type { ReactNode } from 'react';

import { cn } from '~/lib/utils';

/**
 * Panel — the one elevated surface. Replaces the five hand-rolled copies of
 * panel chrome that drifted apart across routes.
 */
export function Panel({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('panel overflow-hidden', className)} {...rest}>
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  actions,
  className,
  titleId,
  as: Heading = 'h2',
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
  as?: 'h2' | 'h3';
}) {
  return (
    <div className={cn('panel-header', className)}>
      <Heading id={titleId} className="panel-title min-w-0 truncate">
        {title}
      </Heading>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-3', className)}>{children}</div>;
}
