import { describe, expect, it } from 'vitest';
import { InMemoryProvisionalStore } from './onboardRepo.js';
import type { ProvisionalRow } from '@whalepod/miniapp';

function fakeRow(id: string): ProvisionalRow {
  return {
    id,
    tgUserId: 1n,
    tgUsername: null,
    mainWallet: '0x1111222233334444555566667777888899990000',
    agentAddress: '0xaaaa222233334444555566667777888899990000',
    sealed: {
      ct: new Uint8Array([1]),
      iv: new Uint8Array(12),
      tag: new Uint8Array(16),
      dekCt: new Uint8Array([2]),
    },
    approvedMaxFeeTenthsBp: 50,
    currentFeeTenthsBp: 50,
    equityFloorUsd: '0',
    approveAgentAction: {
      type: 'approveAgent',
      hyperliquidChain: 'Mainnet',
      signatureChainId: '0xa4b1',
      agentAddress: '0xaaaa222233334444555566667777888899990000',
      agentName: 'WhalePod',
      nonce: 1,
    },
    approveBuilderFeeAction: {
      type: 'approveBuilderFee',
      hyperliquidChain: 'Mainnet',
      signatureChainId: '0xa4b1',
      maxFeeRate: '0.0500%',
      builder: '0x2222333344445555666677778888999900001111',
      nonce: 2,
    },
  };
}

describe('InMemoryProvisionalStore', () => {
  it('put + get round-trip', async () => {
    const s = new InMemoryProvisionalStore();
    const row = fakeRow('p1');
    await s.put(row);
    expect(await s.get('p1')).toBe(row);
  });

  it('get returns null when missing', async () => {
    const s = new InMemoryProvisionalStore();
    expect(await s.get('nope')).toBeNull();
  });

  it('delete removes the row', async () => {
    const s = new InMemoryProvisionalStore();
    await s.put(fakeRow('p1'));
    await s.delete('p1');
    expect(await s.get('p1')).toBeNull();
  });
});
