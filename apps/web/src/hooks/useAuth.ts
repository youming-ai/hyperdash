import { useState } from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useDisconnect, useSignMessage } from 'wagmi';
import { authClient, useSession } from '~/lib/auth-client';

/**
 * Sign-In With Ethereum flow against Better Auth's SIWE plugin.
 *
 * 1. request a nonce, 2. build + sign a SIWE message with the connected wallet,
 * 3. verify it to establish a Better Auth session (cookie).
 */
export function useAuth() {
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const { data: session, isPending } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const signIn = async () => {
    if (!address || !chainId) {
      setError('Connect a wallet first');
      return;
    }
    setIsSigningIn(true);
    setError(null);
    try {
      const { data, error: nonceError } = await authClient.siwe.nonce({
        walletAddress: address,
        chainId,
      });
      if (nonceError || !data) throw new Error('Failed to get nonce');

      const message = createSiweMessage({
        address,
        chainId,
        domain: window.location.host,
        uri: window.location.origin,
        version: '1',
        nonce: data.nonce,
        statement: 'Sign in to HyperDash',
      });
      const signature = await signMessageAsync({ message });

      const { error: verifyError } = await authClient.siwe.verify({
        message,
        signature,
        walletAddress: address,
        chainId,
      });
      if (verifyError) throw new Error('Signature verification failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setIsSigningIn(false);
    }
  };

  /**
   * Sign out of the Better Auth session and drop the wallet connection.
   *
   * Both steps are attempted even if the first fails, and any failure is
   * reported rather than swallowed: a silently failed sign-out leaves the user
   * believing they are logged out while the session cookie is still live.
   */
  const signOut = async () => {
    setIsSigningOut(true);
    setError(null);
    try {
      const { error: signOutError } = await authClient.signOut();
      if (signOutError) throw new Error(signOutError.message ?? 'Sign-out failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-out failed');
    } finally {
      // Always disconnect locally, so the wallet is never left attached to a
      // session the user asked to end.
      try {
        disconnect();
      } finally {
        setIsSigningOut(false);
      }
    }
  };

  return {
    session,
    isAuthenticated: Boolean(session),
    isLoading: isPending,
    isSigningIn,
    isSigningOut,
    isConnected,
    address,
    error,
    signIn,
    signOut,
  };
}
