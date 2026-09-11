import { zValidator } from '@hono/zod-validator';
import { agentWallets } from '@hyperdash/database/schema';
import {
  buildAgentName,
  buildApproveAgentAction,
  buildApproveAgentTypedData,
  checkAgentApproval,
  DEFAULT_AGENT_VALIDITY_MS,
  encryptAgentKey,
  parseEncryptionKey,
  submitSignedAction,
  ZERO_ADDRESS,
} from '@hyperdash/shared-types';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import type { Db } from '~/db';
import { requireSession } from '~/server/middleware/auth';
import type { AppEnv } from '~/server/types';
import { resolveBusinessUserId } from '~/server/user';

/**
 * Agent-wallet (API wallet) authorization.
 *
 * Non-custodial copy trading depends on this one primitive: the user signs an
 * `approveAgent` authorization from their own master wallet, after which the
 * platform may place orders but can never move funds. Hyperliquid enforces that
 * split at the protocol level, so the guarantee does not rest on our behaviour.
 *
 * The three-step shape is deliberate:
 *
 *   1. POST /intent   — server generates the keypair and returns the exact
 *                       payload to sign. The private key never leaves the server.
 *   2. (browser)      — the user's master wallet signs it. The server cannot
 *                       self-authorize; this step is the whole security model.
 *   3. POST /confirm  — the server replays the *stored* action, submits it, then
 *                       re-reads the exchange to verify. A client that signs
 *                       something else fails, and a client that claims success
 *                       is not believed.
 */

/** How long a pending signature stays valid before the user must restart. */
const PENDING_APPROVAL_TTL_MS = 10 * 60 * 1000;

/**
 * A pending authorization.
 *
 * `agentAddress` and `agentName` are stored verbatim and replayed at confirm
 * time. They must NOT be recomputed: the agent name embeds an expiry timestamp
 * which the signature covers, so rebuilding it a moment later would change the
 * signed message and make every confirmation fail signature verification.
 */
interface PendingApproval {
  nonce: number;
  purpose: 'approve' | 'revoke';
  issuedAt: number;
  agentAddress: string;
  agentName: string;
}

const intentBody = z.object({
  /** Revoking is the same flow with the agent address set to zero. */
  purpose: z.enum(['approve', 'revoke']).default('approve'),
  /** Agent lifetime in ms; omitted uses the default window. */
  validityMs: z.number().int().positive().optional(),
});

const confirmBody = z.object({
  nonce: z.number().int().nonnegative(),
  signature: z.object({
    r: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    s: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    v: z.union([z.literal(27), z.literal(28)]),
  }),
});

type AgentWalletRow = typeof agentWallets.$inferSelect;

