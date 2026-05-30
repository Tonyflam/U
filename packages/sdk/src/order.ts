import { clampFeeTenthsBp } from './fee.js';
import type { Address } from '@whalepod/schema';
import type { HlOrderAction, HlOrderRequest, OrderIntent } from './types.js';

export interface BuildOrderActionInput {
  /** The intent (from Mirror Engine or TG command). */
  readonly intent: OrderIntent;
  /** Our builder address (set per environment). */
  readonly builderAddress: Address;
  /** Builder fee we want to charge this order (tenths of bp). */
  readonly requestedFeeTenthsBp: number;
  /** The user's on-chain-approved max fee (tenths of bp). Hard ceiling. */
  readonly userApprovedMaxFeeTenthsBp: number;
}

/**
 * Pure construction of an HL `order` action with the WhalePod builder field
 * always set. Single entry point. The output is what gets signed.
 *
 * Security invariants (each is unit- and property-tested):
 *   1. `builder.b` is always present and equals the configured builderAddress.
 *   2. `builder.f` ≤ userApprovedMaxFeeTenthsBp (clamped, never exceeded).
 *   3. `builder.f` ≤ protocol perp cap (10 bps).
 *   4. No field of the action is derived from operator-controlled data
 *      beyond the builder address and the clamped fee. Order params come
 *      from `intent` verbatim.
 */
export function buildOrderAction(input: BuildOrderActionInput): HlOrderAction {
  const { intent, builderAddress } = input;
  const f = clampFeeTenthsBp(input.requestedFeeTenthsBp, input.userApprovedMaxFeeTenthsBp);

  const order: HlOrderRequest = {
    a: intent.asset,
    b: intent.isBuy,
    p: intent.limitPx,
    s: intent.sz,
    r: intent.reduceOnly,
    t: { limit: { tif: intent.tif } },
    ...(intent.cloid !== undefined ? { c: intent.cloid } : {}),
  };

  return {
    type: 'order',
    orders: [order],
    grouping: 'na',
    builder: { b: builderAddress, f },
  };
}
