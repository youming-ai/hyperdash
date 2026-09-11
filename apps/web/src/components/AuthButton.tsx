import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { SkeletonBlock } from '~/components/ui/state';
import { useAuth } from '~/hooks/useAuth';

/**
 * AuthButton — the SIWE sign-in / sign-out control beside the wallet button.
 *
 * Three rules this follows, each one a bug that was visible in the header:
 *  - Nothing renders until a wallet is connected. A permanently disabled
 *    "Sign in" sat next to "Connect" for every disconnected visitor, offering
 *    two competing CTAs for one intent — and a disabled control is unreachable
 *    by keyboard, so its explanatory label was dead weight.
 *  - While the session resolves, a same-size placeholder holds the slot instead
 *    of flashing "Sign in" at an already-authenticated user.
 *  - Failures surface. A rejected signature previously rendered nothing at all,
 *    which is indistinguishable from an ignored click.
 *
 * The alert is absolutely positioned, so a long error can never reflow the 52px
 * header it lives in.
 */
export function AuthButton() {
  const {
    isConnected,
    isAuthenticated,
    isLoading,
    isSigningIn,
    isSigningOut,
    error,
    signIn,
    signOut,
  } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  if (!isConnected) return null;

  if (isLoading) {
    return (
      <span aria-hidden="true">
        <SkeletonBlock className="h-8 w-[72px]" />
      </span>
    );
  }

  return (
    <span className="relative inline-flex">
      {isAuthenticated ? (
        <Button
          variant="outline"
          size="md"
          onClick={() => void signOut()}
          disabled={isSigningOut}
          aria-busy={isSigningOut}
        >
          {isSigningOut ? 'Signing out…' : 'Sign out'}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="md"
          onClick={() => void signIn()}
          disabled={isSigningIn}
          aria-busy={isSigningIn}
        >
          {isSigningIn ? 'Signing in…' : 'Sign in'}
        </Button>
      )}

      {error && !dismissed ? (
        <span
          role="alert"
          className="absolute right-0 top-[calc(100%+6px)] z-50 flex w-[260px] items-start gap-2 rounded-md border border-destructive/40 bg-[color-mix(in_oklab,var(--destructive)_12%,var(--panel))] p-2 text-2xs text-destructive shadow-lg"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss sign-in error"
            className="-my-0.5 shrink-0 cursor-pointer rounded-sm p-0.5 text-destructive hover:bg-[color-mix(in_oklab,var(--destructive)_18%,transparent)]"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ) : null}
    </span>
  );
}
