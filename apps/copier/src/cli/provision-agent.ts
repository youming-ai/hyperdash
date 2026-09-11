/**
 * Agent provisioning + approval verification CLI.
 *
 * Step 1 of the non-custodial flow. Generating the keypair does NOT grant any
 * rights — only the user's master wallet can authorize an agent, and Hyperliquid
 * enforces that the agent may never move funds. This command prepares the key
 * and prints exactly what the user's wallet must sign.
 *
 *   bun src/cli/provision-agent.ts --user <userId> [--name hyperdash]
 *   bun src/cli/provision-agent.ts --user <userId> --verify --master 0x...
 *
 * The browser signs the payload below with the master wallet (viem
 * `signTypedData` / wagmi `signTypedDataAsync`) and posts it to
 * `https://api.hyperliquid.xyz/exchange`, or calls the SDK's `approveAgent`
 * directly. Nothing here can self-authorize.
 */

import { checkApproval, provisionAgent } from '../agent';
import { loadConfig } from '../config';
import { getEncryptionKey } from '../crypto';
import { createDb } from '../db';
import { log, setLogLevel } from '../log';
import { loadAgentWallet } from '../store';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel('info');

  const userId = arg('user');
  if (!userId) throw new Error('--user <userId> is required');

  const { db, client } = createDb(config.databaseUrl);

  const agentName = arg('name', 'hyperdash') as string;
  const agent = await provisionAgent(db, userId, getEncryptionKey(), agentName);

  const record = await loadAgentWallet(db, agent.agentWalletId);
  if (!record) throw new Error('agent wallet disappeared after provisioning');

  console.log('\n=== agent wallet ===');
  console.log(`agentWalletId : ${agent.agentWalletId}`);
  console.log(`agentAddress  : ${agent.agentAddress}`);
  console.log(`agentName     : ${agent.agentName}`);
  console.log(`private key   : stored encrypted (AES-256-GCM), never printed`);

  const master = arg('master');
  if (arg('verify') === 'true' && master) {
    const status = await checkApproval(master as `0x${string}`, agent.agentAddress);
    console.log('\n=== approval status ===');
    console.log(`approved   : ${status.approved}`);
    console.log(`name       : ${status.name ?? '-'}`);
    console.log(
      `validUntil : ${status.validUntil ? new Date(status.validUntil).toISOString() : 'no expiry'}`,
    );
    await client.end();
    return;
  }

  console.log('\n=== next: user authorizes it (runs in the browser, master wallet) ===');
  console.log('EIP-712 domain:');
  console.log('  name              HyperliquidSignTransaction');
  console.log('  version           1');
  console.log('  chainId           0x66eee   (421614)');
  console.log('  verifyingContract 0x0000000000000000000000000000000000000000');
  console.log('types: HyperliquidTransaction:ApproveAgent');
  console.log('  { hyperliquidChain, agentAddress, agentName, nonce }');
  console.log('message:');
  console.log(
    `  hyperliquidChain  ${process.env.HYPERLIQUID_TESTNET === '1' ? 'Testnet' : 'Mainnet'}`,
  );
  console.log(`  agentAddress      ${agent.agentAddress}`);
  console.log(`  agentName         ${agent.agentName}`);
  console.log('  nonce             Date.now()');
  console.log('\nOr with the SDK inside the app:');
  console.log('  await approveAgent({ transport, wallet: masterWalletClient },');
  console.log(`    { agentAddress: "${agent.agentAddress}", agentName: "${agent.agentName}" });`);
  console.log('\nThen confirm:');
  console.log(`  bun src/cli/provision-agent.ts --user ${userId} --verify --master 0x<master>  `);

  await client.end();
}

main().catch((error) => {
  log.error('provision failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
