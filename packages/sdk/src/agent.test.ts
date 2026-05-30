import { describe, expect, it } from 'vitest';
import { HL_SIG_CHAIN_ID } from './constants.js';
import { buildApproveAgentAction } from './agent.js';

const AGENT = '0x1111222233334444555566667777888899990000';

describe('buildApproveAgentAction', () => {
  it('produces the canonical HL approveAgent shape', () => {
    const a = buildApproveAgentAction({
      agentAddress: AGENT,
      agentName: 'WhalePod',
      chain: 'Mainnet',
      nonce: 1717000000000,
    });
    expect(a).toStrictEqual({
      type: 'approveAgent',
      hyperliquidChain: 'Mainnet',
      signatureChainId: HL_SIG_CHAIN_ID,
      agentAddress: AGENT,
      agentName: 'WhalePod',
      nonce: 1717000000000,
    });
  });

  it('pins signatureChainId to 0xa4b1 regardless of chain', () => {
    const main = buildApproveAgentAction({
      agentAddress: AGENT,
      agentName: 'x',
      chain: 'Mainnet',
      nonce: 1,
    });
    const test = buildApproveAgentAction({
      agentAddress: AGENT,
      agentName: 'x',
      chain: 'Testnet',
      nonce: 1,
    });
    expect(main.signatureChainId).toBe('0xa4b1');
    expect(test.signatureChainId).toBe('0xa4b1');
  });

  it('keeps the user-controllable surface to exactly the documented fields', () => {
    const a = buildApproveAgentAction({
      agentAddress: AGENT,
      agentName: 'WhalePod',
      chain: 'Testnet',
      nonce: 42,
    });
    expect(Object.keys(a).sort()).toStrictEqual(
      ['type', 'hyperliquidChain', 'signatureChainId', 'agentAddress', 'agentName', 'nonce'].sort(),
    );
  });
});
