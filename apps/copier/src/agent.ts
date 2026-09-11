/**
 * Agent wallet lifecycle — the primitive that makes non-custodial copy trading
 * possible.
 *
 * A Hyperliquid agent (API wallet) can place and cancel orders and change
 * leverage for a master account, but the protocol forbids it from transferring
 * funds, withdrawing to L1, or approving further agents. So the trust story is
 * "we can trade for you and physically cannot take your money" — enforced by
 * the exchange, not by a promise.
 *
 * The flow is deliberately asymmetric: the *server* generates the keypair (it
 * must hold the key to sign later), but only the *user's master wallet* can
 * authorize it. The server can never self-authorize.
 *
 *   1. server: generate keypair, store the private key encrypted, expose address
 *   2. user:   sign `approveAgent` from their own wallet (browser)
 *   3. server: verify against the chain, then it may trade
 */

import { checkAgentApproval, buildAgentName as sharedAgentName } from '@hyperdash/shared-types';
import { eq } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decryptKey, encryptKey } from './crypto';
import type { Db } from './db';
import { schema } from './db';
import { log } from './log';
import { type AgentWalletRecord, loadAgentWallet, markAgentApproved } from './store';

export interface ProvisionedAgent {
  agentWalletId: string;
  agentAddress: `0x${string}`;
  agentName: string;
}

/** Agent naming is shared with the BE so both produce exchange-valid names. */
export function buildAgentName(seed: string): string {
  return sharedAgentName(seed);
}

/**
 * Create (or reuse) an agent wallet for a user.
 *
 * The plaintext key never leaves this function's caller — only the encrypted
 * blob is persisted.
 */
export async function provisionAgent(
  db: Db,
  userId: string,
  encryptionKey: Uint8Array,
  agentNameSeed = 'hyperdash',
): Promise<ProvisionedAgent> {
  const existing = await db
    .select()
    .from(schema.agentWallets)
    .where(eq(schema.agentWallets.userId, userId))
    .limit(1);

  const found = existing[0];
  if (found?.encryptedPrivateKey) {
    return {
      agentWalletId: found.id,
      agentAddress: found.address as `0x${string}`,
      agentName: buildAgentName(agentNameSeed),
    };
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const encrypted = await encryptKey(privateKey, encryptionKey);
  const agentName = buildAgentName(agentNameSeed);

  const [inserted] = await db
    .insert(schema.agentWallets)
    .values({
      userId,
      exchange: 'hyperliquid',
      address: account.address,
      status: 'pending',
      encryptedPrivateKey: encrypted,
      metadata: { agentName },
    })
    .returning({ id: schema.agentWallets.id });

  log.info('Agent wallet provisioned', {
    userId,
    agentAddress: account.address,
    agentWalletId: inserted.id,
  });

  return { agentWalletId: inserted.id, agentAddress: account.address, agentName };
}

/** Decrypt an agent wallet's signing key. */
export async function agentPrivateKeyOf(
  record: AgentWalletRecord,
  encryptionKey: Uint8Array,
): Promise<`0x${string}`> {
  if (!record.encryptedPrivateKey) {
    throw new Error(`agent wallet ${record.id} has no stored key`);
  }
  return (await decryptKey(record.encryptedPrivateKey, encryptionKey)) as `0x${string}`;
}

export interface ApprovalStatus {
  approved: boolean;
  validUntil: number | null;
  name: string | null;
}

/**
 * Verify against the exchange that an agent is authorized for a master account.
 *
 * This is the gate for going live: an agent that was never approved (or whose
 * authorization lapsed) has no trading rights, and the platform must not
 * pretend otherwise. The check itself lives in shared-types so the BE and the
 * browser report the same answer from the same code.
 */
export async function checkApproval(
  masterAddress: `0x${string}`,
  agentAddress: `0x${string}`,
): Promise<ApprovalStatus> {
  return checkAgentApproval({ masterAddress, agentAddress });
}

/**
 * Verify approval and, when confirmed, record it on the wallet row.
 *
 * Returns the not-approved state when the user has not signed yet, so callers
 * can surface a "finish authorizing" step instead of failing order submission
 * obscurely much later.
 */
export async function confirmApproval(
  db: Db,
  agentWalletId: string,
  masterAddress: `0x${string}`,
): Promise<ApprovalStatus> {
  const record = await loadAgentWallet(db, agentWalletId);
  if (!record) throw new Error(`agent wallet ${agentWalletId} not found`);

  const status = await checkApproval(masterAddress, record.address as `0x${string}`);

  if (status.approved) {
    await markAgentApproved(db, agentWalletId, {
      agentName: status.name ?? '',
      validUntil: status.validUntil,
    });
    log.info('Agent approval confirmed', {
      agentWalletId,
      masterAddress,
      validUntil: status.validUntil,
    });
  } else {
    log.warn('Agent not approved on-chain', { agentWalletId, masterAddress });
  }

  return status;
}
