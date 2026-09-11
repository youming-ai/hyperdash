import { ConnectButton } from '@rainbow-me/rainbowkit';
import { AlertTriangle, ChevronDown, Wallet } from 'lucide-react';

import { Button } from '~/components/ui/button';
import { cn, shortenAddress } from '~/lib/utils';

/**
 * WalletButton — the header's wallet control.
 *
 * RainbowKit's stock `ConnectButton` renders a 40px-tall control with its own
 * warm-grey styling and a blue "wrong network" state, which fights this design
 * system in three ways: it is the only 40px control in a 52px bar (the theme
 * toggle is 32px, auth is 28px), its palette is not token-driven, and its
 * unsupported-chain state is a hardcoded blue (#1d4ed8) that ignores both
 * themes.
 *
 * `ConnectButton.Custom` gives us the account/chain state and the modal
 * openers, so we render our own 32px control from the shared `Button`
 * primitive. A single instance covers every breakpoint (RainbowKit's
 * `accountStatus` is responsive), which also removes the previously duplicated
 * mount.
 */
export function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal }) => {
        // Before mount (SSR and the first client render) show the connect
        // affordance. `mounted` is false on both passes, so server and client
        // HTML agree, and the prerendered page ships the real CTA rather than a
        // skeleton placeholder.
        const ready = mounted && account && chain;

        if (!ready) {
          return (
            <Button variant="primary" size="md" onClick={openConnectModal}>
              <Wallet aria-hidden="true" />
              Connect
            </Button>
          );
        }

        if (chain.unsupported) {
          return (
            <Button variant="danger" size="md" onClick={openChainModal}>
              <AlertTriangle aria-hidden="true" />
              <span className="hidden sm:inline">Wrong network</span>
              <span className="sm:hidden">Network</span>
            </Button>
          );
        }

        return (
          <Button
            variant="outline"
            size="md"
            onClick={openAccountModal}
            title={`${account.displayName}${account.displayBalance ? ` · ${account.displayBalance}` : ''} — click to manage`}
            aria-label={`Wallet ${account.displayName}. Open account menu.`}
            className={cn('max-w-[160px] gap-1.5 pl-1')}
          >
            {account.ensAvatar ? (
              <img
                src={account.ensAvatar}
                alt=""
                className="size-6 shrink-0 rounded-full"
                aria-hidden="true"
              />
            ) : (
              <span
                className="grid size-6 shrink-0 place-items-center rounded-full bg-raised text-2xs font-medium text-fg-secondary"
                aria-hidden="true"
              >
                {account.displayName.replace(/^0x/, '').slice(0, 2).toUpperCase()}
              </span>
            )}
            {/* Narrow screens get the identicon alone; the address would eat the
                whole bar. The full value stays available via title/aria-label. */}
            <span className="hidden truncate sm:inline">
              {account.ensName ?? shortenAddress(account.address)}
            </span>
            <ChevronDown className="shrink-0 text-fg-quaternary" aria-hidden="true" />
          </Button>
        );
      }}
    </ConnectButton.Custom>
  );
}
