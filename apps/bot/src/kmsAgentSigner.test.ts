/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import { FakeKms, generateAgentKey, sealAgentKey } from '@whalepod/vault';
import { verifyTypedData } from 'viem';
import { KmsAgentSigner, type AgentKeyLookup } from './kmsAgentSigner.js';
import { buildL1ConnectionId, type HlOrderAction } from '@whalepod/sdk';

const ACTION: HlOrderAction = {
  type: 'order',
  orders: [],
  grouping: 'na',
  builder: { b: '0x0000000000000000000000000000000000000000', f: 50 },
};

describe('KmsAgentSigner', () => {
  it('signs an L1 action with the user-bound agent key (recoverable)', async () => {
    const kms = new FakeKms();
    const key = generateAgentKey();
    const sealed = await sealAgentKey({
      privateKey: key.privateKey,
      kms,
      encryptionContext: { mainWallet: '0xaaaa', purpose: 'agent-key' },
    });
    const keys: AgentKeyLookup = { forUser: async () => ({ sealed, mainWallet: '0xaaaa' }) };
    const signer = new KmsAgentSigner({ kms, keys, isMainnet: true });

    const sig = await signer.sign({
      userId: 'u1',
      agentAddress: key.address,
      action: ACTION,
      nonce: 1,
    });

    const vHex = sig.v.toString(16).padStart(2, '0');
    const flat = `${sig.r}${sig.s.slice(2)}${vHex}` as `0x${string}`;
    const connectionId = buildL1ConnectionId({ action: ACTION, nonce: 1 });
    const ok = await verifyTypedData({
      address: key.address,
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

  it('throws when the user has no agent key', async () => {
    const kms = new FakeKms();
    const keys: AgentKeyLookup = { forUser: async () => undefined };
    const signer = new KmsAgentSigner({ kms, keys, isMainnet: true });
    await expect(
      signer.sign({
        userId: 'u-missing',
        agentAddress: '0x000000000000000000000000000000000000abcd',
        action: ACTION,
        nonce: 1,
      }),
    ).rejects.toThrow(/agent key not found/u);
  });

  it('refuses to sign when the stored key address differs from the expected agentAddress', async () => {
    const kms = new FakeKms();
    const key = generateAgentKey();
    const sealed = await sealAgentKey({
      privateKey: key.privateKey,
      kms,
      encryptionContext: { mainWallet: '0xbbbb', purpose: 'agent-key' },
    });
    const keys: AgentKeyLookup = { forUser: async () => ({ sealed, mainWallet: '0xbbbb' }) };
    const signer = new KmsAgentSigner({ kms, keys, isMainnet: true });
    await expect(
      signer.sign({
        userId: 'u1',
        agentAddress: '0x000000000000000000000000000000000000dead',
        action: ACTION,
        nonce: 1,
      }),
    ).rejects.toThrow(/agent key address mismatch/u);
  });
});
