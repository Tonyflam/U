import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from '@upstash/redis';
import { RedisFillPublisher, type TgUserIdResolver } from './fillPublisher.js';
import type { MirrorFillEvent } from './notify.js';

const EVENT: MirrorFillEvent = {
  idempotencyKey: '0x1234',
  whaleAddress: '0xabcd000000000000000000000000000000000001',
  coin: 'ETH',
  side: 'B',
  px: '3000',
  sz: '0.5',
  notionalUsd: '1500.00',
  builderFeeTenthsBp: 50,
  builderFeeUsd: '0.750000',
  ts: 1_700_000_000_000,
};

const log = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function fakeRedis(): { xadd: ReturnType<typeof vi.fn>; redis: Redis } {
  const xadd = vi.fn(() => Promise.resolve('1-0'));
  return { xadd, redis: { xadd } as unknown as Redis };
}

function resolver(map: Record<string, string | null>): TgUserIdResolver {
  return {
    tgUserIdByUserId: (userId: string) => Promise.resolve(map[userId] ?? null),
  };
}

describe('RedisFillPublisher', () => {
  it('xadds payload + tgUserId to the configured stream', async () => {
    const { xadd, redis } = fakeRedis();
    const pub = new RedisFillPublisher({
      redis,
      resolver: resolver({ 'u-1': '12345' }),
      log,
    });
    await pub.publish(EVENT, 'u-1');
    expect(xadd).toHaveBeenCalledTimes(1);
    const call = xadd.mock.calls[0] as [string, string, Record<string, string>];
    expect(call[0]).toBe('mirror-fills');
    expect(call[1]).toBe('*');
    expect(call[2]['tgUserId']).toBe('12345');
    expect(JSON.parse(call[2]['payload'] ?? '')).toMatchObject({
      coin: 'ETH',
    });
  });

  it('skips xadd when tg lookup returns null', async () => {
    const { xadd, redis } = fakeRedis();
    const pub = new RedisFillPublisher({
      redis,
      resolver: resolver({}),
      log,
    });
    await pub.publish(EVENT, 'u-unknown');
    expect(xadd).not.toHaveBeenCalled();
  });

  it('swallows xadd errors so submit path is unaffected', async () => {
    const xadd = vi.fn(() => Promise.reject(new Error('redis down')));
    const redis = { xadd } as unknown as Redis;
    const pub = new RedisFillPublisher({
      redis,
      resolver: resolver({ 'u-1': '12345' }),
      log,
    });
    await expect(pub.publish(EVENT, 'u-1')).resolves.toBeUndefined();
  });

  it('honours custom streamKey + maxLen', async () => {
    const { xadd, redis } = fakeRedis();
    const pub = new RedisFillPublisher({
      redis,
      resolver: resolver({ 'u-1': '12345' }),
      log,
      streamKey: 'custom-stream',
      maxLen: 100,
    });
    await pub.publish(EVENT, 'u-1');
    const call = xadd.mock.calls[0] as [
      string,
      string,
      Record<string, string>,
      { trim: { type: string; threshold: number; comparison: string } },
    ];
    expect(call[0]).toBe('custom-stream');
    expect(call[3]).toMatchObject({
      trim: { type: 'MAXLEN', threshold: 100, comparison: '~' },
    });
  });
});
