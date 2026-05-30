import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { BUILDER_FEE_DEFAULT_TENTHS_BP, BUILDER_FEE_PERP_CAP_TENTHS_BP } from './constants.js';
import { clampFeeTenthsBp, feeRateString } from './fee.js';

describe('clampFeeTenthsBp', () => {
  it('returns min(requested, approved) under cap', () => {
    expect(clampFeeTenthsBp(50, 30)).toBe(30);
    expect(clampFeeTenthsBp(20, 50)).toBe(20);
  });

  it('clamps to protocol cap', () => {
    expect(clampFeeTenthsBp(500, 500)).toBe(BUILDER_FEE_PERP_CAP_TENTHS_BP);
  });

  it('returns 0 for negative inputs', () => {
    expect(clampFeeTenthsBp(-10, 50)).toBe(0);
    expect(clampFeeTenthsBp(50, -10)).toBe(0);
  });

  it('floors fractional inputs', () => {
    expect(clampFeeTenthsBp(50.9, 50.9)).toBe(50);
  });

  it('coerces NaN to 0', () => {
    expect(clampFeeTenthsBp(NaN, 50)).toBe(0);
    expect(clampFeeTenthsBp(50, NaN)).toBe(0);
  });

  it('property: result is always ≤ min(requested, approved, cap) — defense-in-depth invariant', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 10_000 }),
        fc.integer({ min: -1000, max: 10_000 }),
        (requested, approved) => {
          const result = clampFeeTenthsBp(requested, approved);
          const safeRequested = Math.max(0, requested);
          const safeApproved = Math.max(0, approved);
          expect(result).toBeGreaterThanOrEqual(0);
          expect(result).toBeLessThanOrEqual(BUILDER_FEE_PERP_CAP_TENTHS_BP);
          expect(result).toBeLessThanOrEqual(safeRequested);
          expect(result).toBeLessThanOrEqual(safeApproved);
          expect(Number.isInteger(result)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('default fee (50 tenths bp = 5 bps) is well under cap', () => {
    expect(BUILDER_FEE_DEFAULT_TENTHS_BP).toBeLessThan(BUILDER_FEE_PERP_CAP_TENTHS_BP);
  });
});

describe('feeRateString', () => {
  it('formats default 5 bps as "0.0500%"', () => {
    expect(feeRateString(50)).toBe('0.0500%');
  });

  it('formats protocol cap 10 bps as "0.1000%"', () => {
    expect(feeRateString(100)).toBe('0.1000%');
  });

  it('formats 0 as the canonical revoke string "0%"', () => {
    expect(feeRateString(0)).toBe('0%');
  });

  it('treats negative as 0', () => {
    expect(feeRateString(-5)).toBe('0%');
  });

  it('floors fractional input', () => {
    expect(feeRateString(50.9)).toBe('0.0500%');
  });
});
