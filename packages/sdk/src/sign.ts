/**
 * EIP-712 typed-data builders for Hyperliquid wallet-signed actions.
 *
 * The wallet (user's MAIN wallet for approveAgent / approveBuilderFee, or the
 * agent key for orders) signs the *typed data* produced here via viem's
 * `signTypedData`. The HL API receives `{action, signature, nonce}`.
 *
 * Domain and primaryType strings are protocol-pinned — see [docs/phase-2.md].
 * Do not "simplify" or generalize the typed-data layout; the API checks the
 * exact hash and a single mismatched character causes silent rejection.
 */
import {
  HL_DOMAIN_CHAIN_ID,
  HL_DOMAIN_NAME,
  HL_DOMAIN_VERSION,
  HL_VERIFYING_CONTRACT,
} from './constants.js';
import type { HlApproveAgentAction, HlApproveBuilderFeeAction } from './types.js';

/** EIP-712 domain shared by every HL user-signed action. */
export const HL_TYPED_DATA_DOMAIN = {
  name: HL_DOMAIN_NAME,
  version: HL_DOMAIN_VERSION,
  chainId: HL_DOMAIN_CHAIN_ID,
  verifyingContract: HL_VERIFYING_CONTRACT,
} as const;

const APPROVE_AGENT_PRIMARY_TYPE = 'HyperliquidTransaction:ApproveAgent';
const APPROVE_BUILDER_FEE_PRIMARY_TYPE = 'HyperliquidTransaction:ApproveBuilderFee';

const APPROVE_AGENT_TYPES = {
  [APPROVE_AGENT_PRIMARY_TYPE]: [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

const APPROVE_BUILDER_FEE_TYPES = {
  [APPROVE_BUILDER_FEE_PRIMARY_TYPE]: [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'maxFeeRate', type: 'string' },
    { name: 'builder', type: 'address' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export interface TypedDataPayload<TPrimary extends string, TMessage> {
  readonly domain: typeof HL_TYPED_DATA_DOMAIN;
  readonly types: Readonly<Record<TPrimary, readonly { name: string; type: string }[]>>;
  readonly primaryType: TPrimary;
  readonly message: TMessage;
}

export function buildApproveAgentTypedData(action: HlApproveAgentAction): TypedDataPayload<
  typeof APPROVE_AGENT_PRIMARY_TYPE,
  {
    hyperliquidChain: 'Mainnet' | 'Testnet';
    agentAddress: string;
    agentName: string;
    nonce: bigint;
  }
> {
  return {
    domain: HL_TYPED_DATA_DOMAIN,
    types: APPROVE_AGENT_TYPES,
    primaryType: APPROVE_AGENT_PRIMARY_TYPE,
    message: {
      hyperliquidChain: action.hyperliquidChain,
      agentAddress: action.agentAddress,
      agentName: action.agentName,
      nonce: BigInt(action.nonce),
    },
  };
}

export function buildApproveBuilderFeeTypedData(
  action: HlApproveBuilderFeeAction,
): TypedDataPayload<
  typeof APPROVE_BUILDER_FEE_PRIMARY_TYPE,
  {
    hyperliquidChain: 'Mainnet' | 'Testnet';
    maxFeeRate: string;
    builder: string;
    nonce: bigint;
  }
> {
  return {
    domain: HL_TYPED_DATA_DOMAIN,
    types: APPROVE_BUILDER_FEE_TYPES,
    primaryType: APPROVE_BUILDER_FEE_PRIMARY_TYPE,
    message: {
      hyperliquidChain: action.hyperliquidChain,
      maxFeeRate: action.maxFeeRate,
      builder: action.builder,
      nonce: BigInt(action.nonce),
    },
  };
}