function metadataOf(row: AgentWalletRow): Record<string, unknown> {
  return typeof row.metadata === 'object' && row.metadata !== null
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function readPending(metadata: Record<string, unknown>): PendingApproval | null {
  const pending = metadata.pendingApproval;
  if (typeof pending !== 'object' || pending === null) return null;
  const record = pending as Record<string, unknown>;

  const valid =
    typeof record.nonce === 'number' &&
    typeof record.issuedAt === 'number' &&
    typeof record.agentAddress === 'string' &&
    typeof record.agentName === 'string';
  if (!valid) return null;

  return {
    nonce: record.nonce as number,
    purpose: record.purpose === 'revoke' ? 'revoke' : 'approve',
    issuedAt: record.issuedAt as number,
    agentAddress: record.agentAddress as string,
    agentName: record.agentName as string,
  };
}

function withPending(
  metadata: Record<string, unknown>,
  pending: PendingApproval | null,
): Record<string, unknown> {
  const next = { ...metadata };
  if (pending === null) delete next.pendingApproval;
  else next.pendingApproval = pending;
  return next;
}

/** Find the user's agent wallet, creating one with a fresh key when absent. */
async function findOrCreateAgent(db: Db, userId: string, env: AppEnv['Bindings']) {
  const existing = await db
    .select()
    .from(agentWallets)
    .where(eq(agentWallets.userId, userId))
    .limit(1);

  const found = existing[0];
  if (found) return found;

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const encrypted = await encryptAgentKey(privateKey, parseEncryptionKey(env.ENCRYPTION_KEY));

  const [created] = await db
    .insert(agentWallets)
    .values({
      userId,
      exchange: 'hyperliquid',
      address: account.address,
      // Not tradable until the user signs; keeps that visible in every query.
      status: 'inactive',
      encryptedPrivateKey: encrypted,
      metadata: { agentName: buildAgentName('hyperdash') },
    })
    .returning();

  return created;
}

interface AgentContext {
  db: Db;
  userId: string;
  agent: AgentWalletRow;
  masterAddress: `0x${string}`;
  isTestnet: boolean;
}

/** Resolve session → business user → agent wallet, creating the latter if new. */
async function resolveContext(c: Context<AppEnv>): Promise<AgentContext | null> {
  const session = c.get('session');
  if (!session) return null;

  const db = c.get('db');
  const userId = await resolveBusinessUserId(db, session.walletAddress);
  const agent = await findOrCreateAgent(db, userId, c.env);

  return {
    db,
    userId,
    agent,
    masterAddress: session.walletAddress as `0x${string}`,
    isTestnet: c.env.HYPERLIQUID_TESTNET === '1',
  };
}

export const agentWalletsRouter = new Hono<AppEnv>()
  .use(requireSession)

  /**
   * Current authorization state, read from the exchange rather than our own
   * records — a stale local flag would let the UI claim an agent can trade when
   * it cannot.
   */
  .get('/', async (c) => {
    const ctx = await resolveContext(c);
    if (!ctx) return c.json({ error: 'unauthorized' }, 401);

    const { db, userId, agent, masterAddress, isTestnet } = ctx;
    const status = await checkAgentApproval({
      masterAddress,
      agentAddress: agent.address,
      isTestnet,
    });

    // Opportunistically reconcile our row with the chain.
    const desired = status.approved ? 'active' : 'inactive';
    if (agent.status !== desired) {
      await db
        .update(agentWallets)
        .set({ status: desired, updatedAt: new Date() })
        .where(eq(agentWallets.id, agent.id));
    }

    const metadata = metadataOf(agent);
    return c.json({
      userId,
      agentWalletId: agent.id,
      agentAddress: agent.address,
      agentName: typeof metadata.agentName === 'string' ? metadata.agentName : 'hyperdash',
      approved: status.approved,
      validUntil: status.validUntil,
      expiringSoon: status.expiringSoon,
    });
  })

  /**
   * Step 1 — the payload the master wallet must sign.
   *
   * The domain chainId is Hyperliquid's (421614) regardless of which chain the
   * browser wallet is connected to. Deriving it from the wallet's own chain is
   * the classic way to produce a signature the exchange rejects.
   */
  .post('/intent', zValidator('json', intentBody), async (c) => {
    const ctx = await resolveContext(c);
    if (!ctx) return c.json({ error: 'unauthorized' }, 401);

    const { db, agent, isTestnet } = ctx;
    const { purpose, validityMs } = c.req.valid('json');

    // Revoking is an approval of the zero address.
    const targetAddress = purpose === 'revoke' ? ZERO_ADDRESS : agent.address;
    const validUntil =
      purpose === 'revoke' ? null : Date.now() + (validityMs ?? DEFAULT_AGENT_VALIDITY_MS);
    const agentName = purpose === 'revoke' ? 'revoke' : buildAgentName('hyperdash', validUntil);

    const nonce = Date.now();
    const pending: PendingApproval = {
      nonce,
      purpose,
      issuedAt: nonce,
      agentAddress: targetAddress,
      agentName,
    };

    const metadata = withPending(metadataOf(agent), pending);
    await db
      .update(agentWallets)
      .set({ metadata, updatedAt: new Date() })
      .where(eq(agentWallets.id, agent.id));

    const typedData = buildApproveAgentTypedData({
      agentAddress: targetAddress,
      agentName,
      nonce,
      isTestnet,
    });

    return c.json({
      agentWalletId: agent.id,
      agentAddress: targetAddress,
      agentName,
      nonce,
      purpose,
      typedData: {
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      },
    });
  })

  /**
   * Step 3 — submit the user's signature, then confirm against the exchange.
   *
   * The action replayed here comes from our stored intent, never from
   * client-supplied values: a client cannot talk us into authorizing an address
   * we do not control.
   */
  .post('/confirm', zValidator('json', confirmBody), async (c) => {
    const ctx = await resolveContext(c);
    if (!ctx) return c.json({ error: 'unauthorized' }, 401);

    const { db, agent, masterAddress, isTestnet } = ctx;
    const { nonce, signature } = c.req.valid('json');
    const metadata = metadataOf(agent);

    const pending = readPending(metadata);
    if (!pending) {
      return c.json({ error: 'no pending authorization; request a new intent' }, 409);
    }
    if (pending.nonce !== nonce) {
      return c.json({ error: 'nonce does not match the issued intent' }, 409);
    }
    if (Date.now() - pending.issuedAt > PENDING_APPROVAL_TTL_MS) {
      await db
        .update(agentWallets)
        .set({ metadata: withPending(metadata, null), updatedAt: new Date() })
        .where(eq(agentWallets.id, agent.id));
      return c.json({ error: 'authorization intent expired; request a new one' }, 409);
    }

    // Replay the stored values verbatim — the signature covers them.
    const action = buildApproveAgentAction({
      agentAddress: pending.agentAddress,
      agentName: pending.agentName,
      nonce: pending.nonce,
      isTestnet,
    });

    const submitted = await submitSignedAction({ action, signature, nonce, isTestnet });
    if (!submitted.ok) {
      return c.json({ error: submitted.error ?? 'exchange rejected the signature' }, 400);
    }

    // Acceptance of the submission is not proof it took effect; re-read.
    const status = await checkAgentApproval({
      masterAddress,
      agentAddress: agent.address,
      isTestnet,
    });

    const isRevoke = pending.purpose === 'revoke';
    const cleared = withPending(metadata, null);
    if (!isRevoke) cleared.agentName = pending.agentName;

    await db
      .update(agentWallets)
      .set({
        metadata: cleared,
        status: status.approved ? 'active' : 'inactive',
        updatedAt: new Date(),
      })
      .where(eq(agentWallets.id, agent.id));

    return c.json({
      ok: true,
      agentWalletId: agent.id,
      agentAddress: agent.address,
      approved: status.approved,
      validUntil: status.validUntil,
      expiringSoon: status.expiringSoon,
    });
  })

  /** Drop a pending intent, e.g. when the user dismisses the wallet prompt. */
  .post('/cancel', async (c) => {
    const ctx = await resolveContext(c);
    if (!ctx) return c.json({ error: 'unauthorized' }, 401);

    const { db, agent } = ctx;
    await db
      .update(agentWallets)
      .set({ metadata: withPending(metadataOf(agent), null), updatedAt: new Date() })
      .where(eq(agentWallets.id, agent.id));

    return c.json({ ok: true });
  });
