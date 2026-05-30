import { describe, expect, it } from 'vitest';
import { OnboardStartRequest, OnboardCompleteRequest } from './onboardSchema.js';

const WALLET = '0x1111222233334444555566667777888899990000';

describe('OnboardStartRequest', () => {
  it('accepts a valid body', () => {
    const out = OnboardStartRequest.parse({
      tgUserId: 12345n,
      tgUsername: 'alice',
      mainWallet: WALLET,
      equityFloorUsd: '100.00',
      approvedMaxFeeTenthsBp: 50,
    });
    expect(out.mainWallet).toBe(WALLET);
  });

  it('normalizes mixed-case wallets to lowercase', () => {
    const out = OnboardStartRequest.parse({
      tgUserId: 1n,
      mainWallet: '0xABCDEF1111111111111111111111111111111111',
      equityFloorUsd: '0',
      approvedMaxFeeTenthsBp: 0,
    });
    expect(out.mainWallet).toBe('0xabcdef1111111111111111111111111111111111');
  });

  it('rejects a wallet missing 0x prefix', () => {
    expect(() =>
      OnboardStartRequest.parse({
        tgUserId: 1n,
        mainWallet: 'abcdef1111111111111111111111111111111111',
        equityFloorUsd: '0',
        approvedMaxFeeTenthsBp: 0,
      }),
    ).toThrow();
  });

  it('rejects approvedMaxFeeTenthsBp over the protocol cap', () => {
    expect(() =>
      OnboardStartRequest.parse({
        tgUserId: 1n,
        mainWallet: WALLET,
        equityFloorUsd: '0',
        approvedMaxFeeTenthsBp: 101,
      }),
    ).toThrow();
  });

  it('rejects malformed equityFloorUsd', () => {
    expect(() =>
      OnboardStartRequest.parse({
        tgUserId: 1n,
        mainWallet: WALLET,
        equityFloorUsd: '-1',
        approvedMaxFeeTenthsBp: 0,
      }),
    ).toThrow();
  });
});

describe('OnboardCompleteRequest', () => {
  it('accepts a valid body', () => {
    const out = OnboardCompleteRequest.parse({
      provisionalId: '00000000-0000-0000-0000-000000000001',
      approveAgentSig: '0xdeadbeef',
      approveBuilderFeeSig: '0xcafebabe',
    });
    expect(out.approveAgentSig).toBe('0xdeadbeef');
  });

  it('rejects a non-uuid provisionalId', () => {
    expect(() =>
      OnboardCompleteRequest.parse({
        provisionalId: 'not-a-uuid',
        approveAgentSig: '0xab',
        approveBuilderFeeSig: '0xcd',
      }),
    ).toThrow();
  });

  it('rejects non-hex signatures', () => {
    expect(() =>
      OnboardCompleteRequest.parse({
        provisionalId: '00000000-0000-0000-0000-000000000001',
        approveAgentSig: 'not-hex',
        approveBuilderFeeSig: '0xcd',
      }),
    ).toThrow();
  });
});
