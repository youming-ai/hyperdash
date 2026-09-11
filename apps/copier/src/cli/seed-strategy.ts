/**
 * Seed a runnable copy-trading scenario.
 *
 * Creates a demo follower (business user + agent wallet) and an active strategy
 * copying a real leader that has both equity and open positions in Postgres, so
 * the copier has something meaningful to reconcile against.
 *
 * Idempotent: re-running reuses the existing user/strategy instead of
 * duplicating them.
 *
 *   bun src/cli/seed-strategy.ts [--lead 0x...] [--capital 100000] [--weight 1]
 */

import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { provisionAgent } from '../agent';
import { loadConfig } from '../config';
import { getEncryptionKey } from '../crypto';
import { createDb, schema } from '../db';
import { log, setLogLevel } from '../log';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** Deterministic demo master address so re-runs stay idempotent. */
const DEMO_MASTER = '0x1111111111111111111111111111111111111111' as const;

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel('info');

  const { db, client } = createDb(config.databaseUrl);

  const capital = Number(arg('capital', '100000'));
  const weight = Number(arg('weight', '1'));
  const leadAddress = arg('lead');

  // Pick a lead that can actually produce a sized position: it needs equity to
  // scale against and open positions to copy. Positions are aggregated first so
  // the lead search never depends on a correlated subquery.
  const positionCounts = await db
    .select({
      traderId: schema.traderPositions.traderId,
      positionCount: sql<number>`count(*)`.as('position_count'),
      positionNotional:
        sql<number>`coalesce(sum(${schema.traderPositions.positionValueUsd}), 0)`.as(
          'position_notional',
        ),
    })
    .from(schema.traderPositions)
    .groupBy(schema.traderPositions.traderId);

  const countsByTrader = new Map(
    positionCounts.map((row) => [
      row.traderId,
      { count: Number(row.positionCount), notional: Number(row.positionNotional) },
    ]),
  );

  const candidates = await db
    .select({
      traderId: schema.traderStats.traderId,
      address: schema.traderStats.address,
      equityUsd: schema.traderStats.equityUsd,
    })
    .from(schema.traderStats)
    .where(
      leadAddress
        ? eq(schema.traderStats.address, leadAddress.toLowerCase())
        : gt(schema.traderStats.equityUsd, '0'),
    )
    .orderBy(desc(schema.traderStats.equityUsd))
    .limit(200);

  const lead = candidates
    .map((c) => {
      const stats = countsByTrader.get(c.traderId) ?? { count: 0, notional: 0 };
      return { ...c, positionCount: stats.count, positionNotional: stats.notional };
    })
    .find((c) => c.positionCount > 0 && Number(c.equityUsd) > 0);

  if (!lead) {
    throw new Error(
      leadAddress
        ? `lead ${leadAddress} has no equity/positions; run the whale-discovery ingest first`
        : 'no trader with both equity and positions found; run the whale-discovery ingest first',
    );
  }

  log.info('selected lead', {
    address: lead.address,
    equityUsd: Number(lead.equityUsd).toFixed(0),
    positions: Number(lead.positionCount),
    notional: Number(lead.positionNotional).toFixed(0),
  });

  // --- follower -----------------------------------------------------------
  let [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.walletAddress, DEMO_MASTER))
    .limit(1);

  if (!user) {
    [user] = await db
      .insert(schema.users)
      .values({ walletAddress: DEMO_MASTER, status: 'active', kycLevel: 0 })
      .returning();
    log.info('demo user created', { userId: user.id, wallet: DEMO_MASTER });
  } else {
    log.info('demo user reused', { userId: user.id });
  }

  const agent = await provisionAgent(db, user.id, getEncryptionKey(), 'hyperdash');
  log.info('agent wallet ready', {
    agentAddress: agent.agentAddress,
    agentWalletId: agent.agentWalletId,
    approved: false,
  });

  // --- strategy -----------------------------------------------------------
  let [strategy] = await db
    .select()
    .from(schema.copyStrategies)
    .where(
      and(
        eq(schema.copyStrategies.userId, user.id),
        eq(schema.copyStrategies.name, 'Demo Copy Strategy'),
      ),
    )
    .limit(1);

  if (!strategy) {
    [strategy] = await db
      .insert(schema.copyStrategies)
      .values({
        userId: user.id,
        name: 'Demo Copy Strategy',
        description: 'Seeded strategy for end-to-end copier verification',
        status: 'active',
        mode: 'single_trader',
        maxLeverage: '3',
        maxPositionUsd: String(capital),
        slippageBps: 10,
        minOrderUsd: '10',
        followNewEntriesOnly: false,
        autoRebalance: true,
        rebalanceThresholdBps: 100,
        agentWalletId: agent.agentWalletId,
      })
      .returning();
    log.info('strategy created', { strategyId: strategy.id, capital });
  } else {
    [strategy] = await db
      .update(schema.copyStrategies)
      .set({
        status: 'active',
        maxPositionUsd: String(capital),
        agentWalletId: agent.agentWalletId,
        updatedAt: new Date(),
      })
      .where(eq(schema.copyStrategies.id, strategy.id))
      .returning();
    log.info('strategy reactivated', { strategyId: strategy.id, capital });
  }

  // --- allocation ---------------------------------------------------------
  const existingAllocations = await db
    .select()
    .from(schema.copyAllocations)
    .where(eq(schema.copyAllocations.strategyId, strategy.id));

  for (const allocation of existingAllocations) {
    await db.delete(schema.copyAllocations).where(eq(schema.copyAllocations.id, allocation.id));
  }

  await db.insert(schema.copyAllocations).values({
    strategyId: strategy.id,
    traderId: lead.traderId,
    weight: String(weight),
    status: 'active',
  });

  log.info('allocation set', { traderId: lead.traderId, leadAddress: lead.address, weight });

  console.log('\n--- seeded ---');
  console.log(`user        ${user.id}  (${DEMO_MASTER})`);
  console.log(`agent       ${agent.agentAddress}`);
  console.log(`strategy    ${strategy.id}  capital=$${capital}  weight=${weight}`);
  console.log(`lead        ${lead.address}  equity=$${Number(lead.equityUsd).toFixed(0)}`);
  console.log(`\nRun:  bun run start        (paper mode)`);

  await client.end();
}

main().catch((error) => {
  log.error('seed failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
