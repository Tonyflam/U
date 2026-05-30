/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import type { Redis } from '@upstash/redis';
import { RedisGeoCache } from './redisGeoCache.js';

function makeFakeRedis(): {
  redis: Redis;
  storage: Map<string, string>;
  ttls: Map<string, number>;
} {
  const storage = new Map<string, string>();
  const ttls = new Map<string, number>();
  const redis = {
    set: async (key: string, value: string, opts?: { ex?: number }) => {
      storage.set(key, value);
      if (opts?.ex !== undefined) ttls.set(key, opts.ex);
      return 'OK';
    },
    get: async <T>(key: string) => (storage.get(key) ?? null) as T | null,
  } as unknown as Redis;
  return { redis, storage, ttls };
}

describe('RedisGeoCache', () => {
  it('stores normalized uppercase code', async () => {
    const { redis, storage } = makeFakeRedis();
    const cache = new RedisGeoCache({ redis });
    await cache.set('user-1', 'ca');
    expect(storage.get('geo:user-1')).toBe('CA');
  });

  it('returns undefined when no country is set', async () => {
    const { redis } = makeFakeRedis();
    const cache = new RedisGeoCache({ redis });
    expect(await cache.countryFor('user-1')).toBeUndefined();
  });

  it('round-trips set then countryFor', async () => {
    const { redis } = makeFakeRedis();
    const cache = new RedisGeoCache({ redis });
    await cache.set('user-1', 'IR');
    expect(await cache.countryFor('user-1')).toBe('IR');
  });

  it('rejects non-ISO-alpha2 values', async () => {
    const { redis, storage } = makeFakeRedis();
    const cache = new RedisGeoCache({ redis });
    await cache.set('user-1', 'USA');
    await cache.set('user-1', '');
    await cache.set('user-1', '12');
    expect(storage.get('geo:user-1')).toBeUndefined();
  });

  it('sets the EXPIRE TTL on writes', async () => {
    const { redis, ttls } = makeFakeRedis();
    const cache = new RedisGeoCache({ redis, ttlSec: 600 });
    await cache.set('user-1', 'CA');
    expect(ttls.get('geo:user-1')).toBe(600);
  });
});
