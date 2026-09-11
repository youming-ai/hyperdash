import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { cn, shortenAddress } from '~/lib/utils';

/**
 * AddressText — one representation for an on-chain address everywhere.
 * The full value is always available via `title`, a copy control and a
 * `data-address` attribute, so truncation never hides information.
 */
export function AddressText({
  address,
  chars,
  className,
  showCopy = true,
}: {
  address: string;
  chars?: number;
  className?: string;
  showCopy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const label = chars ? `${address.slice(0, chars)}…${address.slice(-4)}` : shortenAddress(address);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable (insecure context) — title still exposes it */
    }
  }

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="num truncate" title={address}>
        {label}
      </span>
      {showCopy ? (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Address copied' : `Copy address ${address}`}
          className="-my-2 inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-quaternary transition-colors hover:bg-raised hover:text-foreground cursor-pointer"
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </span>
  );
}
