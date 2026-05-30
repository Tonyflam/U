import { describe, expect, it } from 'vitest';
/* eslint-disable @typescript-eslint/require-await */
import {
  evaluateRisk,
  slippageBps,
  type RiskDeps,
  type RiskInput,
  type RiskPolicy,
  type RiskProviders,
  type AccountEquity,
} from './riskEngine.js';

const DEFAULT_POLICY: RiskPolicy = {
  maxSlippageBps: 50,
  maxDailyNotionalUsd: 100_000,
  blockedCountries: ['US', 'IR', 'KP'],
  requireKnownGeo: false,
};

function makeProviders(
  over: {
    equity?: AccountEquity | undefined;
    usedUsd?: number;
    country?: string | undefined;
  } = {},
): RiskProviders {
  return {
    accountEquity: {
      forUser: async () => over.equity,
    },
    dailyNotional: {
      usedUsd: async () => over.usedUsd ?? 0,
    },
    geo: {
      countryFor: async () => over.country,
    },
  };
}

function makeDeps(
  over: {
    equity?: AccountEquity | undefined;
    usedUsd?: number;
    country?: string | undefined;
    policy?: Partial<RiskPolicy>;
  } = {},
): RiskDeps {
  return {
    ...makeProviders(over),
    policy: { ...DEFAULT_POLICY, ...(over.policy ?? {}) },
  };
}

const baseInput: RiskInput = {
  userId: 'user-1',
  equityFloorUsd: '100',
  mirrorSizeUsd: 1_000,
  px: 100,
  refPx: 100,
  now: 1_700_000_000_000,
};

describe('slippageBps', () => {
  it('returns 0 for identical prices', () => {
    expect(slippageBps(100, 100)).toBe(0);
  });
  it('is symmetric', () => {
    expect(slippageBps(101, 100)).toBeCloseTo(slippageBps(99, 100), 9);
  });
  it('is 100 bps for a 1% deviation', () => {
    expect(slippageBps(101, 100)).toBeCloseTo(100, 9);
  });
  it('returns Infinity for invalid refPx', () => {
    expect(slippageBps(100, 0)).toBe(Infinity);
    expect(slippageBps(100, -1)).toBe(Infinity);
    expect(slippageBps(100, NaN)).toBe(Infinity);
  });
});

