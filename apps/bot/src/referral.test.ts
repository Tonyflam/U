import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  attributeReferral,
  computeLeaderboard,
  parseReferralStartParam,
  renderLeaderboard,
  type LeaderboardEntry,
  type ReferrerLookupFn,
} from './referral.js';

describe('parseReferralStartParam', () => {
  it('returns null for null / undefined / empty', () => {
    expect(parseReferralStartParam(null)).toBeNull();
    expect(parseReferralStartParam(undefined)).toBeNull();
    expect(parseReferralStartParam('')).toBeNull();
  });

  it('returns null for payloads without the ref_ prefix', () => {
    expect(parseReferralStartParam('alice')).toBeNull();
    expect(parseReferralStartParam('promo_summer')).toBeNull();
  });

  it('extracts and lowercases the code', () => {
    expect(parseReferralStartParam('ref_Alice')).toStrictEqual({ code: 'alice' });
    expect(parseReferralStartParam('ref_TheWhale-9')).toStrictEqual({ code: 'thewhale-9' });
  });

  it('rejects codes that are too short or contain invalid chars', () => {
    expect(parseReferralStartParam('ref_ab')).toBeNull();
    expect(parseReferralStartParam('ref_with space')).toBeNull();
    expect(parseReferralStartParam('ref_with/slash')).toBeNull();
    expect(parseReferralStartParam(`ref_${'a'.repeat(33)}`)).toBeNull();
  });
});

const lookup =
  (records: Record<string, string>): ReferrerLookupFn =>
  (code) => {
    const userId = records[code];
    return Promise.resolve(userId !== undefined ? { userId, code } : null);
  };

describe('attributeReferral', () => {
  it('attributes a fresh user with a valid code', async () => {
    const r = await attributeReferral(
      { newUserId: 'new', existingReferrerUserId: null, startParam: 'ref_alice' },
      lookup({ alice: 'alice-id' }),
    );
    expect(r).toStrictEqual({ kind: 'attributed', referrerUserId: 'alice-id' });
  });

  it('returns no_payload when startParam is null', async () => {
    const r = await attributeReferral(
      { newUserId: 'new', existingReferrerUserId: null, startParam: null },
      lookup({}),
    );
    expect(r.kind).toBe('no_payload');
  });

  it('returns no_payload for a non-ref start param', async () => {
    const r = await attributeReferral(
      { newUserId: 'new', existingReferrerUserId: null, startParam: 'promo_summer' },
      lookup({}),
    );
    expect(r.kind).toBe('no_payload');
  });

  it('returns malformed for a ref_ prefix with bad code', async () => {
    const r = await attributeReferral(
      { newUserId: 'new', existingReferrerUserId: null, startParam: 'ref_!!' },
      lookup({}),
    );
    expect(r.kind).toBe('malformed');
  });

  it('returns unknown_code when the code does not resolve', async () => {
    const r = await attributeReferral(
      { newUserId: 'new', existingReferrerUserId: null, startParam: 'ref_ghost' },
      lookup({}),
    );
    expect(r.kind).toBe('unknown_code');
  });

  it('rejects self-referrals', async () => {
    const r = await attributeReferral(
      { newUserId: 'me', existingReferrerUserId: null, startParam: 'ref_alice' },
      lookup({ alice: 'me' }),
    );
    expect(r.kind).toBe('self_referral');
  });

  it('first attribution wins — already_attributed regardless of new code', async () => {
    const r = await attributeReferral(
      {
        newUserId: 'new',
        existingReferrerUserId: 'first-ref',
        startParam: 'ref_alice',
      },
      lookup({ alice: 'alice-id' }),
    );
    expect(r).toStrictEqual({ kind: 'already_attributed', referrerUserId: 'first-ref' });
  });

  it('property: attribute is idempotent — replaying the same call returns the same outcome', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 50 }), async (param) => {
        const input = {
          newUserId: 'new',
          existingReferrerUserId: null,
          startParam: param,
        };
        const fn = lookup({ alice: 'alice-id' });
        const a = await attributeReferral(input, fn);
        const b = await attributeReferral(input, fn);
        expect(a).toStrictEqual(b);
      }),
      { numRuns: 50 },
    );
  });
});

describe('computeLeaderboard', () => {
  const entries: readonly LeaderboardEntry[] = [
    { userId: 'u-001', handle: '@alice', realizedPnlUsd: 100 },
    { userId: 'u-002', handle: '@bob', realizedPnlUsd: -50 },
    { userId: 'u-003', handle: '@carol', realizedPnlUsd: 100 },
    { userId: 'u-004', handle: '@dave', realizedPnlUsd: 250 },
  ];

  it('sorts by PnL desc with stable tie-break on userId', () => {
    const r = computeLeaderboard(entries);
    expect(r.entries.map((e) => e.userId)).toStrictEqual(['u-004', 'u-001', 'u-003', 'u-002']);
  });

  it('caps to topN and reports totalRanked correctly', () => {
    const r = computeLeaderboard(entries, { topN: 2 });
    expect(r.entries).toHaveLength(2);
    expect(r.totalRanked).toBe(4);
  });

  it('losersHidden drops non-positive entries', () => {
    const r = computeLeaderboard(entries, { losersHidden: true });
    expect(r.entries.every((e) => e.realizedPnlUsd > 0)).toBe(true);
    expect(r.totalRanked).toBe(3);
  });

  it('returns empty entries for empty input', () => {
    const r = computeLeaderboard([]);
    expect(r.entries).toHaveLength(0);
    expect(r.totalRanked).toBe(0);
  });

  it('property: never re-orders ties differently for the same input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            userId: fc.string({ minLength: 1, maxLength: 8 }),
            handle: fc.string({ minLength: 1, maxLength: 8 }),
            realizedPnlUsd: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (xs) => {
          const a = computeLeaderboard(xs);
          const b = computeLeaderboard(xs);
          expect(a.entries.map((e) => e.userId)).toStrictEqual(b.entries.map((e) => e.userId));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('renderLeaderboard', () => {
  it('returns a friendly empty message when there are no entries', () => {
    const r = renderLeaderboard(computeLeaderboard([]));
    expect(r.text).toMatch(/No ranked traders/);
  });

  it('renders a tagged "(you)" marker for the viewer', () => {
    const r = renderLeaderboard(
      computeLeaderboard([
        { userId: 'a', handle: '@alice', realizedPnlUsd: 100 },
        { userId: 'b', handle: '@bob', realizedPnlUsd: 50 },
      ]),
      { viewerUserId: 'b' },
    );
    expect(r.text).toMatch(/@bob \(you\)/);
  });

  it('renders deterministic snapshot', () => {
    const r = renderLeaderboard(
      computeLeaderboard([
        { userId: 'u-001', handle: '@alice', realizedPnlUsd: 250 },
        { userId: 'u-002', handle: '@bob', realizedPnlUsd: -10 },
        { userId: 'u-003', handle: '@carol', realizedPnlUsd: 75 },
      ]),
    );
    expect(r.text).toMatchInlineSnapshot(`
      "Top traders
      1. @alice — +$250.00
      2. @carol — +$75.00
      3. @bob — -$10.00"
    `);
  });

  it('appends "and N more" when topN truncates', () => {
    const entries: LeaderboardEntry[] = Array.from({ length: 12 }, (_, i) => ({
      userId: `u-${String(i).padStart(3, '0')}`,
      handle: `@u${String(i)}`,
      realizedPnlUsd: 100 - i,
    }));
    const r = renderLeaderboard(computeLeaderboard(entries, { topN: 5 }));
    expect(r.text).toMatch(/and 7 more/);
  });
});
