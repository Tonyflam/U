import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { buildL1ConnectionId, signL1Action } from './signL1.js';

// Random throwaway key for tests only.
const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

describe('buildL1ConnectionId', () => {
  it('produces a 32-byte keccak hash', () => {
    const h = buildL1ConnectionId({ action: { type: 'order' }, nonce: 1 });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it('is deterministic for identical inputs', () => {
    const a = buildL1ConnectionId({ action: { type: 'order' }, nonce: 42 });
    const b = buildL1ConnectionId({ action: { type: 'order' }, nonce: 42 });
    expect(a).toBe(b);
  });

  it('changes when nonce changes', () => {
    const a = buildL1ConnectionId({ action: { type: 'order' }, nonce: 1 });
    const b = buildL1ConnectionId({ action: { type: 'order' }, nonce: 2 });
    expect(a).not.toBe(b);
  });

  it('changes when vaultAddress is supplied', () => {
    const base = buildL1ConnectionId({ action: { type: 'order' }, nonce: 1 });
    const vaulted = buildL1ConnectionId({
      action: { type: 'order' },
      nonce: 1,
      vaultAddress: '0x000000000000000000000000000000000000abcd',
    });
    expect(base).not.toBe(vaulted);
  });
});

describe('signL1Action', () => {
  it('returns a recoverable signature for the agent envelope', async () => {
    const account = privateKeyToAccount(PK);
    const action = { type: 'order', orders: [], grouping: 'na' };
    const sig = await signL1Action({ account, action, nonce: 1234, isMainnet: true });

    // Re-build the full 65-byte signature and recover via verifyTypedData.
    const vHex = sig.v.toString(16).padStart(2, '0');
    const flat = `${sig.r}${sig.s.slice(2)}${vHex}` as `0x${string}`;
    const connectionId = buildL1ConnectionId({ action, nonce: 1234 });
    const ok = await verifyTypedData({
      address: account.address,
      domain: {
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' },
        ],
      },
      primaryType: 'Agent',
      message: { source: 'a', connectionId },
      signature: flat,
    });
    expect(ok).toBe(true);
  });

  it('uses source="b" for testnet', async () => {
    const account = privateKeyToAccount(PK);
    const action = { type: 'order' };
    const sig = await signL1Action({ account, action, nonce: 1, isMainnet: false });

    const vHex = sig.v.toString(16).padStart(2, '0');
    const flat = `${sig.r}${sig.s.slice(2)}${vHex}` as `0x${string}`;
    const connectionId = buildL1ConnectionId({ action, nonce: 1 });
    const ok = await verifyTypedData({
      address: account.address,
      domain: {
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' },
        ],
      },
      primaryType: 'Agent',
      message: { source: 'b', connectionId },
      signature: flat,
    });
    expect(ok).toBe(true);
  });
});
