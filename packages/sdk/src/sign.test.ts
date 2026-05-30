import { describe, expect, it } from 'vitest';
import {
  HL_DOMAIN_CHAIN_ID,
  HL_DOMAIN_NAME,
  HL_DOMAIN_VERSION,
  HL_VERIFYING_CONTRACT,
} from './constants.js';
import {
  HL_TYPED_DATA_DOMAIN,
  buildApproveAgentTypedData,
  buildApproveBuilderFeeTypedData,
} from './sign.js';
import { buildApproveAgentAction } from './agent.js';
import { buildApproveBuilderFeeAction } from './builder.js';

const AGENT = '0x1111222233334444555566667777888899990000';
const BUILDER = '0x2222333344445555666677778888999900001111';

describe('HL_TYPED_DATA_DOMAIN', () => {
  it('matches the protocol-pinned values', () => {
    expect(HL_TYPED_DATA_DOMAIN).toStrictEqual({
      name: HL_DOMAIN_NAME,
      version: HL_DOMAIN_VERSION,
      chainId: HL_DOMAIN_CHAIN_ID,
      verifyingContract: HL_VERIFYING_CONTRACT,
    });
    expect(HL_DOMAIN_CHAIN_ID).toBe(42161);
    expect(HL_VERIFYING_CONTRACT).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('buildApproveAgentTypedData', () => {
  it('produces the exact EIP-712 shape HL expects', () => {
    const action = buildApproveAgentAction({
      agentAddress: AGENT,
      agentName: 'WhalePod',
      chain: 'Mainnet',
      nonce: 1717000000000,
    });
    const td = buildApproveAgentTypedData(action);
    expect(td.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    expect(td.types['HyperliquidTransaction:ApproveAgent']).toStrictEqual([
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'agentAddress', type: 'address' },
      { name: 'agentName', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ]);
    expect(td.message).toStrictEqual({
      hyperliquidChain: 'Mainnet',
      agentAddress: AGENT,
      agentName: 'WhalePod',
      nonce: 1717000000000n,
    });
    expect(td.domain).toBe(HL_TYPED_DATA_DOMAIN);
  });
});

describe('buildApproveBuilderFeeTypedData', () => {
  it('produces the exact EIP-712 shape with maxFeeRate as string', () => {
    const action = buildApproveBuilderFeeAction({
      builderAddress: BUILDER,
      chain: 'Mainnet',
      maxFeeTenthsBp: 50,
      nonce: 1717000000000,
    });
    const td = buildApproveBuilderFeeTypedData(action);
    expect(td.primaryType).toBe('HyperliquidTransaction:ApproveBuilderFee');
    expect(td.types['HyperliquidTransaction:ApproveBuilderFee']).toStrictEqual([
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'maxFeeRate', type: 'string' },
      { name: 'builder', type: 'address' },
      { name: 'nonce', type: 'uint64' },
    ]);
    expect(td.message.maxFeeRate).toBe('0.0500%');
    expect(td.message.builder).toBe(BUILDER);
    expect(td.message.nonce).toBe(1717000000000n);
  });

  it('encodes a revoke (0%) the same way as any other approval', () => {
    const action = buildApproveBuilderFeeAction({
      builderAddress: BUILDER,
      chain: 'Mainnet',
      maxFeeTenthsBp: 0,
      nonce: 1,
    });
    const td = buildApproveBuilderFeeTypedData(action);
    expect(td.message.maxFeeRate).toBe('0%');
  });
});
