import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { signInitDataForTest, verifyInitData } from './initData.js';

const BOT_TOKEN = '7000000000:AAH-thisIsATestBotTokenForUnitTestsXyz';
const NOW_MS = 1_717_000_000_000; // 2024-05-29 (well past any auth_date we set)

function makeFields(authDate: number, userId: bigint, extras: Record<string, string> = {}) {
  return {
    auth_date: String(authDate),
    user: JSON.stringify({ id: Number(userId), first_name: 'Ada', username: 'ada' }),
    query_id: 'AAH-test',
    ...extras,
  };
}

describe('verifyInitData', () => {
  it('accepts a well-signed payload', () => {
    const initData = signInitDataForTest(makeFields(Math.floor(NOW_MS / 1000), 42n), BOT_TOKEN);
    const r = verifyInitData({ initData, botToken: BOT_TOKEN, now: () => NOW_MS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.user.id).toBe(42n);
      expect(r.data.user.username).toBe('ada');
      expect(r.data.query_id).toBe('AAH-test');
    }
  });

  it('rejects when the hash field is absent', () => {
    const r = verifyInitData({
      initData: 'auth_date=1717000000&user=%7B%7D',
      botToken: BOT_TOKEN,
      now: () => NOW_MS,
    });
    expect(r).toStrictEqual({ ok: false, reason: 'missing_hash' });
  });

  it('rejects a tampered field while keeping the original hash', () => {
    const fields = makeFields(Math.floor(NOW_MS / 1000), 42n);
    const initData = signInitDataForTest(fields, BOT_TOKEN);
    // swap user.id to a different account, keep hash
    const tampered = initData.replace(/user=[^&]+/u, `user=${encodeURIComponent('{"id":99}')}`);
    const r = verifyInitData({ initData: tampered, botToken: BOT_TOKEN, now: () => NOW_MS });
    expect(r).toStrictEqual({ ok: false, reason: 'bad_hash' });
  });

  it('rejects a payload signed with a different bot token', () => {
    const initData = signInitDataForTest(
      makeFields(Math.floor(NOW_MS / 1000), 42n),
      'different-token',
    );
    const r = verifyInitData({ initData, botToken: BOT_TOKEN, now: () => NOW_MS });
    expect(r).toStrictEqual({ ok: false, reason: 'bad_hash' });
  });

  it('rejects when auth_date is older than maxAgeSeconds', () => {
    const old = Math.floor(NOW_MS / 1000) - 25 * 3600;
    const initData = signInitDataForTest(makeFields(old, 42n), BOT_TOKEN);
    const r = verifyInitData({ initData, botToken: BOT_TOKEN, now: () => NOW_MS });
    expect(r).toStrictEqual({ ok: false, reason: 'expired' });
  });

  it('rejects when the user field is not parseable JSON', () => {
    const fields = {
      auth_date: String(Math.floor(NOW_MS / 1000)),
      user: 'not-json',
    };
    const initData = signInitDataForTest(fields, BOT_TOKEN);
    const r = verifyInitData({ initData, botToken: BOT_TOKEN, now: () => NOW_MS });
    expect(r).toStrictEqual({ ok: false, reason: 'invalid_user' });
  });

  it('rejects when the user field is missing entirely', () => {
    const fields = { auth_date: String(Math.floor(NOW_MS / 1000)) };
    const initData = signInitDataForTest(fields, BOT_TOKEN);
    const r = verifyInitData({ initData, botToken: BOT_TOKEN, now: () => NOW_MS });
    expect(r).toStrictEqual({ ok: false, reason: 'missing_user' });
  });

  it('property: any single-byte mutation of the hash is rejected', () => {
    const fields = makeFields(Math.floor(NOW_MS / 1000), 42n);
    const baseline = signInitDataForTest(fields, BOT_TOKEN);
    const hashMatch = /hash=([0-9a-f]{64})/u.exec(baseline);
    const goodHash = hashMatch?.[1];
    if (!goodHash) throw new Error('test setup');

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 63 }),
        fc.constantFrom(...'0123456789abcdef'.split('')),
        (idx, ch) => {
          const orig = goodHash[idx]!;
          if (orig === ch) return true; // skip non-mutation
          const mutated = goodHash.slice(0, idx) + ch + goodHash.slice(idx + 1);
          const initData = baseline.replace(goodHash, mutated);
          const r = verifyInitData({ initData, botToken: BOT_TOKEN, now: () => NOW_MS });
          return !r.ok && r.reason === 'bad_hash';
        },
      ),
      { numRuns: 40 },
    );
  });
});
