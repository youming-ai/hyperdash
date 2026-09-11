/**
 * Agent approval, verified against the exchange.
 *
 * The platform must never *assume* an agent is authorized: an unapproved agent
 * simply cannot trade, and pretending otherwise turns into orders failing
 * obscurely much later. Everything here therefore reads state from Hyperliquid
 * rather than from local bookkeeping.
 *
 * Plain `fetch` is used instead of the Hyperliquid SDK so the identical module
 * runs in the Cloudflare Workers BE (where adding an SDK dependency is avoided)
 * and in the Bun executor.
 *
 * @module
 */

import {
  type AgentSignature,
  agentNameBase,
  hyperliquidExchangeUrl,
  hyperliquidInfoUrl,
  isApprovalExpiring,
} from './agent-wallet';

export interface ExtraAgent {
  address: string;
  name: string;
  /** Milliseconds since epoch, or null when the agent has no expiry. */
  validUntil: number | null;
}

export interface AgentApprovalState {
  approved: boolean;
  validUntil: number | null;
  name: string | null;
  /** Approved, but the authorization lapses within the warning window. */
  expiringSoon: boolean;
}

interface FetchOptions {
  isTestnet?: boolean;
  signal?: AbortSignal;
}

/**
 * Agents authorized for an account, as reported by the exchange.
 *
 * Returns an empty list rather than throwing on a malformed response: callers
 * treat "cannot confirm" as "not approved", which is the safe direction.
 */
export async function fetchExtraAgents(
  masterAddress: string,
  options: FetchOptions = {},
): Promise<ExtraAgent[]> {
  const res = await fetch(hyperliquidInfoUrl(options.isTestnet), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'extraAgents', user: masterAddress }),
    signal: options.signal,
  });

  if (!res.ok) return [];

  const data = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry): ExtraAgent[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const address = typeof record.address === 'string' ? record.address : null;
    if (!address) return [];
    const rawValidUntil = record.validUntil;
    return [
      {
        address,
        name: typeof record.name === 'string' ? record.name : '',
        validUntil: typeof rawValidUntil === 'number' ? rawValidUntil : null,
      },
    ];
  });
}

/**
 * Whether a specific agent may currently trade for an account.
 *
 * Matched case-insensitively because the exchange and the wallets disagree on
 * address casing, and a missed match here would silently look like "not
 * approved" forever.
 */
export async function checkAgentApproval(input: {
  masterAddress: string;
  agentAddress: string;
  isTestnet?: boolean;
  signal?: AbortSignal;
}): Promise<AgentApprovalState> {
  const agents = await fetchExtraAgents(input.masterAddress, {
    isTestnet: input.isTestnet,
    signal: input.signal,
  });

  const match = agents.find((a) => a.address.toLowerCase() === input.agentAddress.toLowerCase());

  if (!match) {
    return { approved: false, validUntil: null, name: null, expiringSoon: false };
  }

  const name = agentNameBase(match.name);
  const expired = match.validUntil !== null && match.validUntil <= Date.now();

  return {
    approved: !expired,
    validUntil: match.validUntil,
    name,
    expiringSoon: !expired && isApprovalExpiring(match.validUntil),
  };
}

/**
 * Submit an already-signed user action to the exchange.
 *
 * Shared by approval and revocation so both go through one code path — the
 * response shape (`{status: "ok" | "err"}`) is easy to misread, and a wrongly
 * treated "err" would mark an agent approved when it is not.
 */
export async function submitSignedAction(input: {
  action: Record<string, unknown>;
  signature: AgentSignature;
  nonce: number;
  isTestnet?: boolean;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(hyperliquidExchangeUrl(input.isTestnet), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: input.action,
      signature: input.signature,
      nonce: input.nonce,
    }),
    signal: input.signal,
  });

  const body = (await res.json().catch(() => null)) as {
    status?: string;
    response?: unknown;
  } | null;

  if (!res.ok) {
    return { ok: false, error: `exchange returned HTTP ${res.status}` };
  }

  if (body?.status === 'ok') return { ok: true };

  const detail =
    typeof body?.response === 'string' ? body.response : JSON.stringify(body?.response ?? body);
  return { ok: false, error: detail || 'exchange rejected the action' };
}
