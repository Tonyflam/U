import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Address } from '@whalepod/schema';
import { BUILDER_FEE_PERP_CAP_TENTHS_BP } from './constants.js';
import {
  TPSL_MAX_BPS,
  TPSL_MIN_BPS,
  TpSlConfigError,
  buildTriggerOrderAction,
  computeTriggerPx,
} from './trigger.js';
import type { OrderIntent } from './types.js';

const BUILDER = Address.parse('0x1111222233334444555566667777888899990000');

describe('computeTriggerPx', () => {
  it('long tp is above entry, long sl is below', () => {
    expect(
      Number(computeTriggerPx({ entryPx: '100', side: 'B', kind: 'tp', offsetBps: 500 })),
    ).toBeGreaterThan(100);
    expect(
      Number(computeTriggerPx({ entryPx: '100', side: 'B', kind: 'sl', offsetBps: 500 })),
    ).toBeLessThan(100);
  });

  it('short tp is below entry, short sl is above', () => {
    expect(
      Number(computeTriggerPx({ entryPx: '100', side: 'S', kind: 'tp', offsetBps: 500 })),
    ).toBeLessThan(100);
    expect(
      Number(computeTriggerPx({ entryPx: '100', side: 'S', kind: 'sl', offsetBps: 500 })),
    ).toBeGreaterThan(100);
  });

  it('500 bps = 5% offset (long tp at 105 from 100)', () => {
    expect(computeTriggerPx({ entryPx: '100', side: 'B', kind: 'tp', offsetBps: 500 })).toBe('105');
  });

  it('rejects offset out of [1, 9999]', () => {
    for (const bad of [0, -1, 10_000, 10_001, 1.5, NaN]) {
      expect(() =>
        computeTriggerPx({ entryPx: '100', side: 'B', kind: 'tp', offsetBps: bad }),
      ).toThrow(TpSlConfigError);
    }
  });

  it('rejects bad entry price', () => {
    for (const bad of ['', '0', '-1', 'abc']) {
      expect(() =>
        computeTriggerPx({ entryPx: bad, side: 'B', kind: 'tp', offsetBps: 100 }),
      ).toThrow(TpSlConfigError);
    }
  });

  it('property: long tp ≥ entry AND long sl ≤ entry for all valid offsets', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: TPSL_MIN_BPS, max: TPSL_MAX_BPS }),
        fc.double({ min: 0.01, max: 1_000_000, noNaN: true }),
        (bps, entry) => {
          const tp = Number(
            computeTriggerPx({ entryPx: String(entry), side: 'B', kind: 'tp', offsetBps: bps }),
          );
          const sl = Number(
            computeTriggerPx({ entryPx: String(entry), side: 'B', kind: 'sl', offsetBps: bps }),
          );
          expect(tp).toBeGreaterThanOrEqual(sl);
        },
      ),
      { numRuns: 100 },
    );
  });
});

const closeLong: OrderIntent = {
  asset: 0,
  isBuy: false,
  limitPx: '105',
  sz: '0.1',
  reduceOnly: true,
  tif: 'Gtc',
};

describe('buildTriggerOrderAction', () => {
  it('builds a normalTpsl grouped order with trigger variant', () => {
    const action = buildTriggerOrderAction({
      intent: closeLong,
      triggerPx: '105',
      kind: 'tp',
      isMarket: true,
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 50,
      userApprovedMaxFeeTenthsBp: 50,
    });
    expect(action.type).toBe('order');
    expect(action.grouping).toBe('normalTpsl');
    expect(action.builder.b).toBe(BUILDER);
    expect(action.builder.f).toBe(50);
    const o = action.orders[0];
    expect(o).toBeDefined();
    if (!o) throw new Error('unreachable');
    expect(o.t).toEqual({ trigger: { isMarket: true, triggerPx: '105', tpsl: 'tp' } });
    expect(o.r).toBe(true);
  });

  it('clamps fee to min(approved, protocol cap)', () => {
    const a = buildTriggerOrderAction({
      intent: closeLong,
      triggerPx: '105',
      kind: 'tp',
      isMarket: true,
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 9_999,
      userApprovedMaxFeeTenthsBp: 9_999,
    });
    expect(a.builder.f).toBe(BUILDER_FEE_PERP_CAP_TENTHS_BP);
  });

  it('property: builder.f ≤ approved AND ≤ protocol cap for any inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 1000 }),
        fc.integer({ min: -100, max: 1000 }),
        (req, app) => {
          const a = buildTriggerOrderAction({
            intent: closeLong,
            triggerPx: '105',
            kind: 'sl',
            isMarket: false,
            builderAddress: BUILDER,
            requestedFeeTenthsBp: req,
            userApprovedMaxFeeTenthsBp: app,
          });
          expect(a.builder.f).toBeLessThanOrEqual(BUILDER_FEE_PERP_CAP_TENTHS_BP);
          expect(a.builder.f).toBeLessThanOrEqual(Math.max(0, app));
          expect(a.builder.f).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
