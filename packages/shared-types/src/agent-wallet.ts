import { z } from 'zod';

/**
 * Hyperliquid agent-wallet (API wallet) approval.
 *
 * An agent can place/cancel orders and change leverage for a master account, but
 * the protocol forbids it from transferring funds, withdrawing to L1, or
 * approving further agents. Non-custodial copy trading rests entirely on that
 * guarantee being enforced by the exchange rather than promised by the platform.
 *
 * `approveAgent` is a **user-signed action**, not an on-chain transaction: it is
 * an EIP-712 signature POSTed to the exchange endpoint. No gas, no network
 * switch, no funds required — the user only signs.
 *
 * The builders here are the single source of truth for that signature. The
 * values placed in the typed-data message and the values submitted alongside the
 * signature must be byte-identical or the exchange rejects it, so both halves of
 * the flow are produced by the same function rather than assembled twice.
 *
 * @module
 */

/**
 * Hyperliquid's own chain id, used as the EIP-712 domain chainId.
 *
 * Worth knowing: the exchange recomputes the digest from the action's own
 * `signatureChainId`, so verification succeeds for any consistent value. The
 * documented value is kept because interoperability beats relying on that.
 */
export const HYPERLIQUID_CHAIN_ID = 421614;

/** Hex form of the above, as it appears in the action's `signatureChainId`. */
export const HYPERLIQUID_SIGNATURE_CHAIN_ID = '0x66eee';

/**
 * Mainnet and testnet are entirely separate hosts — not a path or a flag.
 * Signing for one and submitting to the other fails with "Mainnet and testnet
 * require different signature", which reads like a signing bug but is really a
 * URL mismatch.
 */
export const HYPERLIQUID_MAINNET_URL = 'https://api.hyperliquid.xyz';
export const HYPERLIQUID_TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';

export function hyperliquidApiUrl(isTestnet?: boolean): string {
  return isTestnet ? HYPERLIQUID_TESTNET_URL : HYPERLIQUID_MAINNET_URL;
}

export function hyperliquidExchangeUrl(isTestnet?: boolean): string {
  return `${hyperliquidApiUrl(isTestnet)}/exchange`;
}

export function hyperliquidInfoUrl(isTestnet?: boolean): string {
  return `${hyperliquidApiUrl(isTestnet)}/info`;
}

/** Backwards-compatible aliases for the mainnet endpoints. */
export const HYPERLIQUID_EXCHANGE_URL = `${HYPERLIQUID_MAINNET_URL}/exchange`;
export const HYPERLIQUID_INFO_URL = `${HYPERLIQUID_MAINNET_URL}/info`;

/** Approving this address as an agent revokes the existing one. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/**
 * Hyperliquid caps agent names at 16 characters. An optional expiry is smuggled
 * into the name as a ` valid_until <ms>` suffix — there is no dedicated field —
 * and the length rule applies only to the part before that suffix.
 */
export const MAX_AGENT_NAME_LENGTH = 16;
const VALID_UNTIL_PATTERN = / valid_until (\d+)$/;

/** EIP-712 types for `approveAgent`. Field order is part of the type hash. */
export const ApproveAgentTypes = {
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export type HyperliquidNetwork = 'Mainnet' | 'Testnet';

export function networkOf(isTestnet: boolean): HyperliquidNetwork {
  return isTestnet ? 'Testnet' : 'Mainnet';
}

/**
 * Build an agent name, optionally carrying an expiry.
 *
 * Callers that want an expiry must pair this with `parseAgentValidity` on read,
 * since the name is the only place the timestamp survives.
 */
export function buildAgentName(base: string, validUntil?: number | null): string {
  const cleaned =
    base.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, MAX_AGENT_NAME_LENGTH) || 'hyperdash';
  return validUntil ? `${cleaned} valid_until ${Math.floor(validUntil)}` : cleaned;
}

