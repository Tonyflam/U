import { HL_SIG_CHAIN_ID } from './constants.js';
import { feeRateString } from './fee.js';
import type { Address } from '@whalepod/schema';
import type { HlApproveBuilderFeeAction } from './types.js';

export interface BuildApproveBuilderFeeInput {
  readonly builderAddress: Address;
  /** Max fee user is approving (tenths of bp). 50 = 5 bps. */
  readonly maxFeeTenthsBp: number;
  /** Mainnet or Testnet. Server-pinned, NEVER user-controlled. */
  readonly chain: 'Mainnet' | 'Testnet';
  /** Nonce — current ms timestamp. Caller provides for testability. */
  readonly nonce: number;
}

/**
 * Build the HL `approveBuilderFee` action. User signs this once per
 * device/agent and it sets the on-chain ceiling for `builder.f`.
 *
 * Passing `maxFeeTenthsBp: 0` produces the canonical revocation action
 * (`maxFeeRate: "0%"`) — used by `/revoke`.
 */
export function buildApproveBuilderFeeAction(
  input: BuildApproveBuilderFeeInput,
): HlApproveBuilderFeeAction {
  return {
    type: 'approveBuilderFee',
    hyperliquidChain: input.chain,
    signatureChainId: HL_SIG_CHAIN_ID,
    maxFeeRate: feeRateString(input.maxFeeTenthsBp),
    builder: input.builderAddress,
    nonce: input.nonce,
  };
}

/**
 * Canonical revoke: re-approve at "0%". Hyperliquid treats this as turning
 * the builder fee off entirely for this (user, builder) pair.
 */
export function buildRevokeBuilderFeeAction(input: {
  readonly builderAddress: Address;
  readonly chain: 'Mainnet' | 'Testnet';
  readonly nonce: number;
}): HlApproveBuilderFeeAction {
  return buildApproveBuilderFeeAction({
    builderAddress: input.builderAddress,
    chain: input.chain,
    maxFeeTenthsBp: 0,
    nonce: input.nonce,
  });
}
