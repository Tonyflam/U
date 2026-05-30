import { describe, expect, it, vi } from 'vitest';
import { RealizedPnlFillSink, applyFill } from './realizedPnlSink.js';
import type { FillSink, MirrorFillRow } from './fillSink.js';

const BASE: Omit<MirrorFillRow, 'hlFillId' | 'side' | 'px' | 'sz' | 'notionalUsd'> = {
  whaleAddress: '0xwhale',
  coin: 'ETH',
  builderFeeTenthsBp: 50,
  builderFeeUsd: '0.000000',
  userId: 'u-1',
  ts: 1_700_000_000_000,
};

function row(
  i: number,
  side: 'B' | 'S',
  px: string,
  sz: string,
  overrides: Partial<MirrorFillRow> = {},
): MirrorFillRow {
  return {
    ...BASE,
    hlFillId: `0xfill${String(i)}`,
    side,
    px,
    sz,
    notionalUsd: (Number(px) * Number(sz)).toFixed(2),
    ...overrides,
  };
}

function fakeInner(): {
  inner: FillSink;
  calls: MirrorFillRow[];
} {
  const calls: MirrorFillRow[] = [];
  const inner: FillSink = {
    recordMirrorFill: vi.fn((r: MirrorFillRow) => {
      calls.push(r);
      return Promise.resolve();
    }),
  };
  return { inner, calls };
}

describe('applyFill (pure)', () => {
  it('opens fresh leg from flat', () => {
    const r = applyFill({ netSz: 0, avgPx: 0 }, 1, 100);
    expect(r.realized).toBe(0);
    expect(r.next).toEqual({ netSz: 1, avgPx: 100 });
  });

  it('weighted-averages on same-side add', () => {
    const r = applyFill({ netSz: 1, avgPx: 100 }, 1, 200);
    expect(r.realized).toBe(0);
    expect(r.next.netSz).toBe(2);
    expect(r.next.avgPx).toBe(150);
  });

  it('realizes profit on partial long close', () => {
    const r = applyFill({ netSz: 2, avgPx: 100 }, -1, 150);
    expect(r.realized).toBe(50);
    expect(r.next).toEqual({ netSz: 1, avgPx: 100 });
  });

  it('realizes profit on full short close', () => {
    const r = applyFill({ netSz: -1, avgPx: 200 }, 1, 150);
    expect(r.realized).toBe(50);
    expect(r.next).toEqual({ netSz: 0, avgPx: 0 });
  });

  it('flips: closes old leg, opens residual at fill px', () => {
    const r = applyFill({ netSz: 1, avgPx: 100 }, -3, 150);
    expect(r.realized).toBe(50);
    expect(r.next).toEqual({ netSz: -2, avgPx: 150 });
  });
});

describe('RealizedPnlFillSink', () => {
  it('omits realizedPnlUsd on opening leg', async () => {
    const { inner, calls } = fakeInner();
    const sink = new RealizedPnlFillSink({ inner });
    await sink.recordMirrorFill(row(1, 'B', '100', '1'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.realizedPnlUsd).toBeUndefined();
  });

  it('stamps realizedPnlUsd on closing leg per (user, coin)', async () => {
    const { inner, calls } = fakeInner();
    const sink = new RealizedPnlFillSink({ inner });
    await sink.recordMirrorFill(row(1, 'B', '100', '2'));
    await sink.recordMirrorFill(row(2, 'S', '150', '1'));
    expect(calls[1]?.realizedPnlUsd).toBe('50.000000');
  });

  it('keeps positions independent across coins and users', async () => {
    const { inner, calls } = fakeInner();
    const sink = new RealizedPnlFillSink({ inner });
    await sink.recordMirrorFill(row(1, 'B', '100', '1', { coin: 'ETH', userId: 'a' }));
    await sink.recordMirrorFill(row(2, 'B', '50', '1', { coin: 'BTC', userId: 'a' }));
    await sink.recordMirrorFill(row(3, 'B', '100', '1', { coin: 'ETH', userId: 'b' }));
    // None of these are closing legs; all should be undefined.
    expect(calls.every((c) => c.realizedPnlUsd === undefined)).toBe(true);
    // Now close ETH for user a only.
    await sink.recordMirrorFill(row(4, 'S', '120', '1', { coin: 'ETH', userId: 'a' }));
    expect(calls[3]?.realizedPnlUsd).toBe('20.000000');
  });
});
