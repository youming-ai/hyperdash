import { apiBaseUrl } from '~/lib/api-client';

/**
 * Typed client for the BE-only agent-wallet endpoints.
 *
 * These routes deliberately live only in the backend Worker: it holds the
 * encryption key and generates the agent keypair, neither of which belongs in
 * the frontend Worker. Because of that they are absent from the web app's own
 * `AppType`, so they get their own small typed client rather than being forced
 * through the co-located router type.
 *
 * In a split deployment `apiBaseUrl` points at the BE Worker; co-located it is
 * same-origin and the web Worker must proxy `/api/*` to the BE (set `BE_URL`).
 */

export interface AgentWalletStatus {
  userId: string;
  agentWalletId: string;
  agentAddress: string;
  agentName: string;
  approved: boolean;
  validUntil: number | null;
  expiringSoon: boolean;
}

export interface AgentApprovalIntent {
  agentWalletId: string;
  agentAddress: string;
  agentName: string;
  nonce: number;
  purpose: 'approve' | 'revoke';
  typedData: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: `0x${string}`;
    };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, string | number>;
  };
}

export interface AgentSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  v: 27 | 28;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl}/api/agent-wallets${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const error = new Error(body?.error ?? `request failed (${res.status})`);
    (error as Error & { status?: number }).status = res.status;
    throw error;
  }

  return (await res.json()) as T;
}

export const agentWalletApi = {
  status: () => request<AgentWalletStatus>(''),

  intent: (purpose: 'approve' | 'revoke' = 'approve') =>
    request<AgentApprovalIntent>('/intent', {
      method: 'POST',
      body: JSON.stringify({ purpose }),
    }),

  confirm: (nonce: number, signature: AgentSignature) =>
    request<AgentWalletStatus & { ok: boolean }>('/confirm', {
      method: 'POST',
      body: JSON.stringify({ nonce, signature }),
    }),

  cancel: () => request<{ ok: boolean }>('/cancel', { method: 'POST' }),
};
