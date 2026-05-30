import { describe, expect, it } from 'vitest';
import { Address } from '@whalepod/schema';
import { HL_DOMAIN_NAME, HL_DOMAIN_VERSION, HL_SIG_CHAIN_ID } from './constants.js';
import { buildApproveBuilderFeeAction, buildRevokeBuilderFeeAction } from './builder.js';

const BUILDER = Address.parse('0x1111222233334444555566667777888899990000');

describe('buildApproveBuilderFeeAction', () => {
  it('pins chainId to Arbitrum 0xa4b1', () => {
    const action = buildApproveBuilderFeeAction({
      builderAddress: BUILDER,
      maxFeeTenthsBp: 50,
      chain: 'Mainnet',
      nonce: 1_700_000_000_000,
    });
    expect(action.signatureChainId).toBe(HL_SIG_CHAIN_ID);
  });

  it('formats maxFeeRate as percentage string', () => {
    const action = buildApproveBuilderFeeAction({
      builderAddress: BUILDER,
      maxFeeTenthsBp: 50,
      chain: 'Mainnet',
      nonce: 1,
    });
    expect(action.maxFeeRate).toBe('0.0500%');
  });

  it('includes builder address verbatim', () => {
    const action = buildApproveBuilderFeeAction({
      builderAddress: BUILDER,
      maxFeeTenthsBp: 50,
      chain: 'Mainnet',
      nonce: 1,
    });
    expect(action.builder).toBe(BUILDER);
  });

  it('threads server-supplied nonce through', () => {
    const action = buildApproveBuilderFeeAction({
      builderAddress: BUILDER,
      maxFeeTenthsBp: 50,
      chain: 'Mainnet',
      nonce: 1_700_000_000_000,
    });
    expect(action.nonce).toBe(1_700_000_000_000);
  });

  it('selects Mainnet vs Testnet per server pin', () => {
    const tn = buildApproveBuilderFeeAction({
      builderAddress: BUILDER,
      maxFeeTenthsBp: 50,
      chain: 'Testnet',
      nonce: 1,
    });
    expect(tn.hyperliquidChain).toBe('Testnet');
  });
});

describe('buildRevokeBuilderFeeAction', () => {
  it('produces the canonical "0%" revocation', () => {
    const action = buildRevokeBuilderFeeAction({
      builderAddress: BUILDER,
      chain: 'Mainnet',
      nonce: 1,
    });
    expect(action.maxFeeRate).toBe('0%');
    expect(action.type).toBe('approveBuilderFee');
  });
});

describe('domain constants', () => {
  it('are pinned per HL spec', () => {
    expect(HL_DOMAIN_NAME).toBe('HyperliquidSignTransaction');
    expect(HL_DOMAIN_VERSION).toBe('1');
    expect(HL_SIG_CHAIN_ID).toBe('0xa4b1');
  });
});
