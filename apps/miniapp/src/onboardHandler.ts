/**
 * Server-side onboarding handlers — pure (transport-agnostic).
 *
 * Wire into Next.js route handlers in the UI shell (deferred to the
 * testnet-wiring unit). All side effects are behind injected dependencies:
 *
 *  - `repo`     persists provisional and finalized rows (Postgres in prod;
 *               in-memory map in tests)
 *  - `kms`      seals the DEK (real AWS KMS in prod; FakeKms in tests)
 *  - `generateAgentKey` lets tests inject a deterministic key
 *  - `now`      lets tests pin the EIP-712 nonce
 *  - `verifyTypedData` matches viem's signature recovery; tests inject a fake
 *
 * Security invariants enforced here:
 *   I-1  agent private key is generated server-side and never returned
 *   I-2  approveAgent + approveBuilderFee signatures MUST recover to mainWallet
 *   I-3  approvedMaxFeeTenthsBp is clamped to the protocol cap (FeeTenthsBp
 *        validator in @whalepod/schema)
 *   I-4  KMS encryptionContext binds the sealed vault to (userId, purpose)
 *        so a stolen blob cannot be re-bound to a different user
 */
import type { z } from 'zod';
import {
  BUILDER_FEE_DEFAULT_TENTHS_BP,
  buildApproveAgentAction,
  buildApproveAgentTypedData,
  buildApproveBuilderFeeAction,
  buildApproveBuilderFeeTypedData,
  type TypedDataPayload,
} from '@whalepod/sdk';
import {
  generateAgentKey as defaultGenerateAgentKey,
  sealAgentKey,
  type NewAgentKey,
  type SealedAgentKey,
  type VaultKms,
} from '@whalepod/vault';
import { zeroize } from '@whalepod/config';
import type { Address } from '@whalepod/schema';
import {
  OnboardCompleteRequest,
  OnboardStartRequest,
  type OnboardCompleteRequest as TOnboardComplete,
  type OnboardStartRequest as TOnboardStart,
} from './onboardSchema.js';

export interface ProvisionalRow {
  readonly id: string;
  readonly tgUserId: bigint;
  readonly tgUsername: string | null;
  readonly mainWallet: Address;
  readonly agentAddress: Address;
  readonly sealed: SealedAgentKey;
  readonly approvedMaxFeeTenthsBp: number;
  readonly currentFeeTenthsBp: number;
  readonly equityFloorUsd: string;
  readonly approveAgentAction: ReturnType<typeof buildApproveAgentAction>;
  readonly approveBuilderFeeAction: ReturnType<typeof buildApproveBuilderFeeAction>;
}

export interface OnboardRepo {
  putProvisional(row: ProvisionalRow): Promise<void>;
  getProvisional(id: string): Promise<ProvisionalRow | null>;
  finalize(
    provisionalId: string,
    sigs: { approveAgentSig: `0x${string}`; approveBuilderFeeSig: `0x${string}` },
  ): Promise<{ userId: string }>;
}

