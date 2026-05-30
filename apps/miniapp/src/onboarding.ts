/**
 * Pure onboarding state machine for the WhalePod mini-app.
 *
 * Drives the UI through:
 *   start
 *     → walletConnected         (user connected main wallet via WC/deeplink)
 *     → agentGenerated          (client called /api/onboard/start, got agent address + nonces)
 *     → agentApproved           (main wallet signed HL approveAgent typed data)
 *     → builderFeeApproved      (main wallet signed HL approveBuilderFee typed data)
 *     → submitted               (server stored sealed vault row + returned user.id)
 *     → error                   (terminal — surfaces err.message in UI; reducer rejects further events)
 *
 * The reducer is pure so the UI can replay events for tests, and so the
 * end-to-end onboarding contract is independently verifiable.
 */
import type { Address } from '@whalepod/schema';

export type OnboardingState =
  | { readonly status: 'idle' }
  | { readonly status: 'walletConnected'; readonly mainWallet: Address }
  | {
      readonly status: 'agentGenerated';
      readonly mainWallet: Address;
      readonly agentAddress: Address;
      readonly approveAgentNonce: number;
      readonly approveBuilderFeeNonce: number;
    }
  | {
      readonly status: 'agentApproved';
      readonly mainWallet: Address;
      readonly agentAddress: Address;
      readonly approveAgentNonce: number;
      readonly approveAgentSig: `0x${string}`;
      readonly approveBuilderFeeNonce: number;
    }
  | {
      readonly status: 'builderFeeApproved';
      readonly mainWallet: Address;
      readonly agentAddress: Address;
      readonly approveAgentNonce: number;
      readonly approveAgentSig: `0x${string}`;
      readonly approveBuilderFeeNonce: number;
      readonly approveBuilderFeeSig: `0x${string}`;
    }
  | { readonly status: 'submitted'; readonly userId: string; readonly tgUserId: bigint }
  | { readonly status: 'error'; readonly message: string };

export type OnboardingEvent =
  | { readonly kind: 'walletConnected'; readonly mainWallet: Address }
  | {
      readonly kind: 'agentGenerated';
      readonly agentAddress: Address;
      readonly approveAgentNonce: number;
      readonly approveBuilderFeeNonce: number;
    }
  | { readonly kind: 'approveAgentSigned'; readonly signature: `0x${string}` }
  | { readonly kind: 'approveBuilderFeeSigned'; readonly signature: `0x${string}` }
  | { readonly kind: 'submitted'; readonly userId: string; readonly tgUserId: bigint }
  | { readonly kind: 'error'; readonly message: string };

export const initialOnboardingState: OnboardingState = { status: 'idle' };

export class OnboardingTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingTransitionError';
  }
}

export function onboardingReducer(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  if (event.kind === 'error') {
    return { status: 'error', message: event.message };
  }
  if (state.status === 'error' || state.status === 'submitted') {
    throw new OnboardingTransitionError(
      `cannot apply ${event.kind} in terminal state ${state.status}`,
    );
  }
  switch (event.kind) {
    case 'walletConnected':
      if (state.status !== 'idle') {
        throw new OnboardingTransitionError(`walletConnected requires idle, got ${state.status}`);
      }
      return { status: 'walletConnected', mainWallet: event.mainWallet };
    case 'agentGenerated':
      if (state.status !== 'walletConnected') {
        throw new OnboardingTransitionError(
          `agentGenerated requires walletConnected, got ${state.status}`,
        );
      }
      return {
        status: 'agentGenerated',
        mainWallet: state.mainWallet,
        agentAddress: event.agentAddress,
        approveAgentNonce: event.approveAgentNonce,
        approveBuilderFeeNonce: event.approveBuilderFeeNonce,
      };
    case 'approveAgentSigned':
      if (state.status !== 'agentGenerated') {
        throw new OnboardingTransitionError(
          `approveAgentSigned requires agentGenerated, got ${state.status}`,
        );
      }
      return {
        status: 'agentApproved',
        mainWallet: state.mainWallet,
        agentAddress: state.agentAddress,
        approveAgentNonce: state.approveAgentNonce,
        approveAgentSig: event.signature,
        approveBuilderFeeNonce: state.approveBuilderFeeNonce,
      };
    case 'approveBuilderFeeSigned':
      if (state.status !== 'agentApproved') {
        throw new OnboardingTransitionError(
          `approveBuilderFeeSigned requires agentApproved, got ${state.status}`,
        );
      }
      return {
        status: 'builderFeeApproved',
        mainWallet: state.mainWallet,
        agentAddress: state.agentAddress,
        approveAgentNonce: state.approveAgentNonce,
        approveAgentSig: state.approveAgentSig,
        approveBuilderFeeNonce: state.approveBuilderFeeNonce,
        approveBuilderFeeSig: event.signature,
      };
    case 'submitted':
      if (state.status !== 'builderFeeApproved') {
        throw new OnboardingTransitionError(
          `submitted requires builderFeeApproved, got ${state.status}`,
        );
      }
      return { status: 'submitted', userId: event.userId, tgUserId: event.tgUserId };
  }
}