/** Extract the expiry embedded in an agent name, or null when unbounded. */
export function parseAgentValidity(agentName: string): number | null {
  const match = VALID_UNTIL_PATTERN.exec(agentName ?? '');
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** The base portion of an agent name, with any expiry suffix removed. */
export function agentNameBase(agentName: string): string {
  return (agentName ?? '').replace(VALID_UNTIL_PATTERN, '');
}

export interface ApproveAgentInput {
  agentAddress: string;
  agentName: string;
  /** Milliseconds since epoch. Must be identical at signing and submission. */
  nonce: number;
  isTestnet?: boolean;
}

/**
 * The action submitted to the exchange alongside the signature.
 *
 * `type` and `signatureChainId` take part in the request but are excluded from
 * the signed message (EIP-712 only covers the fields declared in the types).
 */
export function buildApproveAgentAction(input: ApproveAgentInput) {
  return {
    type: 'approveAgent' as const,
    signatureChainId: HYPERLIQUID_SIGNATURE_CHAIN_ID,
    hyperliquidChain: networkOf(input.isTestnet ?? false),
    agentAddress: input.agentAddress,
    agentName: input.agentName,
    nonce: input.nonce,
  };
}

export interface ApproveAgentTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  types: typeof ApproveAgentTypes;
  primaryType: string;
  message: {
    hyperliquidChain: HyperliquidNetwork;
    agentAddress: string;
    agentName: string;
    nonce: number;
  };
}

/**
 * The exact payload the user's master wallet must sign.
 *
 * Note the domain chainId is Hyperliquid's (421614), **not** the chain the
 * wallet is connected to — signing with the wallet's own chain id produces a
 * signature the exchange rejects.
 */
export function buildApproveAgentTypedData(input: ApproveAgentInput): ApproveAgentTypedData {
  const action = buildApproveAgentAction(input);
  return {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: HYPERLIQUID_CHAIN_ID,
      verifyingContract: ZERO_ADDRESS,
    },
    types: ApproveAgentTypes,
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: {
      hyperliquidChain: action.hyperliquidChain,
      agentAddress: action.agentAddress,
      agentName: action.agentName,
      nonce: action.nonce,
    },
  };
}

/** Signature components as the exchange expects them. `v` is 27 or 28. */
export const AgentSignatureSchema = z.object({
  r: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  s: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  v: z.union([z.literal(27), z.literal(28)]),
});
export type AgentSignature = z.infer<typeof AgentSignatureSchema>;

/** What the client needs in order to sign. */
export const AgentApprovalIntentSchema = z.object({
  agentWalletId: z.string(),
  agentAddress: z.string(),
  agentName: z.string(),
  nonce: z.number(),
  typedData: z.object({
    domain: z.object({
      name: z.string(),
      version: z.string(),
      chainId: z.number(),
      verifyingContract: z.string(),
    }),
    primaryType: z.string(),
    message: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
});
export type AgentApprovalIntent = z.infer<typeof AgentApprovalIntentSchema>;

/** Confirmation posted back after the wallet signs. */
export const AgentApprovalConfirmSchema = z.object({
  agentWalletId: z.string(),
  nonce: z.number(),
  signature: AgentSignatureSchema,
});
export type AgentApprovalConfirm = z.infer<typeof AgentApprovalConfirmSchema>;

/** Approval state as reported to the UI. */
export const AgentApprovalStatusSchema = z.object({
  agentWalletId: z.string(),
  agentAddress: z.string(),
  agentName: z.string(),
  /** True only when the exchange itself confirms the authorization. */
  approved: z.boolean(),
  /** Milliseconds since epoch, or null when the agent has no expiry. */
  validUntil: z.number().nullable(),
  /** True when approved but the authorization lapses soon. */
  expiringSoon: z.boolean(),
});
export type AgentApprovalStatus = z.infer<typeof AgentApprovalStatusSchema>;

/** Default agent lifetime. Hyperliquid API wallets are not indefinite. */
export const DEFAULT_AGENT_VALIDITY_MS = 180 * 24 * 60 * 60 * 1000;

/** How long before expiry the UI should prompt for re-authorization. */
export const AGENT_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

export function isApprovalExpiring(validUntil: number | null, now = Date.now()): boolean {
  if (validUntil === null) return false;
  return validUntil - now <= AGENT_EXPIRY_WARNING_MS;
}
