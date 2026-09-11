import { useAuth } from '~/hooks/useAuth';

/**
 * SIWE sign-in / sign-out control shown next to the wallet ConnectButton.
 * Only meaningful once a wallet is connected.
 */
export function AuthButton() {
  const { isConnected, isAuthenticated, isSigningIn, signIn, signOut } = useAuth();

  if (!isConnected) return null;

  if (isAuthenticated) {
    return (
      <button
        type="button"
        onClick={signOut}
        className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-sm font-medium hover:opacity-80"
      >
        Sign out
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={signIn}
      disabled={isSigningIn}
      className="rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
    >
      {isSigningIn ? 'Signing in…' : 'Sign in'}
    </button>
  );
}