describe('evaluateRisk', () => {
  it('allows when all gates pass', async () => {
    const d = await evaluateRisk(
      baseInput,
      makeDeps({
        equity: { equityUsd: 5_000, withdrawableUsd: 4_000 },
        usedUsd: 0,
        country: 'CA',
      }),
    );
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') {
      expect(d.equity.equityUsd).toBe(5_000);
      expect(d.dailyUsedUsd).toBe(0);
    }
  });

  it('blocks on blocked country', async () => {
    const d = await evaluateRisk(
      baseInput,
      makeDeps({
        equity: { equityUsd: 5_000, withdrawableUsd: 4_000 },
        country: 'US',
      }),
    );
    expect(d).toEqual({ kind: 'block', reason: 'geo_blocked', detail: 'US' });
  });

  it('normalizes country case before checking the blocklist', async () => {
    const d = await evaluateRisk(
      baseInput,
      makeDeps({
        equity: { equityUsd: 5_000, withdrawableUsd: 4_000 },
        country: 'us',
      }),
    );
    expect(d.kind).toBe('block');
    if (d.kind === 'block') expect(d.reason).toBe('geo_blocked');
  });

  it('blocks on unknown geo when requireKnownGeo is true', async () => {
    const d = await evaluateRisk(
      baseInput,
      makeDeps({
        equity: { equityUsd: 5_000, withdrawableUsd: 4_000 },
        country: undefined,
        policy: { requireKnownGeo: true },
      }),
    );
    expect(d).toEqual({ kind: 'block', reason: 'geo_unknown' });
  });

  it('allows unknown geo when requireKnownGeo is false', async () => {
    const d = await evaluateRisk(
      baseInput,
      makeDeps({
        equity: { equityUsd: 5_000, withdrawableUsd: 4_000 },
        country: undefined,
        policy: { requireKnownGeo: false },
      }),
    );
    expect(d.kind).toBe('allow');
  });

  it('blocks on slippage exceeding policy', async () => {
    const d = await evaluateRisk(
      { ...baseInput, px: 101, refPx: 100 }, // 100 bps deviation
      makeDeps({
        equity: { equityUsd: 5_000, withdrawableUsd: 4_000 },
        country: 'CA',
        policy: { maxSlippageBps: 50 },
      }),
    );
    expect(d.kind).toBe('block');
    if (d.kind === 'block') expect(d.reason).toBe('slippage_exceeded');
  });

  it('allows slippage exactly at the cap', async () => {
    const d = await evaluateRisk(
      { ...baseInput, px: 100.5, refPx: 100 }, // exactly 50 bps
      makeDeps({
        equity: { equityUsd: 5_000, withdrawableUsd: 4_000 },
        country: 'CA',
        policy: { maxSlippageBps: 50 },
      }),
    );
    expect(d.kind).toBe('allow');
  });

  it('blocks when account equity is unknown', async () => {
    const d = await evaluateRisk(
      baseInput,
      makeDeps({
        equity: undefined,
        country: 'CA',
      }),
    );
    expect(d).toEqual({ kind: 'block', reason: 'equity_unknown' });
  });

  it('blocks when equity is at or below the floor', async () => {
    const d = await evaluateRisk(
      { ...baseInput, equityFloorUsd: '500' },
      makeDeps({
        equity: { equityUsd: 500, withdrawableUsd: 500 },
        country: 'CA',
      }),
    );
    expect(d.kind).toBe('block');
    if (d.kind === 'block') expect(d.reason).toBe('equity_floor_breach');
  });

  it('treats a malformed equityFloorUsd as equity_unknown', async () => {
    const d = await evaluateRisk(
      { ...baseInput, equityFloorUsd: 'not-a-number' },
      makeDeps({
        equity: { equityUsd: 5_000, withdrawableUsd: 4_000 },
        country: 'CA',
      }),
    );
    expect(d.kind).toBe('block');
    if (d.kind === 'block') expect(d.reason).toBe('equity_unknown');
  });

  it('blocks when adding mirror notional would exceed the daily cap', async () => {
    const d = await evaluateRisk(
      { ...baseInput, mirrorSizeUsd: 60_000 },
      makeDeps({
        equity: { equityUsd: 1_000_000, withdrawableUsd: 1_000_000 },
        usedUsd: 50_000,
        country: 'CA',
        policy: { maxDailyNotionalUsd: 100_000 },
      }),
    );
    expect(d.kind).toBe('block');
    if (d.kind === 'block') expect(d.reason).toBe('daily_notional_exceeded');
  });

  it('allows when adding mirror notional exactly equals the daily cap', async () => {
    const d = await evaluateRisk(
      { ...baseInput, mirrorSizeUsd: 50_000 },
      makeDeps({
        equity: { equityUsd: 1_000_000, withdrawableUsd: 1_000_000 },
        usedUsd: 50_000,
        country: 'CA',
        policy: { maxDailyNotionalUsd: 100_000 },
      }),
    );
    expect(d.kind).toBe('allow');
  });

  it('asks the daily-notional provider for a 24h rolling window', async () => {
    let captured: number | undefined;
    const deps: RiskDeps = {
      accountEquity: { forUser: async () => ({ equityUsd: 5_000, withdrawableUsd: 4_000 }) },
      dailyNotional: {
        usedUsd: async (_id, sinceMs) => {
          captured = sinceMs;
          return 0;
        },
      },
      geo: { countryFor: async () => 'CA' },
      policy: DEFAULT_POLICY,
    };
    await evaluateRisk(baseInput, deps);
    expect(captured).toBe(baseInput.now - 24 * 60 * 60 * 1000);
  });

  it('rejects geo before equity/notional lookups so blocked-country lookups are minimal', async () => {
    let equityCalls = 0;
    let dailyCalls = 0;
    const deps: RiskDeps = {
      accountEquity: {
        forUser: async () => {
          equityCalls++;
          return { equityUsd: 5_000, withdrawableUsd: 4_000 };
        },
      },
      dailyNotional: {
        usedUsd: async () => {
          dailyCalls++;
          return 0;
        },
      },
      geo: { countryFor: async () => 'US' },
      policy: DEFAULT_POLICY,
    };
    const d = await evaluateRisk(baseInput, deps);
    expect(d.kind).toBe('block');
    expect(equityCalls).toBe(0);
    expect(dailyCalls).toBe(0);
  });
});
