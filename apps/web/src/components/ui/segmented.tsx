import { type KeyboardEvent, type ReactNode, useRef } from 'react';

import { cn } from '~/lib/utils';

export interface SegmentedItem<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

/**
 * Segmented — an accessible view switcher implementing the WAI-ARIA tabs
 * pattern (roving tabindex + arrow/Home/End keys). Colour is never the only
 * state cue: the active tab carries `aria-selected` and a solid surface.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
  className,
  solid = false,
}: {
  items: ReadonlyArray<SegmentedItem<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  idBase: string;
  className?: string;
  solid?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = items.findIndex((item) => item.value === value);
    if (current < 0) return;
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('seg max-w-full overflow-x-auto', className)}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            data-active={selected}
            onClick={() => onChange(item.value)}
            className={cn('seg-item', solid && 'is-solid')}
          >
            {item.icon ? (
              <span className="[&_svg]:size-3.5" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
