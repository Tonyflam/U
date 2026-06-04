import { describe, expect, it } from 'vitest';
import { UpdateLeverageConfigError, buildUpdateLeverageAction } from './leverage.js';

describe('buildUpdateLeverageAction', () => {
  it('returns a valid action with cross-margin default', () => {
    const a = buildUpdateLeverageAction({ asset: 5, leverage: 10 });
    expect(a).toEqual({ type: 'updateLeverage', asset: 5, isCross: true, leverage: 10 });
  });

  it('respects isCross override', () => {
    const a = buildUpdateLeverageAction({ asset: 5, leverage: 10, isCross: false });
    expect(a.isCross).toBe(false);
  });

  it.each([-1, 1.5, NaN])('rejects non-integer / negative asset %s', (asset) => {
    expect(() => buildUpdateLeverageAction({ asset, leverage: 5 })).toThrow(
      UpdateLeverageConfigError,
    );
  });

  it.each([0, 51, 1.5, -1])('rejects out-of-range leverage %s', (lev) => {
    expect(() => buildUpdateLeverageAction({ asset: 1, leverage: lev })).toThrow(
      UpdateLeverageConfigError,
    );
  });

  it('accepts leverage 1 and 50 (bounds)', () => {
    expect(buildUpdateLeverageAction({ asset: 1, leverage: 1 }).leverage).toBe(1);
    expect(buildUpdateLeverageAction({ asset: 1, leverage: 50 }).leverage).toBe(50);
  });
});
