import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Address } from '@whalepod/schema';
import { PnlFill, renderPnl, summarizePnl, type MarkPriceFn } from './pnl.js';

const W1 = Address.parse('0xaaaa000000000000000000000000000000000001');
const W2 = Address.parse('0xbbbb000000000000000000000000000000000002');

function fill(
  partial: Partial<PnlFill> & Pick<PnlFill, 'whaleAddress' | 'coin' | 'side' | 'px' | 'sz'>,
): PnlFill {
  return PnlFill.parse({
    notionalUsd: String(Number(partial.px) * Number(partial.sz)),
    builderFeeUsd: '0',
    builderFeeTenthsBp: 0,
    ts: 1_700_000_000_000,
    ...partial,
  });
}

const markFn =
  (prices: Record<string, string>): MarkPriceFn =>
  (coin) =>
    prices[coin] ?? null;

describe('summarizePnl', () => {
  it('returns empty totals for no fills', () => {
    const s = summarizePnl([], () => null);
    expect(s.perWhale).toHaveLength(0);
    expect(s.totalRealizedUsd).toBe(0);
    expect(s.totalUnrealizedUsd).toBe(0);
  });

  it('aggregates realized PnL from fills that carry it', () => {
    const fills = [
      fill({ whaleAddress: W1, coin: 'BTC', side: 'B', px: '50000', sz: '0.1' }),
      fill({
        whaleAddress: W1,
        coin: 'BTC',
        side: 'S',
        px: '52000',
        sz: '0.1',
        realizedPnlUsd: '200',
      }),
    ];
    const s = summarizePnl(fills, markFn({}));
    expect(s.perWhale[0]?.realizedUsd).toBe(200);
    expect(s.totalRealizedUsd).toBe(200);
  });

  it('marks the open long position at the current price (green)', () => {
    const fills = [fill({ whaleAddress: W1, coin: 'BTC', side: 'B', px: '50000', sz: '0.1' })];
    const s = summarizePnl(fills, markFn({ BTC: '52000' }));
    // cost basis 5000; mark value 5200; unrealized = 200
    expect(s.perWhale[0]?.unrealizedUsd).toBeCloseTo(200, 6);
    expect(s.perWhale[0]?.openCoins).toStrictEqual(['BTC']);
  });

  it('marks an open short position correctly (red when price up)', () => {
    const fills = [fill({ whaleAddress: W1, coin: 'BTC', side: 'S', px: '50000', sz: '0.1' })];
    const s = summarizePnl(fills, markFn({ BTC: '52000' }));
    // netSz = -0.1; costBasis = -5000; value = -5200; unrealized = -5200 - (-5000) = -200
    expect(s.perWhale[0]?.unrealizedUsd).toBeCloseTo(-200, 6);
  });

  it('flat position contributes no unrealized and is not listed as open', () => {
    const fills = [
      fill({ whaleAddress: W1, coin: 'BTC', side: 'B', px: '50000', sz: '0.1' }),
      fill({
        whaleAddress: W1,
        coin: 'BTC',
        side: 'S',
        px: '51000',
        sz: '0.1',
        realizedPnlUsd: '100',
      }),
    ];
    const s = summarizePnl(fills, markFn({ BTC: '99999' }));
    expect(s.perWhale[0]?.openCoins).toStrictEqual([]);
    expect(s.perWhale[0]?.unrealizedUsd).toBe(0);
    expect(s.perWhale[0]?.realizedUsd).toBe(100);
  });

  it('skips unrealized for a coin with no mark price', () => {
    const fills = [fill({ whaleAddress: W1, coin: 'BTC', side: 'B', px: '50000', sz: '0.1' })];
    const s = summarizePnl(fills, markFn({}));
    expect(s.perWhale[0]?.unrealizedUsd).toBe(0);
    // but the open position is still surfaced
    expect(s.perWhale[0]?.openCoins).toStrictEqual(['BTC']);
  });

  it('sums fees in USD per whale and overall', () => {
    const fills = [
      fill({
        whaleAddress: W1,
        coin: 'BTC',
        side: 'B',
        px: '50000',
        sz: '0.1',
        builderFeeUsd: '2.50',
        builderFeeTenthsBp: 5,
      }),
      fill({
        whaleAddress: W2,
        coin: 'ETH',
        side: 'B',
        px: '3000',
        sz: '1',
        builderFeeUsd: '1.50',
        builderFeeTenthsBp: 5,
      }),
    ];
    const s = summarizePnl(fills, markFn({}));
    expect(s.perWhale.find((w) => w.whaleAddress === W1)?.feesUsd).toBe(2.5);
    expect(s.totalFeesUsd).toBe(4);
  });

  it('keeps whales independent', () => {
    const fills = [
      fill({ whaleAddress: W1, coin: 'BTC', side: 'B', px: '50000', sz: '0.1' }),
      fill({ whaleAddress: W2, coin: 'BTC', side: 'S', px: '50000', sz: '0.1' }),
    ];
    const s = summarizePnl(fills, markFn({ BTC: '51000' }));
    expect(s.perWhale).toHaveLength(2);
    const sum = s.perWhale[0]!.unrealizedUsd + s.perWhale[1]!.unrealizedUsd;
    expect(sum).toBeCloseTo(0, 6); // opposite positions hedge
  });

  it('property: closing the exact opposite of an open fill returns flat', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1_000_000, noNaN: true }),
        fc.double({ min: 0.001, max: 100, noNaN: true }),
        (px, sz) => {
          const fills = [
            fill({ whaleAddress: W1, coin: 'BTC', side: 'B', px: String(px), sz: String(sz) }),
            fill({ whaleAddress: W1, coin: 'BTC', side: 'S', px: String(px), sz: String(sz) }),
          ];
          const s = summarizePnl(fills, markFn({ BTC: String(px * 2) }));
          expect(s.perWhale[0]?.openCoins).toStrictEqual([]);
          expect(s.perWhale[0]?.unrealizedUsd).toBeCloseTo(0, 4);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('renderPnl', () => {
  it('returns a friendly empty message when there are no fills', () => {
    const r = renderPnl(summarizePnl([], () => null));
    expect(r.text).toMatch(/No mirrored fills yet/);
  });

  it('renders a green-day snapshot deterministically', () => {
    const fills = [
      fill({
        whaleAddress: W1,
        whaleAlias: 'AlphaCat',
        coin: 'BTC',
        side: 'B',
        px: '50000',
        sz: '0.1',
        builderFeeUsd: '2.50',
        builderFeeTenthsBp: 5,
      }),
      fill({
        whaleAddress: W1,
        whaleAlias: 'AlphaCat',
        coin: 'BTC',
        side: 'S',
        px: '52000',
        sz: '0.05',
        builderFeeUsd: '1.30',
        builderFeeTenthsBp: 5,
        realizedPnlUsd: '100',
      }),
    ];
    const s = summarizePnl(fills, markFn({ BTC: '52000' }));
    const r = renderPnl(s);
    expect(r.text).toMatchInlineSnapshot(`
      "PnL summary
      🟢 AlphaCat: +$300.00
        realized +$100.00 · unrealized +$200.00 · fees $3.80
        open: BTC
      —
      Total: 🟢 +$300.00  (fees $3.80)"
    `);
  });

  it('renders a red-day snapshot deterministically', () => {
    const fills = [
      fill({
        whaleAddress: W1,
        whaleAlias: 'AlphaCat',
        coin: 'BTC',
        side: 'B',
        px: '50000',
        sz: '0.1',
        builderFeeUsd: '2.50',
        builderFeeTenthsBp: 5,
      }),
      fill({
        whaleAddress: W1,
        whaleAlias: 'AlphaCat',
        coin: 'BTC',
        side: 'S',
        px: '48000',
        sz: '0.05',
        builderFeeUsd: '1.20',
        builderFeeTenthsBp: 5,
        realizedPnlUsd: '-100',
      }),
    ];
    const s = summarizePnl(fills, markFn({ BTC: '48000' }));
    const r = renderPnl(s);
    expect(r.text).toMatchInlineSnapshot(`
      "PnL summary
      🔴 AlphaCat: -$300.00
        realized -$100.00 · unrealized -$200.00 · fees $3.70
        open: BTC
      —
      Total: 🔴 -$300.00  (fees $3.70)"
    `);
  });

  it('sorts whales by total PnL descending and caps with maxWhales', () => {
    const fills = [
      fill({
        whaleAddress: W1,
        coin: 'BTC',
        side: 'B',
        px: '50000',
        sz: '0.1',
        realizedPnlUsd: '10',
      }),
      fill({
        whaleAddress: W2,
        coin: 'BTC',
        side: 'B',
        px: '50000',
        sz: '0.1',
        realizedPnlUsd: '500',
      }),
    ];
    const s = summarizePnl(fills, markFn({}));
    const r = renderPnl(s, { maxWhales: 1 });
    // W2 should appear first; W1 should be hidden behind "...and 1 more"
    const idxW2 = r.text.indexOf(W2.slice(0, 6));
    const idxMore = r.text.indexOf('and 1 more');
    expect(idxW2).toBeGreaterThan(-1);
    expect(idxMore).toBeGreaterThan(idxW2);
  });
});

const formattedLine = /[+\-$]\$\d|\$0\.00/u;
describe('renderPnl invariants', () => {
  it('property: every shown whale line carries a signed USD amount', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            px: fc.integer({ min: 1, max: 100_000 }),
            sz: fc.integer({ min: 1, max: 100 }),
            realized: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (entries) => {
          const fills = entries.map((e, i) =>
            fill({
              whaleAddress:
                `0x${'0'.repeat(38)}${(i + 1).toString().padStart(2, '0')}` as `0x${string}`,
              coin: 'BTC',
              side: 'B',
              px: String(e.px),
              sz: String(e.sz),
              realizedPnlUsd: String(e.realized),
            }),
          );
          const s = summarizePnl(fills, markFn({ BTC: '1' }));
          const r = renderPnl(s);
          expect(r.text).toMatch(formattedLine);
          expect(r.text).toMatch(/^PnL summary/);
          expect(r.text).toMatch(/Total:/);
        },
      ),
      { numRuns: 50 },
    );
  });
});
