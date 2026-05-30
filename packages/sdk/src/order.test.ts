import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Address } from '@whalepod/schema';
import { BUILDER_FEE_PERP_CAP_TENTHS_BP } from './constants.js';
import { buildOrderAction } from './order.js';
import type { OrderIntent } from './types.js';

const BUILDER = Address.parse('0x1111222233334444555566667777888899990000');

const intent: OrderIntent = {
  asset: 0,
  isBuy: true,
  limitPx: '50000',
  sz: '0.1',
  reduceOnly: false,
  tif: 'Gtc',
};

describe('buildOrderAction', () => {
  it('produces type=order with one order request', () => {
    const action = buildOrderAction({
      intent,
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 50,
      userApprovedMaxFeeTenthsBp: 50,
    });
    expect(action.type).toBe('order');
    expect(action.orders).toHaveLength(1);
    expect(action.grouping).toBe('na');
  });

  it('always carries builder field with our address', () => {
    const action = buildOrderAction({
      intent,
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 50,
      userApprovedMaxFeeTenthsBp: 50,
    });
    expect(action.builder.b).toBe(BUILDER);
    expect(action.builder.f).toBe(50);
  });

  it('maps intent fields verbatim — no operator-controlled mutation', () => {
    const action = buildOrderAction({
      intent,
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 50,
      userApprovedMaxFeeTenthsBp: 50,
    });
    const [order] = action.orders;
    expect(order).toBeDefined();
    if (!order) throw new Error('unreachable');
    expect(order.a).toBe(intent.asset);
    expect(order.b).toBe(intent.isBuy);
    expect(order.p).toBe(intent.limitPx);
    expect(order.s).toBe(intent.sz);
    expect(order.r).toBe(intent.reduceOnly);
    expect(order.t).toEqual({ limit: { tif: intent.tif } });
  });

  it('includes cloid only when intent provides it', () => {
    const withCloid = buildOrderAction({
      intent: { ...intent, cloid: '0x1234' },
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 50,
      userApprovedMaxFeeTenthsBp: 50,
    });
    expect(withCloid.orders[0]?.c).toBe('0x1234');

    const withoutCloid = buildOrderAction({
      intent,
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 50,
      userApprovedMaxFeeTenthsBp: 50,
    });
    expect(withoutCloid.orders[0]?.c).toBeUndefined();
  });

  it('clamps fee to userApprovedMax even when requested is higher', () => {
    const action = buildOrderAction({
      intent,
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 99,
      userApprovedMaxFeeTenthsBp: 20,
    });
    expect(action.builder.f).toBe(20);
  });

  it('clamps fee to protocol cap even when both inputs exceed it', () => {
    const action = buildOrderAction({
      intent,
      builderAddress: BUILDER,
      requestedFeeTenthsBp: 9999,
      userApprovedMaxFeeTenthsBp: 9999,
    });
    expect(action.builder.f).toBe(BUILDER_FEE_PERP_CAP_TENTHS_BP);
  });

  it('property: builder.f ≤ userApprovedMax AND ≤ protocol cap for all inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 1000 }),
        fc.integer({ min: -100, max: 1000 }),
        (requested, approved) => {
          const action = buildOrderAction({
            intent,
            builderAddress: BUILDER,
            requestedFeeTenthsBp: requested,
            userApprovedMaxFeeTenthsBp: approved,
          });
          expect(action.builder.f).toBeLessThanOrEqual(BUILDER_FEE_PERP_CAP_TENTHS_BP);
          expect(action.builder.f).toBeLessThanOrEqual(Math.max(0, approved));
          expect(action.builder.f).toBeGreaterThanOrEqual(0);
          expect(action.builder.b).toBe(BUILDER);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('property: order params depend only on intent, not on fee/builder inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (requested, approved) => {
          const a = buildOrderAction({
            intent,
            builderAddress: BUILDER,
            requestedFeeTenthsBp: requested,
            userApprovedMaxFeeTenthsBp: approved,
          });
          const o = a.orders[0];
          expect(o).toBeDefined();
          if (!o) throw new Error('unreachable');
          expect(o.a).toBe(intent.asset);
          expect(o.p).toBe(intent.limitPx);
          expect(o.s).toBe(intent.sz);
          expect(o.b).toBe(intent.isBuy);
        },
      ),
      { numRuns: 200 },
    );
  });
});
