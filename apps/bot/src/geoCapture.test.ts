import { describe, expect, it, vi } from 'vitest';
import { captureGeo, extractCountry, extractTgUserId } from './geoCapture.js';

describe('extractCountry', () => {
  it('returns undefined for missing header', () => {
    expect(extractCountry(undefined)).toBeUndefined();
    expect(extractCountry([])).toBeUndefined();
  });

  it('normalizes lowercase to uppercase ISO-2', () => {
    expect(extractCountry('us')).toBe('US');
    expect(extractCountry(' de ')).toBe('DE');
  });

  it('uses the first value when an array is given', () => {
    expect(extractCountry(['fr', 'gb'])).toBe('FR');
  });

  it('drops Cloudflare sentinels XX and T1', () => {
    expect(extractCountry('XX')).toBeUndefined();
    expect(extractCountry('t1')).toBeUndefined();
  });

  it('rejects non ISO-2 values', () => {
    expect(extractCountry('USA')).toBeUndefined();
    expect(extractCountry('1')).toBeUndefined();
    expect(extractCountry('')).toBeUndefined();
  });
});

describe('extractTgUserId', () => {
  it('returns undefined for non-objects', () => {
    expect(extractTgUserId(null)).toBeUndefined();
    expect(extractTgUserId('x')).toBeUndefined();
    expect(extractTgUserId(42)).toBeUndefined();
  });

  it('reads message.from.id', () => {
    expect(extractTgUserId({ message: { from: { id: 42 } } })).toBe(42n);
  });

  it('reads callback_query.from.id', () => {
    expect(extractTgUserId({ callback_query: { from: { id: 1234 } } })).toBe(1234n);
  });

  it('reads my_chat_member.from.id when present', () => {
    expect(extractTgUserId({ my_chat_member: { from: { id: 7 } } })).toBe(7n);
  });

  it('returns undefined when no recognized envelope carries from', () => {
    expect(extractTgUserId({ update_id: 1, poll: {} })).toBeUndefined();
    expect(extractTgUserId({ message: {} })).toBeUndefined();
  });
});

describe('captureGeo', () => {
  it('resolves the user and stamps the country', async () => {
    const repo = { getUserByTgId: vi.fn().mockResolvedValue({ id: 'u-1' }) };
    const geoCache = { set: vi.fn().mockResolvedValue(undefined) };
    const ok = await captureGeo({ repo, geoCache }, { tgUserId: 99n, country: 'DE' });
    expect(ok).toBe(true);
    expect(repo.getUserByTgId).toHaveBeenCalledWith(99n);
    expect(geoCache.set).toHaveBeenCalledWith('u-1', 'DE');
  });

  it('returns false and does not write when the user is unknown', async () => {
    const repo = { getUserByTgId: vi.fn().mockResolvedValue(null) };
    const geoCache = { set: vi.fn().mockResolvedValue(undefined) };
    const ok = await captureGeo({ repo, geoCache }, { tgUserId: 1n, country: 'US' });
    expect(ok).toBe(false);
    expect(geoCache.set).not.toHaveBeenCalled();
  });
});
