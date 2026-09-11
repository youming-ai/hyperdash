import { Badge, type BadgeProps } from '~/components/ui/badge';

/**
 * The four states the strategies API reports.
 *
 * Declared once and shared: both the strategies list and the detail route type
 * their responses with it, so the badge receives a real union instead of
 * `string` and an unknown status has to be handled deliberately.
 */
export type StrategyStatus = 'active' | 'paused' | 'error' | 'terminated';

interface StatusMeta {
  label: string;
  variant: NonNullable<BadgeProps['variant']>;
}

/**
 * Module-level and frozen — the previous implementation rebuilt an identical
 * lookup object on every render of every row.
 *
 * `terminated` is a final state, not an idle one, so it deliberately does not
 * share `paused`'s neutral treatment: a badge-warning tone plus a distinct
 * label is what stops the two reading as the same thing.
 */
const STATUS_META: Readonly<Record<StrategyStatus, StatusMeta>> = Object.freeze({
  active: { label: 'Active', variant: 'up' },
  paused: { label: 'Paused', variant: 'neutral' },
  error: { label: 'Error', variant: 'down' },
  terminated: { label: 'Terminated', variant: 'warning' },
});

function isStrategyStatus(value: string): value is StrategyStatus {
  return Object.hasOwn(STATUS_META, value);
}

export function StrategyStatusBadge({
  status,
  className,
}: {
  status: StrategyStatus;
  className?: string;
}) {
  // The union is the contract, but a status added server-side must degrade to a
  // visible label rather than an empty badge.
  const known = isStrategyStatus(status);
  return (
    <Badge variant={known ? STATUS_META[status].variant : 'outline'} className={className}>
      {known ? STATUS_META[status].label : status}
    </Badge>
  );
}
