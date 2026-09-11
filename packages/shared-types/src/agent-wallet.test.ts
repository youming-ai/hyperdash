import { describe, expect, test } from 'bun:test';
import {
  AGENT_EXPIRY_WARNING_MS,
  agentNameBase,
  buildAgentName,
  buildApproveAgentAction,
  buildApproveAgentTypedData,
  DEFAULT_AGENT_VALIDITY_MS,
  HYPERLIQUID_CHAIN_ID,
  HYPERLIQUID_SIGNATURE_CHAIN_ID,
  hyperliquidApiUrl,
  isApprovalExpiring,
  parseAgentValidity,
  ZERO_ADDRESS,
} from './index';

const AGENT = '0x82Ad26Ee18a4cF44fCB99c6045AE314bc999Fd88';

describe('agent naming and expiry', () => {
  test('embeds an expiry that round-trips', () => {
    const validUntil = 1795540528182;
    const name = buildAgentName('hyperdash', validUntil);

    expect(parseAgentValidity(name)).toBe(validUntil);
    expect(agentNameBase(name)).toBe('hyperdash');
  });

  test('omits the suffix when there is no expiry', () => {
    const name = buildAgentName('hyperdash');
    expect(name).toBe('hyperdash');
    expect(parseAgentValidity(name)).toBeNull();
  });

  test('keeps the base name within the 16-character exchange limit', () => {
    // Hyperliquid validates the name BEFORE the " valid_until <ts>" suffix.
    const name = buildAgentName('a-very-long-agent-name-that-exceeds', 1795540528182);
    expect(agentNameBase(name).length).toBeLessThanOrEqual(16);
  });

  test('strips characters the exchange rejects', () => {
    expect(agentNameBase(buildAgentName('my agent!@#', 1))).toBe('myagent');
  });

  test('falls back to a usable name when the seed sanitizes to nothing', () => {
    expect(buildAgentName('!!!')).toBe('hyperdash');
  });
});

describe('approveAgent payload', () => {
  const input = { agentAddress: AGENT, agentName: 'hyperdash', nonce: 1_757_491_234_567 };

  test('uses the Hyperliquid chain id, not a wallet chain id', () => {
    // The browser wallet is typically on Arbitrum (42161); signing with that
    // chain id produces a signature the exchange rejects.
    const typed = buildApproveAgentTypedData(input);
    expect(typed.domain.chainId).toBe(HYPERLIQUID_CHAIN_ID);
    expect(typed.domain.chainId).toBe(421614);
    expect(typed.domain.chainId).not.toBe(42161);
  });

  test('declares the domain and types the exchange expects', () => {
    const typed = buildApproveAgentTypedData(input);
    expect(typed.domain.name).toBe('HyperliquidSignTransaction');
    expect(typed.domain.version).toBe('1');
    expect(typed.domain.verifyingContract).toBe(ZERO_ADDRESS);
    expect(typed.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    expect(typed.types['HyperliquidTransaction:ApproveAgent'].map((f) => f.name)).toEqual([
      'hyperliquidChain',
      'agentAddress',
      'agentName',
      'nonce',
    ]);
  });

  test('the action carries the fields excluded from the signed message', () => {
    const action = buildApproveAgentAction(input);
    expect(action.type).toBe('approveAgent');
    expect(action.signatureChainId).toBe(HYPERLIQUID_SIGNATURE_CHAIN_ID);
    expect(action.hyperliquidChain).toBe('Mainnet');
  });

  test('signed message and submitted action agree on every shared field', () => {
    // The exchange recomputes the digest from the action, so a mismatch here is
    // a silently rejected signature.
    const typed = buildApproveAgentTypedData(input);
    const action = buildApproveAgentAction(input);

    expect(typed.message.agentAddress).toBe(action.agentAddress);
    expect(typed.message.agentName).toBe(action.agentName);
    expect(typed.message.nonce).toBe(action.nonce);
    expect(typed.message.hyperliquidChain).toBe(action.hyperliquidChain);
  });

  test('rebuilding with a later timestamp changes the message (why the action must be stored)', () => {
    // Regression: the confirm handler originally recomputed the expiry with a
    // fresh Date.now(), so the agent name no longer matched what the user had
    // signed and every confirmation failed signature verification. The fix is to
    // replay the stored action verbatim; this test pins that invariant.
    const signedName = buildAgentName('hyperdash', Date.now() + DEFAULT_AGENT_VALIDITY_MS);
    const recomputedName = buildAgentName(
      'hyperdash',
      Date.now() + DEFAULT_AGENT_VALIDITY_MS + 5_000,
    );

    expect(signedName).not.toBe(recomputedName);

    const signed = buildApproveAgentTypedData({ ...input, agentName: signedName });
    const replayed = buildApproveAgentTypedData({ ...input, agentName: recomputedName });
    expect(signed.message.agentName).not.toBe(replayed.message.agentName);
  });

  test('revoking targets the zero address', () => {
    const action = buildApproveAgentAction({ ...input, agentAddress: ZERO_ADDRESS });
    expect(action.agentAddress).toBe(ZERO_ADDRESS);
  });

  test('selects the network label and host together', () => {
    const mainnet = buildApproveAgentAction({ ...input, isTestnet: false });
    const testnet = buildApproveAgentAction({ ...input, isTestnet: true });

    expect(mainnet.hyperliquidChain).toBe('Mainnet');
    expect(testnet.hyperliquidChain).toBe('Testnet');
    // Mainnet and testnet are different hosts; mismatching these is the cause of
    // "Mainnet and testnet require different signature".
    expect(hyperliquidApiUrl(false)).toBe('https://api.hyperliquid.xyz');
    expect(hyperliquidApiUrl(true)).toBe('https://api.hyperliquid-testnet.xyz');
  });
});

describe('expiry warning', () => {
  test('flags an authorization inside the warning window', () => {
    expect(isApprovalExpiring(Date.now() + AGENT_EXPIRY_WARNING_MS / 2)).toBe(true);
  });

  test('does not flag a distant authorization', () => {
    expect(isApprovalExpiring(Date.now() + AGENT_EXPIRY_WARNING_MS * 4)).toBe(false);
  });

  test('treats a missing expiry as not expiring', () => {
    expect(isApprovalExpiring(null)).toBe(false);
  });
});
