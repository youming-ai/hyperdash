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

  const signOut = async () => {
    await authClient.signOut();
    disconnect();
  };

  return {
    session,
    isAuthenticated: Boolean(session),
    isLoading: isPending,
    isSigningIn,
    isConnected,
    address,
    error,
    signIn,
    signOut,
  };
}
