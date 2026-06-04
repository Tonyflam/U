/**
 * HL `updateLeverage` L1 action builder.
 *
 * HL applies the leverage to the NEXT order on that asset, persisted
 * server-side per (wallet, asset). So we send this once per (user,
 * coin, leverage) change — caller is responsible for the dedupe cache.
 */
import type { HlUpdateLeverageAction } from './types.js';

export interface BuildUpdateLeverageInput {
  readonly asset: number;
  readonly leverage: number;
  /** Defaults to `true` (cross). Isolated margin requires a deposit step. */
  readonly isCross?: boolean;
}

export class UpdateLeverageConfigError extends Error {
  constructor(public readonly code: 'invalid_leverage' | 'invalid_asset') {
    super(code);
    this.name = 'UpdateLeverageConfigError';
  }
}

export function buildUpdateLeverageAction(input: BuildUpdateLeverageInput): HlUpdateLeverageAction {
  if (!Number.isInteger(input.asset) || input.asset < 0) {
    throw new UpdateLeverageConfigError('invalid_asset');
  }
  if (!Number.isInteger(input.leverage) || input.leverage < 1 || input.leverage > 50) {
    throw new UpdateLeverageConfigError('invalid_leverage');
  }
  return {
    type: 'updateLeverage',
    asset: input.asset,
    isCross: input.isCross ?? true,
    leverage: input.leverage,
  };
}
