import { describe, expect, it } from 'vitest';
import type { HttpHlTransport } from '@whalepod/sdk';
import { summarizeFills, fetchClearinghouseState, fetchUserFills } from './hlFetch.js';

const NOW = 1_717_800_000_000;
const DAY = 86_400_000;

/** Stub transport whose `info` returns the canned payload regardless of query. */
function stub(payload: unknown): Pick<HttpHlTransport, 'info'> {
  return { info: () => Promise.resolve(payload as never) };
}

function failing(): Pick<HttpHlTransport, 'info'> {
  return { info: () => Promise.reject(new Error('HTTP 500')) };
}

describe('summarizeFills', () => {
  it('returns zeros for empty fills', () => {
    const s = summarizeFills([], () => NOW);
    expect(s).toEqual({
      allTimeUsd: 0,
      thirtyDayUsd: 0,
      sevenDayUsd: 0,
      feesUsd: 0,
      fillCount: 0,
      lastFillTs: null,
    });
  });

  it('sums closedPnl across all returned fills', () => {
    const s = summarizeFills(
      [
        { closedPnl: '100', fee: '0.5', time: NOW - 1 * DAY },
        { closedPnl: -50, fee: 0.3, time: NOW - 3 * DAY },
        { closedPnl: '200', fee: '1.0', time: NOW - 40 * DAY },
      ],
      () => NOW,
    );
    expect(s.allTimeUsd).toBe(250);
    expect(s.feesUsd).toBeCloseTo(1.8, 5);
    expect(s.fillCount).toBe(3);
  });

  it('only includes 7-day fills in the 7-day window', () => {
    const s = summarizeFills(
      [
        { closedPnl: 100, fee: 0, time: NOW - 1 * DAY },
        { closedPnl: 200, fee: 0, time: NOW - 6 * DAY },
        { closedPnl: 999, fee: 0, time: NOW - 8 * DAY },
      ],
      () => NOW,
    );
    expect(s.sevenDayUsd).toBe(300);
    expect(s.thirtyDayUsd).toBe(1299);
  });

  it('uses the newest fill ts as lastFillTs', () => {
    const s = summarizeFills(
      [
        { closedPnl: 1, time: NOW - 5 * DAY },
        { closedPnl: 1, time: NOW - 1 * DAY },
        { closedPnl: 1, time: NOW - 10 * DAY },
      ],
      () => NOW,
    );
    expect(s.lastFillTs).toBe(NOW - 1 * DAY);
  });

  it('skips fills with non-numeric closedPnl values gracefully', () => {
    const s = summarizeFills(
      [
        { closedPnl: 'not-a-number', fee: 'bad', time: NOW },
        { closedPnl: 50, fee: 0, time: NOW },
      ],
      () => NOW,
    );
    expect(s.allTimeUsd).toBe(50);
  });
});

describe('fetchClearinghouseState (stubbed transport)', () => {
  it('parses positions with positionValue when available', async () => {
    const s = await fetchClearinghouseState('0xabc', {
      transport: stub({
        marginSummary: { accountValue: '12345.67' },
        assetPositions: [
          {
            position: {
              coin: 'hype',
              szi: '100',
              entryPx: '28.5',
              positionValue: '2850',
              unrealizedPnl: '50',
            },
          },
          {
            position: {
              coin: 'btc',
              szi: '-0.1',
              entryPx: '70000',
              positionValue: '7000',
              unrealizedPnl: '-25',
            },
          },
        ],
      }),
    });
    expect(s.equityUsd).toBeCloseTo(12345.67, 2);
    expect(s.positions).toHaveLength(2);
    expect(s.positions[0]!.coin).toBe('BTC');
    expect(s.positions[0]!.side).toBe('short');
    expect(s.positions[1]!.coin).toBe('HYPE');
    expect(s.positions[1]!.side).toBe('long');
  });

  it('falls back to |szi|*entryPx when positionValue is missing', async () => {
    const s = await fetchClearinghouseState('0xabc', {
      transport: stub({
        marginSummary: { accountValue: '0' },
        assetPositions: [
          { position: { coin: 'ETH', szi: '5', entryPx: '3000', unrealizedPnl: '0' } },
        ],
      }),
    });
    expect(s.positions[0]!.sizeUsd).toBeCloseTo(15000, 2);
  });

  it('drops zero-size positions', async () => {
    const s = await fetchClearinghouseState('0xabc', {
      transport: stub({
        marginSummary: { accountValue: '0' },
        assetPositions: [
          { position: { coin: 'ETH', szi: '0', entryPx: '3000' } },
          { position: { coin: 'BTC', szi: '1', entryPx: '70000', unrealizedPnl: '0' } },
        ],
      }),
    });
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]!.coin).toBe('BTC');
  });

  it('propagates transport errors so the build can mark whale stale', async () => {
    await expect(fetchClearinghouseState('0xabc', { transport: failing() })).rejects.toThrow(
      /HTTP 500/u,
    );
  });
});

describe('fetchUserFills (stubbed transport)', () => {
  it('forwards the fills array to summarizeFills', async () => {
    const s = await fetchUserFills('0xabc', {
      transport: stub([{ closedPnl: '100', fee: '1', time: 1_717_700_000_000 }]),
      now: () => 1_717_800_000_000,
    });
    expect(s.allTimeUsd).toBe(100);
    expect(s.fillCount).toBe(1);
  });
});
