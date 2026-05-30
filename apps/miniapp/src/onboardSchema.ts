/**
 * Request / response zod schemas for the two-step onboarding API.
 *
 * Step 1  POST /api/onboard/start
 *   Body: { tgUserId, tgUsername?, mainWallet, equityFloorUsd, approvedMaxFeeTenthsBp }
 *   Resp: { provisionalId, agentAddress, approveAgent: {action, typedData},
 *           approveBuilderFee: {action, typedData} }
 *   Server generates + seals the agent key, persists a provisional row, and
 *   returns the typed-data payloads the user's MAIN wallet must sign.
 *
 * Step 2  POST /api/onboard/complete
 *   Body: { provisionalId, approveAgentSig, approveBuilderFeeSig }
 *   Resp: { userId }
 *   Server recovers the signer of both typed-data payloads, confirms it
 *   equals `mainWallet`, then finalizes the user row.
 */
import { z } from 'zod';
import { Address, FeeTenthsBp, TgUserId } from '@whalepod/schema';

const Hex0xSig = z.string().regex(/^0x[0-9a-fA-F]+$/u);

const PositiveDecimalString = z.string().regex(/^[0-9]+(\.[0-9]+)?$/u);

export const OnboardStartRequest = z.object({
  tgUserId: TgUserId,
  tgUsername: z.string().min(1).max(64).optional(),
  mainWallet: Address,
  equityFloorUsd: PositiveDecimalString,
  approvedMaxFeeTenthsBp: FeeTenthsBp,
});
export type OnboardStartRequest = z.infer<typeof OnboardStartRequest>;

export const OnboardCompleteRequest = z.object({
  provisionalId: z.string().uuid(),
  approveAgentSig: Hex0xSig,
  approveBuilderFeeSig: Hex0xSig,
});
export type OnboardCompleteRequest = z.infer<typeof OnboardCompleteRequest>;