export type VerifyTypedDataFn = (args: {
  address: `0x${string}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  domain: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  types: any;
  primaryType: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any;
  signature: `0x${string}`;
}) => Promise<boolean>;

export interface OnboardDeps {
  readonly repo: OnboardRepo;
  readonly kms: VaultKms;
  readonly builderAddress: Address;
  readonly chain: 'Mainnet' | 'Testnet';
  readonly agentName: string;
  readonly now?: () => number;
  readonly generateAgentKey?: () => NewAgentKey;
  readonly newId?: () => string;
  readonly verifyTypedData: VerifyTypedDataFn;
}

export interface StartResponse {
  readonly provisionalId: string;
  readonly agentAddress: Address;
  readonly approveAgent: {
    readonly action: ReturnType<typeof buildApproveAgentAction>;
    readonly typedData: ReturnType<typeof buildApproveAgentTypedData>;
  };
  readonly approveBuilderFee: {
    readonly action: ReturnType<typeof buildApproveBuilderFeeAction>;
    readonly typedData: ReturnType<typeof buildApproveBuilderFeeTypedData>;
  };
}

export class OnboardError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'provisional_not_found'
      | 'signature_mismatch'
      | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'OnboardError';
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new OnboardError('invalid_request', parsed.error.message);
  }
  return parsed.data;
}

export async function onboardStartHandler(
  body: unknown,
  deps: OnboardDeps,
): Promise<StartResponse> {
  const req: TOnboardStart = parseOrThrow(OnboardStartRequest, body);
  const now = deps.now ?? (() => Date.now());
  const gen = deps.generateAgentKey ?? defaultGenerateAgentKey;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const provisionalId = newId();
  const key = gen();
  let sealed: SealedAgentKey;
  try {
    sealed = await sealAgentKey({
      privateKey: key.privateKey,
      kms: deps.kms,
      encryptionContext: { provisionalId, purpose: 'agent-key' },
    });
  } finally {
    zeroize(key.privateKey);
  }

  const approveAgentNonce = now();
  const approveBuilderFeeNonce = approveAgentNonce + 1;

  const currentFeeTenthsBp = Math.min(req.approvedMaxFeeTenthsBp, BUILDER_FEE_DEFAULT_TENTHS_BP);

  const approveAgentAction = buildApproveAgentAction({
    agentAddress: key.address,
    agentName: deps.agentName,
    chain: deps.chain,
    nonce: approveAgentNonce,
  });
  const approveBuilderFeeAction = buildApproveBuilderFeeAction({
    builderAddress: deps.builderAddress,
    chain: deps.chain,
    maxFeeTenthsBp: req.approvedMaxFeeTenthsBp,
    nonce: approveBuilderFeeNonce,
  });

  await deps.repo.putProvisional({
    id: provisionalId,
    tgUserId: req.tgUserId,
    tgUsername: req.tgUsername ?? null,
    mainWallet: req.mainWallet,
    agentAddress: key.address,
    sealed,
    approvedMaxFeeTenthsBp: req.approvedMaxFeeTenthsBp,
    currentFeeTenthsBp,
    equityFloorUsd: req.equityFloorUsd,
    approveAgentAction,
    approveBuilderFeeAction,
  });

  return {
    provisionalId,
    agentAddress: key.address,
    approveAgent: {
      action: approveAgentAction,
      typedData: buildApproveAgentTypedData(approveAgentAction),
    },
    approveBuilderFee: {
      action: approveBuilderFeeAction,
      typedData: buildApproveBuilderFeeTypedData(approveBuilderFeeAction),
    },
  };
}

export async function onboardCompleteHandler(
  body: unknown,
  deps: OnboardDeps,
): Promise<{ userId: string }> {
  const req: TOnboardComplete = parseOrThrow(OnboardCompleteRequest, body);
  const approveAgentSig = req.approveAgentSig as `0x${string}`;
  const approveBuilderFeeSig = req.approveBuilderFeeSig as `0x${string}`;
  const prov = await deps.repo.getProvisional(req.provisionalId);
  if (!prov) {
    throw new OnboardError('provisional_not_found', `no provisional row for ${req.provisionalId}`);
  }
  const agentTd: TypedDataPayload<string, unknown> = buildApproveAgentTypedData(
    prov.approveAgentAction,
  );
  const builderTd: TypedDataPayload<string, unknown> = buildApproveBuilderFeeTypedData(
    prov.approveBuilderFeeAction,
  );
  const okAgent = await deps.verifyTypedData({
    address: prov.mainWallet as `0x${string}`,
    domain: agentTd.domain,
    types: agentTd.types,
    primaryType: agentTd.primaryType,
    message: agentTd.message,
    signature: approveAgentSig,
  });
  const okBuilder = await deps.verifyTypedData({
    address: prov.mainWallet as `0x${string}`,
    domain: builderTd.domain,
    types: builderTd.types,
    primaryType: builderTd.primaryType,
    message: builderTd.message,
    signature: approveBuilderFeeSig,
  });
  if (!okAgent || !okBuilder) {
    throw new OnboardError('signature_mismatch', 'one or both signatures do not match mainWallet');
  }
  return deps.repo.finalize(req.provisionalId, {
    approveAgentSig,
    approveBuilderFeeSig,
  });
}
