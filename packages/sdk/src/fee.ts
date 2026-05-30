import { BUILDER_FEE_PERP_CAP_TENTHS_BP } from './constants.js';
import type { TenthsBp } from './types.js';

/**
 * Clamp a requested builder fee to `min(requested, approvedMax, protocolCap)`.
 *
 * The result is guaranteed:
 * - non-negative integer
 * - ≤ requested
 * - ≤ approvedMax (NEVER charge the user more than they approved on-chain)
 * - ≤ protocol cap (defense-in-depth; protocol also rejects above-cap)
 *
 * Inputs that violate these are coerced (negatives → 0, fractions → floor)
 * rather than throwing, because this runs in the hot order path and the
 * caller has already validated upstream. Throwing here would silently drop
 * a user's mirror trade.
 */
export function clampFeeTenthsBp(requested: number, approvedMax: number): TenthsBp {
  const r = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
  const a = Number.isFinite(approvedMax) ? Math.max(0, Math.floor(approvedMax)) : 0;
  const clamped = Math.min(r, a, BUILDER_FEE_PERP_CAP_TENTHS_BP);
  return clamped as TenthsBp;
}

/**
 * Format tenths-of-bp as the percentage string Hyperliquid expects in
 * `approveBuilderFee.maxFeeRate`.
 *
 *   50 (5 bps) → "0.0500%"
 *  100 (10 bps) → "0.1000%"
 *    0          → "0%"  (used to revoke)
 */
export function feeRateString(tenthsBp: number): string {
  const t = Math.max(0, Math.floor(tenthsBp));
  if (t === 0) return '0%';
  // 1 tenth of a bp = 0.001 %. 50 → 0.05 %. 100 → 0.10 %.
  const pct = t / 1000;
  return `${pct.toFixed(4)}%`;
}
