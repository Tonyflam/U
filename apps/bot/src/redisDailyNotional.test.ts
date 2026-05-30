/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import type { Redis } from '@upstash/redis';
import { RedisDailyNotional } from './redisDailyNotional.js';

interface ZSetMember {
  score: number;
  member: string;
}

function makeFakeRedis(): {
  redis: Redis;
  storage: Map<string, ZSetMember[]>;
  ttls: Map<string, number>;
} {
  const storage = new Map<string, ZSetMember[]>();
  const ttls = new Map<string, number>();
  const ops: { kind: 'zadd' | 'zrem' | 'expire'; key: string; args: unknown[] }[] = [];

  const exec = async (): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const op of ops) {
      if (op.kind === 'zadd') {
        const arr = storage.get(op.key) ?? [];
        const m = op.args[0] as ZSetMember;
        arr.push(m);
        storage.set(op.key, arr);
        results.push(1);
      } else if (op.kind === 'zrem') {
        const [min, max] = op.args as [number, number];
        const arr = (storage.get(op.key) ?? []).filter((x) => x.score < min || x.score > max);
        storage.set(op.key, arr);
        results.push(0);
      } else {
        ttls.set(op.key, op.args[0] as number);
        results.push(1);
      }
    }
    ops.length = 0;
    return results;
  };

  const redis = {
    pipeline: () => ({
      zadd: (key: string, m: ZSetMember) => {
        ops.push({ kind: 'zadd', key, args: [m] });
      },
      zremrangebyscore: (key: string, min: number, max: number) => {
        ops.push({ kind: 'zrem', key, args: [min, max] });
      },
      expire: (key: string, sec: number) => {
        ops.push({ kind: 'expire', key, args: [sec] });
      },
      exec,
    }),
    zrange: async <T>(
      key: string,
      min: number | string,
      _max: number | string,
      opts?: { byScore?: boolean },
    ) => {
      if (opts?.byScore !== true) throw new Error('expected byScore');
      const arr = storage.get(key) ?? [];
      const minN = typeof min === 'number' ? min : Number.NEGATIVE_INFINITY;
      return arr.filter((x) => x.score >= minN).map((x) => x.member) as T;
    },
  } as unknown as Redis;

  return { redis, storage, ttls };
}

describe('RedisDailyNotional', () => {
  it('records one entry per add and returns the running sum', async () => {
    const { redis } = makeFakeRedis();
    const sink = new RedisDailyNotional({ redis });
    await sink.add('user-1', 100, 1_000);
    await sink.add('user-1', 250, 2_000);
    expect(await sink.usedUsd('user-1', 0)).toBe(350);
  });

  it('isolates users', async () => {
    const { redis } = makeFakeRedis();
    const sink = new RedisDailyNotional({ redis });
    await sink.add('a', 100, 1_000);
    await sink.add('b', 999, 1_000);
    expect(await sink.usedUsd('a', 0)).toBe(100);
    expect(await sink.usedUsd('b', 0)).toBe(999);
  });

  it('GCs entries older than 25h on each write', async () => {
    const { redis, storage } = makeFakeRedis();
    const sink = new RedisDailyNotional({ redis });
    const t0 = 0;
    const t1 = 25 * 60 * 60 * 1000 + 1;
    await sink.add('user-1', 50, t0);
    await sink.add('user-1', 60, t1);
    const arr = storage.get('notional:user-1') ?? [];
    expect(arr.length).toBe(1);
    expect(arr[0]?.score).toBe(t1);
  });

  it('windows usedUsd by sinceMs', async () => {
    const { redis } = makeFakeRedis();
    const sink = new RedisDailyNotional({ redis });
    await sink.add('user-1', 100, 1_000);
    await sink.add('user-1', 200, 5_000);
    expect(await sink.usedUsd('user-1', 4_000)).toBe(200);
  });

  it('ignores non-positive or non-finite usd', async () => {
    const { redis, storage } = makeFakeRedis();
    const sink = new RedisDailyNotional({ redis });
    await sink.add('user-1', 0, 1_000);
    await sink.add('user-1', -5, 1_000);
    await sink.add('user-1', Number.NaN, 1_000);
    expect(storage.get('notional:user-1') ?? []).toEqual([]);
    expect(await sink.usedUsd('user-1', 0)).toBe(0);
  });

  it('sets an EXPIRE on every write', async () => {
    const { redis, ttls } = makeFakeRedis();
    const sink = new RedisDailyNotional({ redis });
    await sink.add('user-1', 10, 1_000);
    expect(ttls.get('notional:user-1')).toBe(26 * 60 * 60);
  });
});
