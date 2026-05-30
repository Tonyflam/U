import { describe, expect, it } from 'vitest';
import {
  initialOnboardingState,
  onboardingReducer,
  OnboardingTransitionError,
  type OnboardingEvent,
  type OnboardingState,
} from './onboarding.js';

const WALLET = '0x1111222233334444555566667777888899990000';
const AGENT = '0xaaaa222233334444555566667777888899990000';
const SIG_A = '0xa1';
const SIG_B = '0xb2';

function run(events: OnboardingEvent[]): OnboardingState {
  return events.reduce(onboardingReducer, initialOnboardingState);
}

describe('onboardingReducer', () => {
  it('drives the full happy path to submitted', () => {
    const final = run([
      { kind: 'walletConnected', mainWallet: WALLET },
      {
        kind: 'agentGenerated',
        agentAddress: AGENT,
        approveAgentNonce: 1,
        approveBuilderFeeNonce: 2,
      },
      { kind: 'approveAgentSigned', signature: SIG_A },
      { kind: 'approveBuilderFeeSigned', signature: SIG_B },
      { kind: 'submitted', userId: 'u-1', tgUserId: 123n },
    ]);
    expect(final.status).toBe('submitted');
  });

  it('error is reachable from any non-terminal state', () => {
    const s = run([
      { kind: 'walletConnected', mainWallet: WALLET },
      { kind: 'error', message: 'wallet rejected' },
    ]);
    expect(s).toStrictEqual({ status: 'error', message: 'wallet rejected' });
  });

  it('rejects out-of-order events', () => {
    expect(() => run([{ kind: 'approveAgentSigned', signature: SIG_A }])).toThrowError(
      OnboardingTransitionError,
    );
  });

  it('refuses further events after submitted', () => {
    expect(() =>
      run([
        { kind: 'walletConnected', mainWallet: WALLET },
        {
          kind: 'agentGenerated',
          agentAddress: AGENT,
          approveAgentNonce: 1,
          approveBuilderFeeNonce: 2,
        },
        { kind: 'approveAgentSigned', signature: SIG_A },
        { kind: 'approveBuilderFeeSigned', signature: SIG_B },
        { kind: 'submitted', userId: 'u-1', tgUserId: 123n },
        { kind: 'walletConnected', mainWallet: WALLET },
      ]),
    ).toThrowError(OnboardingTransitionError);
  });

  it('refuses further events after error', () => {
    expect(() =>
      run([
        { kind: 'walletConnected', mainWallet: WALLET },
        { kind: 'error', message: 'x' },
        { kind: 'walletConnected', mainWallet: WALLET },
      ]),
    ).toThrowError(OnboardingTransitionError);
  });

  it('carries forward mainWallet through every transition', () => {
    const s = run([
      { kind: 'walletConnected', mainWallet: WALLET },
      {
        kind: 'agentGenerated',
        agentAddress: AGENT,
        approveAgentNonce: 1,
        approveBuilderFeeNonce: 2,
      },
      { kind: 'approveAgentSigned', signature: SIG_A },
      { kind: 'approveBuilderFeeSigned', signature: SIG_B },
    ]);
    if (s.status !== 'builderFeeApproved') throw new Error('unexpected status');
    expect(s.mainWallet).toBe(WALLET);
    expect(s.agentAddress).toBe(AGENT);
    expect(s.approveAgentSig).toBe(SIG_A);
    expect(s.approveBuilderFeeSig).toBe(SIG_B);
  });
});
