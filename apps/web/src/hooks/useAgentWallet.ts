import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { type AgentWalletStatus, agentWalletApi } from '~/lib/agent-wallet-client';

/**
 * Agent-wallet (API wallet) authorization, driven from the browser.
 *
 * Non-custodial copy trading hinges on this step: the user signs an
 * `approveAgent` authorization with their own master wallet, which lets
 * HyperDash place and cancel orders for their account while the protocol
 * forbids it from transferring funds or withdrawing. The guarantee is enforced
 * by Hyperliquid, not by our behaviour — which is why the server generates the
 * agent key but can never authorize it. Only this signature can.
 *
 * `approveAgent` is a user-signed action, not an on-chain transaction, so the
 * wallet is asked to sign typed data: no gas, no network switch, no funds.
 *
 * Three steps, deliberately:
 *
 *   1. POST /agent-wallets/intent   — server returns the exact payload to sign
 *   2. the wallet signs it locally   — the server cannot do this for the user
 *   3. POST /agent-wallets/confirm  — server submits and re-verifies on-chain
 *
 * The payload is signed exactly as returned. In particular the EIP-712 domain
 * chainId is Hyperliquid's (421614), not the wallet's connected chain:
 * substituting the wallet's chain id yields a signature the exchange rejects,
 * which is easy to do and hard to diagnose.
 */

const STATUS_KEY = ['agent-wallet', 'status'] as const;

export type ApprovalStep = 'idle' | 'preparing' | 'signing' | 'confirming';

export function useAgentWallet() {
  const queryClient = useQueryClient();
  const { isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<ApprovalStep>('idle');

  const statusQuery = useQuery({
    queryKey: STATUS_KEY,
    enabled: isConnected,
    retry: false,
    queryFn: async (): Promise<AgentWalletStatus | null> => {
      try {
        return await agentWalletApi.status();
      } catch (err) {
        // An unauthenticated visitor has no agent wallet; that is a state, not
        // an error, so the UI can show "sign in" instead of a failure.
        if ((err as { status?: number }).status === 401) return null;
        throw err;
      }
    },
  });

  /**
   * Run the authorize (or revoke) flow.
   *
   * Revoking reuses this path with the agent address set to zero, so there is
   * exactly one signing routine to get right.
   */
  const authorize = useCallback(
    async (purpose: 'approve' | 'revoke' = 'approve'): Promise<AgentWalletStatus> => {
      setError(null);
      try {
        setStep('preparing');
        const intent = await agentWalletApi.intent(purpose);

        setStep('signing');
        const signatureHex = await signTypedDataAsync({
          domain: intent.typedData.domain,
          types: intent.typedData.types,
          primaryType: intent.typedData.primaryType,
          message: intent.typedData.message,
        });

        setStep('confirming');
        const result = await agentWalletApi.confirm(intent.nonce, splitSignature(signatureHex));

        if (!result.approved && purpose === 'approve') {
          // The submission was accepted but the exchange still does not list
          // the agent; saying so beats reporting a success that is not real.
          throw new Error('authorization was submitted but is not active yet — try again shortly');
        }

        await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'authorization failed';
        // Rejecting the wallet prompt is a normal outcome, not a fault.
        setError(/reject|denied/i.test(message) ? 'Signature request was rejected' : message);
        throw err;
      } finally {
        setStep('idle');
      }
    },
    [signTypedDataAsync, queryClient],
  );

  const approve = useCallback(() => authorize('approve'), [authorize]);
  const revoke = useCallback(() => authorize('revoke'), [authorize]);

  return {
    status: statusQuery.data ?? null,
    isLoading: statusQuery.isLoading,
    isWorking: step !== 'idle',
    step,
    error,
    approve,
    revoke,
    refetch: statusQuery.refetch,
  };
}

/**
 * Split a 65-byte hex signature into the components the exchange expects.
 *
 * viem returns `v` as 0/1 while Hyperliquid requires 27/28; getting this wrong
 * breaks signature recovery without a clear error.
 */
function splitSignature(signature: `0x${string}`): {
  r: `0x${string}`;
  s: `0x${string}`;
  v: 27 | 28;
} {
  const r = signature.slice(0, 66) as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const raw = Number.parseInt(signature.slice(130, 132), 16);
  return { r, s, v: (raw < 27 ? raw + 27 : raw) as 27 | 28 };
}

/** Human-readable expiry for the UI, or null when the agent never expires. */
export function formatValidity(validUntil: number | null): string | null {
  if (validUntil === null) return null;
  return new Date(validUntil).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
