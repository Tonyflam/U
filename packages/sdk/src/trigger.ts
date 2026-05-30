/**
 * Take-profit / stop-loss pure logic.
 *
 * Two responsibilities:
 *  1. Compute a trigger price given an entry price, side, kind (tp|sl), and
 *     an offset expressed in basis points (1 bp = 0.01%).
 *  2. Build a Hyperliquid `order` action carrying a `trigger` variant so the
 *     transport layer can submit it alongside (or after) the mirror fill.
 *
 * Notes:
 *  - Offsets are integer bps, range 1..10000 (0.01% .. 100%). Zero is
 *    nonsensical (would fire instantly); >100% is almost certainly user error.
 *  - Output price uses 5 significant figures (HL perp tick rule of thumb).
 *    Per-asset tick alignment lives in the transport layer once we have
 *    asset metadata; this function MUST NOT be the only line of defense.
 *  - Number-based arithmetic is intentional here: trigger prices don't need
 *    bit-exact precision, and HL itself rounds to ticks server-side.
 */
import { clampFeeTenthsBp } from './fee.js';
import type { Address } from '@whalepod/schema';
import type { HlOrderAction, HlOrderRequest, OrderIntent, Side } from './types.js';

export type TpSl = 'tp' | 'sl';

export const TPSL_MIN_BPS = 1;
export const TPSL_MAX_BPS = 9_999;

export interface ComputeTriggerPxInput {
  /** Entry price as decimal string (e.g. "50000", "2543.21"). */
  readonly entryPx: string;
  /** Side of the ORIGINAL (entry) position — 'B' for long, 'S' for short. */
  readonly side: Side;
  readonly kind: TpSl;
  /** Offset from entry in basis points (1 bp = 0.01%). 1..10000. */
  readonly offsetBps: number;
}

export class TpSlConfigError extends Error {
  constructor(public readonly code: 'invalid_offset' | 'invalid_entry_px') {
    super(code);
    this.name = 'TpSlConfigError';
  }
}

function formatPx(n: number): string {
  if (!Number.isFinite(n) || n <= 0) throw new TpSlConfigError('invalid_entry_px');
  // toPrecision(5) returns scientific notation for very small / very large
  // values; convert back via Number → String to normalize.
  const s = Number.parseFloat(n.toPrecision(5)).toString();
  return s;
}

export function computeTriggerPx(input: ComputeTriggerPxInput): string {
  const { entryPx, side, kind, offsetBps } = input;
  if (!Number.isInteger(offsetBps) || offsetBps < TPSL_MIN_BPS || offsetBps > TPSL_MAX_BPS) {
    throw new TpSlConfigError('invalid_offset');
  }
  const entry = Number(entryPx);
  if (!Number.isFinite(entry) || entry <= 0) {
    throw new TpSlConfigError('invalid_entry_px');
  }
  // For a long (B) entry, tp is above and sl is below.
  // For a short (S) entry, tp is below and sl is above.
  const isLong = side === 'B';
  const above = (isLong && kind === 'tp') || (!isLong && kind === 'sl');
  const factor = above ? 1 + offsetBps / 10_000 : 1 - offsetBps / 10_000;
  return formatPx(entry * factor);
}

export interface BuildTriggerOrderActionInput {
  /**
   * Intent for the trigger LEG. Caller is responsible for setting
   * `reduceOnly: true` and the opposite side of the original position
   * (sell-to-close a long, buy-to-close a short). `tif` is ignored — trigger
   * orders use their own variant.
   */
  readonly intent: OrderIntent;
  readonly triggerPx: string;
  readonly kind: TpSl;
  /** true = market on trigger, false = limit at intent.limitPx on trigger. */
  readonly isMarket: boolean;
  readonly builderAddress: Address;
  readonly requestedFeeTenthsBp: number;
  readonly userApprovedMaxFeeTenthsBp: number;
}

/**
 * Build an HL `order` action whose single child uses the `trigger` variant
 * with grouping `normalTpsl`. Same builder/fee invariants as the entry
 * order: builder.f is always clamped to min(approved, protocol cap).
 *
 * Invariants (tested):
 *  - `builder.b` = configured address.
 *  - `builder.f` ≤ approved AND ≤ protocol cap AND ≥ 0.
 *  - The child order has `t.trigger.tpsl` exactly equal to `kind`.
 *  - `triggerPx` is passed through verbatim (caller already formatted it).
 */
export function buildTriggerOrderAction(input: BuildTriggerOrderActionInput): HlOrderAction {
  const { intent, triggerPx, kind, isMarket, builderAddress } = input;
  const f = clampFeeTenthsBp(input.requestedFeeTenthsBp, input.userApprovedMaxFeeTenthsBp);

  const order: HlOrderRequest = {
    a: intent.asset,
    b: intent.isBuy,
    p: intent.limitPx,
    s: intent.sz,
    r: intent.reduceOnly,
    t: { trigger: { isMarket, triggerPx, tpsl: kind } },
    ...(intent.cloid !== undefined ? { c: intent.cloid } : {}),
  };

  return {
    type: 'order',
    orders: [order],
    grouping: 'normalTpsl',
    builder: { b: builderAddress, f },
  };
}
